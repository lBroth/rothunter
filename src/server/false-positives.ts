import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type { Finding } from '../types.js';

/**
 * Workspace-scoped false-positive store. The fingerprint set lives at
 * `<workspace>/.rothunter/false-positives.json` so it follows the repo
 * (commit it, share across the team, survive workspace switches). On
 * every scan completion `splitFalsePositives` partitions `result.findings`
 * into normal vs false-positives — the latter never disappear from the
 * report but get a dedicated section in the UI.
 */

export function falsePositivesFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.rothunter', 'false-positives.json');
}

export function readFalsePositives(workspaceRoot: string): Set<string> {
  const file = falsePositivesFile(workspaceRoot);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

export async function writeFalsePositives(workspaceRoot: string, set: Set<string>): Promise<void> {
  const file = falsePositivesFile(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ fingerprints: [...set].sort() }, null, 2),
    'utf-8',
  );
}

export function splitFalsePositives(
  findings: Finding[],
  fpSet: ReadonlySet<string>,
): { findings: Finding[]; falsePositives: Finding[] } {
  if (fpSet.size === 0) return { findings, falsePositives: [] };
  const ok: Finding[] = [];
  const fp: Finding[] = [];
  for (const f of findings) (fpSet.has(f.fingerprint) ? fp : ok).push(f);
  return { findings: ok, falsePositives: fp };
}
