import * as crypto from 'node:crypto';
import type { Finding, SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';

export interface DeadApiDetectorInput {
  /** Symbols from every linked workspace. `exported` set, `workspace` set. */
  symbols: ReadonlyArray<SymbolRecord>;
  /** Imports from every linked workspace, with `sourceWorkspace` + optional `targetWorkspace`. */
  imports: ReadonlyArray<ImportRecord>;
}

// Cross-workspace dead-API: exported symbol with no consumer in any
// OTHER workspace. Intra-workspace use intentionally ignored (dead-export
// covers that). Severity low — external dependents are invisible.
export function detectDeadApis(input: DeadApiDetectorInput): Finding[] {
  // Per-target consumed name sets across workspace boundaries.
  const crossConsumed = new Map<string, Set<string>>();
  const crossNamespace = new Set<string>(); // target file: a namespace consumer exists from another workspace
  const crossDefault = new Set<string>();

  const addCross = (target: string, name: string): void => {
    const s = crossConsumed.get(target) ?? new Set<string>();
    s.add(name);
    crossConsumed.set(target, s);
  };

  for (const imp of input.imports) {
    if (!imp.target) continue;
    if (imp.targetWorkspace && imp.sourceWorkspace && imp.targetWorkspace !== imp.sourceWorkspace) {
      if (imp.namespaceAlias) crossNamespace.add(imp.target);
      if (imp.isStarReExport) crossNamespace.add(imp.target);
      if (imp.defaultImport) crossDefault.add(imp.target);
      for (const name of imp.namedImports) addCross(imp.target, name);
    }
  }

  // Re-export propagation. If `pkg/src/index.ts` does
  // `export { getUser } from './api/users'` and a cross-workspace consumer
  // imports `getUser` from `pkg`, the consumption was recorded against
  // `pkg/src/index.ts` (the resolved target). We need to forward that
  // consumption to `pkg/src/api/users.ts`, where the actual symbol lives.
  // Fixpoint iteration handles re-export chains (A re-exports from B
  // which re-exports from C).
  let changed = true;
  while (changed) {
    changed = false;
    for (const imp of input.imports) {
      if (!imp.isReExport) continue;
      if (!imp.target) continue;
      const sourceConsumed = crossConsumed.get(imp.source);
      const sourceIsNamespaceConsumed = crossNamespace.has(imp.source);
      if (imp.isStarReExport) {
        // `export * from './x'` — every cross-consumed name on the re-exporting
        // file must propagate to the target.
        if (sourceConsumed) {
          for (const name of sourceConsumed) {
            const targetSet = crossConsumed.get(imp.target) ?? new Set<string>();
            if (!targetSet.has(name)) {
              targetSet.add(name);
              crossConsumed.set(imp.target, targetSet);
              changed = true;
            }
          }
        }
        if (sourceIsNamespaceConsumed && !crossNamespace.has(imp.target)) {
          crossNamespace.add(imp.target);
          changed = true;
        }
        continue;
      }
      for (const name of imp.reExportNames ?? imp.namedImports) {
        const consumedHere = sourceConsumed?.has(name) || sourceIsNamespaceConsumed;
        if (!consumedHere) continue;
        const targetSet = crossConsumed.get(imp.target) ?? new Set<string>();
        if (!targetSet.has(name)) {
          targetSet.add(name);
          crossConsumed.set(imp.target, targetSet);
          changed = true;
        }
      }
    }
  }

  const findings: Finding[] = [];
  const exportedSymbols = input.symbols.filter((s) => s.exported);
  for (const sym of exportedSymbols) {
    if (!sym.workspace) continue; // single-workspace scan — skip
    // `sym.file` is already workspace-prefixed by the multi-workspace scanner.
    if (crossNamespace.has(sym.file)) continue;
    if (crossDefault.has(sym.file)) continue;
    const consumed = crossConsumed.get(sym.file);
    if (consumed && consumed.has(sym.name)) continue;

    findings.push({
      detectorId: 'dead-api',
      severity: 'low',
      confidence: 0.7,
      layer: 1,
      title: `Unused public API: ${sym.name} (${sym.workspace}/${stripWorkspace(sym.file, sym.workspace)})`,
      description: `\`${sym.name}\` is exported from \`${sym.file}\` but no file in any sibling workspace imports it.\nLocations:\n- ${sym.file}:${sym.range.startLine} (${sym.kind} ${sym.name})`,
      evidence: [
        {
          file: sym.file,
          range: sym.range,
          snippet: sym.source,
        },
      ],
      suggestion:
        'If this is an internal helper accidentally exported, remove the `export` keyword. If it is meant for external consumers outside the linked group, snooze the fingerprint.',
      fingerprint: `dead-api:${stableHash(`${sym.workspace}::${sym.file}::${sym.name}`)}`,
    });
  }
  return findings;
}

function stripWorkspace(file: string, workspace: string): string {
  const prefix = `${workspace}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
