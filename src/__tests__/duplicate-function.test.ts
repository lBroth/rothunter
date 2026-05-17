import { describe, expect, it } from '@jest/globals';
import { DuplicateFunctionDetector } from '../detectors/duplicate-function.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import type { FunctionStructure, SymbolRecord } from '../types.js';

function makeFn(
  name: string,
  file: string,
  params: Array<[string, string]>,
  returnType: string,
  body: string,
  opts: { async?: boolean; generator?: boolean } = {},
): SymbolRecord {
  const bodyNormalized = body.replace(/\s+/g, ' ').trim();
  const stripped = bodyNormalized
    .replace(/`[^`]*`/g, '`_`')
    .replace(/"[^"]*"/g, '"_"')
    .replace(/'[^']*'/g, "'_'");
  const tokens = stripped
    .replace(/([{}()\[\].,;:?<>=!+\-*/%&|^~])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
  const KEEP = new Set([
    'if', 'else', 'for', 'while', 'return', 'throw', 'try', 'catch', 'await', 'async',
    'const', 'let', 'var', 'new', 'true', 'false', 'null', 'undefined', 'this',
    'string', 'number', 'boolean', 'void', 'Promise', 'Array', 'Map', 'Set',
  ]);
  const anon = tokens.map((t) =>
    /^[A-Za-z_$][\w$]*$/.test(t) && !KEEP.has(t) ? '_' : t,
  );
  const shingles = new Set<string>();
  for (let i = 0; i + 4 <= anon.length; i++) shingles.add(anon.slice(i, i + 4).join(' '));
  if (anon.length < 4) shingles.add(anon.join(' '));
  const structure: FunctionStructure = {
    kind: 'function',
    params: params.map(([n, t]) => ({ name: n, type: t, optional: false, readonly: false })),
    returnType,
    async: opts.async ?? false,
    generator: opts.generator ?? false,
    body,
    bodyNormalized,
    bodyShingles: shingles,
  };
  return {
    id: `${file}#${name}`,
    kind: 'function',
    name,
    file,
    range: { startLine: 1, endLine: 5 },
    source: `function ${name}() {}`,
    exported: true,
    structure,
  };
}

async function runDetector(records: SymbolRecord[]) {
  const norm = new TypeNormalizer();
  const detector = new DuplicateFunctionDetector();
  return detector.run(norm.normalizeAll(records));
}

describe('DuplicateFunctionDetector', () => {
  it('detects strict duplicates across files (same params + same body)', async () => {
    const body = '{ if (value < 0) return -value; return value; }';
    const findings = await runDetector([
      makeFn('absA', 'a.ts', [['value', 'number']], 'number', body),
      makeFn('absB', 'b.ts', [['value', 'number']], 'number', body),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.layer).toBe(1);
    expect(findings[0]?.confidence).toBeCloseTo(0.97);
    expect(findings[0]?.fingerprint).toMatch(/^dup-fn:strict:/);
  });

  it('detects normalized-name duplicates (snake↔camel parameter names)', async () => {
    const body = '{ const ok = order_id.length > 0; return ok; }';
    const bodyCamel = '{ const ok = orderId.length > 0; return ok; }';
    const findings = await runDetector([
      makeFn('processA', 'a.ts', [['order_id', 'string']], 'boolean', body),
      makeFn('processB', 'b.ts', [['orderId', 'string']], 'boolean', bodyCamel),
    ]);
    // Body text differs (order_id vs orderId), so this matches at structural
    // (identifier anonymisation) — same shape, different identifiers.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^dup-fn:(structural|normalized-names):/);
  });

  it('detects structural duplicates with completely renamed identifiers in the body', async () => {
    const findings = await runDetector([
      makeFn(
        'uploadA',
        'a.ts',
        [['bucket', 'string'], ['payload', 'Buffer']],
        'Promise<string>',
        '{ const key = derive(bucket); if (!key) throw new Error("x"); await send(key, payload); return key; }',
      ),
      makeFn(
        'uploadB',
        'b.ts',
        [['folder', 'string'], ['blob', 'Buffer']],
        'Promise<string>',
        '{ const handle = pick(folder); if (!handle) throw new Error("x"); await push(handle, blob); return handle; }',
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^dup-fn:structural:/);
  });

  it('suppresses functions with trivial (very short) bodies', async () => {
    const findings = await runDetector([
      makeFn('a', 'a.ts', [], 'string', '{ return "x"; }'),
      makeFn('b', 'b.ts', [], 'string', '{ return "x"; }'),
    ]);
    // Both bodies are below MIN_BODY_CHARS after normalisation.
    expect(findings).toHaveLength(0);
  });

  it('does NOT cluster two functions whose bodies actually diverge', async () => {
    const findings = await runDetector([
      makeFn(
        'applyTax',
        'a.ts',
        [['amount', 'number'], ['rate', 'number']],
        'number',
        '{ return amount * (1 + rate); }',
      ),
      makeFn(
        'applyDiscount',
        'b.ts',
        [['amount', 'number'], ['rate', 'number']],
        'number',
        '{ return amount * (1 - rate); }',
      ),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('detects near-duplicates with one extra line + a rename (Layer 4 Jaccard)', async () => {
    // Same signature, almost-identical body skeleton: B has one extra guard
    // line. Strict/structural hashes diverge; Layer 4 should catch this.
    const findings = await runDetector([
      makeFn(
        'validateA',
        'a.ts',
        [['input', 'string']],
        'boolean',
        '{ if (!input) return false; const trimmed = input.trim(); return trimmed.length > 0; }',
      ),
      makeFn(
        'validateB',
        'b.ts',
        [['input', 'string']],
        'boolean',
        '{ if (!input) return false; if (typeof input !== "string") return false; const trimmed = input.trim(); return trimmed.length > 0; }',
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^dup-fn:near-duplicate:/);
  });

  it('does NOT cluster identical-skeleton functions whose parameter types differ', async () => {
    const findings = await runDetector([
      makeFn('addNum', 'a.ts', [['a', 'number'], ['b', 'number']], 'number', '{ const s = a + b; return s; }'),
      makeFn('addStr', 'b.ts', [['a', 'string'], ['b', 'string']], 'string', '{ const s = a + b; return s; }'),
    ]);
    expect(findings).toHaveLength(0);
  });
});
