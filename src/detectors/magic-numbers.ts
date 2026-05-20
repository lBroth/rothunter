import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface MagicNumbersDetectorInput extends FileWalkingDetectorInput {
/** Numbers considered "obvious" and not magic. Default `{0, 1, -1, 2, 10, 100, 1000}`. */
  whitelist?: ReadonlySet<number>;
  /** Per-file finding cap so a single noisy file doesn't dominate the report. Default 5. */
  perFileCap?: number;
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

// Default whitelist. Includes the obvious math constants (0/1/-1/2),
// common round numbers (10/100/1000), AND bit-width / byte-size
// constants (8/16/24/32/64/128/256). Encoder/decoder code (base64,
// chunking, hashing, network parsing) is otherwise flooded with FPs:
// `Math.floor(byteLength / 9 * 8)` and friends are domain math, not
// magic numbers. Add 512/1024/4096 too — they're page/buffer sizes
// every reader recognises at a glance.
const DEFAULT_WHITELIST: ReadonlySet<number> = new Set([
  0, 1, -1, 2,
  10, 100, 1000,
  8, 16, 24, 32, 64, 128, 256, 512, 1024, 4096,
]);
// Match positive integer literals (we treat negatives via the previous char).
const NUM_RE = /\b(\d+(?:\.\d+)?)\b/g;

function analyseFile(file: string, raw: string, whitelist: ReadonlySet<number>, cap: number): Finding[] {
  const out: Finding[] = [];
  // Pre-strip strings + comments AND regex literals so literals inside
  // them aren't flagged. Regex masking matters a lot: `[A-Za-z0-9]` flags
  // 9, `\d{15}` flags 15, `\d{1,3}` flags 3, etc. Those are charset/
  // quantifier internals, not magic numbers.
  const masked = maskStringsAndComments(raw);
  for (const m of masked.matchAll(NUM_RE)) {
    if (out.length >= cap) break;
    const positive = parseFloat(m[1]!);
    const before = masked.slice(Math.max(0, m.index! - 30), m.index!);
    const after = masked.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
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
    // Skip HTTP status code idioms — `reply.code(502)`, `res.status(404)`,
    // `.code(401).send(...)`, `throw new HttpError(500, ...)`. The method
    // name IS the named constant in framework code; introducing a
    // `HTTP_BAD_GATEWAY = 502` const adds friction without clarity.
    if (/\.(?:code|status|statusCode|sendStatus)\s*\(\s*-?\s*$/.test(before) && value >= 100 && value < 600) continue;
    // Skip HTTP success/error-tier range checks: `if (status < 200 ||
    // status >= 300)` and friends. The 200/300/400/500 boundaries are
    // textbook HTTP semantics; flagging them invites the reader to
    // invent names that read worse than the literal.
    if (
      value >= 100 && value < 600 && value % 100 === 0 &&
      /(?:<=?|>=?|===?|!==?)\s*$/.test(before) &&
      /\b(?:status|statusCode|httpStatus|http_status|code)\b/.test(lineAround(masked, m.index!))
    ) continue;
    // Skip elements of `new Set([...])` / `new Map([...])` / array literal
    // bound to a named const. The CONST NAME documents what each value
    // represents (`RETRYABLE_HTTP`, `ALLOWED_PORTS`, …) — naming each
    // element individually is busywork.
    if (insideNamedConstCollection(masked, m.index!)) continue;
    // Skip `key: NUMBER,` inside object literals when the value is a
    // bare literal (no expression). `confidence: 0.95,` / `timeoutMs:
    // 1500,` style — the KEY names the magic. Same effective semantics
    // as `const KEY = NUMBER`. Tight bounds avoid catching subtraction.
    if (
      /[:=]\s*-?\s*$/.test(before) &&
      /^\s*-?\s*[,;)}\]\n]/.test(after) &&
      !/\b(?:return|throw|case|new)\b\s*-?\s*$/.test(before)
    ) {
      continue;
    }
    const line = lineOf(raw, m.index!);
    if (hasIgnoreAnnotation(raw, line, 'magic-numbers')) continue;
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
  let inRegex = false;
  let inRegexClass = false;
  // Track the previous non-whitespace masked-output character so we can
  // disambiguate `/` as regex-start vs division. After punctuation /
  // keywords a `/` opens a regex; after an identifier or closing bracket
  // it is division.
  let prevSig = '';
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
        prevSig = c;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inRegex) {
      // Mask everything inside the regex body so the numeric scanner sees
      // no digits. Track `[…]` character classes only to know when the
      // regex actually ends (slash inside class does not terminate).
      if (c === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (c === '[' && !inRegexClass) inRegexClass = true;
      else if (c === ']' && inRegexClass) inRegexClass = false;
      if (c === '/' && !inRegexClass) {
        inRegex = false;
        out += c;
        prevSig = c;
        // Consume trailing flags (g, i, m, s, u, y, d) so they cannot be
        // misread as identifiers in lookback.
        while (i + 1 < raw.length && /[gimsuyd]/.test(raw[i + 1] ?? '')) {
          out += ' ';
          i++;
        }
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
    if (c === '/' && canStartRegexAfter(prevSig)) {
      inRegex = true;
      inRegexClass = false;
      out += c;
      prevSig = c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      prevSig = c;
      continue;
    }
    out += c;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prevSig = c;
  }
  return out;
}

/**
 * Decide whether a `/` is the start of a regex literal (vs division)
 * based on the previous non-whitespace character. After punctuation,
 * an opening bracket / paren / brace, a comma, a return-like keyword,
 * or an operator a slash starts a regex. After an identifier char or
 * closing bracket it's division.
 */
function canStartRegexAfter(prev: string): boolean {
  if (prev === '') return true;
  return /[=(,;:?{[+\-*/%&|^!<>~]/.test(prev);
}

/**
 * Detect whether a numeric literal at `idx` sits inside a collection
 * literal (`new Set([…])`, `new Map([…])`, plain `[…]`) bound to a
 * named const declared earlier on the same logical statement. The
 * collection name documents each element — `RETRYABLE_HTTP = new Set
 * ([408, 425, 429, …])` does not need every literal extracted to its
 * own const.
 *
 * Walks backwards from `idx` counting `[` / `]` / `(` / `)` to find the
 * enclosing bracket open, then checks whether the chunk between the
 * preceding `=` and the bracket looks like a collection constructor or
 * a bare array literal.
 */
function insideNamedConstCollection(masked: string, idx: number): boolean {
  let depthSq = 0;
  let depthPar = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = masked[i]!;
    if (c === ']') depthSq++;
    else if (c === '[') {
      if (depthSq === 0) {
        // Found the enclosing array open. Look back for `=` to find the
        // assignment target.
        const lhs = masked.slice(Math.max(0, i - 200), i);
        const eq = lhs.lastIndexOf('=');
        if (eq === -1) return false;
        const declHead = lhs.slice(Math.max(0, eq - 80), eq);
        if (!/\b(?:const|let|var|readonly)\s+\w+/.test(declHead)) return false;
        const between = lhs.slice(eq + 1).trim();
        // Bracket directly follows `=` (bare array) OR follows
        // `new Set(` / `new Map(` / `new Array(` / `new Uint8Array(`
        // etc. The trailing `(` is part of the constructor call —
        // `new Set([...])` has the array inside the call parens.
        if (between === '' || /\bnew\s+\w+\s*\(?\s*$/.test(between)) return true;
        return false;
      }
      depthSq--;
    } else if (c === ')') depthPar++;
    else if (c === '(') {
      if (depthPar === 0) return false;
      depthPar--;
    } else if (c === ';' && depthSq === 0 && depthPar === 0) {
      return false;
    }
  }
  return false;
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

function lineAround(raw: string, idx: number): string {
  const start = raw.lastIndexOf('\n', idx) + 1;
  let end = raw.indexOf('\n', idx);
  if (end === -1) end = raw.length;
  return raw.slice(start, end);
}

function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}

