import type { ImportGraph } from '../graph/import-graph.js';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';

export interface HotHubFileDetectorInput {
  graph: ImportGraph;
  /** Threshold for incoming-import count. Default 20. */
  threshold?: number;
  /** Max findings to emit. Default 10 (this is an INFO signal, not a buglist). */
  maxFindings?: number;
}

// Files imported by >threshold others — refactor blast-radius signal. INFO.
//
// TODO(under-implemented): minimal detector compared to peers. Open items:
//   1. Threshold tuning — current 20 is a static guess. Should scale with
//      workspace size (e.g. p95 of incoming-import distribution + bonus
//      for files with no outgoing imports → pure leaf hubs are worst).
//   2. Severity scaling — currently always 'low'. Bump to 'medium' at
//      2x threshold, 'high' at 4x (a barrel re-export pulled by 100 files
//      is a much bigger blast radius than one pulled by 21).
//   3. Suggestion enrichment — detect barrel-export shape (file body is
//      mostly `export { … } from './x'`) and tailor the suggestion
//      (delete the barrel) vs utility-module shape (suggest splitting).
//   4. Per-workspace blast-radius — in multi-workspace mode, weight by
//      how many workspaces import the file, not just file count.
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

