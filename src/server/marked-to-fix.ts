import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Workspace-scoped "queue of findings the operator plans to fix"
 * persisted at `<workspace>/.rothunter/marked-to-fix.json`. Same shape
 * + same workspace-local storage as the false-positive set, so the
 * list survives workspace switches + can be committed alongside the
 * repo if a team wants shared backlog visibility.
 *
 * Used by:
 *   - FindingDetail "Add to fix queue" toggle
 *   - Dashboard "Generate combined fix prompt for N marked findings"
 *     button, which feeds the queue to the LLM in one shot
 */
export function markedToFixFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.rothunter', 'marked-to-fix.json');
}

export function readMarkedToFix(workspaceRoot: string): Set<string> {
  const file = markedToFixFile(workspaceRoot);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

export async function writeMarkedToFix(workspaceRoot: string, set: Set<string>): Promise<void> {
  const file = markedToFixFile(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ fingerprints: [...set].sort() }, null, 2),
    'utf-8',
  );
}
