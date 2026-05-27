import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface TestWithoutAssertionDetectorInput extends FileWalkingDetectorInput {}

// `it(...)` / `test(...)` whose body contains no assertion call. Catches
// tests that exist for the green tick without exercising anything. The
// `expect-expect` eslint-plugin-jest rule covers this but ships off in
// most projects + doesn't know custom matcher helpers; this detector
// runs whether or not the project pulled the plugin in. MED severity.
//
// `.skip` / `.only` / `.todo` callsites are deliberately excluded —
// `skip-tests` owns those, and `.todo` is an intentional placeholder.
export function detectTestsWithoutAssertion(input: TestWithoutAssertionDetectorInput): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const findings: Finding[] = [];
  for (const rel of input.files) {
    if (!isTestFile(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    findings.push(...analyseFile(rel, raw));
  }
  return findings;
}

// `it('name', fn)` or `test('name', fn)`. Excludes `it.skip` / `it.only`
// / `it.todo` / `xit` / `fit` so we don't double-flag skip-tests's
// territory. `it.concurrent(...)` and `it.each(...)` are caught — they
// still execute and still need assertions.
const TEST_OPENING_RE =
  /\b(?:it|test)\s*(?:\.(?:concurrent|each(?:\.\w+)*)\s*(?:\([^)]*\))?)?\s*\(/g;

const ASSERTION_PATTERNS: RegExp[] = [
  // Jest / Vitest / Bun
  /\bexpect\s*\(/,
  /\bexpectTypeOf\s*\(/,
  // Node built-in + Chai + Node-tap
  /\bassert\b\s*(?:\.|\()/,
  /\bstrict\.\w+\s*\(/, // `import { strict } from 'node:assert'; strict.equal(...)`
  // Chai BDD
  /\.\s*should\b/,
  /\bshould\s*\(/,
  /\bchai\.\w+/,
  // Promise-rejection helpers commonly used as the only assertion
  /\.\s*to(?:Throw|Reject|Resolve|MatchSnapshot|MatchInlineSnapshot)/,
  // Snapshot-style
  /\bmatchSnapshot\b/,
  /\binlineSnapshot\b/,
  // Sinon, jest fn matchers used as assertions
  /\.calledWith\b/,
  /\.calledOnce\b/,
  /\.toHaveBeenCalled\b/,
  // Project-defined helpers — convention: any identifier starting with
  // `expect`, `assert`, or `verify` followed by `(` is an assertion.
  // Reduces FPs on codebases that wrap matchers in helpers.
  /\b(?:expect|assert|verify)[A-Z]\w*\s*\(/,
];

function analyseFile(file: string, raw: string): Finding[] {
  const out: Finding[] = [];
  const matches = [...raw.matchAll(TEST_OPENING_RE)];
  for (const match of matches) {
    const idx = match.index!;
    if (isSkippedCallsite(raw, idx)) continue;

    // Walk to the test's argument list to find the function-body braces.
    // Tests are typically `it('name', () => { ... })` or
    // `it('name', async function() { ... })`. We only need to locate
    // the OUTERMOST `{` that opens the body and pair it with its `}`.
    const bodyRange = findFunctionBody(raw, idx + match[0].length - 1);
    if (!bodyRange) continue;

    const body = raw.slice(bodyRange.start + 1, bodyRange.end);
    if (body.trim().length === 0) continue; // empty body — different smell
    if (ASSERTION_PATTERNS.some((re) => re.test(body))) continue;

    const line = lineOf(raw, idx);
    if (hasIgnoreAnnotation(raw, line, 'test-without-assertion')) continue;

    const title = extractTestTitle(raw, idx) ?? '(unnamed test)';
    out.push({
      detectorId: 'test-without-assertion',
      severity: 'medium',
      confidence: 0.85,
      layer: 1,
      title: `Test without assertion: \`${title}\` in ${file}:${line}`,
      description:
        `The body of this test contains no \`expect\`, \`assert\`, \`should\`, snapshot match, or thrown-error matcher. ` +
        `It can only fail by throwing on unrelated code, so it offers near-zero regression value while still costing CI time.`,
      evidence: [
        {
          file,
          range: { startLine: line, endLine: lineOf(raw, bodyRange.end) },
          snippet: snippetAround(raw, line),
        },
      ],
      suggestion:
        `Either add an explicit assertion (\`expect(...).toBe(...)\`, \`assert.equal(...)\`, …), ` +
        `replace with \`it.todo(...)\` if the test is a placeholder, or delete it. ` +
        `If you assert through a project-specific helper, name it \`expectFoo()\` / \`assertFoo()\` / \`verifyFoo()\` so this detector recognises it.`,
      fingerprint: `test-without-assertion:${stableHash(`${file}:${line}:${title}`)}`,
    });
  }
  return out;
}

// Don't flag `it.skip(...)` / `it.only(...)` / `it.todo(...)` / `xit(...)` /
// `fit(...)` — skip-tests owns those, and `.todo` is intentional.
function isSkippedCallsite(raw: string, matchIdx: number): boolean {
  // Look at the keyword that opened the match — `it`/`test`. If immediately
  // preceded by `x` or `f` (`xit` / `fit`), or followed by `.skip` / `.only`
  // / `.todo`, skip. The regex above already strips `.concurrent` / `.each`.
  const before = raw.slice(Math.max(0, matchIdx - 1), matchIdx);
  if (before === 'x' || before === 'f') return true;
  // `it.skip(` etc. The TEST_OPENING_RE already excludes those because
  // it doesn't accept `.skip` in its dot-suffix group, but the regex
  // *does* match the `it` token of `it.skip(...)` followed by `.skip(`.
  // Defensive double-check: look at the next 6 chars after `it`/`test`.
  const after = raw.slice(matchIdx, matchIdx + 12);
  if (/^(?:it|test)\s*\.\s*(?:skip|only|todo)\b/.test(after)) return true;
  return false;
}

// Given an index pointing at the `(` that opens `it(...)`, find the
// outermost `{ ... }` that is the test's function body. Returns null if
// the body is missing (`it.todo` style) or unparseable.
function findFunctionBody(
  raw: string,
  openParenIdx: number,
): { start: number; end: number } | null {
  // Walk the argument list with paren depth, ignoring braces inside
  // string / template / comment contexts is a heavy lift — we instead
  // accept a small false-negative on macro-heavy bodies and look for the
  // first `{` at paren-depth 1 inside the arg list, then balance.
  let i = openParenIdx + 1;
  let parenDepth = 1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) return null; // closed the it(...) call without ever seeing a `{`
    } else if (ch === '{' && parenDepth === 1) {
      const end = findMatchingBrace(raw, i);
      if (end === -1) return null;
      return { start: i, end };
    }
    i++;
  }
  return null;
}

function findMatchingBrace(raw: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractTestTitle(raw: string, idx: number): string | null {
  // Look just past the opening `(`. Tests almost always start with a
  // string literal title: `it('does X', ...)`. We grab whatever's in
  // the first string for the finding title.
  const open = raw.indexOf('(', idx);
  if (open === -1) return null;
  const rest = raw.slice(open + 1, open + 200);
  const m = /^\s*(['"`])((?:\\.|(?!\1).)*?)\1/.exec(rest);
  return m ? m[2]! : null;
}

function isTestFile(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return (
    /(?:^|\/)(__tests__|tests|test|spec)\//.test(posix) ||
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(posix)
  );
}

function lineOf(raw: string, idx: number): number {
  return raw.slice(0, idx).split('\n').length;
}

function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, line + 2);
  return lines.slice(from, to).join('\n');
}
