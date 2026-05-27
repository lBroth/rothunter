import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import { escapeForRegex } from '../utils/regex.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface MutableGlobalsDetectorInput extends FileWalkingDetectorInput {}

// Top-level `let`/`var` reassigned in the same file → shared mutable
// state across importers. MED. One-shot assignment at decl is skipped.
export function detectMutableGlobals(input: MutableGlobalsDetectorInput): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const findings: Finding[] = [];
  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    findings.push(...analyseFile(rel, raw));
  }
  return findings;
}

function analyseFile(file: string, raw: string): Finding[] {
  const lines = raw.split('\n');
  const out: Finding[] = [];
  // Locate top-level let/var declarations: line starts with `let `/`var `
  // (allow `export let`).
  const declRe = /^(?:export\s+)?(?:let|var)\s+(\w+)\b/;
  const declarations: Array<{ name: string; line: number }> = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    // crude tracking — strings/comments are NOT masked here, so multiline
    // template-literal-heavy files may misalign; the heuristic still works
    // in practice because we only care about indentation-0 declarations.
    const m = declRe.exec(line);
    if (m && braceDepth === 0 && parenDepth === 0) {
      declarations.push({ name: m[1]!, line: lineNo });
    }
    for (const c of line) {
      if (c === '{') braceDepth++;
      else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (c === '(') parenDepth++;
      else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  for (const d of declarations) {
    // Look for reassignments anywhere after the declaration line.
    const after = lines.slice(d.line).join('\n');
    const re = new RegExp(
      `(?<![\\.\\w])${escapeForRegex(d.name)}\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|\\?\\?=|\\|\\|=|&&=)`,
      'g',
    );
    const matches = [...after.matchAll(re)];
    if (matches.length === 0) continue;
    if (hasIgnoreAnnotation(raw, d.line, 'mutable-globals')) continue;
    out.push({
      detectorId: 'mutable-globals',
      severity: 'medium',
      confidence: 0.8,
      layer: 1,
      title: `Mutable top-level binding: \`${d.name}\` in ${file}:${d.line}`,
      description: `\`${d.name}\` is declared with \`let\`/\`var\` at module scope and reassigned later. Module-scope mutation is shared by every importer — common cause of cross-test pollution, hidden state in SSR, and bugs that only appear after the second request.`,
      evidence: [
        {
          file,
          range: { startLine: d.line, endLine: d.line },
          snippet: snippetAround(raw, d.line),
        },
      ],
      suggestion:
        'Encapsulate the state in a class / closure / module factory so each consumer gets its own copy, or move to `const` if no mutation is actually needed.',
      fingerprint: `mutable-globals:${stableHash(`${file}:${d.name}`)}`,
    });
  }
  return out;
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return (
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(posix) &&
    !/\.d\.ts$/.test(posix) &&
    !/(^|\/)node_modules\//.test(posix) &&
    !/(?:^|\/)__tests__\//.test(posix) &&
    !/(?:^|\/)tests?\//.test(posix) &&
    !/\.test\.(?:ts|tsx|js|jsx)$/.test(posix) &&
    !/\.spec\.(?:ts|tsx|js|jsx)$/.test(posix)
  );
}

function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}
