import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

export interface ConsoleLogProdDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
}

/**
 * Console-log-in-production detector.
 *
 * Flags `console.log` / `console.debug` / `console.info` calls in
 * non-test source. `console.warn` / `console.error` are intentional
 * (real error reporting) and never flagged.
 *
 * Severity LOW: high-volume but mostly aesthetic. Useful as a "you forgot
 * a debug statement" sanity sweep before merging.
 */
export function detectConsoleLogsInProd(input: ConsoleLogProdDetectorInput): Finding[] {
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

const LOG_RE = /\bconsole\.(log|debug|info)\s*\(/g;

function analyseFile(file: string, raw: string): Finding[] {
  const out: Finding[] = [];
  for (const m of raw.matchAll(LOG_RE)) {
    const line = lineOf(raw, m.index!);
    // Skip if the call is inside a line comment.
    const lineText = lineAt(raw, line);
    if (/^\s*\/\//.test(lineText)) continue;
    out.push({
      detectorId: 'console-log-prod',
      severity: 'low',
      confidence: 0.9,
      layer: 1,
      title: `console.${m[1]} in ${file}:${line}`,
      description: `\`console.${m[1]}\` leaks to stdout in production. Loggers configured for severity, redaction, or sampling do not see this output, and CI / serverless / browser consoles pollute with debug noise.`,
      evidence: [
        {
          file,
          range: { startLine: line, endLine: line },
          snippet: snippetAround(raw, line),
        },
      ],
      suggestion:
        'Route through the project logger (pino / winston / debug / your custom one). For temporary debugging, gate behind `if (process.env.DEBUG)` or remove before merging.',
      fingerprint: `console-log-prod:${stableHash(`${file}:${line}:${m[1]}`)}`,
    });
  }
  return out;
}

function lineAt(raw: string, line: number): string {
  return raw.split('\n')[line - 1] ?? '';
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(posix)
    && !/\.d\.ts$/.test(posix)
    && !/(^|\/)node_modules\//.test(posix)
    && !/(?:^|\/)__tests__\//.test(posix)
    && !/(?:^|\/)tests?\//.test(posix)
    && !/(?:^|\/)scripts?\//.test(posix)
    && !/\.test\.(?:ts|tsx|js|jsx)$/.test(posix)
    && !/\.spec\.(?:ts|tsx|js|jsx)$/.test(posix);
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
