import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';
import { escapeForRegex } from '../utils/regex.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface BadConfigDetectorInput extends FileWalkingDetectorInput {}

// Flags anti-patterns in tsconfig*.json, eslint config, biome.json:
// disabled strict family, any-permitting rules off, legacy targets.
// Cites the exact JSON key path.
export function detectBadConfig(input: BadConfigDetectorInput): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  const candidates = discoverConfigFiles(input.workspaceRoot, input.files);
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.resolve(input.workspaceRoot, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (rel.endsWith('.json') || /\/tsconfig.*\.json$/.test(rel) || rel.endsWith('biome.json') || rel.endsWith('biome.jsonc')) {
      const parsed = tryParseJsonc(raw);
      if (!parsed) continue;
      if (isTsConfig(rel)) {
        // Resolve `extends` chain so inherited strict-family flags
        // count. Operators commonly put `strict: true` in
        // `tsconfig.base.json` and leave the leaf tsconfigs minimal;
        // flagging those leafs as "strict not set" is a false positive.
        const merged = mergeTsConfigExtends(input.workspaceRoot, rel, parsed);
        findings.push(...analyseTsConfig(rel, raw, merged));
      } else if (rel.endsWith('biome.json') || rel.endsWith('biome.jsonc')) findings.push(...analyseBiome(rel, raw, parsed));
      else if (isEslintJson(rel)) findings.push(...analyseEslint(rel, raw, parsed));
    } else if (isEslintScript(rel)) {
      findings.push(...analyseEslintScript(rel, raw));
    }
  }
  return findings;
}

/**
 * Walk the tsconfig `extends` chain (relative + bare specifiers),
 * merging parent `compilerOptions` under the child's. Bounded depth
 * (8) + a visited set guard against cyclic / pathological inheritance.
 * The merged object is what the rule checks read — so a leaf tsconfig
 * that only sets `outDir` no longer trips "strict not set" when its
 * base has `"strict": true`.
 */
function mergeTsConfigExtends(
  workspaceRoot: string,
  relConfig: string,
  raw: unknown,
  visited = new Set<string>(),
  depth = 0,
): unknown {
  if (depth >= 8) return raw;
  const root = asObj(raw);
  if (!root) return raw;
  const extendsValue = typeof root.extends === 'string' ? root.extends : null;
  if (!extendsValue) return raw;
  const configAbs = path.resolve(workspaceRoot, relConfig);
  if (visited.has(configAbs)) return raw;
  visited.add(configAbs);

  const configDir = path.dirname(configAbs);
  const parentAbs = resolveExtends(configDir, extendsValue);
  if (!parentAbs) return raw;

  let parentRaw: unknown;
  try {
    parentRaw = tryParseJsonc(readFileSync(parentAbs, 'utf-8'));
  } catch {
    return raw;
  }
  if (!parentRaw) return raw;

  const parentMerged = mergeTsConfigExtends(
    workspaceRoot,
    path.relative(workspaceRoot, parentAbs),
    parentRaw,
    visited,
    depth + 1,
  );
  const parentObj = asObj(parentMerged) ?? {};
  const parentCompiler = asObj(parentObj.compilerOptions) ?? {};
  const childCompiler = asObj(root.compilerOptions) ?? {};
  return {
    ...parentObj,
    ...root,
    compilerOptions: { ...parentCompiler, ...childCompiler },
  };
}

function resolveExtends(configDir: string, extendsValue: string): string | null {
  const tryPaths = (base: string): string | null => {
    if (existsSync(base)) return base;
    if (existsSync(`${base}.json`)) return `${base}.json`;
    return null;
  };
  if (extendsValue.startsWith('.') || extendsValue.startsWith('/')) {
    return tryPaths(path.resolve(configDir, extendsValue));
  }
  // Bare specifier — walk node_modules up.
  let cur = configDir;
  while (cur !== path.dirname(cur)) {
    const candidate = path.join(cur, 'node_modules', extendsValue);
    const hit = tryPaths(candidate);
    if (hit) return hit;
    cur = path.dirname(cur);
  }
  return null;
}

