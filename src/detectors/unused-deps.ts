import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ImportRecord } from '../graph/import-graph.js';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';
import { escapeForRegex } from '../utils/regex.js';

export interface UnusedDepsDetectorInput {
  workspaceRoot: string;
  imports: ReadonlyArray<ImportRecord>;
}

// dependencies + peerDependencies declared but never imported. LOW.
// Skips devDeps, workspace:* entries, known runtime loaders (tsx, …).
export function detectUnusedDeps(input: UnusedDepsDetectorInput): Finding[] {
  const pkgPath = path.join(input.workspaceRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf-8');
  } catch {
    return [];
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    return [];
  }
  const declared = new Set<string>();
  for (const k of Object.keys(pkg.dependencies ?? {})) declared.add(k);
  for (const k of Object.keys(pkg.peerDependencies ?? {})) declared.add(k);

  const used = new Set<string>();
  for (const imp of input.imports) {
    if (imp.target) continue; // resolved to a workspace path → not an npm dep
    const pkgName = parsePackageName(imp.specifier);
    if (pkgName) used.add(pkgName);
  }

  const out: Finding[] = [];
  for (const dep of declared) {
    if (used.has(dep)) continue;
    if (RUNTIME_LOADERS.has(dep)) continue;
    if ((pkg.dependencies?.[dep] ?? '').startsWith('workspace:')) continue;
    const line = findLineInJson(raw, dep);
    out.push({
      detectorId: 'unused-deps',
      severity: 'low',
      confidence: 0.85,
      layer: 1,
      title: `Unused dependency: \`${dep}\` in package.json`,
      description:
        `\`${dep}\` is declared in \`dependencies\` (or \`peerDependencies\`) but never imported across the workspace. Unused deps inflate the lockfile + the install footprint and complicate audits.`,
      evidence: [
        {
          file: 'package.json',
          range: { startLine: line, endLine: line },
          snippet: snippetAround(raw, line),
        },
      ],
      suggestion:
        `If genuinely unused, run \`npm uninstall ${dep}\` (or your package manager's equivalent). If the dep is loaded by name at runtime (plugin/CLI/loader pattern), add it to the runtime-loader allow-list.`,
      fingerprint: `unused-deps:${stableHash(dep)}`,
    });
  }
  return out;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const RUNTIME_LOADERS = new Set<string>([
  'tsx',
  'ts-node',
  'tsconfig-paths',
  '@swc/register',
  '@swc-node/register',
  'esbuild-register',
  'jiti',
  'dotenv-cli',
  'concurrently',
  'rimraf',
  'cross-env',
]);

function parsePackageName(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  // node builtins without prefix:
  if (BUILTINS.has(specifier.split('/')[0]!)) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return specifier.split('/')[0]!;
}

const BUILTINS = new Set<string>([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'events', 'stream', 'buffer',
  'child_process', 'url', 'querystring', 'zlib', 'tty', 'net', 'tls', 'dns', 'cluster',
  'worker_threads', 'perf_hooks', 'assert', 'process', 'readline', 'string_decoder',
  'vm', 'v8', 'inspector', 'async_hooks', 'timers', 'dgram',
]);

function findLineInJson(raw: string, key: string): number {
  const re = new RegExp(`"${escapeForRegex(key)}"\\s*:`);
  const m = re.exec(raw);
  if (!m) return 1;
  return raw.slice(0, m.index).split('\n').length;
}


function snippetAround(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}

