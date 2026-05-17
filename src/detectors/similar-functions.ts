import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Finding, FunctionStructure, SymbolRecord } from '../types.js';

export interface SimilarFunctionsDetectorInput {
  workspaceRoot: string;
  symbols: ReadonlyArray<SymbolRecord>;
  /** Combined score (name + body) above which a pair is considered similar. Default 0.5. */
  similarityThreshold?: number;
  /** Weight of the name-token Jaccard in the combined score (0..1). Body gets `1 - this`. Default 0.4. */
  nameWeight?: number;
  /** Minimum function size in lines to consider — skip tiny stubs. Default 3. */
  minLines?: number;
  /** Cap on findings to avoid drowning the dashboard. Default 25. */
  maxFindings?: number;
}

/**
 * Similar-functions detector — clusters candidates for "we have N
 * variants of the same thing, deduplicate into a shared package".
 *
 * Generalises `duplicate-function` (body-hash equality) and the original
 * `same-name-evolution` (string-equal name + git-date gap). Two
 * functions are considered similar when the **combined** similarity of:
 *
 *   - their tokenised names         (camelCase / snake / kebab split, stop-words dropped)
 *   - their body-shingle Jaccard    (already computed by the parser)
 *
 * exceeds `similarityThreshold`. Pairs above the threshold are merged
 * via union-find into clusters; each cluster gets one MED finding with
 * every member cited, plus a "canonical" pick driven by:
 *
 *   1. most-recently touched copy (via `git log -1 --format=%ct`)
 *   2. tie-break: largest body / most params (a heuristic for "richest"
 *      implementation).
 *
 * Suggestion text includes a concrete npm-package proposal when the
 * cluster spans ≥3 files or ≥2 distinct top-level directories — the
 * canonical "this wants to live in a shared lib" signal.
 *
 * Compared to `duplicate-function`, this detector fires when the bodies
 * have already diverged (so the hash check fails) but the intent is
 * clearly the same. Compared to `same-name-evolution`, it doesn't need
 * the names to be byte-equal: `getDbConnection` and `databaseConnection`
 * cluster together as long as their body shingles agree.
 */
export function detectSimilarFunctions(input: SimilarFunctionsDetectorInput): Finding[] {
  const threshold = input.similarityThreshold ?? 0.5;
  const nameWeight = clamp01(input.nameWeight ?? 0.4);
  const bodyWeight = 1 - nameWeight;
  const minLines = input.minLines ?? 3;
  const maxFindings = input.maxFindings ?? 25;

  const candidates: Array<{
    sym: SymbolRecord;
    fn: FunctionStructure;
    nameTokens: Set<string>;
  }> = [];
  for (const sym of input.symbols) {
    if (sym.kind !== 'function') continue;
    if (IGNORE_NAMES.has(sym.name)) continue;
    if (sym.range.endLine - sym.range.startLine + 1 < minLines) continue;
    const fn = sym.structure as FunctionStructure | undefined;
    if (!fn || fn.kind !== 'function') continue;
    candidates.push({ sym, fn, nameTokens: tokeniseName(sym.name) });
  }

  // Union-find over the candidate index space.
  const uf = new UnionFind(candidates.length);
  // Track the best (highest-score) edge seen between any two members of a
  // pair — surfaces the "why" string for the finding.
  const reasons = new Map<string, { score: number; nameSim: number; bodySim: number; i: number; j: number }>();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const nameSim = jaccard(a.nameTokens, b.nameTokens);
      const bodySim = jaccard(a.fn.bodyShingles, b.fn.bodyShingles);
      const score = nameWeight * nameSim + bodyWeight * bodySim;
      if (score < threshold) continue;
      uf.union(i, j);
      // After union, keep the strongest edge encountered for each root.
      const root = uf.find(i);
      const cached = reasons.get(String(root));
      if (!cached || score > cached.score) {
        reasons.set(String(root), { score, nameSim, bodySim, i, j });
      }
    }
  }

  // Group candidates by union-find root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const r = uf.find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  const isGit = isGitRepo(input.workspaceRoot);
  const tsCache = new Map<string, number | null>();
  const lastTouched = (file: string): number | null => {
    if (!isGit) return null;
    if (tsCache.has(file)) return tsCache.get(file)!;
    const ts = gitLastTouchedUnix(input.workspaceRoot, file);
    tsCache.set(file, ts);
    return ts;
  };

  const findings: Finding[] = [];
  // Sort groups by size (largest first) so the dashboard shows the
  // highest-value clusters first when the cap kicks in.
  const sortedGroups = [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [root, members] of sortedGroups) {
    if (findings.length >= maxFindings) break;
    // Deduplicate to one entry per file: an overloaded function appears
    // multiple times in the symbol list but we only want it cited once.
    const seenFiles = new Set<string>();
    const entries = members
      .map((idx) => candidates[idx]!)
      .filter((c) => {
        if (seenFiles.has(c.sym.file)) return false;
        seenFiles.add(c.sym.file);
        return true;
      });
    if (entries.length < 2) continue;
    // Rank by recency, then by body size, then by param count.
    const ranked = entries
      .map((c) => ({
        c,
        ts: lastTouched(c.sym.file),
        bodyLines: c.sym.range.endLine - c.sym.range.startLine + 1,
        arity: c.fn.params.length,
      }))
      .sort(
        (a, b) =>
          (b.ts ?? 0) - (a.ts ?? 0) ||
          b.bodyLines - a.bodyLines ||
          b.arity - a.arity,
      );
    const canonical = ranked[0]!;
    const others = ranked.slice(1);
    const why = reasons.get(String(root)) ?? { score: 0, nameSim: 0, bodySim: 0, i: -1, j: -1 };
    const distinctDirs = new Set(entries.map((e) => topLevelDir(e.sym.file))).size;
    const packageWorthy = entries.length >= 3 || distinctDirs >= 2;

    const namesSeen = uniqueNames(entries.map((e) => e.sym.name));
    findings.push({
      detectorId: 'similar-functions',
      severity: 'medium',
      confidence: clamp01(0.6 + (why.score - threshold) * 0.5),
      layer: 1,
      title: `Similar functions cluster: ${namesSeen.slice(0, 3).join(' / ')}${namesSeen.length > 3 ? ' …' : ''} (${entries.length} copies)`,
      description: buildDescription(canonical, others, why),
      evidence: entries.map((e) => ({
        file: e.sym.file,
        range: { startLine: e.sym.range.startLine, endLine: e.sym.range.endLine },
        snippet: e.sym.source.split('\n').slice(0, 3).join('\n'),
      })),
      suggestion: buildSuggestion(canonical, others, packageWorthy),
      fingerprint: `similar-functions:${stableHash(
        entries
          .map((e) => `${e.sym.file}:${e.sym.name}`)
          .sort()
          .join('|'),
      )}`,
    });
  }
  return findings;
}

