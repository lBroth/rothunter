import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface UnsanitizedInputToSinkDetectorInput extends FileWalkingDetectorInput {}

interface Hit {
  file: string;
  line: number;
  sink: string;
  sinkLabel: string;
  taintedVar: string;
  source: string;
  snippet: string;
}

// Taint flow from a request-shaped source (`req.body.X` / `req.query.X`
// / `req.params.X` / `searchParams.get(...)`) into a dangerous sink:
// raw SQL template, `child_process.exec` / `execSync`, fs path
// concatenation, `eval` / `new Function`, dynamic `import()`. V1 is
// per-file flat-scope tainting — every variable bound from a request
// source becomes tainted for the whole file, and any sink whose
// argument interpolates / concatenates a tainted name fires. HIGH
// severity, confidence 0.7 (taint heuristics false-positive readily;
// the LLM confirmation pass keeps the dashboard honest).
//
// Sources scanned: `req.body.X`, `request.body.X`, `ctx.request.body.X`
// (Koa), `req.query.X`, `req.params.X`, `req.headers.X`,
// `searchParams.get('X')`, `useSearchParams().get('X')`,
// `formData.get('X')`. Variables assigned from any of these — or
// destructured from `req.body` / `req.query` / `req.params` — are
// considered tainted.
//
// Sinks recognised:
// - `db.query(`, `client.query(`, `connection.query(`, `prisma.$queryRaw(`,
//   `sql\`...\`` tagged template
// - `child_process.exec(`, `exec(`, `execSync(`, `spawn(`, `spawnSync(`
// - `fs.readFile(`, `fs.writeFile(`, `fs.unlink(`, `fs.readFileSync(`,
//   `fs.writeFileSync(`, `fs.unlinkSync(`, `fs.createReadStream(`,
//   `fs.createWriteStream(`, `fs.promises.readFile(`, `fs.promises.writeFile(`,
//   `fs.promises.unlink(`
// - `eval(`, `new Function(`
// - Dynamic `import(<tainted>)` with a template-literal argument
export function detectUnsanitizedInputToSink(
  input: UnsanitizedInputToSinkDetectorInput,
): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;

    const tainted = collectTaintedVars(raw);
    if (tainted.size === 0) continue;

    for (const hit of findSinkHits(rel, raw, tainted)) {
      if (hasIgnoreAnnotation(raw, hit.line, 'unsanitized-input-to-sink')) continue;
      const key = `${hit.file}:${hit.line}:${hit.sink}:${hit.taintedVar}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        detectorId: 'unsanitized-input-to-sink',
        severity: 'high',
        confidence: 0.7,
        layer: 1,
        title:
          `Unsanitised input \`${hit.taintedVar}\` flows into ${hit.sinkLabel} in ${hit.file}:${hit.line}`,
        description:
          `\`${hit.taintedVar}\` is bound from \`${hit.source}\` and reaches \`${hit.sink}\` at ${hit.file}:${hit.line} ` +
          `without going through a parser / parameterised query / shell-escape helper. ` +
          `Common live exploits at this shape: SQL injection (raw SQL sinks), command injection ` +
          `(\`exec\` / \`spawn\` sinks), arbitrary file read/write (fs sinks), arbitrary code execution ` +
          `(\`eval\` / \`new Function\` / dynamic import sinks).`,
        evidence: [
          {
            file: hit.file,
            range: { startLine: hit.line, endLine: hit.line },
            snippet: hit.snippet,
          },
        ],
        suggestion:
          `Parameterise the call (prepared statements, \`spawn(cmd, [args])\` instead of \`exec(\` + concat, ` +
          `path-allowlist for fs sinks). If the value is already validated, pass it through a typed parser ` +
          `(zod / a hand-written schema) so the validation is visible at the call-site — the detector will then ` +
          `see the parser output as the bound name and stop tainting it.`,
        fingerprint: `unsanitized-input-to-sink:${stableHash(key)}`,
      });
    }
  }
  return findings;
}

// ---------- tainted-variable extraction ----------

