import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
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

// Shape mirrors src/schemas/rothunter.config.schema.json — that JSON
// Schema powers IDE autocomplete + inline validation, this zod schema
// powers runtime validation with line-accurate error messages. Keep the
// two in sync.
const RawConfigSchema = z
  .object({
    $schema: z.string().url().optional(),
    workspaces: z
      .array(
        z
          .object({
            path: z.string().min(1, 'path is required'),
            name: z.string().min(1, 'name is required'),
            package: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1, 'workspaces must be a non-empty array'),
  })
  .strict();
type RawConfig = z.infer<typeof RawConfigSchema>;

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
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`${configPath}: invalid JSON — ${(err as Error).message}`, { cause: err });
  }
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${configPath}: schema validation failed:\n${issues}`);
  }
  const data: RawConfig = parsed.data;
  const configDir = path.dirname(configPath);

  const workspaces: WorkspaceConfig[] = data.workspaces.map((entry, i) => {
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
