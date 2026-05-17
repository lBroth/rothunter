import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

export interface MagicNumbersDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  /** Numbers considered "obvious" and not magic. Default `{0, 1, -1, 2, 10, 100, 1000}`. */
  whitelist?: ReadonlySet<number>;
  /** Per-file finding cap so a single noisy file doesn't dominate the report. Default 5. */
  perFileCap?: number;
}

/**
 * Magic-numbers detector.
 *
 * Flags numeric literals that:
 *   - aren't in the whitelist (`0`, `1`, `-1`, `2`, `10`, `100`, `1000`)
 *   - aren't simple array indices / for-loop bounds (heuristic: literal
 *     follows `[` or appears in `for (let i = 0; i < N; i++)` patterns)
 *   - aren't inside an obvious time / size constant context already
 *     (we look at the surrounding identifier — if it's already
 *     `TIMEOUT_MS`, the value is being declared, not magic)
 *
 * LOW severity; capped per file so it doesn't dominate dashboards.
 */
export function detectMagicNumbers(input: MagicNumbersDetectorInput): Finding[] {
  const whitelist = input.whitelist ?? DEFAULT_WHITELIST;
  const cap = input.perFileCap ?? 5;
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
    findings.push(...analyseFile(rel, raw, whitelist, cap));
  }
  return findings;
}

const DEFAULT_WHITELIST: ReadonlySet<number> = new Set([0, 1, -1, 2, 10, 100, 1000]);
// Match positive integer literals (we treat negatives via the previous char).
const NUM_RE = /\b(\d+(?:\.\d+)?)\b/g;

function analyseFile(file: string, raw: string, whitelist: ReadonlySet<number>, cap: number): Finding[] {
  const out: Finding[] = [];
  // Pre-strip strings + comments so literals inside them aren't flagged.
  const masked = maskStringsAndComments(raw);
  for (const m of masked.matchAll(NUM_RE)) {
    if (out.length >= cap) break;
    const value = parseFloat(m[1]!);
    if (whitelist.has(value)) continue;
    if (whitelist.has(-value)) continue;
    // Skip if the literal is being assigned to a constant (declaration site).
    const before = masked.slice(Math.max(0, m.index! - 30), m.index!);
    if (/\b(?:const|let|var|enum|readonly)\s+[A-Z_][A-Z0-9_]*\s*[:=]\s*$/.test(before)) continue;
    if (/\b(?:const|let|var)\s+\w+\s*[:=]\s*$/.test(before)) continue;
    // Skip array indices (preceded by `[`).
    if (/\[\s*$/.test(before)) continue;
    // Skip enum members.
    if (/=\s*$/.test(before) && /\benum\b/.test(masked.slice(Math.max(0, m.index! - 200), m.index!))) continue;
    // Skip exponents / decimals (e.g. 1e-3 — the `3` should not be flagged).
    if (/e-?$/i.test(before)) continue;
    const line = lineOf(raw, m.index!);
    out.push({
      detectorId: 'magic-numbers',
      severity: 'low',
      confidence: 0.7,
      layer: 1,
      title: `Magic number \`${m[1]}\` in ${file}:${line}`,
      description: `Numeric literal \`${m[1]}\` appears in business logic without a named constant. Re-readers must guess what it represents (a timeout? a port? a column count?).`,
      evidence: [
        {
          file,
          range: { startLine: line, endLine: line },
          snippet: snippetAround(raw, line),
        },
      ],
      suggestion:
        'Extract to a named const (`const RETRY_LIMIT = 3;`). If it derives from a real-world unit, encode the unit in the name (`TIMEOUT_MS`, `MAX_AGE_DAYS`).',
      fingerprint: `magic-numbers:${stableHash(`${file}:${line}:${m[1]}`)}`,
    });
  }
  return out;
}

function maskStringsAndComments(raw: string): string {
  let out = '';
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i++;
      } else {
        out += c === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (c === inString) {
        inString = null;
        out += c;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /\.(?:ts|tsx|mts|cts)$/.test(posix)
    && !/\.d\.ts$/.test(posix)
    && !/(^|\/)node_modules\//.test(posix)
    && !/(?:^|\/)__tests__\//.test(posix)
    && !/(?:^|\/)tests?\//.test(posix)
    && !/(?:^|\/)scripts?\//.test(posix)
    && !/\.test\.(?:ts|tsx)$/.test(posix)
    && !/\.spec\.(?:ts|tsx)$/.test(posix);
}

function lineOf(raw: string, idx: number): number {
  return raw.slice(0, idx).split('\n').length;
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
