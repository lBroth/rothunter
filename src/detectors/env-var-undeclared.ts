import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import { loadGitignore, enumerateSourceFiles } from '../utils/gitignore.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface EnvVarUndeclaredDetectorInput extends FileWalkingDetectorInput {}

interface EnvUsage {
  name: string;
  file: string;
  line: number;
}

interface EnvDeclaration {
  name: string;
  source: string;
}

// Environment variables read in source (`process.env.X`,
// `process.env['X']`, `import.meta.env.X`) that don't appear in any
// declaration file (.env.example / .env.sample / .env.template,
// Dockerfile ENV / ARG, docker-compose environment:, GitHub Actions
// env:, `envalid` / `zod` / `t3-env` schemas). Catches the classic
// "works on my machine, undefined in prod" deploy bug. MED severity.
//
// Also emits a paired "dead env declaration" finding (LOW) when a
// variable is declared in .env.example but never referenced in code —
// drift in the opposite direction.
export function detectEnvVarUndeclared(input: EnvVarUndeclaredDetectorInput): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const usages: EnvUsage[] = [];
  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    collectUsages(rel, raw, usages);
  }

  const declarations = collectDeclarations(input.workspaceRoot);
  const declaredNames = new Set(declarations.map((d) => d.name));

  const findings: Finding[] = [];
  const seenUndeclared = new Set<string>();
  for (const u of usages) {
    if (declaredNames.has(u.name)) continue;
    if (isBuiltinEnvVar(u.name)) continue;
    if (hasIgnoreAnnotation(read(u.file) ?? '', u.line, 'env-var-undeclared')) continue;
    // One finding per (name, file) — multiple reads in the same file
    // collapse into one report.
    const key = `${u.name}::${u.file}`;
    if (seenUndeclared.has(key)) continue;
    seenUndeclared.add(key);
    const declSources =
      declarations.length === 0
        ? '(no env declaration files found)'
        : declarations
            .map((d) => d.source)
            .filter((s, i, a) => a.indexOf(s) === i)
            .join(', ');
    findings.push({
      detectorId: 'env-var-undeclared',
      severity: 'medium',
      confidence: 0.9,
      layer: 1,
      title: `Env var \`${u.name}\` used in ${u.file}:${u.line} but not declared`,
      description:
        `\`process.env.${u.name}\` (or \`import.meta.env.${u.name}\`) is read at runtime but no .env.example / dotenv schema / Dockerfile / compose file declares it. ` +
        `Scanned: ${declSources}. ` +
        `Either the variable is missing from your distributed example file (new contributors and prod boxes get \`undefined\`), or the read should be removed.`,
      evidence: [
        {
          file: u.file,
          range: { startLine: u.line, endLine: u.line },
          snippet: snippetAt(read(u.file) ?? '', u.line),
        },
      ],
      suggestion:
        `Add \`${u.name}=\` (with a sensible default or empty placeholder) to your .env.example, dotenv schema, ` +
        `or Dockerfile ENV — whichever file your project uses as the canonical env contract.`,
      fingerprint: `env-var-undeclared:${stableHash(`${u.name}::${u.file}`)}`,
    });
  }

  // Paired "dead env declaration": a variable in .env.example never
  // referenced in code. LOW signal — common during incremental config
  // cleanup — but useful to surface when paired with the undeclared
  // direction.
  if (declarations.length > 0) {
    const readNames = new Set(usages.map((u) => u.name));
    const reportedDead = new Set<string>();
    for (const d of declarations) {
      if (readNames.has(d.name)) continue;
      if (reportedDead.has(d.name)) continue;
      reportedDead.add(d.name);
      findings.push({
        detectorId: 'env-var-undeclared',
        severity: 'low',
        confidence: 0.85,
        layer: 1,
        title: `Dead env declaration: \`${d.name}\` in ${d.source} (never read)`,
        description:
          `\`${d.name}\` appears in ${d.source} but no source file reads \`process.env.${d.name}\` / \`import.meta.env.${d.name}\`. ` +
          `Either the variable was removed from code and forgotten in config, or the read happens via dynamic indexing (\`process.env[someVar]\`) which this detector can't trace.`,
        evidence: [
          {
            file: d.source,
            range: { startLine: 1, endLine: 1 },
            snippet: `${d.name}=…`,
          },
        ],
        suggestion: `Remove the unused entry, or — if it's read via dynamic indexing — add a \`// rothunter:ignore-env-var-undeclared\` comment alongside that read.`,
        fingerprint: `env-var-undeclared-dead:${stableHash(`${d.name}::${d.source}`)}`,
      });
    }
  }

  return findings;
}

