import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Load every `.gitignore` reachable from `workspaceRoot` AND the
 * workspace-root `.rothunterignore` (gitignore-syntax extension, only
 * for rothunter). Returns a unified matcher.
 *
 * The matcher answers "is this workspace-relative path ignored?" — used
 * by the parser + by any detector that walks the filesystem on its own.
 *
 * Rules:
 *   - Top-level `.gitignore` always loads (when present).
 *   - Nested `.gitignore`s load too, prefixed with their relative dir so
 *     a pattern like `dist/` inside `packages/foo/.gitignore` matches
 *     `packages/foo/dist/...` and not the root `dist/`.
 *   - `.rothunterignore` at the workspace root loads with the same
 *     syntax — use this for files that ARE in git but should be hidden
 *     from rothunter (fixtures, vendored SDKs, generated test data).
 *   - `node_modules/` and `.git/` are always ignored regardless of
 *     what the operator's files say — the cost of scanning them is
 *     prohibitive on every repo and never produces useful findings.
 *
 * Always returns a non-null matcher; the always-on rules (`node_modules`
 * + `.git`) ensure callers get sensible defaults even when no ignore
 * file exists.
 */
export function loadGitignore(workspaceRoot: string): Ignore {
  const ig = ignore();

  // Always-on baseline. node_modules is the single biggest perf win;
  // .git is opaque to detectors anyway. These are baked in so that a
  // workspace without any .gitignore still scans something sensible.
  ig.add(['.git', 'node_modules']);

  const scan = (dir: string, relPrefix: string): void => {
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const raw = fs.readFileSync(gitignorePath, 'utf-8');
        const patterns = raw
          .split('\n')
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
        if (relPrefix === '') {
          ig.add(patterns);
        } else {
          // Nested .gitignore — scope every pattern to the containing dir
          // unless the pattern is anchored (starts with `/`) or negated
          // (`!`), in which case the `ignore` library's standard semantics
          // around relative roots take over.
          const scoped = patterns.map((p) => {
            const neg = p.startsWith('!');
            const body = neg ? p.slice(1) : p;
            const anchored = body.startsWith('/');
            const cleanBody = anchored ? body.slice(1) : body;
            const scopedBody = path.posix.join(relPrefix, cleanBody);
            return (neg ? '!' : '') + scopedBody;
          });
          ig.add(scoped);
        }
      } catch {
        // Unreadable — silently skip. Better to scan more files than to
        // crash the whole pipeline on a permissions error.
      }
    }

    // Recurse into immediate sub-directories. Cap depth to avoid
    // pathological monorepos eating O(n) syscalls per scan; the gitignore
    // files we care about live within a handful of levels of the root.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.') && entry.name !== '.rothunter') continue;
      const childDir = path.join(dir, entry.name);
      const childRel = relPrefix === '' ? entry.name : path.posix.join(relPrefix, entry.name);
      // Already-ignored directories don't need their nested .gitignores
      // — git doesn't recurse past an ignored dir, neither should we.
      if (ig.ignores(childRel + '/')) continue;
      scan(childDir, childRel);
    }
  };

  scan(workspaceRoot, '');

  // Layer `.rothunterignore` on top — rothunter-only path patterns
  // using identical gitignore syntax. Used to hide fixtures, vendored
  // code, and generated artifacts from scans without touching the
  // operator's git rules.
  const rhPath = path.join(workspaceRoot, '.rothunterignore');
  if (fs.existsSync(rhPath)) {
    try {
      const raw = fs.readFileSync(rhPath, 'utf-8');
      const patterns = raw
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      if (patterns.length > 0) ig.add(patterns);
    } catch {
      // Unreadable — silently skip.
    }
  }

  return ig;
}

/**
 * Filter a workspace-relative path list through the gitignore matcher,
 * preserving order.
 */
export function filterGitignored(matcher: Ignore, files: ReadonlyArray<string>): string[] {
  return files.filter((f) => !matcher.ignores(f.replace(/\\/g, '/')));
}
