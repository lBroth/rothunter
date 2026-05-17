import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

export interface SkipTestsDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
}

/**
 * Skip/only-tests detector.
 *
 * Catches the four classic shipping-broken-tests footguns:
 *   - `describe.skip(...)` / `it.skip(...)` / `test.skip(...)`     → silenced suites
 *   - `xdescribe(...)` / `xit(...)` / `xtest(...)`                  → silenced suites (Jasmine syntax)
 *   - `describe.only(...)` / `it.only(...)` / `test.only(...)`     → CI runs ONLY this
 *   - `fdescribe(...)` / `fit(...)`                                → Jasmine `f` prefix variants
 *
 * `.only` is HIGH because merging it makes the test suite a no-op for every
 * other case. `.skip` / `x*` are MEDIUM — explicit skips are common during
 * triage but rot if left forever.
 */
export function detectSkipTests(input: SkipTestsDetectorInput): Finding[] {
  const findings: Finding[] = [];
  for (const rel of input.files) {
    if (!isTestFile(rel)) continue;
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

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
