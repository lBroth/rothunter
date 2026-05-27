import type { Finding } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';
import { isHandlerConventionFile } from '../graph/handler-conventions.js';
import { stableHash } from '../utils/hash.js';

export interface DeadHandlerDetectorInput {
  /** All workspace-relative files parsed in this run. */
  files: ReadonlyArray<string>;
  /** Files referenced by an IaC construct's `entry`/`handler`/routes config. */
  iacEntries: ReadonlySet<string>;
  /** Import records — used to know if a file is statically/dynamically imported. */
  imports: ReadonlyArray<ImportRecord>;
}

// Files in handler-convention dirs (src/handlers, src/lambdas, …) that are
// neither IaC-referenced nor imported anywhere. Confidence 0.65 (runtime
// config-file wiring is invisible to ts-morph).
export function detectDeadHandlers(input: DeadHandlerDetectorInput): Finding[] {
  const importedTargets = new Set<string>();
  for (const imp of input.imports) {
    if (imp.target) importedTargets.add(imp.target);
  }

  const findings: Finding[] = [];
  for (const file of input.files) {
    if (!isHandlerConventionFile(file)) continue;
    if (input.iacEntries.has(file)) continue;
    if (importedTargets.has(file)) continue;
    findings.push({
      detectorId: 'dead-handler',
      severity: 'low',
      confidence: 0.65,
      layer: 1,
      title: `Handler with no IaC wiring: ${file}`,
      description: `\`${file}\` lives in a handler-convention directory but no CDK / SST / Serverless-framework construct references its path, and no other file imports it.\nLocations:\n- ${file} (entire file)`,
      evidence: [
        {
          file,
          range: { startLine: 1, endLine: 1 },
          snippet: `// (no IaC reference and no inbound import for ${file})`,
        },
      ],
      suggestion:
        'If this handler is wired by a non-TypeScript config (`serverless.yml`, `sam.template.yaml`, runtime path string), mark this finding as a false positive. Otherwise it is dead infrastructure — wire it or remove the file.',
      fingerprint: `dead-handler:${stableHash(file)}`,
    });
  }
  return findings;
}
