import * as path from 'node:path';
import type { Finding, SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';
import { stableHash } from '../utils/hash.js';

export interface DeadExportDetectorInput {
  /** Symbols parsed from the workspace, with `exported: boolean` set by the parser. */
  symbols: ReadonlyArray<SymbolRecord>;
  /** Import + re-export records produced by the parser. */
  imports: ReadonlyArray<ImportRecord>;
  /** Entry-point files (workspace-relative) — their exports are externally consumed. */
  entryPoints: ReadonlySet<string>;
}

// Flag exports nothing imports. Consumed = named import, `* as ns`, `export *`,
// re-export, OR default import IFF the symbol is the file's `isDefault`.
// Dynamic / string-eval'd imports invisible. Severity low, confidence 0.65 —
// mark as FP from the dashboard for framework conventions.
export function detectDeadExports(input: DeadExportDetectorInput): Finding[] {
  const consumedNames = new Map<string, Set<string>>();
  const namespaceConsumedFiles = new Set<string>();
  const defaultConsumedFiles = new Set<string>();

  const addConsumed = (file: string, name: string): void => {
    const s = consumedNames.get(file) ?? new Set<string>();
    s.add(name);
    consumedNames.set(file, s);
  };

  for (const imp of input.imports) {
    if (!imp.target) continue;
    if (imp.namespaceAlias) namespaceConsumedFiles.add(imp.target);
    if (imp.isStarReExport) namespaceConsumedFiles.add(imp.target);
    if (imp.defaultImport) defaultConsumedFiles.add(imp.target);
    for (const name of imp.namedImports) addConsumed(imp.target, name);
  }

  // Per-file map of EVERY symbol (exported AND internal) → its source.
  // Used for the same-file reachability pass: an exported helper /
  // type / class referenced from any sibling — exported or not —
  // counts as used. Restricting to siblings-also-exported missed the
  // common case where an exported utility (`sha256File`) is called
  // only from a non-exported helper (`checksumMatchesSidecar`) within
  // the same file.
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const sym of input.symbols) {
    const arr = symbolsByFile.get(sym.file) ?? [];
    arr.push(sym);
    symbolsByFile.set(sym.file, arr);
  }

  const findings: Finding[] = [];
  for (const sym of input.symbols) {
    if (!sym.exported) continue;
    if (input.entryPoints.has(sym.file)) continue;
    if (shouldSkipFile(sym.file)) continue;
    if (namespaceConsumedFiles.has(sym.file)) continue;
    const consumed = consumedNames.get(sym.file);
    if (consumed && consumed.has(sym.name)) continue;
    // Default-import gate: only protect the symbol that IS the file's
    // default. Other named exports in the same file remain subject to
    // dead-export. The parser tags `isDefault` on the symbol; absent
    // that tag the symbol is NOT the default, so leave the rest of the
    // file's named exports open to the check.
    if (defaultConsumedFiles.has(sym.file) && sym.isDefault) continue;
    // Type-surface reachability: an exported type / interface used in
    // another exported symbol's source is reachable through that
    // symbol's signature, even if no module imports it by name. Only
    // applies to types — runtime symbols (function / class / enum)
    // would show up via named import anyway.
    if (isTypeSurface(sym, symbolsByFile)) continue;

    findings.push({
      detectorId: 'dead-export',
      severity: 'low',
      confidence: 0.65,
      layer: 1,
      title: `Unused export: ${sym.name} in ${sym.file}`,
      description: `\`${sym.name}\` is exported from \`${sym.file}\` but no other workspace file imports it.\nLocations:\n- ${sym.file}:${sym.range.startLine} (${sym.kind} ${sym.name})`,
      evidence: [
        {
          file: sym.file,
          range: sym.range,
          snippet: sym.source,
        },
      ],
      suggestion:
        'If this export is consumed via dynamic import, framework convention, or an external package, mark this finding as a false positive. Otherwise drop the `export` keyword (or delete the symbol).',
      fingerprint: `dead-export:${stableHash(`${sym.file}::${sym.name}`)}`,
    });
  }
  return findings;
}

const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.d\.ts$/,
  /(^|\/)__fixtures__\//,
  /(^|\/)__mocks__\//,
  /\.story\.tsx?$/,
  /\.stories\.tsx?$/,
];

function shouldSkipFile(file: string): boolean {
  const posix = file.split(path.sep).join('/');
  return SKIP_FILE_PATTERNS.some((re) => re.test(posix));
}

/**
 * Decide whether `sym` is exposed transitively through the signature
 * of any OTHER exported symbol in the same file. A `\bName\b` hit in a
 * sibling's source is treated as a structural reference — return type,
 * parameter, generic constraint, extends clause.
 *
 * Restricted to `interface` / `type-alias` kinds: those are the ones
 * regularly exported purely to name a shape passed across the module
 * boundary. A runtime symbol (function / class / enum) imported only
 * through a sibling is rare; relying on the named-import path keeps
 * the FP risk low.
 */
function isTypeSurface(
  sym: SymbolRecord,
  symbolsByFile: Map<string, SymbolRecord[]>,
): boolean {
  // Restricted to symbols whose surface is naturally referenced from a
  // sibling — types from signatures, helpers from another function's
  // body. Enum / class also count: extending or referencing the type
  // inside another symbol of the same module is enough proof the
  // symbol is consumed transitively. Variables / constants are
  // intentionally excluded because their name regularly collides with
  // local variables and would over-mask.
  if (
    sym.kind !== 'interface' &&
    sym.kind !== 'type-alias' &&
    sym.kind !== 'function' &&
    sym.kind !== 'class' &&
    sym.kind !== 'enum'
  )
    return false;
  const siblings = symbolsByFile.get(sym.file);
  if (!siblings) return false;
  const nameRe = new RegExp(`\\b${escapeRegex(sym.name)}\\b`);
  for (const other of siblings) {
    if (other === sym) continue;
    if (nameRe.test(other.source)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

