import * as fs from 'node:fs';
import * as path from 'node:path';

// Entry-point heuristics: package.json main/module/bin/exports, conventional
// filenames (index/main/cli, scripts/, bin/), tests, framework routes (Next,
// SvelteKit, Astro). Workspace-relative POSIX paths.
/**
 * Decide whether the workspace at `root` describes a published npm
 * library. Heuristic: top-level `package.json` has a name + version,
 * is NOT marked private, AND declares one of the standard package
 * entry fields (main / module / exports / bin). When this is true,
 * downstream consumers can import individual files and dead-export
 * verdicts need to lean toward FALSE-POSITIVE for any symbol that
 * looks like a utility / config / type-surface helper.
 */
export function isPublishedLibrary(root: string): boolean {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) return false;
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) return false;
    if (pkg.private === true) return false;
    return (
      typeof pkg.main === 'string' ||
      typeof pkg.module === 'string' ||
      pkg.exports != null ||
      pkg.bin != null
    );
  } catch {
    return false;
  }
}

export function discoverEntryPoints(workspaceRoot: string, knownFiles: ReadonlySet<string>): Set<string> {
  const entries = new Set<string>();
  addPackageJsonEntries(workspaceRoot, entries);
  // Walk nested package.json files (monorepo workspaces — `packages/foo/
  // package.json`, `apps/bar/package.json`, etc.). Each one's scripts /
  // main / bin / exports field names entry points in its own subtree.
  // Walked via direct fs scan rather than `knownFiles` because package.json
  // is not parsed by the TS parser and never appears in the file set.
  for (const pkgDir of findNestedPackageDirs(workspaceRoot)) {
    addPackageJsonEntries(pkgDir, entries, workspaceRoot);
  }
  for (const file of knownFiles) {
    if (matchesConvention(file)) entries.add(file);
  }
  return entries;
}

/**
 * Filesystem walk for every directory containing a `package.json`
 * below `root`. Skips `node_modules`, dot-directories, and common
 * build / cache outputs to keep the walk bounded. Returns absolute
 * paths (consumed by `addPackageJsonEntries`).
 */
function findNestedPackageDirs(root: string): string[] {
  const out: string[] = [];
  const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'out', 'coverage', '.git',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
    '.vite', 'tmp', 'temp',
  ]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirents) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile() && e.name === 'package.json' && dir !== root) {
        out.push(dir);
      }
    }
  }
  return out;
}

const ENTRY_FILENAMES = new Set([
  'index.ts',
  'index.tsx',
  'main.ts',
  'main.tsx',
  'cli.ts',
  'mcp-server.ts',
  'server.ts',
]);

