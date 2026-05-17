import * as crypto from 'node:crypto';
import type { Finding } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';
import { isHandlerConventionFile } from '../graph/handler-conventions.js';

export interface DeadHandlerDetectorInput {
  /** All workspace-relative files parsed in this run. */
  files: ReadonlyArray<string>;
  /** Files referenced by an IaC construct's `entry`/`handler`/routes config. */
  iacEntries: ReadonlySet<string>;
  /** Import records — used to know if a file is statically/dynamically imported. */
  imports: ReadonlyArray<ImportRecord>;
}

/**
 * Surface handler files that look like they should be wired by IaC (live in
 * `src/handlers/`, `src/lambdas/`, `netlify/functions/`, …) but are NOT
 * referenced by any IaC construct AND are not imported anywhere.
 *
 * The detector is intentionally precise — handler files matched by the
 * entry-points heuristic are *protected* from dead-module, which keeps
 * dead-module's precision high. This detector inverts that: it asks
 * "fine, the file is in a handler dir, but is it actually wired?".
 *
 * False-positive control:
 *   - Only fires on the handler-convention pattern (not on Next.js, Vercel
 *     /api, Cloudflare workers — those are wired by filesystem convention,
 *     no IaC needed).
 *   - Skips files referenced by any IaC entry string the iac-entries walker
 *     resolved (`entry`, `handler`, `code`, `routes: ...`).
 *   - Skips files imported (statically or dynamically) by any other file.
 *   - Confidence 0.65 — runtime may load handlers via a path defined in a
 *     config file (`serverless.yml`, `sam.template.yaml`) that ts-morph
 *     does not parse. The dashboard / .rothunterignore handles that tail.
 */
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
        'If this handler is wired by a non-TypeScript config (`serverless.yml`, `sam.template.yaml`, runtime path string), snooze the fingerprint. Otherwise it is dead infrastructure — wire it or remove the file.',
      fingerprint: `dead-handler:${stableHash(file)}`,
    });
  }
  return findings;
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
