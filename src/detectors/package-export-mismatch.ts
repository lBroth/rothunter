import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';

export interface PackageExportMismatchDetectorInput {
  workspaceRoot: string;
}

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  browser?: string | Record<string, string>;
  bin?: string | Record<string, string>;
  exports?: ExportsField;
}

// JSON schema for `exports`: a string, a single conditional object, or
// a map of subpaths → conditional-or-string. We walk all branches and
// collect concrete file-system targets.
type ExportsField = string | ExportsMap | null;
type ExportsMap = { [key: string]: ExportsField };

interface ExportTarget {
  /** Where in package.json this target was declared, for evidence text. */
  field: string;
  /** File path as written in package.json (POSIX, package-relative). */
  spec: string;
}

// package.json `exports` / `main` / `module` / `types` / `bin` point at
// files that don't exist on disk — and don't have an obvious TS source
// counterpart either. Catches the "works locally, npm install broken"
// publish bug. Severity HIGH because npm install will fail downstream
// (or the import will return undefined at runtime). One finding per
// missing target.
export function detectPackageExportMismatch(input: PackageExportMismatchDetectorInput): Finding[] {
  const pkgPath = path.join(input.workspaceRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
  } catch {
    return [];
  }

  // Private packages never publish — the contract is internal and the
  // operator owns the source of truth. Skip to avoid noise on monorepo
  // root packages whose `main` deliberately points at unbuilt paths.
  if (pkg.private === true) return [];

  const targets: ExportTarget[] = [];
  if (typeof pkg.main === 'string') targets.push({ field: 'main', spec: pkg.main });
  if (typeof pkg.module === 'string') targets.push({ field: 'module', spec: pkg.module });
  if (typeof pkg.types === 'string') targets.push({ field: 'types', spec: pkg.types });
  if (typeof pkg.typings === 'string') targets.push({ field: 'typings', spec: pkg.typings });
  if (typeof pkg.browser === 'string') targets.push({ field: 'browser', spec: pkg.browser });

  if (pkg.bin != null) {
    if (typeof pkg.bin === 'string') {
      targets.push({ field: 'bin', spec: pkg.bin });
    } else {
      for (const [name, p] of Object.entries(pkg.bin)) {
        if (typeof p === 'string') targets.push({ field: `bin.${name}`, spec: p });
      }
    }
  }

  if (pkg.exports != null) {
    walkExports(pkg.exports, ['exports'], targets);
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    // Wildcard subpaths (`./*`, `./internal/*`) cannot be resolved
    // without a glob expansion; conservatively skip them. The same
    // logic would catch a missing wildcard target by exploring the
    // wildcard universe — out of scope for v1.
    if (t.spec.includes('*')) continue;
    if (resolveTarget(input.workspaceRoot, t.spec)) continue;
    const key = `${t.field}::${t.spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      detectorId: 'package-export-mismatch',
      severity: 'high',
      confidence: 0.97,
      layer: 1,
      title: `Missing publish target: \`${t.spec}\` in package.json#${t.field}`,
      description:
        `\`package.json#${t.field}\` points at \`${t.spec}\`, but neither that file nor a TypeScript source counterpart (.ts / .tsx / .mts / .cts) exists in the workspace. ` +
        `Once published the install will fail to resolve this entry, or the consumer's import will yield undefined.`,
      evidence: [
        {
          file: 'package.json',
          range: { startLine: 1, endLine: 1 },
          snippet: `"${t.field}": "${t.spec}"`,
        },
      ],
      suggestion:
        `Either build the missing target (\`npm run build\` if \`${t.spec}\` is produced from source) ` +
        `or correct the path in package.json. If the target is intentionally absent in source (generated only by CI), ` +
        `keep a \`prepublishOnly\` script that creates it and document that scans run pre-build.`,
      fingerprint: `package-export-mismatch:${stableHash(`${t.field}::${t.spec}`)}`,
    });
  }
  return findings;
}

function walkExports(node: ExportsField, pathTrail: string[], out: ExportTarget[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    out.push({ field: pathTrail.join('.'), spec: node });
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    walkExports(child, [...pathTrail, key], out);
  }
}

// Resolve a package.json target spec to an on-disk file. Accepts the
// path as written, OR a TS source counterpart for a JS path (so the
// detector doesn't false-positive pre-build). Returns true if any
// candidate exists.
function resolveTarget(workspaceRoot: string, spec: string): boolean {
  const normalised = spec.startsWith('./') ? spec.slice(2) : spec;
  const abs = path.join(workspaceRoot, normalised);
  if (existsSync(abs)) return true;

  // Try TS counterparts for .js / .mjs / .cjs / .d.ts targets. Most
  // publishable packages declare `dist/x.js` but the source lives at
  // `src/x.ts` — we still want a green result before the build runs.
  const tsCandidates = jsToTsCandidates(normalised);
  for (const c of tsCandidates) {
    const candidateAbs = path.join(workspaceRoot, c);
    if (existsSync(candidateAbs)) return true;
  }
  return false;
}

function jsToTsCandidates(spec: string): string[] {
  const out: string[] = [];
  // Replace dist/ prefix with src/.
  const srcSwap = spec
    .replace(/^dist\//, 'src/')
    .replace(/^build\//, 'src/')
    .replace(/^lib\//, 'src/');
  const candidates = new Set<string>([spec, srcSwap]);
  for (const base of candidates) {
    if (/\.d\.ts$/.test(base)) {
      out.push(base.replace(/\.d\.ts$/, '.ts'));
      out.push(base.replace(/\.d\.ts$/, '.tsx'));
      continue;
    }
    if (/\.m?js$/.test(base)) {
      out.push(base.replace(/\.m?js$/, '.ts'));
      out.push(base.replace(/\.m?js$/, '.tsx'));
      out.push(base.replace(/\.m?js$/, '.mts'));
    }
    if (/\.cjs$/.test(base)) {
      out.push(base.replace(/\.cjs$/, '.cts'));
      out.push(base.replace(/\.cjs$/, '.ts'));
    }
  }
  return out;
}
