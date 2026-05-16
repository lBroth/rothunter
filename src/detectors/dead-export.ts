import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Finding, SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';

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
// snooze via .rothunterignore for framework conventions.
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
        'If this export is consumed via dynamic import, framework convention, or an external package, snooze the fingerprint. Otherwise drop the `export` keyword (or delete the symbol).',
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

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