function collectTaintedVars(raw: string): Map<string, string> {
  const map = new Map<string, string>();

  const REQ_PROP_RE =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:req|request|ctx\.request)\s*\.\s*(?:body|query|params|headers)\s*\.\s*[A-Za-z_$][\w$]*)/g;
  for (const m of raw.matchAll(REQ_PROP_RE)) map.set(m[1]!, m[2]!);

  const REQ_DESTRUCTURE_RE =
    /\b(?:const|let|var)\s*\{\s*([^}]+?)\s*\}\s*=\s*((?:req|request|ctx\.request)\s*\.\s*(?:body|query|params|headers))/g;
  for (const m of raw.matchAll(REQ_DESTRUCTURE_RE)) {
    const source = m[2]!;
    for (const part of m[1]!.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const aliasMatch = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (aliasMatch) {
        map.set(aliasMatch[2]!, `${source}.${aliasMatch[1]!}`);
        continue;
      }
      const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (nameMatch) map.set(nameMatch[1]!, `${source}.${nameMatch[1]!}`);
    }
  }

  // searchParams / formData / urlParams .get('X')
  const GET_RE =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*get\s*\(\s*(['"`])([^'"`]+)\3\s*\)/g;
  for (const m of raw.matchAll(GET_RE)) {
    const sourceObj = m[2]!;
    if (!/searchParams|FormData|formData|params|urlParams|query/.test(sourceObj)) continue;
    map.set(m[1]!, `${sourceObj}.get('${m[4]!}')`);
  }

  return map;
}

// ---------- sink detection ----------

interface SinkPattern {
  re: RegExp;
  label: string;
}

const SINK_PATTERNS: SinkPattern[] = [
  { re: /\b((?:db|client|connection|conn|pool)\s*\.\s*query)\s*\(/g, label: 'a raw SQL query' },
  { re: /\b(prisma\s*\.\s*\$queryRaw(?:Unsafe)?)\s*\(/g, label: 'a Prisma raw query' },
  { re: /\b(prisma\s*\.\s*\$executeRaw(?:Unsafe)?)\s*\(/g, label: 'a Prisma raw execute' },
  { re: /\b((?:child_process\s*\.\s*)?(?:exec|execSync|spawn|spawnSync|execFile|execFileSync))\s*\(/g, label: 'a process-exec sink' },
  { re: /\b(fs(?:\s*\.\s*promises)?\s*\.\s*(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|createReadStream|createWriteStream|rm|rmSync))\s*\(/g, label: 'an fs path sink' },
  { re: /\b(eval)\s*\(/g, label: '`eval`' },
  { re: /\bnew\s+(Function)\s*\(/g, label: '`new Function`' },
  { re: /\b(import)\s*\(/g, label: 'dynamic `import()`' },
];

// Sink calls whose argument list interpolates / concatenates a tainted
// name. We extract just the argument-list slice and check it.
function findSinkHits(
  file: string,
  raw: string,
  tainted: Map<string, string>,
): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of SINK_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const m of raw.matchAll(pattern.re)) {
      const sink = m[1]!;
      const openParenIdx = m.index! + m[0].length - 1;
      const closeIdx = findCallEnd(raw, openParenIdx);
      if (closeIdx === -1) continue;
      const args = raw.slice(openParenIdx + 1, closeIdx);
      const hitVar = anyTaintedReferenced(args, tainted);
      if (hitVar == null) continue;
      hits.push({
        file,
        line: lineOf(raw, m.index!),
        sink,
        sinkLabel: pattern.label,
        taintedVar: hitVar,
        source: tainted.get(hitVar)!,
        snippet: snippetAt(raw, lineOf(raw, m.index!)),
      });
    }
  }

  // SQL tagged template — `sql\`SELECT … ${tainted} …\``. Different
  // shape: no parens to slice. Walk template literals tagged with
  // a SQL-shaped identifier and check their interpolations.
  const TAG_RE = /\b((?:sql|SQL|query|raw)\s*)\`([^`\\]*(?:\\.[^`\\]*)*)\`/g;
  for (const m of raw.matchAll(TAG_RE)) {
    const sink = m[1]!.trim();
    const body = m[2]!;
    const hitVar = templateTainted(body, tainted);
    if (hitVar == null) continue;
    hits.push({
      file,
      line: lineOf(raw, m.index!),
      sink: `${sink}\`...\``,
      sinkLabel: 'a tagged-template SQL sink',
      taintedVar: hitVar,
      source: tainted.get(hitVar)!,
      snippet: snippetAt(raw, lineOf(raw, m.index!)),
    });
  }
  return hits;
}

function anyTaintedReferenced(args: string, tainted: Map<string, string>): string | null {
  for (const name of tainted.keys()) {
    // The variable name must appear at a word boundary AND in a
    // template or string-concat context. Bare appearance like
    // `safeParse(user)` shouldn't fire — we only flag interpolation
    // (`\`${user}\``) or concat (`'… ' + user`).
    const tpl = new RegExp(`\\$\\{[^}]*\\b${escapeRe(name)}\\b[^}]*\\}`).test(args);
    if (tpl) return name;
    const concat = new RegExp(`['"\`][^'"\`]*['"\`]\\s*\\+\\s*[^,)]*\\b${escapeRe(name)}\\b`).test(args)
      || new RegExp(`\\b${escapeRe(name)}\\b[^,)]*\\s*\\+\\s*['"\`]`).test(args);
    if (concat) return name;
  }
  return null;
}

function templateTainted(body: string, tainted: Map<string, string>): string | null {
  const placeholderRe = /\$\{([^}]+)\}/g;
  for (const m of body.matchAll(placeholderRe)) {
    const expr = m[1]!;
    for (const name of tainted.keys()) {
      if (new RegExp(`\\b${escapeRe(name)}\\b`).test(expr)) return name;
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- utils ----------

function findCallEnd(raw: string, openParenIdx: number): number {
  let depth = 1;
  let inString: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = openParenIdx + 1; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1] ?? '';
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    // Template literals: don't follow ${...} depth here — the regex
    // for sink arg checking walks them on its own.
    if (ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  const to = Math.min(lines.length, line + 2);
  return lines.slice(from, to).join('\n');
}
