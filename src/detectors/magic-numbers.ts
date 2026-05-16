import * as crypto from 'node:crypto';
import type { Project } from 'ts-morph';
import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';

export interface MagicNumbersDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  /** Numbers considered "obvious" and not magic. Default `{0, 1, -1, 2, 10, 100, 1000}`. */
  whitelist?: ReadonlySet<number>;
  /** Per-file finding cap so a single noisy file doesn't dominate the report. Default 5. */
  perFileCap?: number;
  /** Optional shared ts-morph Project — source is read from its in-memory cache instead of disk. */
  project?: Project;
}

// Numeric literals outside the whitelist {0,1,-1,2,10,100,1000}. Skip
// array indices, for-loop bounds, named-const declarations. LOW, per-file cap.
export function detectMagicNumbers(input: MagicNumbersDetectorInput): Finding[] {
  const whitelist = input.whitelist ?? DEFAULT_WHITELIST;
  const cap = input.perFileCap ?? 5;
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const findings: Finding[] = [];
  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
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
    const positive = parseFloat(m[1]!);
    const before = masked.slice(Math.max(0, m.index! - 30), m.index!);
    // Distinguish UNARY minus (`-3`, `[-3]`, `f(-3)`, `return -3`) from
    // BINARY subtraction (`x - 3`). Unary triggers when the char before
    // the `-` is start-of-string, opening punctuation, a comma, an
    // operator/comparison, or a `:=` assignment. Identifier or closing-
    // bracket before `-` means subtraction → keep the value positive.
    const unaryMinus = /(?:^|[=([{,;:?+\-*/%&|^!<>~]|\b(?:return|typeof|in|of|case|delete|void|throw|yield|await|new)\b)\s*-\s*$/.test(before);
    const value = unaryMinus ? -positive : positive;
    if (whitelist.has(value)) continue;
    // Skip if the literal is being assigned to a constant (declaration site).
    if (/\b(?:const|let|var|enum|readonly)\s+[A-Z_][A-Z0-9_]*\s*[:=]\s*-?\s*$/.test(before)) continue;
    if (/\b(?:const|let|var)\s+\w+\s*[:=]\s*-?\s*$/.test(before)) continue;
    // Skip array indices (preceded by `[`).
    if (/\[\s*-?\s*$/.test(before)) continue;
    // Skip enum members.
    if (/=\s*-?\s*$/.test(before) && /\benum\b/.test(masked.slice(Math.max(0, m.index! - 200), m.index!))) continue;
    // Skip exponents (e.g. 1e-3 or 1e+3 — the `3` should not be flagged).
    if (/e[+-]?$/i.test(before)) continue;
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
    && !/\.spec\.(?:ts|tsx)$/.test(posix)
    // Tool config files are mostly threshold / timeout / port numbers
    // by design — flagging every coverage threshold + chunk-size limit
    // as a magic number is noise. Skip the common tooling configs.
    && !/(?:^|\/)(?:vite|vitest|jest|rollup|webpack|esbuild|tsup|playwright|cypress|drizzle|next|nuxt|astro|svelte|remix|tailwind|postcss|prettier|eslint|biome|babel|rome|tsdown|tsconfig\.[^/]*)\.config\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(posix)
    && !/(?:^|\/)\.?(?:eslint|prettier|stylelint)rc(?:\.[^/]+)?$/.test(posix);
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
