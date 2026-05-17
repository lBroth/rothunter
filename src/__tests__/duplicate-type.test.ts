import { describe, expect, it } from '@jest/globals';
import { DuplicateTypeDetector } from '../detectors/duplicate-type.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import type { SymbolRecord } from '../types.js';

function makeRecord(
  name: string,
  file: string,
  fields: Array<[string, string, { optional?: boolean }?]>,
): SymbolRecord {
  return {
    id: `${file}#${name}`,
    kind: 'interface',
    name,
    file,
    range: { startLine: 1, endLine: 2 },
    source: `interface ${name} {}`,
    exported: true,
    structure: {
      kind: 'object',
      fields: fields.map(([n, t, o]) => ({
        name: n,
        type: t,
        optional: o?.optional ?? false,
        readonly: false,
      })),
    },
  };
}

function runDetector(records: SymbolRecord[]) {
  const norm = new TypeNormalizer();
  const detector = new DuplicateTypeDetector();
  return detector.run(norm.normalizeAll(records));
}

describe('DuplicateTypeDetector', () => {
  it('detects strict duplicates across files (layer 1a, confidence 1.0)', async () => {
    const findings = await runDetector([
      makeRecord('UserA', 'a.ts', [
        ['id', 'string'],
        ['email', 'string'],
      ]),
      makeRecord('UserB', 'b.ts', [
        ['id', 'string'],
        ['email', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.layer).toBe(1);
    expect(findings[0]?.confidence).toBeCloseTo(1.0);
    expect(findings[0]?.fingerprint).toMatch(/^dup-type:strict:/);
  });

  it('detects normalized-name duplicates (layer 2, confidence 0.75) for snake↔camel pairs', async () => {
    const findings = await runDetector([
      makeRecord('AccountSnake', 'a.ts', [
        ['user_id', 'string'],
        ['full_name', 'string'],
        ['created_on', 'string'],
        ['mail', 'string'],
      ]),
      makeRecord('AccountCamel', 'b.ts', [
        ['uid', 'string'],
        ['fullName', 'string'],
        ['createdAt', 'string'],
        ['email', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.layer).toBe(2);
    expect(findings[0]?.fingerprint).toMatch(/^dup-type:normalized-names:/);
  });

  it('detects anonymous structural duplicates (layer 1b, confidence 0.85)', async () => {
    const findings = await runDetector([
      makeRecord('OrderRecord', 'a.ts', [
        ['orderId', 'string'],
        ['amount', 'number'],
        ['paid', 'boolean'],
        ['retries', 'number'],
        ['placedAt', 'string'],
      ]),
      makeRecord('InvoiceDocument', 'b.ts', [
        ['invoiceNumber', 'string'],
        ['total', 'number'],
        ['settled', 'boolean'],
        ['attempts', 'number'],
        ['issuedAt', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^dup-type:structural:/);
    expect(findings[0]?.confidence).toBeCloseTo(0.85);
  });

  it('suppresses structural matches with fewer than 4 fields', async () => {
    const findings = await runDetector([
      makeRecord('A', 'a.ts', [
        ['x', 'number'],
        ['y', 'number'],
        ['label', 'string'],
      ]),
      makeRecord('B', 'b.ts', [
        ['start', 'number'],
        ['end', 'number'],
        ['reason', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('suppresses structural matches that are monotype primitive (all-string, all-number)', async () => {
    const findings = await runDetector([
      makeRecord('A', 'a.ts', [
        ['s1', 'string'],
        ['s2', 'string'],
        ['s3', 'string'],
        ['s4', 'string'],
      ]),
      makeRecord('B', 'b.ts', [
        ['t1', 'string'],
        ['t2', 'string'],
        ['t3', 'string'],
        ['t4', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('skips clusters of size 2 that live in a single file', async () => {
    const findings = await runDetector([
      makeRecord('A', 'same.ts', [
        ['id', 'string'],
        ['name', 'string'],
      ]),
      makeRecord('B', 'same.ts', [
        ['id', 'string'],
        ['name', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does NOT collide a method-bearing interface with a property-only one of the same property names (parser-fix regression)', async () => {
    const findings = await runDetector([
      makeRecord('Processor', 'a.ts', [
        ['id', 'string'],
        ['name', 'string'],
        ['()process', '(input:string)=>Promise<string>'],
      ]),
      makeRecord('Document', 'b.ts', [
        ['id', 'string'],
        ['name', 'string'],
      ]),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does NOT collide methods with diverging parameter types', async () => {
    const findings = await runDetector([
      makeRecord('A', 'a.ts', [
        ['id', 'string'],
        ['()process', '(input:string)=>Promise<string>'],
      ]),
      makeRecord('B', 'b.ts', [
        ['id', 'string'],
        ['()process', '(input:number)=>Promise<string>'],
      ]),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('prefers normalized-names layer when names also align (layer 2 runs before structural 1b)', async () => {
    // Both interfaces have identical primitive layouts AND normalized names — Layer 2
    // should claim them first so the more informative fingerprint wins.
    const findings = await runDetector([
      makeRecord('KebabCase', 'a.ts', [
        ['max-retries', 'number'],
        ['base-url', 'string'],
        ['enable-cache', 'boolean'],
        ['timeout-ms', 'number'],
      ]),
      makeRecord('CamelCase', 'b.ts', [
        ['maxRetries', 'number'],
        ['baseUrl', 'string'],
        ['enableCache', 'boolean'],
        ['timeoutMs', 'number'],
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^dup-type:normalized-names:/);
  });
});