// Source-code matchers. We allow both dot- and bracket-access; the
// bracket form must use a STRING literal — dynamic keys can't be
// resolved by a regex pass and are left to the operator.
const PROCESS_ENV_DOT_RE = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;
const PROCESS_ENV_BRACKET_RE = /\bprocess\.env\[(?:"|')([A-Z_][A-Z0-9_]*)(?:"|')\]/g;
const IMPORT_META_ENV_DOT_RE = /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g;
const IMPORT_META_ENV_BRACKET_RE = /\bimport\.meta\.env\[(?:"|')([A-Z_][A-Z0-9_]*)(?:"|')\]/g;

function collectUsages(file: string, raw: string, out: EnvUsage[]): void {
  for (const re of [
    PROCESS_ENV_DOT_RE,
    PROCESS_ENV_BRACKET_RE,
    IMPORT_META_ENV_DOT_RE,
    IMPORT_META_ENV_BRACKET_RE,
  ]) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const name = m[1]!;
      out.push({ name, file, line: lineOf(raw, m.index!) });
    }
  }
}

function collectDeclarations(workspaceRoot: string): EnvDeclaration[] {
  const decls: EnvDeclaration[] = [];
  const gitignore = loadGitignore(workspaceRoot);

  // .env-style files. Skip `.env` itself (operator's real secrets) and
  // `.env.local` (machine-local overrides). Read every `.env*.example`,
  // `.env*.sample`, `.env*.template`, and the canonical `.env.example`
  // / `.env.sample` / `.env.template` names.
  const envFiles = enumerateSourceFiles(workspaceRoot, gitignore, [
    '.example',
    '.sample',
    '.template',
  ]);
  // The matcher above relies on extension, but `.env.example` has
  // a multi-dot name — fall back to a direct walk of the workspace
  // root for the canonical names.
  const rootCandidates = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
  ];
  for (const c of rootCandidates) {
    const abs = path.join(workspaceRoot, c);
    if (fs.existsSync(abs)) envFiles.push(c);
  }
  for (const rel of new Set(envFiles)) {
    const abs = path.join(workspaceRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
      if (m) decls.push({ name: m[1]!, source: rel });
    }
  }

  // Dockerfile ENV + ARG. Walk recursively for files literally named
  // `Dockerfile` or matching `Dockerfile.*`.
  const dockerfiles = findFilesByName(workspaceRoot, gitignore, /^Dockerfile(?:\..+)?$/);
  for (const rel of dockerfiles) {
    const abs = path.join(workspaceRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const env = /^\s*(?:ENV|ARG)\s+([A-Z_][A-Z0-9_]*)/i.exec(line);
      if (env) decls.push({ name: env[1]!, source: rel });
    }
  }

  // docker-compose.{yml,yaml} — under `environment:` blocks. Cheap
  // line-by-line parse: any `      KEY:` or `      KEY=value` under an
  // `environment:` key counts. The YAML may be valid in shapes we
  // can't parse without a YAML lib, so we accept some recall loss.
  const composeFiles = findFilesByName(
    workspaceRoot,
    gitignore,
    /^docker-compose(?:\..+)?\.ya?ml$/i,
  );
  for (const rel of composeFiles) {
    const abs = path.join(workspaceRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    let inEnv = false;
    let envIndent = -1;
    for (const line of raw.split(/\r?\n/)) {
      const indent = line.search(/\S/);
      if (/^\s*environment\s*:/.test(line)) {
        inEnv = true;
        envIndent = indent;
        continue;
      }
      if (inEnv) {
        if (indent <= envIndent && line.trim() !== '') {
          inEnv = false;
          continue;
        }
        const m = /^\s*(?:-\s*)?([A-Z_][A-Z0-9_]*)\s*[=:]/.exec(line);
        if (m) decls.push({ name: m[1]!, source: rel });
      }
    }
  }

  return decls;
}

// Recursive name-based search honouring .gitignore. Used for files
// without a fixed extension (Dockerfile, docker-compose.yml).
function findFilesByName(
  workspaceRoot: string,
  gitignore: ReturnType<typeof loadGitignore>,
  pattern: RegExp,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (gitignore.ignores(`${childRel}/`)) continue;
        walk(path.join(dir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (gitignore.ignores(childRel)) continue;
      if (pattern.test(entry.name)) out.push(childRel);
    }
  };
  walk(workspaceRoot, '');
  return out;
}

// Well-known runtime-provided env vars — Node sets these without an
// .env file. Flagging them produces pure noise.
const BUILTIN_ENV = new Set<string>([
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'HOME',
  'USER',
  'PWD',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'GITHUB_REF',
  'TERM',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
]);

function isBuiltinEnvVar(name: string): boolean {
  return BUILTIN_ENV.has(name);
}

function isAnalysable(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file);
}

function lineOf(raw: string, idx: number): number {
  return raw.slice(0, idx).split('\n').length;
}

function snippetAt(raw: string, line: number): string {
  const lines = raw.split('\n');
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}
