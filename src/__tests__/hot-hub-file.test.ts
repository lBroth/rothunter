import { describe, expect, it } from '@jest/globals';
import { detectHotHubFiles } from '../detectors/hot-hub-file.js';
import type { ImportGraph } from '../graph/import-graph.js';

function graphWith(incoming: Record<string, number>): ImportGraph {
  const incomingMap = new Map<string, Set<string>>();
  for (const [target, count] of Object.entries(incoming)) {
    incomingMap.set(target, new Set(Array.from({ length: count }, (_, i) => `caller${i}.ts`)));
  }
  return { nodes: new Set(), outgoing: new Map(), incoming: incomingMap };
}

describe('hot-hub-file detector', () => {
  it('flags files imported by >= 20 (default)', () => {
    const findings = detectHotHubFiles({
      graph: graphWith({ 'src/utils.ts': 25, 'src/small.ts': 3 }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toMatch(/src\/utils\.ts/);
    expect(findings[0]!.title).toMatch(/25 importers/);
  });

  it('sorts by importer count, caps results', () => {
    const incoming: Record<string, number> = {};
    for (let i = 0; i < 20; i++) incoming[`hub${i}.ts`] = 50 + i;
    const findings = detectHotHubFiles({ graph: graphWith(incoming), maxFindings: 5 });
    expect(findings).toHaveLength(5);
    expect(findings[0]!.title).toMatch(/hub19\.ts/);
  });

  it('respects custom threshold', () => {
    const findings = detectHotHubFiles({
      graph: graphWith({ 'a.ts': 5, 'b.ts': 3 }),
      threshold: 4,
    });
    expect(findings.map((f) => f.title)).toEqual([expect.stringMatching(/a\.ts/)]);
  });
});
