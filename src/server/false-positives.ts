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
  /**
   * User-overridden "keep open" set — fingerprints the operator
   * explicitly un-FP'd. Wins over BOTH the persisted FP set and the
   * per-scan LLM verdict so a click-to-undo on the dashboard actually
   * sticks across reload + future scans.
   */
  keptOpenSet: ReadonlySet<string> = new Set(),
): { findings: Finding[]; falsePositives: Finding[] } {
  const ok: Finding[] = [];
  const fp: Finding[] = [];
  for (const f of findings) {
    // Precedence: user override > persisted FP > LLM auto-FP. The
    // user clicking Unmark FP is the strongest signal and must
    // override the LLM verdict on subsequent renders / scans.
    if (keptOpenSet.has(f.fingerprint)) {
      // Strip the auto-FP flag so the UI doesn't render the badge.
      if (f.llmFalsePositive) delete f.llmFalsePositive;
      ok.push(f);
      continue;
    }
    const isFp = fpSet.has(f.fingerprint) || f.llmFalsePositive != null;
    (isFp ? fp : ok).push(f);
  }
  return { findings: ok, falsePositives: fp };
}

/**
 * Persistent "keep open" override store. Same shape as the FP store,
 * lives at `<workspace>/.rothunter/kept-open.json`. The semantics is
 * inverse: any fingerprint in this set is FORCED into the open list
 * even if the LLM auto-FP'd it. Commit it like the FP store so the
 * team's "no, this IS a real defect" calls survive a fresh scan.
 */
export function keptOpenFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.rothunter', 'kept-open.json');
}

export function readKeptOpen(workspaceRoot: string): Set<string> {
  const file = keptOpenFile(workspaceRoot);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

export async function writeKeptOpen(workspaceRoot: string, set: Set<string>): Promise<void> {
  const file = keptOpenFile(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ fingerprints: [...set].sort() }, null, 2),
    'utf-8',
  );
}
