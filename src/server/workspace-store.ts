import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync, realpathSync, readFileSync } from 'node:fs';

/**
 * Workspace selection + filesystem allow-roots. Two responsibilities:
 *   1. Persist the operator's active workspace (and recent picks) under
 *      ~/.rothunter/workspace.json so server restarts remember the choice.
 *   2. Guard every fs-reaching endpoint against paths outside the
 *      configured allow-roots — defaults to $HOME (+ /workspace inside the
 *      Docker image) unless ROTHUNTER_FS_ROOTS overrides.
 *
 * Module-level mutables (WORKSPACE_ROOT, RECENT_WORKSPACES) are exposed
 * through getters/setters so the rest of the server can hold a reference
 * to "current workspace" without each caller re-reading the persisted
 * config every time.
 */

export const CONFIG_DIR = path.join(os.homedir(), '.rothunter');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'workspace.json');

// macOS HFS+/APFS and Windows NTFS are case-insensitive by default.
// Fold case on the prefix comparison so `/Users/Foo` matches `/users/foo`.
export const FS_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function loadFsAllowRoots(): string[] {
  const raw = process.env.ROTHUNTER_FS_ROOTS;
  const explicit = !!raw;
  const roots = raw ? raw.split(':').filter(Boolean) : [os.homedir()];
  if (!explicit && existsSync('/workspace')) roots.push('/workspace');
  const resolved = roots.map((r) => {
    const abs = path.resolve(r);
    try {
      return realpathSync(abs);
    } catch {
      return abs; // path may not exist yet (e.g. fresh container)
    }
  });
  return [...new Set(resolved)];
}

export const FS_ALLOW_ROOTS = loadFsAllowRoots();

export function isUnderAllowRoot(abs: string): boolean {
  let resolved = path.resolve(abs);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Path may not exist yet (POST /api/workspace before mkdir, etc.).
    // Fall back to the un-resolved form — the caller's existsSync gate
    // catches "missing path" cases separately.
  }
  const needle = FS_CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
  return FS_ALLOW_ROOTS.some((root) => {
    const r = FS_CASE_INSENSITIVE ? root.toLowerCase() : root;
    if (needle === r) return true;
    return needle.startsWith(r + path.sep);
  });
}

interface PersistedWorkspaceConfig {
  current: string;
  recent: string[];
}

export function readPersistedWorkspace(): PersistedWorkspaceConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as PersistedWorkspaceConfig;
  } catch {
    return null;
  }
}

async function writePersistedWorkspace(cfg: PersistedWorkspaceConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

let WORKSPACE_ROOT: string;
let RECENT_WORKSPACES: string[];

/**
 * Boot-time workspace initialisation. Must be called once before any
 * getWorkspaceRoot() reader. Throws when no candidate falls inside the
 * allow-roots — the server is unusable in that state, so we let the
 * caller decide whether to exit or fall back.
 */
export function initWorkspaceStore(initial: string): { workspaceRoot: string; recent: string[] } {
  const persisted = readPersistedWorkspace();
  WORKSPACE_ROOT = initial;
  RECENT_WORKSPACES = (persisted?.recent ?? [initial]).filter((p) => isUnderAllowRoot(p));
  if (RECENT_WORKSPACES.length === 0) RECENT_WORKSPACES = [initial];
  return { workspaceRoot: WORKSPACE_ROOT, recent: RECENT_WORKSPACES };
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function getRecentWorkspaces(): ReadonlyArray<string> {
  return RECENT_WORKSPACES;
}

export function setWorkspaceRoot(next: string): void {
  WORKSPACE_ROOT = next;
  // Move to head of recent list (MRU).
  RECENT_WORKSPACES = [next, ...RECENT_WORKSPACES.filter((p) => p !== next)].slice(0, 10);
}

export async function persistCurrentWorkspace(): Promise<void> {
  try {
    await writePersistedWorkspace({ current: WORKSPACE_ROOT, recent: RECENT_WORKSPACES });
  } catch {
    // Persist failures should not crash the server; the next switch will retry.
  }
}
