import * as crypto from 'node:crypto';
import type { ImportGraph } from '../graph/import-graph.js';
import type { Finding } from '../types.js';

export interface HotHubFileDetectorInput {
  graph: ImportGraph;
  /** Threshold for incoming-import count. Default 20. */
  threshold?: number;
  /** Max findings to emit. Default 10 (this is an INFO signal, not a buglist). */
  maxFindings?: number;
}

/**
 * Hot-hub-file detector.
 *
 * Surfaces files imported by an unusually large number of other files in
 * the workspace. These "import hubs" are often:
 *   - barrel files that re-export everything from a folder,
 *   - shared utility modules that have outgrown their original scope,
 *   - dependency-graph chokepoints that any local change touches.
 *
 * INFO severity by design — being a hub is not inherently bad, but it's
 * useful to know when planning a refactor (changing the hub touches
 * everyone) or hunting build-time bottlenecks.
 */
export function detectHotHubFiles(input: HotHubFileDetectorInput): Finding[] {
  const threshold = input.threshold ?? 20;
  const maxFindings = input.maxFindings ?? 10;
  const ranked = [...input.graph.incoming.entries()]
    .map(([file, callers]) => ({ file, count: callers.size }))
    .filter((x) => x.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxFindings);
  return ranked.map(({ file, count }) => ({
    detectorId: 'hot-hub-file',
    severity: 'low',
    confidence: 1,
    layer: 1,
    title: `Import hub: ${file} (${count} importers)`,
    description:
      `\`${file}\` is imported by ${count} other files. Hubs concentrate change-blast-radius — every refactor of this file ripples across the whole workspace.`,
    evidence: [
      {
        file,
        range: { startLine: 1, endLine: 1 },
        snippet: `// ${file} — imported by ${count} files`,
      },
    ],
    suggestion:
      'If this is a barrel re-export, consider deleting it and asking importers to use the original module — barrels confuse tree-shaking and slow incremental builds. If it is a utility module, split it along its natural responsibilities.',
    fingerprint: `hot-hub-file:${stableHash(file)}`,
  }));
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