/** Patterns that indicate a file is conventionally an entry point or a test harness. */
function matchesConvention(file: string): boolean {
  const posix = file.split(path.sep).join('/');
  const basename = path.basename(posix);

  if (ENTRY_FILENAMES.has(basename)) return true;
  if (/^scripts\//.test(posix)) return true;
  if (/^bin\//.test(posix)) return true;
  if (/(^|\/)__tests__\//.test(posix)) return true;
  if (/(^|\/)__fixtures__\//.test(posix)) return true;
  if (/(^|\/)__mocks__\//.test(posix)) return true;
  if (/(^|\/)tests\//.test(posix)) return true;
  if (/(^|\/)test\//.test(posix)) return true;
  if (/(^|\/)e2e\//.test(posix)) return true;
  // Standalone demos / runnable examples — never imported, but invoked
  // directly via `tsx examples/foo.ts`. Real-world FP on nullpii's
  // examples/01-basic.ts etc.
  if (/(^|\/)examples\//.test(posix)) return true;
  if (/(^|\/)demo\//.test(posix)) return true;
  if (/(^|\/)benchmarks?\//.test(posix)) return true;
  // Workspace-level config files at the root — `vitest.config.ts`,
  // `jest.config.ts`, `vite.config.ts`, `playwright.config.ts`, etc.
  if (/^[^/]*\.config\.(ts|tsx|mts|cts)$/.test(posix)) return true;
  if (/\.(test|spec)\.(ts|tsx)$/.test(posix)) return true;

  // ---- Next.js (pages-router + app-router) --------------------------------
  if (/(^|\/)pages\//.test(posix)) return true;
  // app/ files: match both the un-nested case (`app/layout.tsx`, `app/page.tsx`)
  // AND nested route segments (`app/users/[id]/page.tsx`).
  if (/(^|\/)(src\/)?app\/(.*\/)?(page|route|layout|loading|error|template|not-found|head|default|global-error)\.(ts|tsx)$/.test(posix)) return true;
  if (basename === 'middleware.ts' || basename === 'middleware.tsx') return true;
  if (basename === 'instrumentation.ts' || basename === 'instrumentation-client.ts') return true;

  // ---- SvelteKit / Remix / Astro -------------------------------------------
  if (/(^|\/)routes\//.test(posix)) return true;
  if (/(^|\/)src\/pages\//.test(posix)) return true;
  if (/(^|\/)app\/routes\//.test(posix)) return true;

  // ---- Serverless handlers ------------------------------------------------
  // Vercel /api, Netlify functions, AWS SAM/CDK Lambda layouts, OpenNext.
  if (/(^|\/)api\//.test(posix) && /\.(ts|tsx)$/.test(posix)) return true;
  if (/(^|\/)netlify\/(functions|edge-functions)\//.test(posix)) return true;
  if (/(^|\/)functions\//.test(posix)) return true;
  if (/(^|\/)src\/functions\//.test(posix)) return true;
  if (/(^|\/)handlers\//.test(posix)) return true;
  if (/(^|\/)src\/handlers\//.test(posix)) return true;
  if (/(^|\/)src\/lambdas?\//.test(posix)) return true;
  if (/(^|\/)lambdas?\//.test(posix)) return true;
  // Cloudflare Workers, Deno, Bun single-file conventions.
  if (basename === 'mod.ts') return true;
  if (basename === 'worker.ts' || basename === 'worker.tsx') return true;

  // ---- AWS CDK / IaC entrypoints ------------------------------------------
  if (/(^|\/)(bin|infra|cdk)\//.test(posix) && /\.(ts|tsx)$/.test(posix)) return true;
  if (/\.stack\.(ts|tsx)$/.test(posix)) return true;
  return false;
}

function addPackageJsonEntries(
  pkgRoot: string,
  entries: Set<string>,
  /**
   * Workspace root for emitting workspace-relative paths. Defaults to
   * `pkgRoot` for the top-level case; nested package.json files pass
   * the original workspace root so resolved files stay relative to it.
   */
  workspaceRoot: string = pkgRoot,
): void {
  const pkgPath = path.join(pkgRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  pushIfFile(pkgRoot, pkg.main, entries, workspaceRoot);
  pushIfFile(pkgRoot, pkg.module, entries, workspaceRoot);
  pushIfFile(pkgRoot, pkg.types, entries, workspaceRoot);

  const bin = pkg.bin;
  if (typeof bin === 'string') pushIfFile(pkgRoot, bin, entries, workspaceRoot);
  else if (bin && typeof bin === 'object') {
    for (const v of Object.values(bin as Record<string, unknown>)) pushIfFile(pkgRoot, v, entries, workspaceRoot);
  }

  const exportsField = pkg.exports;
  if (exportsField && typeof exportsField === 'object') {
    walkExports(pkgRoot, exportsField as Record<string, unknown>, entries, workspaceRoot);
  }

  // `scripts` field: dev runners (`tsx watch src/dev.ts`), one-off
  // scripts (`node scripts/seed.ts`), build steps that compile a file
  // directly — each names a real file in the workspace that should
  // count as an entry point. Without this, every server `dev.ts` /
  // worker / migration script reads as dead-module.
  const scripts = pkg.scripts;
  if (scripts && typeof scripts === 'object') {
    for (const v of Object.values(scripts as Record<string, unknown>)) {
      if (typeof v === 'string') extractScriptFileRefs(pkgRoot, v, entries, workspaceRoot);
    }
  }
}

/**
 * Walk a package.json script command and extract every workspace-
 * relative file path that looks like a source-file argument. Matches
 * tokens ending in `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.mjs` /
 * `.cjs` and runs them through the same `pushIfFile` resolver as
 * `main` / `bin` / `exports` so `dist/foo.js` → `src/foo.ts` swapping
 * still works.
 *
 * Heuristic: extract via word boundary on whitespace, `&&`, `||`, `;`,
 * `|`. Skip flag-shaped tokens (`--config=foo.ts`) — they're tooling
 * config, not entry points the tool walks.
 */
function extractScriptFileRefs(
  pkgRoot: string,
  cmd: string,
  out: Set<string>,
  workspaceRoot: string,
): void {
  const tokens = cmd.split(/[\s&|;]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue;
    if (tok.startsWith('"') || tok.startsWith("'")) continue;
    // Strip leading `./` / `node:` / shell expansion artifacts.
    const cleaned = tok.replace(/^\.\/+/, '').replace(/[)"';]+$/, '');
    if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/i.test(cleaned)) continue;
    pushIfFile(pkgRoot, cleaned, out, workspaceRoot);
  }
}

function walkExports(
  pkgRoot: string,
  node: Record<string, unknown> | string,
  out: Set<string>,
  workspaceRoot: string,
): void {
  if (typeof node === 'string') {
    pushIfFile(pkgRoot, node, out, workspaceRoot);
    return;
  }
  for (const v of Object.values(node)) {
    if (typeof v === 'string') pushIfFile(pkgRoot, v, out, workspaceRoot);
    else if (v && typeof v === 'object')
      walkExports(pkgRoot, v as Record<string, unknown>, out, workspaceRoot);
  }
}

function pushIfFile(
  pkgRoot: string,
  value: unknown,
  out: Set<string>,
  workspaceRoot: string,
): void {
  if (typeof value !== 'string') return;
  // Resolve package.json paths (often `dist/index.js`) back to the source by
  // swapping `dist/` → `src/` and `.js` → `.ts` — a common build convention.
  const candidates = [
    value,
    value.replace(/^\.?\/?dist\//, 'src/').replace(/\.js$/, '.ts'),
    value.replace(/\.js$/, '.ts'),
  ];
  for (const c of candidates) {
    const abs = path.resolve(pkgRoot, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out.add(path.relative(workspaceRoot, abs));
      return;
    }
  }
}
