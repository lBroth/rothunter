import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface SkipTestsDetectorInput extends FileWalkingDetectorInput {}

// .skip / .only / xdescribe / fdescribe in tests. .only is HIGH (suite
// no-op on merge), .skip / x* are MED.
export function detectSkipTests(input: SkipTestsDetectorInput): Finding[] {
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

const SKIP_PATTERNS: Array<{ re: RegExp; kind: 'skip' | 'only'; label: string }> = [
  { re: /\b(describe|it|test)\.skip\s*\(/g, kind: 'skip', label: '.skip(...)' },
  { re: /\b(describe|it|test)\.only\s*\(/g, kind: 'only', label: '.only(...)' },
  { re: /\b(xdescribe|xit|xtest)\s*\(/g, kind: 'skip', label: 'x-prefixed skip' },
  { re: /\b(fdescribe|fit)\s*\(/g, kind: 'only', label: 'f-prefixed only' },
];

function analyseFile(file: string, raw: string): Finding[] {
  const out: Finding[] = [];
  for (const p of SKIP_PATTERNS) {
    p.re.lastIndex = 0;
    for (const match of raw.matchAll(p.re)) {
      const line = lineOf(raw, match.index!);
      out.push({
        detectorId: 'skip-tests',
        severity: p.kind === 'only' ? 'high' : 'medium',
        confidence: 0.97,
        layer: 1,
        title: `${p.kind === 'only' ? 'Test isolation' : 'Skipped test'}: ${p.label} in ${file}:${line}`,
        description:
          p.kind === 'only'
            ? `\`${match[0].replace(/\($/, '')}\` causes the entire test framework to run ONLY the marked block — every other test in the suite is silently skipped during CI. Merging this disables the whole test bed.`
            : `\`${match[0].replace(/\($/, '')}\` is a skipped test. Skips are useful during triage but rot fast when left without a tracking ticket or a delete plan.`,
        evidence: [
          {
            file,
            range: { startLine: line, endLine: line },
            snippet: snippetAround(raw, line),
          },
        ],
        suggestion:
          p.kind === 'only'
            ? 'Remove the `.only` modifier before merging. Add an ESLint rule (e.g. `mocha/no-exclusive-tests` or `jest/no-focused-tests`) to fail CI on `.only` callsites.'
            : 'Either re-enable + fix the test, or delete it. If a skip is genuinely intentional, replace it with `it.todo(...)` and link the tracking ticket.',
        fingerprint: `skip-tests:${stableHash(`${file}:${line}:${p.label}`)}`,
      });
    }
  }
  return out;
}

function isTestFile(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /(?:^|\/)(__tests__|tests|test|spec)\//.test(posix)
    || /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(posix);
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

