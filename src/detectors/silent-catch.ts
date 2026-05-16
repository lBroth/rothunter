import * as crypto from 'node:crypto';
import type { Project } from 'ts-morph';
import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';

export interface SilentCatchDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  /** Optional shared ts-morph Project — source is read from its in-memory cache instead of disk. */
  project?: Project;
}

// try/catch whose body is empty, only console.log/warn/info/debug, or a bare
// return. console.error + rethrow intentional, skipped. MED.
export function detectSilentCatches(input: SilentCatchDetectorInput): Finding[] {
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

const CATCH_RE = /\bcatch\s*(?:\(([^)]*)\))?\s*\{/g;

function analyseFile(file: string, raw: string): Finding[] {
  const out: Finding[] = [];
  for (const match of raw.matchAll(CATCH_RE)) {
    const openBraceIdx = match.index! + match[0].length - 1;
    const closeBraceIdx = findMatchingBrace(raw, openBraceIdx);
    if (closeBraceIdx === -1) continue;
    const body = raw.slice(openBraceIdx + 1, closeBraceIdx);
    const verdict = classifyCatchBody(body);
    if (!verdict) continue;
    const line = lineOf(raw, match.index!);
    const snippet = sliceSnippet(raw, match.index!, closeBraceIdx);
    out.push({
      detectorId: 'silent-catch',
      severity: verdict.severity,
      confidence: 0.85,
      layer: 1,
      title: `Silent catch in ${file}:${line}`,
      description: verdict.blurb,
      evidence: [
        {
          file,
          range: { startLine: line, endLine: lineOf(raw, closeBraceIdx) },
          snippet,
        },
      ],
      suggestion:
        'Either rethrow, route to your error reporter (Sentry/Bugsnag/etc.), or document the deliberate swallow with a comment naming the failure mode you are choosing to ignore.',
      fingerprint: `silent-catch:${stableHash(`${file}:${line}`)}`,
    });
  }
  return out;
}

interface CatchVerdict {
  severity: 'high' | 'medium' | 'low';
  blurb: string;
}

function classifyCatchBody(body: string): CatchVerdict | null {
  const stripped = stripCommentsAndWhitespace(body);
  if (stripped === '') {
    return {
      severity: 'medium',
      blurb: 'The `catch` block is empty — every error inside the corresponding `try` is silently discarded.',
    };
  }
  // Single `return ...` with no operand or literal `null` / `undefined`.
  if (/^return\s*(?:undefined|null)?\s*;?$/.test(stripped)) {
    return {
      severity: 'medium',
      blurb: 'The `catch` block returns silently — the caller cannot distinguish "no result" from "errored out".',
    };
  }
  // Only a console.log/warn/info/debug call (NOT console.error — that's intentional).
  if (/^console\.(log|warn|info|debug)\([^;]*\);?$/.test(stripped)) {
    return {
      severity: 'medium',
      blurb: 'The `catch` block only logs to the console — failures never reach your error reporter or alerting.',
    };
  }
  return null;
}

function stripCommentsAndWhitespace(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findMatchingBrace(raw: string, openIdx: number): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(raw: string, idx: number): number {
  return raw.slice(0, idx).split('\n').length;
}

function sliceSnippet(raw: string, startIdx: number, endIdx: number): string {
  const lines = raw.split('\n');
  const startLine = lineOf(raw, startIdx);
  const endLine = lineOf(raw, endIdx);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine + 1);
  return lines.slice(from, to).join('\n');
}

function isAnalysable(file: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)
    && !/(^|\/)node_modules\//.test(file)
    && !/\.d\.ts$/.test(file);
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
