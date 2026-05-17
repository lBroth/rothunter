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

/**
 * Detector for exports that nothing else in the workspace consumes.
 *
 * Inputs:
 *   - workspace symbols, each with its file + `exported` flag
 *   - all import + re-export edges captured by the parser
 *   - the entry-point set (entry files are considered "consumed by the outside
 *     world" — their exports are protected so we don't false-positive on the
 *     CLI surface).
 *
 * What counts as "consumed":
 *   - A named import that mentions the symbol's name and resolves to the
 *     symbol's file.
 *   - A `default` import resolving to the file, IF the symbol is the file's
 *     default export. (We don't track default-export identities yet — covered
 *     by a defensive fallback: any default import marks the file's exports
 *     as having default-bound consumption, but does NOT cover named exports.)
 *   - Any namespace alias import (`import * as ns from './x'`) — assumed to
 *     consume every export of the target (can't statically tell which names
 *     `ns.*` will end up touching).
 *   - Any `export * from './x'` re-export — same rationale: every export of
 *     the target propagates and could be consumed downstream.
 *   - A named re-export (`export { foo } from './x'`) — consumes `foo` in
 *     the target.
 *
 * What is NOT yet supported (documented limitations, not silent gaps):
 *   - Default-export name tracking — if you have `export default function bar`,
 *     `bar` is not currently tied to the default-import edge.
 *   - Dynamic imports (`await import('./x')`) — invisible to the static parser.
 *   - String-eval'd module IDs — also invisible.
 *
 * False-positive control: we flag at severity `low` and confidence 0.65 so the
 * humans-in-the-loop snooze flow (`.rothunterignore`) absorbs the unavoidable
 * tail of framework conventions / dynamic loads.
 */
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
    // Conservative default-import gate: if anyone imports default from the
    // file, we don't currently know which symbol is `default`, so don't flag
    // the file's exports as dead.
    if (defaultConsumedFiles.has(sym.file)) continue;

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
