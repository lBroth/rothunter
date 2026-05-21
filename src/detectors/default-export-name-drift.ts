import type { Finding, SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';
import { stableHash } from '../utils/hash.js';

export interface DefaultExportNameDriftDetectorInput {
  /** Workspace symbols — used to locate files that publish a default export. */
  symbols: ReadonlyArray<SymbolRecord>;
  /** Import records — used to collect each importer's local name for the default. */
  imports: ReadonlyArray<ImportRecord>;
}

// A default export is consumed under 2+ different local names by its
// importers. Half-done rename refactors leave the codebase referring to
// the same symbol under inconsistent names — `import getUser from`,
// `import fetchUser from`, `import loadUser from` — which defeats grep
// and confuses readers. LOW severity (style + maintainability).
export function detectDefaultExportNameDrift(
  input: DefaultExportNameDriftDetectorInput,
): Finding[] {
  // Files that publish a default export. Restricting to known defaults
  // avoids flagging non-default imports that share the field name (we
  // wouldn't see those in `defaultImport` anyway, but the gate keeps the
  // semantics explicit for future readers).
  const defaultExporters = new Set<string>();
  const defaultSymbolByFile = new Map<string, SymbolRecord>();
  for (const sym of input.symbols) {
    if (!sym.isDefault) continue;
    defaultExporters.add(sym.file);
    if (!defaultSymbolByFile.has(sym.file)) defaultSymbolByFile.set(sym.file, sym);
  }
  if (defaultExporters.size === 0) return [];

  // target file -> Map<localName, importerFiles[]>
  const aliasesByTarget = new Map<string, Map<string, string[]>>();
  for (const imp of input.imports) {
    if (!imp.defaultImport) continue;
    if (!imp.target) continue;
    if (!defaultExporters.has(imp.target)) continue;
    const local = stripIdentifier(imp.defaultImport);
    if (!local) continue;
    const aliasMap = aliasesByTarget.get(imp.target) ?? new Map<string, string[]>();
    const sources = aliasMap.get(local) ?? [];
    sources.push(imp.source);
    aliasMap.set(local, sources);
    aliasesByTarget.set(imp.target, aliasMap);
  }

  const findings: Finding[] = [];
  for (const [target, aliasMap] of aliasesByTarget) {
    if (aliasMap.size < 2) continue;
    const ranked = [...aliasMap.entries()].sort((a, b) => b[1].length - a[1].length);
    const aliasList = ranked
      .map(([name, sources]) => `\`${name}\` (${sources.length}× — ${sources.slice(0, 2).join(', ')}${sources.length > 2 ? ', …' : ''})`)
      .join(', ');
    const defaultSym = defaultSymbolByFile.get(target);
    const declaredName = defaultSym?.name && defaultSym.name !== 'default' ? defaultSym.name : null;
    const declaredHint = declaredName ? `Declared name: \`${declaredName}\`. ` : '';

    findings.push({
      detectorId: 'default-export-name-drift',
      severity: 'low',
      confidence: 0.95,
      layer: 1,
      title: `Default export of ${target} imported under ${aliasMap.size} different names`,
      description:
        `${declaredHint}Importers disagree on the local name for this default: ${aliasList}. ` +
        `Renames silently lose track of the symbol; grep across the repo misses occurrences under any single name.`,
      evidence: [
        {
          file: target,
          range: defaultSym
            ? { startLine: defaultSym.range.startLine, endLine: defaultSym.range.endLine }
            : { startLine: 1, endLine: 1 },
          snippet: defaultSym
            ? defaultSym.source.split('\n').slice(0, 4).join('\n')
            : 'export default …',
        },
      ],
      suggestion:
        `Pick one canonical name and update each importer, or convert to a named export ` +
        `(\`export function ${declaredName ?? 'theThing'}() {…}\`) so consumers cannot rename it at the import site.`,
      fingerprint: `default-export-name-drift:${stableHash(target)}`,
    });
  }
  return findings;
}

// `getDefaultImport()` returns the raw text — e.g. `Foo` or, defensively,
// `Foo /* trailing */`. Strip down to the bare identifier so two importers
// with semantically-identical aliases collapse into one bucket.
function stripIdentifier(raw: string): string | null {
  const m = /^[\s]*([A-Za-z_$][\w$]*)/.exec(raw);
  return m ? m[1]! : null;
}