interface RankedEntry {
  c: { sym: SymbolRecord; fn: FunctionStructure; nameTokens: Set<string> };
  ts: number | null;
  bodyLines: number;
  arity: number;
}

function buildDescription(
  canonical: RankedEntry,
  others: RankedEntry[],
  why: { score: number; nameSim: number; bodySim: number },
): string {
  const lines = [
    `Detected ${others.length + 1} functions that look like variants of the same thing — name-tokens ${(why.nameSim * 100).toFixed(0)}% shared, body shingles ${(why.bodySim * 100).toFixed(0)}% shared (combined score ${(why.score * 100).toFixed(0)}%).`,
    '',
    `Canonical pick (newest / largest body): \`${canonical.c.sym.name}\` in ${canonical.c.sym.file}:${canonical.c.sym.range.startLine}${canonical.ts ? ' · touched ' + fmtDate(canonical.ts) : ''}.`,
    '',
    'Other copies:',
    ...others.map(
      (o) =>
        `  - \`${o.c.sym.name}\` in ${o.c.sym.file}:${o.c.sym.range.startLine}${o.ts ? ' · touched ' + fmtDate(o.ts) : ''}`,
    ),
  ];
  return lines.join('\n');
}

function buildSuggestion(canonical: RankedEntry, others: RankedEntry[], packageWorthy: boolean): string {
  const base = `Diff each copy against \`${canonical.c.sym.file}\` (\`git diff -- ${canonical.c.sym.file} ${others.map((o) => o.c.sym.file).join(' ')}\`). Decide which behaviour is canonical, then delete the laggards or replace them with imports.`;
  if (!packageWorthy) return base;
  return (
    base +
    '\n\nThis cluster spans multiple directories — strong candidate for extraction into a small shared package (an internal npm package, or a workspace package in a monorepo). One canonical implementation eliminates the back-port risk for good.'
  );
}

const IGNORE_NAMES = new Set<string>([
  'default', 'render', 'constructor', 'toString', 'toJSON', 'valueOf',
  'index', 'main', 'init', 'setup', 'teardown', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'mount', 'unmount', 'use', 'noop', 'empty',
]);

// Stop-words intentionally generic across naming styles.
const STOP_WORDS = new Set<string>([
  'get', 'set', 'fn', 'do', 'a', 'an', 'the', 'to', 'of', 'for', 'with',
  'my', 'new', 'old', 'is', 'has', 'on', 'off', 'and', 'or', 'not', 'fn',
]);

/**
 * Splits a function name into lowercase content tokens. Handles
 * camelCase, snake_case, kebab-case, and mixed. Drops stop-words and
 * single-character residues.
 */
function tokeniseName(name: string): Set<string> {
  const tokens = name
    // insert spaces around case-changes / separators
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const small = a.size < b.size ? a : b;
  const large = a.size < b.size ? b : a;
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r]! !== r) r = this.parent[r]!;
    let i = x;
    while (this.parent[i]! !== r) {
      const next = this.parent[i]!;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function uniqueNames(names: ReadonlyArray<string>): string[] {
  return [...new Set(names)];
}

function topLevelDir(file: string): string {
  // Use the immediate parent directory of the file. `src/api/a.ts` and
  // `src/services/b.ts` count as different dirs (`src/api` vs
  // `src/services`) — the top-level-segment-only heuristic was too
  // coarse for monorepos that bucket everything under `src/`.
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

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

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
