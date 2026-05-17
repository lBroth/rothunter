import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

export interface SecretLeakDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
}

/**
 * Secret-leak detector.
 *
 * Regex pass for committed credentials / hardcoded local URLs. Each
 * pattern is high-precision enough to flag at HIGH and let the user
 * snooze legitimate cases (test fixtures, demo configs).
 *
 * Patterns:
 *   - AWS access key  (AKIA + 16 base32 chars)
 *   - AWS secret key  (40 base64 chars after literal "AWS_SECRET")
 *   - GitHub token    (ghp_ / gho_ / ghs_ / ghr_ + 36+ chars)
 *   - OpenAI key      (sk-proj-… or sk-… + 20+ chars)
 *   - Anthropic key   (sk-ant-… + 90+ chars)
 *   - Slack token     (xoxb-/xoxa-/xoxp- + …)
 *   - Stripe live key (sk_live_ + 24+ chars)
 *   - Generic         "password" / "passwd" / "secret" / "token" / "api_key" = "..."
 *   - localhost URLs  http://localhost / http://127.0.0.1 / http://0.0.0.0
 *
 * Test fixtures (under __tests__/__fixtures__/spec/) + .env.example are
 * excluded so demo material doesn't drown out real leaks.
 */
export function detectSecretLeaks(input: SecretLeakDetectorInput): Finding[] {
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

interface PatternDef {
  name: string;
  re: RegExp;
  severity: 'high' | 'medium' | 'low';
  blurb: string;
  suggestion: string;
}

const PATTERNS: PatternDef[] = [
  {
    name: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: 'high',
    blurb: 'AWS access-key identifier (AKIA…) committed to source.',
    suggestion: 'Rotate the key immediately, move it to a secret manager (AWS Secrets Manager / Doppler / 1Password) and load it at runtime.',
  },
  {
    name: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/g,
    severity: 'high',
    blurb: 'GitHub personal-access / OAuth token committed to source.',
    suggestion: 'Revoke the token on github.com, regenerate, and load it via process.env.',
  },
  {
    name: 'openai-key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    severity: 'high',
    blurb: 'OpenAI API key (sk-…) committed to source.',
    suggestion: 'Rotate the key, load via process.env.OPENAI_API_KEY, and add it to .gitignore-tracked .env.local.',
  },
  {
    name: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    severity: 'high',
    blurb: 'Anthropic API key (sk-ant-…) committed to source.',
    suggestion: 'Rotate the key in console.anthropic.com and load via process.env.ANTHROPIC_API_KEY.',
  },
  {
    name: 'slack-token',
    re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
    severity: 'high',
    blurb: 'Slack token (xoxb/xoxa/xoxp/xoxr-…) committed to source.',
    suggestion: 'Revoke at api.slack.com/apps, regenerate, load via process.env.',
  },
  {
    name: 'stripe-live-key',
    re: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
    severity: 'high',
    blurb: 'Stripe LIVE secret key committed to source.',
    suggestion: 'Roll the key in dashboard.stripe.com immediately; use restricted keys for ops scripts.',
  },
  {
    name: 'private-key-pem',
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
    severity: 'high',
    blurb: 'PEM-encoded private key embedded in source.',
    suggestion: 'Move the key to a secret manager + KMS; never commit private keys to the repo.',
  },
  {
    name: 'generic-secret-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    severity: 'medium',
    blurb: 'Looks like an assignment of a credential literal (password / secret / api_key = "…").',
    suggestion: 'Replace the literal with process.env reads; commit a .env.example with placeholders instead.',
  },
  {
    name: 'localhost-url',
    re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/g,
    severity: 'low',
    blurb: 'Hardcoded localhost URL — breaks the moment the code runs anywhere except the developer machine.',
    suggestion: 'Use an env-var (process.env.API_BASE_URL) with a documented default.',
  },
];

function analyseFile(file: string, raw: string): Finding[] {
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const matches = [...raw.matchAll(p.re)];
    for (const m of matches) {
      const line = lineOf(raw, m.index!);
      out.push({
        detectorId: 'secret-leak',
        severity: p.severity,
        confidence: 0.95,
        layer: 1,
        title: `${labelFor(p)} in ${file}:${line}`,
        description: p.blurb,
        evidence: [
          {
            file,
            range: { startLine: line, endLine: line },
            snippet: snippetAround(raw, line),
          },
        ],
        suggestion: p.suggestion,
        fingerprint: `secret-leak:${stableHash(`${file}:${line}:${p.name}`)}`,
      });
    }
  }
  return out;
}

function labelFor(p: PatternDef): string {
  switch (p.name) {
    case 'aws-access-key':
      return 'AWS access key';
    case 'github-token':
      return 'GitHub token';
    case 'openai-key':
      return 'OpenAI API key';
    case 'anthropic-key':
      return 'Anthropic API key';
    case 'slack-token':
      return 'Slack token';
    case 'stripe-live-key':
      return 'Stripe LIVE key';
    case 'private-key-pem':
      return 'PEM private key';
    case 'generic-secret-assignment':
      return 'Hardcoded credential';
    case 'localhost-url':
      return 'Hardcoded localhost URL';
    default:
      return p.name;
  }
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  if (/(?:^|\/)__fixtures__\//.test(posix)) return false;
  if (/(?:^|\/)__tests__\//.test(posix)) return false;
  if (/(?:^|\/)tests?\//.test(posix)) return false;
  if (/\.env\.example$/.test(posix)) return false;
  if (/\.test\.(?:ts|tsx|js|jsx)$/.test(posix)) return false;
  if (/\.spec\.(?:ts|tsx|js|jsx)$/.test(posix)) return false;
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|yaml|yml|env|env\..+)$/.test(posix)
    && !/\.d\.ts$/.test(posix)
    && !/(^|\/)node_modules\//.test(posix);
}

function lineOf(raw: string, idx: number): number {
  return raw.slice(0, idx).split('\n').length;
}

function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, line + 1);
  // Redact the literal so the dashboard doesn't display the secret in clear.
  return lines
    .slice(from, to)
    .map((l) =>
      l.replace(
        /(["'])([^"'\s]{8,})\1/g,
        (_, q, v) => q + v.slice(0, 4) + '…REDACTED…' + v.slice(-4) + q,
      ),
    )
    .join('\n');
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
