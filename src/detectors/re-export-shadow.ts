import type { Finding, SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';
import { stableHash } from '../utils/hash.js';

export interface ReExportShadowDetectorInput {
  /** Symbols parsed from the workspace (used to detect local-vs-re-export shadow). */
  symbols: ReadonlyArray<SymbolRecord>;
  /** Import + re-export records produced by the parser. */
  imports: ReadonlyArray<ImportRecord>;
}

// Same barrel re-exports the same name from two different modules, OR a
// re-exported name shadows a sibling local declaration in the same file.
// Both cases make the symbol's origin ambiguous to callers — a rename
// refactor silently lands on one implementation, and `dead-export` loses
// the second branch. `export * from` is conservative (no name info), so
// only named re-exports participate in the shadow check.
export function detectReExportShadows(input: ReExportShadowDetectorInput): Finding[] {
  // Re-exports: source file → name → set of target files contributing it.
  // Local exported names use the sentinel `__local__:` prefix so they
  // collide in the same map without colliding with a real path.
  const byFile = new Map<string, Map<string, Set<string>>>();

  for (const imp of input.imports) {
    if (!imp.isReExport) continue;
    if (!imp.target) continue;
    // Use the final published name (alias-RHS when present, else the
    // original LHS) — that's what consumers actually see, and what makes
    // two re-exports ambiguous from the outside.
    const names = imp.reExportLocalNames ?? imp.reExportNames;
    if (!names || names.length === 0) continue;
    const fileMap = byFile.get(imp.source) ?? new Map<string, Set<string>>();
    for (const n of names) {
      const s = fileMap.get(n) ?? new Set<string>();
      s.add(imp.target);
      fileMap.set(n, s);
    }
    byFile.set(imp.source, fileMap);
  }

  // Locally declared exported symbols. Same name declared twice locally is
  // already a TS error, so a single entry per (file, name) is enough.
  const localByFile = new Map<string, Map<string, SymbolRecord>>();
  for (const sym of input.symbols) {
    if (!sym.exported) continue;
    const fm = localByFile.get(sym.file) ?? new Map<string, SymbolRecord>();
    if (!fm.has(sym.name)) fm.set(sym.name, sym);
    localByFile.set(sym.file, fm);
  }

  const findings: Finding[] = [];
  for (const [file, nameMap] of byFile) {
    const locals = localByFile.get(file);
    for (const [name, targets] of nameMap) {
      const localHit = locals?.get(name);
      const origins: string[] = [...targets].sort();
      const localShadow = localHit != null;
      const totalOrigins = origins.length + (localShadow ? 1 : 0);
      if (totalOrigins < 2) continue;

      const severity: 'high' | 'medium' = localShadow ? 'high' : 'medium';
      const originList = [
        ...origins.map((t) => `\`${t}\``),
        ...(localShadow ? [`local declaration in \`${file}\``] : []),
      ].join(', ');

      const evidenceRange = localHit
        ? { startLine: localHit.range.startLine, endLine: localHit.range.endLine }
        : { startLine: 1, endLine: 1 };
      const evidenceSnippet = localHit
        ? localHit.source.split('\n').slice(0, 4).join('\n')
        : `export { ${name} } from '...'`;

      findings.push({
        detectorId: 're-export-shadow',
        severity,
        confidence: 0.92,
        layer: 1,
        title: `Ambiguous re-export: \`${name}\` in ${file}`,
        description:
          `\`${name}\` is exported from ${file} via ${totalOrigins} different origins: ${originList}. ` +
          `Consumers cannot tell which implementation they're getting; rename refactors silently land on one of them, ` +
          `and dead-export loses sight of the unused branch.`,
        evidence: [
          {
            file,
            range: evidenceRange,
            snippet: evidenceSnippet,
          },
        ],
        suggestion: localShadow
          ? `Remove the re-export of \`${name}\` (the local declaration wins) or rename one side ` +
            `(e.g. \`export { ${name} as ${name}External } from '...'\`).`
          : `Pick one origin for \`${name}\`. If both implementations are intentional, give them distinct names ` +
            `(e.g. \`export { ${name} as ${name}V1 } from '${origins[0]}'\`).`,
        fingerprint: `re-export-shadow:${stableHash(`${file}::${name}`)}`,
      });
    }
  }
  return findings;
}
