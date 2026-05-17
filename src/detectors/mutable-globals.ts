import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

export interface MutableGlobalsDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
}

/**
 * Mutable-globals detector.
 *
 * Top-level `let` / `var` that get reassigned in the same file are
 * effectively shared mutable state across every import — a notorious
 * source of cross-test pollution, test-order dependence, and SSR
 * hydration bugs.
 *
 * Heuristic:
 *   - find each `let foo = …;` / `var foo = …;` at indent depth 0
 *   - search the rest of the file for `foo = …` (assignment, not
 *     declaration) at depth 0 or inside any function
 *   - if found, flag as MED
 *
 * Top-level `let` that is ONLY assigned once at declaration is fine —
 * it's just a const that the dev forgot to mark.
 */
export function detectMutableGlobals(input: MutableGlobalsDetectorInput): Finding[] {
  const findings: Finding[] = [];
  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const abs = path.resolve(input.workspaceRoot, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
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
    const re = new RegExp(`(?<![\\.\\w])${escapeForRegex(d.name)}\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|\\?\\?=|\\|\\|=|&&=)`, 'g');
    const matches = [...after.matchAll(re)];
    if (matches.length === 0) continue;
    out.push({
      detectorId: 'mutable-globals',
      severity: 'medium',
      confidence: 0.8,
      layer: 1,
      title: `Mutable top-level binding: \`${d.name}\` in ${file}:${d.line}`,
      description:
        `\`${d.name}\` is declared with \`let\`/\`var\` at module scope and reassigned later. Module-scope mutation is shared by every importer — common cause of cross-test pollution, hidden state in SSR, and bugs that only appear after the second request.`,
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

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(posix)
    && !/\.d\.ts$/.test(posix)
    && !/(^|\/)node_modules\//.test(posix)
    && !/(?:^|\/)__tests__\//.test(posix)
    && !/(?:^|\/)tests?\//.test(posix)
    && !/\.test\.(?:ts|tsx|js|jsx)$/.test(posix)
    && !/\.spec\.(?:ts|tsx|js|jsx)$/.test(posix);
}

function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