function discoverConfigFiles(workspaceRoot: string, files: ReadonlyArray<string>): string[] {
  const fromParse = files.filter((f) => isConfigFile(f));
  // The parsed file set covers .ts/.tsx — but tsconfig/eslint are JSON or
  // pre-import JS, so they're invisible to the symbol parser. Do a light
  // scan of the workspace root for the common config filenames.
  const fromRoot: string[] = [];
  for (const name of CONFIG_ROOT_FILES) {
    const candidate = path.join(workspaceRoot, name);
    if (existsSync(candidate)) fromRoot.push(name);
  }
  // Pick up tsconfig.something.json variants too.
  try {
    for (const entry of readdirSync(workspaceRoot)) {
      if (/^tsconfig(\..+)?\.json$/.test(entry)) fromRoot.push(entry);
    }
  } catch {
    // workspace unreadable — fall through
  }
  // Also pick tsconfig.json from immediate sub-packages (monorepo roots).
  try {
    for (const entry of readdirSync(workspaceRoot)) {
      const sub = path.join(workspaceRoot, entry);
      let s;
      try {
        s = statSync(sub);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      for (const name of CONFIG_ROOT_FILES) {
        const candidate = path.join(sub, name);
        if (existsSync(candidate)) fromRoot.push(path.join(entry, name));
      }
    }
  } catch {
    // ignore
  }
  return [...new Set([...fromParse, ...fromRoot])];
}

const CONFIG_ROOT_FILES = [
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'biome.json',
  'biome.jsonc',
];

function isConfigFile(file: string): boolean {
  return /(^|\/)(tsconfig.*\.json|\.eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?)$/.test(
    file.replace(/\\/g, '/'),
  );
}

function isTsConfig(file: string): boolean {
  return /(^|\/)tsconfig.*\.json$/.test(file.replace(/\\/g, '/'));
}

function isEslintJson(file: string): boolean {
  return /(^|\/)\.eslintrc(\.json)?$/.test(file.replace(/\\/g, '/'));
}

function isEslintScript(file: string): boolean {
  return /(^|\/)\.?eslintrc?\.(js|cjs|mjs|ts)$/.test(file.replace(/\\/g, '/'))
    || /(^|\/)eslint\.config\.(js|mjs|cjs|ts)$/.test(file.replace(/\\/g, '/'));
}

/**
 * Lightweight JSONC parser: strips // line comments, /* block comments,
 * and trailing commas before JSON.parse. tsconfig.json + biome.jsonc
 * accept all three; the editor-quoted location lines aren't affected
 * because we only use this for value lookup, not editing.
 */
function tryParseJsonc(text: string): unknown | null {
  try {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"\\])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

interface JsonObj {
  [k: string]: unknown;
}

function asObj(v: unknown): JsonObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObj) : null;
}

function analyseTsConfig(file: string, raw: string, parsed: unknown): Finding[] {
  const root = asObj(parsed);
  if (!root) return [];
  const compilerOptions = asObj(root.compilerOptions) ?? {};
  const out: Finding[] = [];

  // strict family
  if (compilerOptions.strict === false) {
    out.push(makeFinding({
      file, raw, key: 'strict',
      detectorId: 'bad-config',
      severity: 'high',
      title: 'tsconfig: \`strict\` disabled',
      blurb: '`"strict": false` opts out of the umbrella that enables `noImplicitAny`, `strictNullChecks`, and other safety nets in one go. Code compiled under this setting silently accepts `any` and undefined-prone access.',
      suggestion: 'Set `"strict": true` and burn down the resulting type errors. Use file-level `// @ts-expect-error` to triage gradually.',
    }));
  } else if (compilerOptions.strict === undefined && compilerOptions.noImplicitAny !== true && compilerOptions.strictNullChecks !== true) {
    out.push(makeFinding({
      file, raw, key: 'compilerOptions',
      detectorId: 'bad-config',
      severity: 'medium',
      title: 'tsconfig: \`strict\` not set',
      blurb: 'Without `"strict": true` (and no explicit sub-flags), `noImplicitAny` and `strictNullChecks` default to false. Most type-safety guarantees are off.',
      suggestion: 'Add `"strict": true` to `compilerOptions`.',
    }));
  }
  if (compilerOptions.noImplicitAny === false) {
    out.push(makeFinding({
      file, raw, key: 'noImplicitAny',
      detectorId: 'bad-config',
      severity: 'high',
      title: 'tsconfig: \`noImplicitAny\` disabled',
      blurb: 'Untyped parameters silently become `any`. Refactors lose type-safety guarantees and a whole class of bugs becomes invisible.',
      suggestion: 'Remove the override or set `"noImplicitAny": true`. Type the remaining offenders explicitly.',
    }));
  }
  if (compilerOptions.strictNullChecks === false) {
    out.push(makeFinding({
      file, raw, key: 'strictNullChecks',
      detectorId: 'bad-config',
      severity: 'high',
      title: 'tsconfig: \`strictNullChecks\` disabled',
      blurb: '`null` and `undefined` are silently allowed in every value, defeating the most common class of runtime errors TS is meant to catch.',
      suggestion: 'Set `"strictNullChecks": true` (or `"strict": true`). Use `?` and explicit unions where null is a legal value.',
    }));
  }
  if (compilerOptions.noImplicitReturns === false) {
    out.push(makeFinding({
      file, raw, key: 'noImplicitReturns',
      detectorId: 'bad-config',
      severity: 'low',
      title: 'tsconfig: \`noImplicitReturns\` disabled',
      blurb: 'Functions can fall off the end without returning a value, returning `undefined` implicitly even when the type annotation forbids it.',
      suggestion: 'Set `"noImplicitReturns": true`.',
    }));
  }
  if (compilerOptions.noFallthroughCasesInSwitch === false) {
    out.push(makeFinding({
      file, raw, key: 'noFallthroughCasesInSwitch',
      detectorId: 'bad-config',
      severity: 'low',
      title: 'tsconfig: \`noFallthroughCasesInSwitch\` disabled',
      blurb: 'Missing `break` / `return` in switch cases silently falls through — a famous source of off-by-one bugs.',
      suggestion: 'Set `"noFallthroughCasesInSwitch": true`.',
    }));
  }
  if (compilerOptions.noUnusedLocals === false || compilerOptions.noUnusedParameters === false) {
    out.push(makeFinding({
      file, raw, key: compilerOptions.noUnusedLocals === false ? 'noUnusedLocals' : 'noUnusedParameters',
      detectorId: 'bad-config',
      severity: 'low',
      title: 'tsconfig: unused-symbol checks disabled',
      blurb: 'Unused locals/parameters accumulate as dead code and mask refactor mistakes.',
      suggestion: 'Enable `"noUnusedLocals": true` and `"noUnusedParameters": true`. Prefix intentionally unused params with `_`.',
    }));
  }
  if (compilerOptions.noUncheckedIndexedAccess === false) {
    out.push(makeFinding({
      file, raw, key: 'noUncheckedIndexedAccess',
      detectorId: 'bad-config',
      severity: 'low',
      title: 'tsconfig: \`noUncheckedIndexedAccess\` disabled',
      blurb: '`array[i]` is typed `T` instead of `T | undefined`. Out-of-bounds access is invisible to the type-checker.',
      suggestion: 'Set `"noUncheckedIndexedAccess": true` and handle the `undefined` case at each index.',
    }));
  }
  if (compilerOptions.allowJs === true && compilerOptions.checkJs !== true) {
    out.push(makeFinding({
      file, raw, key: 'allowJs',
      detectorId: 'bad-config',
      severity: 'medium',
      title: 'tsconfig: \`allowJs\` without \`checkJs\`',
      blurb: 'JS files are bundled with the TS project but not type-checked, so they leak unchecked `any` types into every importer.',
      suggestion: 'Either remove `"allowJs"` once the migration is done, or add `"checkJs": true` to type-check the JS too.',
    }));
  }
  if (compilerOptions.skipLibCheck === false) {
    // Not actually a bad practice in most cases; skip.
  }
  if (typeof compilerOptions.target === 'string' && /^(ES3|ES5)$/i.test(compilerOptions.target)) {
    out.push(makeFinding({
      file, raw, key: 'target',
      detectorId: 'bad-config',
      severity: 'low',
      title: `tsconfig: \`target\` is ${compilerOptions.target}`,
      blurb: 'Pre-ES2015 target ships heavy polyfills, breaks async/await without runtime, and signals an old toolchain.',
      suggestion: 'Bump `"target"` to `ES2020` or newer (Node 16+ supports it natively).',
    }));
  }
  if (typeof compilerOptions.module === 'string' && compilerOptions.module.toLowerCase() === 'commonjs' && !file.endsWith('tsconfig.base.json')) {
    out.push(makeFinding({
      file, raw, key: 'module',
      detectorId: 'bad-config',
      severity: 'low',
      title: 'tsconfig: \`module\` is CommonJS',
      blurb: 'CommonJS output blocks top-level `await`, ESM-only deps, and complicates bundler interop. ESM is the default in modern toolchains.',
      suggestion: 'Move to `"module": "ESNext"` (or `"NodeNext"` on Node), and `"moduleResolution": "Bundler"` (or `"NodeNext"`).',
    }));
  }
  if (compilerOptions.suppressImplicitAnyIndexErrors === true || compilerOptions.suppressExcessPropertyErrors === true) {
    out.push(makeFinding({
      file, raw, key: compilerOptions.suppressImplicitAnyIndexErrors === true ? 'suppressImplicitAnyIndexErrors' : 'suppressExcessPropertyErrors',
      detectorId: 'bad-config',
      severity: 'high',
      title: 'tsconfig: error-suppression flag enabled',
      blurb: '`suppressImplicitAnyIndexErrors` / `suppressExcessPropertyErrors` silence whole classes of errors. Both are documented escape hatches the TS team discourages.',
      suggestion: 'Remove the suppression flag and fix the underlying errors (typed index signatures, exact object shapes).',
    }));
  }
  return out;
}

function analyseEslint(file: string, raw: string, parsed: unknown): Finding[] {
  const root = asObj(parsed);
  if (!root) return [];
  const rules = asObj(root.rules) ?? {};
  return analyseEslintRules(file, raw, rules);
}

function analyseEslintRules(file: string, raw: string, rules: JsonObj): Finding[] {
  const out: Finding[] = [];
  const BAD: Record<string, { sev: 'high' | 'medium' | 'low'; title: string; blurb: string; suggestion: string }> = {
    '@typescript-eslint/no-explicit-any': {
      sev: 'high',
      title: 'eslint: \`no-explicit-any\` disabled',
      blurb: '`any` defeats type-checking by design. Disabling this rule across the project is the lint-config equivalent of `strict:false`.',
      suggestion: 'Re-enable the rule, fix offenders with `unknown` or generics, and use eslint-disable comments for the few legitimate cases.',
    },
    '@typescript-eslint/no-non-null-assertion': {
      sev: 'medium',
      title: 'eslint: \`no-non-null-assertion\` disabled',
      blurb: '`foo!` overrides the type-checker. Disabling the rule globally normalises a pattern that silently crashes at runtime when the assumption fails.',
      suggestion: 'Keep the rule on; opt out with a comment + reason at the rare site that actually needs it.',
    },
    '@typescript-eslint/no-unused-vars': {
      sev: 'low',
      title: 'eslint: \`no-unused-vars\` disabled',
      blurb: 'Unused imports / vars accumulate, masking refactor mistakes and inflating bundle size.',
      suggestion: 'Re-enable; prefix intentional throwaways with `_`.',
    },
    'eqeqeq': {
      sev: 'low',
      title: 'eslint: \`eqeqeq\` disabled',
      blurb: '`==` coercion bugs are still real. Disabling the rule allows accidental `null == 0` weirdness.',
      suggestion: 'Re-enable with `"always"`.',
    },
  };
  for (const [name, cfg] of Object.entries(BAD)) {
    const val = rules[name];
    if (val == null) continue;
    if (val === 'off' || val === 0 || (Array.isArray(val) && (val[0] === 'off' || val[0] === 0))) {
      out.push(makeFinding({
        file, raw, key: name,
        detectorId: 'bad-config',
        severity: cfg.sev,
        title: cfg.title,
        blurb: cfg.blurb,
        suggestion: cfg.suggestion,
      }));
    }
  }
  return out;
}

function analyseEslintScript(file: string, raw: string): Finding[] {
  // Best-effort heuristic for `eslint.config.js` (Flat) and legacy
  // `.eslintrc.js` — we can't execute the module safely, so we regex for
  // rule lines like `'@typescript-eslint/no-explicit-any': 'off'`.
  const out: Finding[] = [];
  const PATTERNS: Array<{
    name: string;
    re: RegExp;
    sev: 'high' | 'medium' | 'low';
    title: string;
    blurb: string;
    suggestion: string;
  }> = [
    {
      name: '@typescript-eslint/no-explicit-any',
      re: /['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*\[?\s*['"]?off['"]?|['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*0\b/,
      sev: 'high',
      title: 'eslint: \`no-explicit-any\` disabled',
      blurb: '`any` defeats type-checking by design. Disabling this rule across the project is the lint-config equivalent of `strict:false`.',
      suggestion: 'Re-enable; fix offenders with `unknown` or generics.',
    },
    {
      name: '@typescript-eslint/no-non-null-assertion',
      re: /['"]@typescript-eslint\/no-non-null-assertion['"]\s*:\s*\[?\s*['"]?off['"]?/,
      sev: 'medium',
      title: 'eslint: \`no-non-null-assertion\` disabled',
      blurb: '`foo!` overrides the type-checker; rule should stay on.',
      suggestion: 'Keep the rule on; opt out at site with a comment.',
    },
    {
      name: '@typescript-eslint/no-unused-vars',
      re: /['"]@typescript-eslint\/no-unused-vars['"]\s*:\s*\[?\s*['"]?off['"]?/,
      sev: 'low',
      title: 'eslint: \`no-unused-vars\` disabled',
      blurb: 'Unused imports / vars accumulate, masking refactors.',
      suggestion: 'Re-enable; prefix intentional throwaways with `_`.',
    },
    {
      name: 'eqeqeq',
      re: /['"]eqeqeq['"]\s*:\s*\[?\s*['"]?off['"]?/,
      sev: 'low',
      title: 'eslint: \`eqeqeq\` disabled',
      blurb: '`==` coercion bugs are still real.',
      suggestion: 'Re-enable with `"always"`.',
    },
  ];
  for (const p of PATTERNS) {
    const m = p.re.exec(raw);
    if (!m) continue;
    out.push(makeFinding({
      file, raw, key: p.name, indexOverride: m.index,
      detectorId: 'bad-config',
      severity: p.sev,
      title: p.title,
      blurb: p.blurb,
      suggestion: p.suggestion,
    }));
  }
  return out;
}

function analyseBiome(file: string, raw: string, parsed: unknown): Finding[] {
  const root = asObj(parsed);
  if (!root) return [];
  const linter = asObj(root.linter) ?? {};
  const rulesGroup = asObj(linter.rules) ?? {};
  const suspicious = asObj(rulesGroup.suspicious) ?? {};
  const style = asObj(rulesGroup.style) ?? {};
  const out: Finding[] = [];
  if (suspicious.noExplicitAny === 'off') {
    out.push(makeFinding({
      file, raw, key: 'noExplicitAny',
      detectorId: 'bad-config',
      severity: 'high',
      title: 'biome: \`noExplicitAny\` disabled',
      blurb: '`any` defeats type-checking by design.',
      suggestion: 'Re-enable; fix offenders with `unknown` or generics.',
    }));
  }
  if (style.noNonNullAssertion === 'off') {
    out.push(makeFinding({
      file, raw, key: 'noNonNullAssertion',
      detectorId: 'bad-config',
      severity: 'medium',
      title: 'biome: \`noNonNullAssertion\` disabled',
      blurb: '`foo!` overrides the type-checker.',
      suggestion: 'Keep on; opt out at site with a comment.',
    }));
  }
  if (linter.enabled === false) {
    out.push(makeFinding({
      file, raw, key: 'linter.enabled',
      detectorId: 'bad-config',
      severity: 'medium',
      title: 'biome: linter disabled',
      blurb: 'The whole linter is off — lint findings will never reach the developer.',
      suggestion: 'Set `"enabled": true` and tune individual rules instead.',
    }));
  }
  return out;
}

interface MakeFindingArgs {
  file: string;
  raw: string;
  key: string;
  detectorId: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  blurb: string;
  suggestion: string;
  indexOverride?: number;
}

function makeFinding(args: MakeFindingArgs): Finding {
  const { line, snippetLines } = locateInSource(args.raw, args.key, args.indexOverride);
  return {
    detectorId: args.detectorId,
    severity: args.severity,
    confidence: 0.95,
    layer: 1,
    title: `${args.title} \`${args.file}\``,
    description: args.blurb,
    evidence: [
      {
        file: args.file,
        range: { startLine: line, endLine: line },
        snippet: snippetLines.join('\n'),
      },
    ],
    suggestion: args.suggestion,
    fingerprint: `bad-config:${stableHash(`${args.file}:${args.key}`)}`,
  };
}

function locateInSource(raw: string, key: string, indexOverride?: number): { line: number; snippetLines: string[] } {
  const idx = indexOverride ?? findKeyIndex(raw, key);
  const lines = raw.split('\n');
  if (idx < 0) {
    return { line: 1, snippetLines: lines.slice(0, Math.min(3, lines.length)) };
  }
  const preceding = raw.slice(0, idx);
  const line = preceding.split('\n').length;
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 2);
  return { line, snippetLines: lines.slice(start, end) };
}

function findKeyIndex(raw: string, key: string): number {
  // Look for `"key"` or `'key'` followed by `:` — handles both JSONC and
  // JS-style config dumps.
  const re = new RegExp(`["']${escapeForRegex(key)}["']\\s*:`);
  const m = re.exec(raw);
  return m ? m.index : -1;
}


