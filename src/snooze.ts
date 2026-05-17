import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from './types.js';

/**
 * Snooze persistence via a workspace-root `.rothunterignore` file.
 *
 * Format: one fingerprint per line. Blank lines and lines starting with `#`
 * are comments. Fingerprints are the stable `dup-type:<layer>:<hash>` strings
 * produced by the detector, so a snooze survives re-runs across commits as
 * long as the underlying shape doesn't change.
 *
 * Example file:
 *   # PodCreate vs UpsertContext intentionally separate domains
 *   dup-type:structural:f376fd24e97f35db
 *   # Tag and Token use {id,name} but live in unrelated subsystems
 *   dup-type:strict:1172db9e07a37fae
 */

export interface SnoozeFile {
  /** Absolute path to the `.rothunterignore` file (whether it exists or not). */
  path: string;
  /** Set of fingerprints to suppress. */
  fingerprints: ReadonlySet<string>;
  /** Whether the file existed when we read it. */
  exists: boolean;
}

const SNOOZE_FILENAME = '.rothunterignore';

export function loadSnooze(workspaceRoot: string): SnoozeFile {
  const p = path.join(workspaceRoot, SNOOZE_FILENAME);
  if (!fs.existsSync(p)) {
    return { path: p, fingerprints: new Set(), exists: false };
  }
  const text = fs.readFileSync(p, 'utf-8');
  const fingerprints = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    fingerprints.add(line);
  }
  return { path: p, fingerprints, exists: true };
}

export interface SnoozeApplication {
  kept: Finding[];
  snoozed: Finding[];
}

export function applySnooze(findings: Finding[], snooze: SnoozeFile): SnoozeApplication {
  if (!snooze.exists || snooze.fingerprints.size === 0) {
    return { kept: findings, snoozed: [] };
  }
  const kept: Finding[] = [];
  const snoozed: Finding[] = [];
  for (const f of findings) {
    if (snooze.fingerprints.has(f.fingerprint)) snoozed.push(f);
    else kept.push(f);
  }
  return { kept, snoozed };
}
