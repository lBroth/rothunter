import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceConfig } from '../config.js';

// Auto-detect monorepo layout from package.json#workspaces (npm/yarn/bun/
// turbo/lerna), pnpm-workspace.yaml, nx.json#workspaceLayout. Simple globs
// (dir/*) only — complex patterns require explicit rothunter.config.json.
export function discoverMonorepoWorkspaces(repoRoot: string): WorkspaceConfig[] | null {
  const dirs = new Set<string>();

  // ---- package.json `workspaces` -------------------------------------------
  const rootPkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8')) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const list = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg.workspaces?.packages)
          ? pkg.workspaces!.packages
          : [];
      for (const pattern of list) {
        for (const d of expandWorkspacePattern(repoRoot, pattern)) dirs.add(d);
      }
    } catch {
      // unreadable package.json — fall through
    }
  }

  // ---- pnpm-workspace.yaml -------------------------------------------------
  const pnpmPath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const yaml = fs.readFileSync(pnpmPath, 'utf-8');
      for (const pattern of parsePnpmWorkspacePackages(yaml)) {
        for (const d of expandWorkspacePattern(repoRoot, pattern)) dirs.add(d);
      }
    } catch {
      // ignore
    }
  }

  // ---- nx.json `workspaceLayout` -------------------------------------------
  const nxPath = path.join(repoRoot, 'nx.json');
  if (fs.existsSync(nxPath)) {
    try {
      const nx = JSON.parse(fs.readFileSync(nxPath, 'utf-8')) as {
        workspaceLayout?: { libsDir?: string; appsDir?: string };
      };
      const roots = [nx.workspaceLayout?.libsDir, nx.workspaceLayout?.appsDir].filter(
        (s): s is string => typeof s === 'string',
      );
      for (const r of roots) {
        for (const d of expandWorkspacePattern(repoRoot, `${r}/*`)) dirs.add(d);
      }
    } catch {
      // ignore
    }
  }

  // Filter to directories that have their own package.json (the canonical
  // "this is a workspace" signal). Skip the repo root itself.
  const workspaces: WorkspaceConfig[] = [];
  for (const dir of dirs) {
    if (path.resolve(dir) === path.resolve(repoRoot)) continue;
    const dirPkg = path.join(dir, 'package.json');
    if (!fs.existsSync(dirPkg)) continue;
    let name: string | undefined;
    let packageName: string | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(dirPkg, 'utf-8')) as { name?: string };
      packageName = typeof parsed.name === 'string' ? parsed.name : undefined;
      name = packageName?.replace(/^@[^/]+\//, '') || path.basename(dir);
    } catch {
      name = path.basename(dir);
    }
    if (!name) continue;
    workspaces.push({
      rootAbs: path.resolve(dir),
      name,
      packageName,
    });
  }
  if (workspaces.length === 0) return null;

  // Deduplicate by `name` (could collide if two siblings produce the same
  // basename after the npm-scope strip); the second one wins via Map.
  const byName = new Map<string, WorkspaceConfig>();
  for (const w of workspaces) byName.set(w.name, w);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Expand a workspace pattern relative to repoRoot.
 *
 * Supports two shapes:
 *   - `packages/foo`       — concrete directory; included if it exists
 *   - `packages/*`         — every direct subdirectory of `packages/`
 *
 * `**` and other complex globs are deliberately rejected; users with that
 * level of branching should provide an explicit rothunter.config.json.
 */
function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  const trimmed = pattern.trim();
  if (!trimmed) return [];

  // Concrete path (no glob).
  if (!trimmed.includes('*')) {
    const abs = path.resolve(repoRoot, trimmed);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? [abs] : [];
  }

  // Single trailing `/*` shape.
  if (trimmed.endsWith('/*') && !trimmed.includes('**')) {
    const baseDir = path.resolve(repoRoot, trimmed.slice(0, -2));
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(baseDir, d.name));
  }

  // Anything else: skip with a noisy console warning (debugging help) but
  // don't crash the scan.
  return [];
}

/**
 * Minimal pnpm-workspace.yaml parser — pulls strings under a `packages:`
 * list. We don't bring in a full YAML parser; the pnpm-workspace shape is
 * narrow enough to handle directly.
 *
 *   packages:
 *     - "apps/*"
 *     - "packages/*"
 *     - "!packages/legacy"   <-- excludes; we ignore the `!` prefix entries.
 */
function parsePnpmWorkspacePackages(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\r$/, '');
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const trim = line.trim();
      // End of packages list when we hit another top-level key.
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        inPackages = false;
        continue;
      }
      if (!trim.startsWith('-')) continue;
      let value = trim.slice(1).trim();
      // Strip surrounding quotes if present.
      value = value.replace(/^["']|["']$/g, '');
      if (!value) continue;
      if (value.startsWith('!')) continue; // exclusion patterns
      out.push(value);
    }
  }
  return out;
}
