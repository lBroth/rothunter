import * as fs from 'node:fs';
import * as path from 'node:path';

// tsconfig.json paths/baseUrl resolver. Maps `@/foo`/`~`/`@org/lib` aliases
// to disk. Follows one level of `extends`. Project references + bundler
// resolution not modelled.
export interface TsconfigPaths {
  /** Absolute base directory derived from baseUrl, or workspaceRoot. */
  baseDir: string;
  /** Compiled mapping: alias prefix → resolved target paths (absolute). */
  mappings: Array<{
    /** Either the literal alias or the prefix up to (and not including) `*`. */
    aliasPrefix: string;
    /** Whether the alias originally contained `*`. */
    isWildcard: boolean;
    /** Possible target paths to try, in priority order, absolute. */
    targets: string[];
  }>;
}

const CONFIG_CANDIDATES = ['tsconfig.json', 'jsconfig.json'];

export function loadTsconfigPaths(workspaceRoot: string): TsconfigPaths | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const abs = path.join(workspaceRoot, candidate);
    if (!fs.existsSync(abs)) continue;
    const merged = readMergedConfig(abs, new Set());
    if (!merged) continue;
    return compileMappings(abs, merged, workspaceRoot);
  }
  return null;
}

const MAX_EXTENDS_DEPTH = 8;

interface RawConfig {
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readMergedConfig(configPath: string, visited: Set<string>): RawConfig | null {
  // Cycle guard: `visited` tracks the realpath of every config seen on the
  // extends chain. A self-extending or A→B→A loop returns null instead of
  // recursing forever. Depth cap is a belt-and-braces for pathological
  // chains the cycle guard didn't catch (e.g. each step is a distinct
  // file but the chain length is still adversarial).
  const realPath = (() => {
    try { return fs.realpathSync(configPath); } catch { return configPath; }
  })();
  if (visited.has(realPath)) return null;
  if (visited.size >= MAX_EXTENDS_DEPTH) return null;
  visited.add(realPath);

  const raw = readJsonWithComments(configPath);
  if (!raw) return null;
  if (typeof raw.extends === 'string') {
    const parentPath = resolveExtends(configPath, raw.extends);
    if (parentPath && fs.existsSync(parentPath)) {
      const parent = readMergedConfig(parentPath, visited);
      if (parent) {
        return {
          extends: raw.extends,
          compilerOptions: {
            baseUrl: raw.compilerOptions?.baseUrl ?? parent.compilerOptions?.baseUrl,
            paths: {
              ...(parent.compilerOptions?.paths ?? {}),
              ...(raw.compilerOptions?.paths ?? {}),
            },
          },
        };
      }
    }
  }
  return raw;
}

function resolveExtends(configPath: string, extendsValue: string): string | null {
  const dir = path.dirname(configPath);
  // Relative path
  if (extendsValue.startsWith('.') || extendsValue.startsWith('/')) {
    const direct = path.resolve(dir, extendsValue);
    if (fs.existsSync(direct)) return direct;
    if (fs.existsSync(`${direct}.json`)) return `${direct}.json`;
    return null;
  }
  // Bare specifier — `@org/tsconfig-base` etc. Try node_modules lookup walking up.
  let cur = dir;
  while (cur !== path.dirname(cur)) {
    const candidate = path.join(cur, 'node_modules', extendsValue);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(`${candidate}.json`)) return `${candidate}.json`;
    cur = path.dirname(cur);
  }
  return null;
}

function readJsonWithComments(configPath: string): RawConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  // String-aware comment + trailing-comma stripper. The naive regex
  // `/\*[\s\S]*?\*\//` corrupts tsconfig path values like `"@/*": ["src/*"]`
  // because `@/*` opens what the regex thinks is a comment, and `src/*"`
  // closes it. Walk the source as a tiny state machine instead.
  const repaired = stripJsoncTrivia(text);
  try {
    return JSON.parse(repaired) as RawConfig;
  } catch {
    return null;
  }
}

function stripJsoncTrivia(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    if (ch === '"') {
      // Copy the entire string literal verbatim, respecting `\` escapes.
      let j = i + 1;
      out += '"';
      while (j < n) {
        const c = text[j]!;
        out += c;
        if (c === '\\' && j + 1 < n) {
          out += text[j + 1]!;
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '/' && next === '/') {
      // Line comment — skip to end of line.
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Block comment — skip until `*/`.
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      // Tolerate trailing commas: look ahead for the next non-whitespace.
      let k = i + 1;
      while (k < n && /\s/.test(text[k]!)) k++;
      if (k < n && (text[k] === '}' || text[k] === ']')) {
        i = k; // drop the comma; emit the closing brace next iteration
        continue;
      }
    }
    out += ch!;
    i += 1;
  }
  return out;
}

function compileMappings(
  configPath: string,
  raw: RawConfig,
  workspaceRoot: string,
): TsconfigPaths {
  const configDir = path.dirname(configPath);
  const baseUrl = raw.compilerOptions?.baseUrl;
  const baseDir = baseUrl ? path.resolve(configDir, baseUrl) : workspaceRoot;
  const paths = raw.compilerOptions?.paths ?? {};

  const mappings: TsconfigPaths['mappings'] = [];
  for (const [alias, targets] of Object.entries(paths)) {
    const isWildcard = alias.endsWith('*');
    const aliasPrefix = isWildcard ? alias.slice(0, -1) : alias;
    const absTargets = targets.map((t) => path.resolve(baseDir, t));
    mappings.push({ aliasPrefix, isWildcard, targets: absTargets });
  }
  // Longest-prefix-first: ensures `@/foo` doesn't accidentally win over `@/foo/bar`.
  mappings.sort((a, b) => b.aliasPrefix.length - a.aliasPrefix.length);
  return { baseDir, mappings };
}

/**
 * Resolve an alias specifier to an existing file on disk. Returns the
 * absolute path or null if no mapping matched / no target existed.
 *
 * The `extensions` parameter mirrors the standard TS resolution candidate
 * list (`.ts`, `.tsx`, `/index.ts`, etc).
 */
export function resolveTsconfigAlias(
  cfg: TsconfigPaths,
  specifier: string,
  extensions: string[] = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.d.ts', '/index.d.ts'],
): string | null {
  for (const m of cfg.mappings) {
    if (m.isWildcard) {
      if (!specifier.startsWith(m.aliasPrefix)) continue;
      const tail = specifier.slice(m.aliasPrefix.length);
      for (const t of m.targets) {
        const candidate = t.endsWith('*') ? t.slice(0, -1) + tail : path.join(t, tail);
        const hit = tryExtensions(candidate, extensions);
        if (hit) return hit;
      }
    } else {
      if (specifier !== m.aliasPrefix) continue;
      for (const t of m.targets) {
        const hit = tryExtensions(t, extensions);
        if (hit) return hit;
      }
    }
  }
  // baseUrl fallback — try resolving the specifier under baseDir.
  const baseCandidate = path.join(cfg.baseDir, specifier);
  return tryExtensions(baseCandidate, extensions);
}

function tryExtensions(base: string, extensions: string[]): string | null {
  for (const ext of extensions) {
    const abs = `${base}${ext}`;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}
