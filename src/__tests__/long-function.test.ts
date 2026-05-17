import { describe, expect, it } from '@jest/globals';
import { detectLongFunctions } from '../detectors/long-function.js';
import type { SymbolRecord } from '../types.js';

function fn(name: string, startLine: number, endLine: number): SymbolRecord {
  return {
    id: `${name}-${startLine}`,
    kind: 'function',
    name,
    file: 'a.ts',
    range: { startLine, endLine },
    source: Array.from({ length: endLine - startLine + 1 }, () => 'body').join('\n'),
    exported: false,
  };
}

describe('long-function detector', () => {
  it('flags functions over LOW threshold (>= 60 lines)', () => {
    const findings = detectLongFunctions({ symbols: [fn('a', 1, 80)] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('low');
  });

  it('flags MED at >= 120, HIGH at >= 200', () => {
    const findings = detectLongFunctions({ symbols: [fn('m', 1, 140), fn('h', 1, 250)] });
    expect(findings.map((f) => f.severity).sort()).toEqual(['high', 'medium']);
  });

  it('ignores short functions', () => {
    expect(detectLongFunctions({ symbols: [fn('short', 1, 30)] })).toEqual([]);
  });

  it('ignores test-harness names (describe/it/test/suite)', () => {
    const findings = detectLongFunctions({
      symbols: [fn('describe', 1, 500), fn('it', 1, 300), fn('userCode', 1, 80)],
    });
    expect(findings.map((f) => f.title)).toEqual([expect.stringMatching(/userCode/)]);
  });

  it('honors custom thresholds', () => {
    const findings = detectLongFunctions({
      symbols: [fn('small', 1, 20)],
      lowThreshold: 10,
      medThreshold: 15,
      highThreshold: 18,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
  });

  it('produces stable fingerprints', () => {
    const a = detectLongFunctions({ symbols: [fn('a', 1, 80)] });
    const b = detectLongFunctions({ symbols: [fn('a', 1, 80)] });
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });
});
