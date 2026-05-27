import type { Finding, SymbolRecord } from '../types.js';
import { stableHash } from '../utils/hash.js';

export interface LongFunctionDetectorInput {
  symbols: ReadonlyArray<SymbolRecord>;
  /** LOW threshold. Default 60 source lines. */
  lowThreshold?: number;
  /** MED threshold. Default 120 source lines. */
  medThreshold?: number;
  /** HIGH threshold. Default 200 source lines. */
  highThreshold?: number;
}

// Flag function symbols over 60 (low) / 120 (med) / 200 (high) lines.
// Test bodies (describe/it/test/suite) skipped.
export function detectLongFunctions(input: LongFunctionDetectorInput): Finding[] {
  const low = input.lowThreshold ?? 60;
  const med = input.medThreshold ?? 120;
  const high = input.highThreshold ?? 200;
  const findings: Finding[] = [];

  for (const sym of input.symbols) {
    if (sym.kind !== 'function') continue;
    if (isTestHarnessName(sym.name)) continue;
    const lines = sym.range.endLine - sym.range.startLine + 1;
    if (lines < low) continue;
    const severity: 'high' | 'medium' | 'low' =
      lines >= high ? 'high' : lines >= med ? 'medium' : 'low';
    findings.push({
      detectorId: 'long-function',
      severity,
      confidence: 0.98,
      layer: 1,
      title: `Long function: \`${sym.name}\` (${lines} lines) in ${sym.file}`,
      description: `\`${sym.name}\` spans ${lines} lines (${sym.range.startLine}–${sym.range.endLine}). Functions this long are hard to test, hard to reason about, and accumulate branching that begs to be flattened (polymorphism, lookup tables, early returns).`,
      evidence: [
        {
          file: sym.file,
          range: { startLine: sym.range.startLine, endLine: sym.range.endLine },
          snippet: firstLines(sym.source, 4),
        },
      ],
      suggestion:
        'Extract one cohesive chunk at a time into a well-named helper. If branching dominates, replace the switch/if chain with a dispatch table keyed by the discriminator.',
      fingerprint: `long-function:${stableHash(`${sym.file}:${sym.name}:${sym.range.startLine}`)}`,
    });
  }
  return findings;
}

const TEST_HARNESS_NAMES = new Set(['describe', 'it', 'test', 'suite', 'context']);

function isTestHarnessName(name: string): boolean {
  return TEST_HARNESS_NAMES.has(name);
}

function firstLines(source: string, n: number): string {
  return source.split('\n').slice(0, n).join('\n');
}
