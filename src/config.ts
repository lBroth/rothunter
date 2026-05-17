import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverMonorepoWorkspaces } from './graph/monorepo-detect.js';

/**
 * RotHunter configuration — one file per linked-workspaces group.
 *
 * Discovered at scan time by `loadRotHunterConfig(workspaceRoot)`. Looks for
 * `rothunter.config.json` in the workspace root, then in `.rothunter/config.json`.
 * Returns null if no config is present (single-workspace mode).
 *
 * Schema:
 *   {
 *     "workspaces": [
 *       { "path": ".",            "name": "backend",  "package": "@org/backend" },
 *       { "path": "../frontend",  "name": "frontend", "package": "@org/frontend" }
 *     ]
 *   }
 *
 *  - `path` is relative to the config file's directory (or absolute).
 *  - `name` is a stable logical identifier used as a path prefix in
 *    findings + fingerprints.
 *  - `package` is optional. When set, a bare import specifier matching
 *    that package name (e.g. `import { X } from '@org/backend'`) is
 *    resolved into that workspace's source tree.
 */
export interface WorkspaceConfig {
  /** Absolute path on disk. */
  rootAbs: string;
  /** Logical name used as a workspace ID + finding prefix. */
  name: string;
  /** Package name (npm-style) for bare-specifier resolution into this workspace. */
  packageName?: string;
}

export interface RotHunterConfig {
  workspaces: WorkspaceConfig[];
  /** Absolute path of the config file that produced this object. */
  configPath: string;
}

const CONFIG_CANDIDATES = ['rothunter.config.json', '.rothunter/config.json'];

interface RawConfigEntry {
  path?: string;
  name?: string;
  package?: string;
}

interface RawConfig {
  workspaces?: RawConfigEntry[];
}

export function loadRotHunterConfig(workspaceRoot: string): RotHunterConfig | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const abs = path.join(workspaceRoot, candidate);
    if (!fs.existsSync(abs)) continue;
    return parseConfig(abs);
  }
  // Fall back to monorepo auto-detection. Reads package.json#workspaces
  // (npm / yarn / yarn-berry / bun / Turbo / Lerna), pnpm-workspace.yaml,
  // and nx.json. If any sibling packages exist we ingest them automatically
  // so users don't have to write a rothunter.config.json by hand.
  const auto = discoverMonorepoWorkspaces(workspaceRoot);
  if (auto && auto.length > 0) {
    return {
      workspaces: auto,
      configPath: `${workspaceRoot}/[auto-detected]`,
    };
  }
  return null;
}

function parseConfig(configPath: string): RotHunterConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RawConfig;
  const configDir = path.dirname(configPath);

  if (!raw.workspaces || !Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
    throw new Error(`${configPath}: "workspaces" must be a non-empty array.`);
  }

  const workspaces: WorkspaceConfig[] = raw.workspaces.map((entry, i) => {
    if (!entry.path || typeof entry.path !== 'string') {
      throw new Error(`${configPath}: workspaces[${i}].path is required.`);
    }
    if (!entry.name || typeof entry.name !== 'string') {
      throw new Error(`${configPath}: workspaces[${i}].name is required.`);
    }
    const rootAbs = path.isAbsolute(entry.path) ? entry.path : path.resolve(configDir, entry.path);
    if (!fs.existsSync(rootAbs)) {
      throw new Error(`${configPath}: workspaces[${i}].path "${entry.path}" does not exist on disk.`);
    }
    return {
      rootAbs,
      name: entry.name,
      packageName: entry.package,
    };
  });

  const names = new Set<string>();
  for (const w of workspaces) {
    if (names.has(w.name)) {
      throw new Error(`${configPath}: duplicate workspace name "${w.name}".`);
    }
    names.add(w.name);
  }

  return { workspaces, configPath };
}
