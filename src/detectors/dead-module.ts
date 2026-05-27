import * as path from 'node:path';
import type { Finding } from '../types.js';
import type { ImportGraph } from '../graph/import-graph.js';
import { stableHash } from '../utils/hash.js';

export interface DeadModuleDetectorInput {
  /** All workspace-relative files parsed in this run. */
  files: ReadonlyArray<string>;
  /** Import graph built from those files. */
  graph: ImportGraph;
  /** Set of entry-point files (workspace-relative). */
  entryPoints: ReadonlySet<string>;
  /** Files reachable from entry points via BFS. */
  reachable: ReadonlySet<string>;
}

// Files not reachable from any entry point + not themselves entry points
// + not .d.ts/ambient. LOW — framework conventions create FPs; mark as FP.
export function detectDeadModules(input: DeadModuleDetectorInput): Finding[] {
  const findings: Finding[] = [];
  for (const file of input.files) {
    if (input.entryPoints.has(file)) continue;
    if (input.reachable.has(file)) continue;
    if (shouldExcludeFromDeadCheck(file)) continue;

    findings.push({
      detectorId: 'dead-module',
      severity: 'low',
      // 0.7 is the post-LLM-confirmation default; deterministic-only this would
      // be higher (1.0 — the file is genuinely unimported) but the LLM is
      // expected to drop borderline framework-handler files below the report
      // threshold. We start in the middle so a no-LLM run still reports.
      confidence: 0.7,
      layer: 1,
      title: `Unused module: ${file}`,
      description: `\`${file}\` is not imported by any other workspace file and is not a known entry point.\nLocations:\n- ${file} (entire file)`,
      evidence: [
        {
          file,
          range: { startLine: 1, endLine: 1 },
          snippet: `// (entire file ${file} appears to have no inbound imports)`,
        },
      ],
      suggestion:
        'If this file is intentionally loaded by convention (framework route, dynamic import, build step), add an entry-point hint or mark this finding as a false positive. Otherwise delete it.',
      fingerprint: `dead-module:${stableHash(file)}`,
    });
  }
  return findings;
}

const ALWAYS_SKIP_PATTERNS: RegExp[] = [
  /\.d\.ts$/, // ambient declarations — consumed via tsconfig, no import edge
  /(^|\/)global\.d\.ts$/,
  /(^|\/)vite-env\.d\.ts$/,
  /(^|\/)next-env\.d\.ts$/,
  /\.story\.tsx?$/,
  /\.stories\.tsx?$/,
];

function shouldExcludeFromDeadCheck(file: string): boolean {
  const posix = file.split(path.sep).join('/');
  return ALWAYS_SKIP_PATTERNS.some((re) => re.test(posix));
}
