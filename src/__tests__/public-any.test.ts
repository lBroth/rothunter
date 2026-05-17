import { describe, expect, it } from '@jest/globals';
import { detectPublicAny } from '../detectors/public-any.js';
import type { SymbolRecord, FunctionStructure } from '../types.js';

function fn(
  name: string,
  exported: boolean,
  params: Array<{ name: string; type: string }>,
  returnType: string,
): SymbolRecord {
  const structure: FunctionStructure = {
    kind: 'function',
    params: params.map((p) => ({ name: p.name, type: p.type, optional: false, readonly: false })),
    returnType,
    async: false,
    generator: false,
    body: '{}',
    bodyNormalized: '{}',
    bodyShingles: new Set(),
  };
  return {
    id: name,
    kind: 'function',
    name,
    file: 'a.ts',
    range: { startLine: 1, endLine: 1 },
    source: `function ${name}() {}`,
    exported,
    structure,
  };
}

describe('public-any detector', () => {
  it('flags exported function with any param', () => {
    const findings = detectPublicAny({
      symbols: [fn('f', true, [{ name: 'x', type: 'any' }], 'void')],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
  });

  it('flags exported function with any return type', () => {
    const findings = detectPublicAny({
      symbols: [fn('f', true, [{ name: 'x', type: 'string' }], 'any')],
    });
    expect(findings).toHaveLength(1);
  });

  it('does NOT flag unexported functions', () => {
    expect(
      detectPublicAny({
        symbols: [fn('f', false, [{ name: 'x', type: 'any' }], 'any')],
      }),
    ).toEqual([]);
  });

  it('does NOT flag unknown', () => {
    expect(
      detectPublicAny({
        symbols: [fn('f', true, [{ name: 'x', type: 'unknown' }], 'unknown')],
      }),
    ).toEqual([]);
  });

  it('flags nested any inside generics', () => {
    const findings = detectPublicAny({
      symbols: [fn('f', true, [{ name: 'x', type: 'Record<string, any>' }], 'Promise<any>')],
    });
    expect(findings).toHaveLength(1);
  });

  it('does NOT match identifiers like `Many` or `anyway`', () => {
    expect(
      detectPublicAny({
        symbols: [fn('f', true, [{ name: 'x', type: 'Many' }], 'Anyway')],
      }),
    ).toEqual([]);
  });
});
