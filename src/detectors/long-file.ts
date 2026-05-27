import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface LongFileDetectorInput extends FileWalkingDetectorInput {
  /** LOW threshold in non-blank/non-comment lines. Default 400. */
  lowThreshold?: number;
  /** MED threshold. Default 700. */
  medThreshold?: number;
  /** HIGH threshold. Default 1200. */
  highThreshold?: number;
}

// Effective LOC (non-blank, non-pure-comment) over 400 (low) / 700 (med) /
// 1200 (high). Generated + .d.ts excluded.
export function detectLongFiles(input: LongFileDetectorInput): Finding[] {
  const low = input.lowThreshold ?? 400;
  const med = input.medThreshold ?? 700;
  const high = input.highThreshold ?? 1200;
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const findings: Finding[] = [];

  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    const loc = countEffectiveLines(raw);
    if (loc < low) continue;
    const severity: 'high' | 'medium' | 'low' =
      loc >= high ? 'high' : loc >= med ? 'medium' : 'low';
    findings.push({
      detectorId: 'long-file',
      severity,
      confidence: 0.99,
      layer: 1,
      title: `Long file: ${rel} (${loc} LOC)`,
      description: `${loc} non-blank lines of code (excluding pure-comment lines). Files this size are hard to navigate, hard to test, and accumulate unrelated concerns. Common root cause: feature-by-feature additions without periodic refactoring.`,
      evidence: [
        {
          file: rel,
          range: { startLine: 1, endLine: Math.min(raw.split('\n').length, loc) },
          snippet: `// ${rel} — ${loc} effective lines of code`,
        },
      ],
      suggestion:
        'Split the file along its natural concerns (e.g. one class per file, separate I/O from logic, extract pure helpers to a sibling `*-utils.ts`). Use the symbol-graph view to spot internal clusters that are good split candidates.',
      fingerprint: `long-file:${stableHash(rel)}`,
    });
  }
  return findings;
}

function countEffectiveLines(raw: string): number {
  let count = 0;
  let inBlockComment = false;
  for (const line of raw.split('\n')) {
    let t = line.trim();
    if (inBlockComment) {
      const endIdx = t.indexOf('*/');
      if (endIdx === -1) continue;
      inBlockComment = false;
      t = t.slice(endIdx + 2).trim();
    }
    if (t === '') continue;
    // Strip leading block-comment that ends on same line.
    while (t.startsWith('/*')) {
      const endIdx = t.indexOf('*/');
      if (endIdx === -1) {
        inBlockComment = true;
        t = '';
        break;
      }
      t = t.slice(endIdx + 2).trim();
    }
    if (t === '') continue;
    if (t.startsWith('//')) continue;
    if (t.startsWith('*')) continue; // continuation of JSDoc
    count += 1;
  }
  return count;
}

function isAnalysable(file: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file) &&
    !/\.d\.ts$/.test(file) &&
    !/(^|\/)node_modules\//.test(file) &&
    !/(^|\/)dist\//.test(file) &&
    !/\.generated\.(?:ts|js)$/.test(file)
  );
}
