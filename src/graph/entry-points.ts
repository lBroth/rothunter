import * as fs from 'node:fs';
import * as path from 'node:path';

// Entry-point heuristics: package.json main/module/bin/exports, conventional
// filenames (index/main/cli, scripts/, bin/), tests, framework routes (Next,
// SvelteKit, Astro). Workspace-relative POSIX paths.
export function discoverEntryPoints(workspaceRoot: string, knownFiles: ReadonlySet<string>): Set<string> {
  const entries = new Set<string>();
  addPackageJsonEntries(workspaceRoot, entries);
  for (const file of knownFiles) {
    if (matchesConvention(file)) entries.add(file);
  }
  return entries;
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

function addPackageJsonEntries(workspaceRoot: string, entries: Set<string>): void {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  pushIfFile(workspaceRoot, pkg.main, entries);
  pushIfFile(workspaceRoot, pkg.module, entries);
  pushIfFile(workspaceRoot, pkg.types, entries);

  const bin = pkg.bin;
  if (typeof bin === 'string') pushIfFile(workspaceRoot, bin, entries);
  else if (bin && typeof bin === 'object') {
    for (const v of Object.values(bin as Record<string, unknown>)) pushIfFile(workspaceRoot, v, entries);
  }

  const exportsField = pkg.exports;
  if (exportsField && typeof exportsField === 'object') {
    walkExports(workspaceRoot, exportsField as Record<string, unknown>, entries);
  }
}

function walkExports(
  workspaceRoot: string,
  node: Record<string, unknown> | string,
  out: Set<string>,
): void {
  if (typeof node === 'string') {
    pushIfFile(workspaceRoot, node, out);
    return;
  }
  for (const v of Object.values(node)) {
    if (typeof v === 'string') pushIfFile(workspaceRoot, v, out);
    else if (v && typeof v === 'object') walkExports(workspaceRoot, v as Record<string, unknown>, out);
  }
}

function pushIfFile(workspaceRoot: string, value: unknown, out: Set<string>): void {
  if (typeof value !== 'string') return;
  // Resolve package.json paths (often `dist/index.js`) back to the source by
  // swapping `dist/` → `src/` and `.js` → `.ts` — a common build convention.
  const candidates = [
    value,
    value.replace(/^\.?\/?dist\//, 'src/').replace(/\.js$/, '.ts'),
    value.replace(/\.js$/, '.ts'),
  ];
  for (const c of candidates) {
    const abs = path.resolve(workspaceRoot, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out.add(path.relative(workspaceRoot, abs));
      return;
    }
  }
}
