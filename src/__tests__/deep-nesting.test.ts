import { describe, expect, it } from '@jest/globals';
import { detectDeepNesting } from '../detectors/deep-nesting.js';
import type { SymbolRecord } from '../types.js';

function fn(name: string, source: string): SymbolRecord {
  const lines = source.split('\n');
  return {
    id: name,
    kind: 'function',
    name,
    file: 'a.ts',
    range: { startLine: 1, endLine: lines.length },
    source,
    exported: false,
  };
}

describe('deep-nesting detector', () => {
  it('flags nesting depth >= 4 as LOW', () => {
    const src = `function f() {
      if (a) {
        if (b) {
          if (c) {
            if (d) {
              return 1;
            }
          }
        }
      }
    }`;
    const findings = detectDeepNesting({ symbols: [fn('f', src)] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('low');
  });

  it('escalates to MED then HIGH', () => {
    const src5 = "function f() { if(a){ if(b){ if(c){ if(d){ if(e){ x; }}}}} }";
    const src6 = "function f() { if(a){ if(b){ if(c){ if(d){ if(e){ if(g){ x; }}}}}} }";
    const findings = detectDeepNesting({ symbols: [fn('m', src5), fn('h', src6)] });
    expect(findings.find((f) => f.title.startsWith('Deeply nested function: `m`'))!.severity).toBe('medium');
    expect(findings.find((f) => f.title.startsWith('Deeply nested function: `h`'))!.severity).toBe('high');
  });

  it('ignores shallow functions', () => {
    const src = "function f() { if (a) { return 1; } }";
    expect(detectDeepNesting({ symbols: [fn('shallow', src)] })).toEqual([]);
  });

  it('does not count object-literal braces', () => {
    const src = `function f() {
      const o = { a: 1, b: { c: 2 }, d: { e: 3 } };
      return o;
    }`;
    expect(detectDeepNesting({ symbols: [fn('safe', src)] })).toEqual([]);
  });
});
