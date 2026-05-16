import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TypeScriptParser, type ParseResult } from './parsers/typescript-parser.js';
import type { RotHunterConfig, WorkspaceConfig } from './config.js';
import type { SymbolRecord } from './types.js';
import type { ImportRecord } from './graph/import-graph.js';
import { resolveImport } from './graph/import-graph.js';

export interface MultiWorkspaceParseResult {
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /** All workspace-relative file paths, prefixed by their workspace name (e.g. `backend/src/index.ts`). */
  files: string[];
  /** Workspace configs in the order they were scanned. */
  workspaces: WorkspaceConfig[];
}

// Parse every linked workspace; stitch cross-workspace imports by resolving
// bare specifiers against sibling `package` names. File paths get a
// workspace-name prefix for global uniqueness.
export async function scanWorkspaces(config: RotHunterConfig): Promise<MultiWorkspaceParseResult> {
  const parser = new TypeScriptParser();

  // Pass 1 — parse each workspace independently. Keep raw results keyed by name.
  const parsed = new Map<string, ParseResult>();
  for (const ws of config.workspaces) {
    const r = await parser.parseWorkspaceFull({ workspaceRoot: ws.rootAbs });
    parsed.set(ws.name, r);
  }

  // Build a lookup from packageName → workspace name, for cross-workspace
  // resolution. Also auto-derive from each workspace's package.json `name`
  // field when no explicit `package` was set in the config.
  const pkgToWorkspace = new Map<string, string>();
  for (const ws of config.workspaces) {
    const declared = ws.packageName ?? readPackageName(ws.rootAbs);
    if (declared) pkgToWorkspace.set(declared, ws.name);
  }

  const symbols: SymbolRecord[] = [];
  const imports: ImportRecord[] = [];
  const files: string[] = [];

  for (const ws of config.workspaces) {
    const r = parsed.get(ws.name);
    if (!r) continue;
    // Prefix every file with the workspace name so downstream code can treat
    // paths as globally unique without losing the within-workspace structure.
    // Re-mint the symbol id with the workspace name folded in — without
    // this, two workspaces with the same relative file path (e.g. both
    // export `interface User` from `src/types.ts`) produce symbols that
    // share the parser's content-derived id and collapse into a single
    // entry in every downstream Map<id, …>. The duplicate-type detector
    // never sees the cross-workspace pair as a result.
    for (const sym of r.symbols) {
      symbols.push({
        ...sym,
        id: namespaceId(ws.name, sym.id),
        workspace: ws.name,
        file: prefix(ws.name, sym.file),
      });
    }
    for (const f of r.files) files.push(prefix(ws.name, f));
    for (const imp of r.imports) {
      // Default: stays within source workspace.
      let target = imp.target ? prefix(ws.name, imp.target) : null;
      let targetWorkspace: string | undefined;

      // Cross-workspace resolution. Two cases:
      //   (a) a bare-specifier that exactly matches a sibling's package name
      //   (b) `<pkg>/sub/path` — resolve sub/path inside the sibling workspace
      if (!target) {
        const crossWs = matchPackageSpecifier(imp.specifier, pkgToWorkspace);
        if (crossWs) {
          const subPath = imp.specifier.slice(crossWs.packageName.length);
          const sibling = config.workspaces.find((w) => w.name === crossWs.workspaceName);
          if (sibling) {
            const resolved = resolveSubPath(sibling.rootAbs, subPath);
            if (resolved) {
              target = prefix(sibling.name, resolved);
              targetWorkspace = sibling.name;
            }
          }
        }
      }

      imports.push({
        ...imp,
        source: prefix(ws.name, imp.source),
        sourceWorkspace: ws.name,
        target,
        targetWorkspace,
      });
    }
  }

  return { symbols, imports, files, workspaces: config.workspaces };
}

function prefix(workspaceName: string, file: string): string {
  // Use POSIX separator so paths are stable across platforms.
  return `${workspaceName}/${file.split(path.sep).join('/')}`;
}

function namespaceId(workspaceName: string, id: string): string {
  return crypto.createHash('sha256').update(`${workspaceName}::${id}`).digest('hex').slice(0, 16);
}

function readPackageName(rootAbs: string): string | undefined {
  const pkgPath = path.join(rootAbs, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function matchPackageSpecifier(
  specifier: string,
  pkgToWorkspace: ReadonlyMap<string, string>,
): { packageName: string; workspaceName: string } | null {
  for (const [pkg, ws] of pkgToWorkspace) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return { packageName: pkg, workspaceName: ws };
    }
  }
  return null;
}

function resolveSubPath(workspaceRoot: string, subPath: string): string | null {
  // `subPath` is like "" (just the package name), "/src/foo", or "/dist/foo".
  // We try the most common shapes: empty → src/index, /x → src/x.ts, /x → x.ts.
  const candidates: string[] = [];
  if (subPath === '' || subPath === '/') {
    candidates.push(
      path.join(workspaceRoot, 'src/index.ts'),
      path.join(workspaceRoot, 'index.ts'),
      path.join(workspaceRoot, 'src/index.tsx'),
    );
  } else {
    const rel = subPath.startsWith('/') ? subPath.slice(1) : subPath;
    candidates.push(
      path.join(workspaceRoot, 'src', `${rel}.ts`),
      path.join(workspaceRoot, 'src', rel, 'index.ts'),
      path.join(workspaceRoot, `${rel}.ts`),
      path.join(workspaceRoot, rel, 'index.ts'),
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return path.relative(workspaceRoot, c);
    }
  }
  // Last resort: piggy-back on the standard resolver pretending we're already
  // inside the workspace root.
  return resolveImport(workspaceRoot, 'fake.ts', `./${subPath.replace(/^\//, '')}`);
}
