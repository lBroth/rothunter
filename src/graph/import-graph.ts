import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveTsconfigAlias, type TsconfigPaths } from './tsconfig-paths.js';

/**
 * File-level import graph.
 *
 * A directed edge `a → b` means "file a imports something from file b". The
 * graph is used by the dead-module detector to find files unreachable from
 * any entry point.
 *
 * Edges and node identities are workspace-relative POSIX paths so the graph
 * is stable across machines and easy to serialise.
 */
export interface ImportGraph {
  /** All workspace files known to the graph. */
  nodes: Set<string>;
  /** Outgoing edges keyed by source file. */
  outgoing: Map<string, Set<string>>;
  /** Incoming edges keyed by target file. */
  incoming: Map<string, Set<string>>;
}

export interface ImportRecord {
  /** Source file (workspace-relative). */
  source: string;
  /** Logical workspace name of the source file in multi-workspace mode. */
  sourceWorkspace?: string;
  /** Resolved target file (workspace-relative) if the specifier resolved to a workspace path, else null. */
  target: string | null;
  /** Workspace name of the resolved target when the import crossed a workspace boundary. */
  targetWorkspace?: string;
  /** Raw specifier as written in the import (e.g. `'./utils'`, `'fs'`, `'@org/pkg'`). */
  specifier: string;
  /** Named imports (`import { a, b as c }` → ['a', 'c']). Aliases recorded as the local name. */
  namedImports: string[];
  /** Default import local name (`import Foo from ...`). */
  defaultImport?: string;
  /** Namespace alias (`import * as ns from ...`). When set, every export of the target is consumed. */
  namespaceAlias?: string;
  /** True when this record came from `export ... from '...'` (re-export). */
  isReExport: boolean;
  /** True for `export * from '...'` — every export of the target propagates. */
  isStarReExport: boolean;
  /** Original exported names mentioned in the re-export (`export { a as b } from` → ['a']). */
  reExportNames?: string[];
}

export function buildImportGraph(records: ImportRecord[]): ImportGraph {
  const nodes = new Set<string>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const r of records) {
    nodes.add(r.source);
    if (!r.target) continue;
    nodes.add(r.target);
    addEdge(outgoing, r.source, r.target);
    addEdge(incoming, r.target, r.source);
  }
  return { nodes, outgoing, incoming };
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  const s = map.get(from) ?? new Set<string>();
  s.add(to);
  map.set(from, s);
}

// Resolve TS import specifier → workspace-relative path, or null for
// node_modules / virtual. Tries relative, absolute, then tsconfig paths aliases.
export function resolveImport(
  workspaceRoot: string,
  sourceFile: string,
  specifier: string,
  tsconfigPaths?: TsconfigPaths | null,
): string | null {
  const sourceAbs = path.isAbsolute(sourceFile) ? sourceFile : path.join(workspaceRoot, sourceFile);

  // Relative + absolute path resolution path.
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const baseDir = path.dirname(sourceAbs);
    const target = specifier.startsWith('/') ? specifier : path.resolve(baseDir, specifier);

    const candidates = [
      target,
      `${target}.ts`,
      `${target}.tsx`,
      path.join(target, 'index.ts'),
      path.join(target, 'index.tsx'),
      `${target}.d.ts`,
      path.join(target, 'index.d.ts'),
    ];
    if (target.endsWith('.js')) {
      candidates.push(target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx');
    }

    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return path.relative(workspaceRoot, c);
      }
    }
    return null;
  }

  // Bare specifier: try tsconfig path aliases (`@/foo`, `~/bar`, `@app/lib`).
  if (tsconfigPaths) {
    const hit = resolveTsconfigAlias(tsconfigPaths, specifier);
    if (hit) return path.relative(workspaceRoot, hit);
  }
  return null;
}

/** BFS reachability from a set of entry-point files. Returns the reachable set. */
export function reachableFrom(graph: ImportGraph, entryPoints: Iterable<string>): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const e of entryPoints) {
    if (graph.nodes.has(e) && !reachable.has(e)) {
      reachable.add(e);
      queue.push(e);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const out = graph.outgoing.get(cur);
    if (!out) continue;
    for (const next of out) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}
