import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSimilarFunctions } from '../detectors/similar-functions.js';
import type { SymbolRecord, FunctionStructure } from '../types.js';

function shingles(text: string): Set<string> {
  // Light token shingles for tests — enough to give Jaccard meaningful weight.
  const tokens = text
    .replace(/[\s\n]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(tokens[i]! + ' ' + tokens[i + 1]!);
  }
  if (tokens.length === 1) out.add(tokens[0]!);
  return out;
}

function fn(name: string, file: string, body: string, params: string[] = []): SymbolRecord {
  const fnLike: FunctionStructure = {
    kind: 'function',
    params: params.map((n) => ({ name: n, type: 'string', optional: false, readonly: false })),
    returnType: 'void',
    async: false,
    generator: false,
    body,
    bodyNormalized: body,
    bodyShingles: shingles(body),
  };
  const lines = body.split('\n');
  return {
    id: `${file}:${name}`,
    kind: 'function',
    name,
    file,
    range: { startLine: 1, endLine: Math.max(3, lines.length) },
    source: `function ${name}() ${body}`,
    exported: true,
    structure: fnLike,
  };
}

describe('similar-functions detector', () => {
  it('clusters camelCase variants with similar bodies', () => {
    // getDbConnection ↔ databaseConnection ↔ getDatabase share "db"+"connection"
    // tokens, and their bodies share most shingles.
    const body = 'open pool client config await pool query db connection result return result';
    const symbols = [
      fn('getDbConnection', 'src/a.ts', body),
      fn('databaseConnection', 'src/b.ts', body + ' extra log'),
      fn('getDatabaseConnection', 'src/c.ts', body + ' extra retry'),
      fn('unrelatedHelper', 'src/x.ts', 'compute totals from invoices stream'),
    ];
    const findings = detectSimilarFunctions({
      workspaceRoot: process.cwd(),
      symbols,
      similarityThreshold: 0.3,
      minLines: 1,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.length).toBe(3);
    expect(findings[0]!.title).toMatch(/getDbConnection|databaseConnection|getDatabaseConnection/);
  });

  it('does NOT cluster unrelated functions', () => {
    const findings = detectSimilarFunctions({
      workspaceRoot: process.cwd(),
      symbols: [
        fn('parseInvoice', 'a.ts', 'extract lines from pdf return invoice'),
        fn('renderButton', 'b.ts', 'jsx onClick callback render component'),
      ],
      similarityThreshold: 0.3,
      minLines: 1,
    });
    expect(findings).toEqual([]);
  });

  it('picks the largest body as canonical when git is unavailable', () => {
    // Tmp dir without .git → lastTouched returns null for everything,
    // tie-break falls through to bodyLines / arity.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-sf-'));
    try {
      const small = fn('parseUser', 'a.ts', 'parse name email return user');
      // Force b.ts to span more lines than a.ts so the body-size tie-break wins.
      const big = fn(
        'parseUserPayload',
        'b.ts',
        'parse name email role org return user with extras and validation',
      );
      big.range = { startLine: 1, endLine: 25 };
      const findings = detectSimilarFunctions({
        workspaceRoot: root,
        symbols: [small, big],
        similarityThreshold: 0.3,
        minLines: 1,
      });
      expect(findings).toHaveLength(1);
      // The larger body is on b.ts → it should appear as the canonical
      // pick in the description.
      expect(findings[0]!.description).toMatch(/Canonical pick.*parseUserPayload/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('proposes npm-package extraction when cluster spans multiple directories', () => {
    const body = 'fetch retry backoff parse json return data';
    const findings = detectSimilarFunctions({
      workspaceRoot: process.cwd(),
      symbols: [
        fn('fetchWithRetry', 'src/api/a.ts', body),
        fn('retryFetch', 'src/services/b.ts', body),
      ],
      similarityThreshold: 0.3,
      minLines: 1,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.suggestion).toMatch(/shared package|npm package/);
  });

  it('ignores tiny stubs below minLines', () => {
    const symbols = [
      fn('a', 'a.ts', 'x'),
      fn('a', 'b.ts', 'x'),
    ];
    const findings = detectSimilarFunctions({
      workspaceRoot: process.cwd(),
      symbols,
      similarityThreshold: 0.1,
      minLines: 5,
    });
    expect(findings).toEqual([]);
  });

  it('honors the similarity threshold knob', () => {
    const body = 'parse json return data';
    const symbols = [
      fn('foo', 'a.ts', body),
      fn('bar', 'b.ts', body + ' tweak'),
    ];
    // Same bodies, very different names — combined score is dragged down
    // by name component but body still pushes it through at low threshold.
    const lax = detectSimilarFunctions({ workspaceRoot: process.cwd(), symbols, similarityThreshold: 0.4, minLines: 1 });
    const strict = detectSimilarFunctions({ workspaceRoot: process.cwd(), symbols, similarityThreshold: 0.9, minLines: 1 });
    expect(lax.length).toBeGreaterThanOrEqual(1);
    expect(strict).toEqual([]);
  });
});
