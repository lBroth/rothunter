import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Finding, SymbolRecord } from '../types.js';

export interface SameNameEvolutionDetectorInput {
  workspaceRoot: string;
  symbols: ReadonlyArray<SymbolRecord>;
  /** Day-gap that turns two same-name functions into "evolution" candidates. Default 30. */
  minDayGap?: number;
  /** Minimum function size to consider. Skip 1-liners. Default 3 lines. */
  minLines?: number;
  /** Names to ignore (`default`, framework lifecycle hooks). */
  ignoreNames?: ReadonlySet<string>;
}

/**
 * Same-name-evolution detector.
 *
 * Premise: two (or more) functions with the same name living in
 * different files where one was last touched significantly later than
 * the other are typically not "accidental duplicates" but **evolutions**
 * — somebody fixed the bug, added a feature, or simplified the logic in
 * one copy and forgot to back-port the change to the others.
 *
 * Pipeline:
 *   1. Group function symbols by `name`
 *   2. For each group with ≥ 2 entries, look up the per-file last-commit
 *      date via `git log --format=%ct -n 1 -- <file>`
 *   3. If the newest and the oldest copy are more than `minDayGap` days
 *      apart, emit a MED finding citing both file:line locations and
 *      suggesting consolidation into a shared module (or an npm package
 *      when the evolution gap is large + the function is exported).
 *
 * Different from `duplicate-function`: that detector hashes BODIES and
 * fires only when bodies are byte-identical (after normalisation). This
 * one fires on NAME equivalence regardless of body — so it surfaces
 * cases where the two copies have already diverged and the divergence
 * itself is the smell.
 */
export function detectSameNameEvolution(input: SameNameEvolutionDetectorInput): Finding[] {
  const minDayGap = input.minDayGap ?? 30;
  const minLines = input.minLines ?? 3;
  const ignore = input.ignoreNames ?? IGNORE_NAMES;
  if (!isGitRepo(input.workspaceRoot)) return [];

  const groups = new Map<string, SymbolRecord[]>();
  for (const sym of input.symbols) {
    if (sym.kind !== 'function') continue;
    if (ignore.has(sym.name)) continue;
    if (sym.range.endLine - sym.range.startLine + 1 < minLines) continue;
    const list = groups.get(sym.name) ?? [];
    list.push(sym);
    groups.set(sym.name, list);
  }

  // Cache git timestamps per workspace-relative file.
  const tsCache = new Map<string, number | null>();
  const lastTouched = (relFile: string): number | null => {
    if (tsCache.has(relFile)) return tsCache.get(relFile)!;
    const ts = gitLastTouchedUnix(input.workspaceRoot, relFile);
    tsCache.set(relFile, ts);
    return ts;
  };

  const out: Finding[] = [];
  for (const [name, symbols] of groups) {
    if (symbols.length < 2) continue;
    // Dedupe to one symbol per file (otherwise overload arms inflate the group).
    const byFile = new Map<string, SymbolRecord>();
    for (const s of symbols) if (!byFile.has(s.file)) byFile.set(s.file, s);
    if (byFile.size < 2) continue;

    const entries = [...byFile.values()]
      .map((s) => ({ sym: s, ts: lastTouched(s.file) }))
      .filter((e) => e.ts !== null) as Array<{ sym: SymbolRecord; ts: number }>;
    if (entries.length < 2) continue;

    entries.sort((a, b) => a.ts - b.ts);
    const oldest = entries[0]!;
    const newest = entries[entries.length - 1]!;
    const gapDays = (newest.ts - oldest.ts) / 86400;
    if (gapDays < minDayGap) continue;

    const locations = entries.map((e) => `- ${e.sym.file}:${e.sym.range.startLine} (touched ${fmtDate(e.ts)})`).join('\n');
    const sameSignature = bodyShape(oldest.sym) === bodyShape(newest.sym);
    const npmHint = sameSignature && oldest.sym.exported && newest.sym.exported
      ? 'Both copies are exported and have the same shape — extracting into a small internal npm package (or a shared workspace package in a monorepo) eliminates the back-port risk for good.'
      : 'Move the divergent copy back to the canonical one, or rename one of them so the difference is intentional and visible at the call sites.';

    out.push({
      detectorId: 'same-name-evolution',
      severity: 'medium',
      confidence: 0.85,
      layer: 1,
      title: `Likely evolution of \`${name}\` across ${entries.length} files (${Math.round(gapDays)}d gap)`,
      description:
        `\`${name}\` exists in ${entries.length} files but the copies were last touched ${Math.round(gapDays)} days apart — typically a sign that one copy received a fix or feature the other(s) missed.\n\nLast-touched (oldest → newest):\n${locations}`,
      evidence: [
        ...entries.map((e) => ({
          file: e.sym.file,
          range: { startLine: e.sym.range.startLine, endLine: e.sym.range.endLine },
          snippet: e.sym.source.split('\n').slice(0, 3).join('\n'),
        })),
      ],
      suggestion: `Diff the copies (\`git diff -- ${oldest.sym.file} ${newest.sym.file}\`) and decide which behaviour is correct. ${npmHint}`,
      fingerprint: `same-name-evolution:${stableHash(`${name}:${entries.map((e) => e.sym.file).sort().join('|')}`)}`,
    });
  }
  return out;
}

const IGNORE_NAMES = new Set<string>([
  'default', 'render', 'constructor', 'toString', 'toJSON', 'valueOf',
  'index', 'main', 'init', 'setup', 'teardown', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'mount', 'unmount', 'use',
]);

function isGitRepo(root: string): boolean {
  return existsSync(path.join(root, '.git'));
}

function gitLastTouchedUnix(workspaceRoot: string, relFile: string): number | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relFile], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
    if (!out) return null;
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function bodyShape(sym: SymbolRecord): string {
  // Crude shape proxy: param-arity + presence of common keywords.
  const m = /\(([^)]*)\)/.exec(sym.source);
  const arity = m ? m[1]!.split(',').filter((s) => s.trim().length > 0).length : -1;
  return `arity=${arity}`;
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
