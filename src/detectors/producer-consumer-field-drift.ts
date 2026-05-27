import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface ProducerConsumerFieldDriftDetectorInput extends FileWalkingDetectorInput {}

interface ServerReads {
  url: string;
  method: string;
  file: string;
  line: number;
  fields: Set<string>;
}

interface ClientWrites {
  url: string;
  method: string;
  file: string;
  line: number;
  fields: Set<string>;
}

// API handler reads `req.body.foo` / `req.query.foo` for a route that
// no client in the workspace ever writes to. Builds (endpoint, server-
// reads) and (endpoint, client-writes) sets and diffs them. Catches
// the platonic "frontend renamed `email` → `userEmail`, backend still
// expects `email`" bug. v1 scope: Express / Fastify-style
// `app.<method>('/url', handler)` routes, fetch + axios callsites.
// Pure regex walk — fast (~10 ms on the rothunter source tree). HIGH
// confidence (0.85) on direct routes; we don't follow handler
// references across files yet.
export function detectProducerConsumerFieldDrift(
  input: ProducerConsumerFieldDriftDetectorInput,
): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);

  const servers: ServerReads[] = [];
  const clients: ClientWrites[] = [];

  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    extractServerRoutes(rel, raw, servers);
    extractClientCalls(rel, raw, clients);
  }

  // Key by `METHOD /url` so a GET and a POST to the same path don't
  // get matched.
  const clientsByEndpoint = new Map<string, ClientWrites[]>();
  for (const c of clients) {
    const k = endpointKey(c.method, c.url);
    const arr = clientsByEndpoint.get(k) ?? [];
    arr.push(c);
    clientsByEndpoint.set(k, arr);
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const s of servers) {
    const k = endpointKey(s.method, s.url);
    const matchingClients = clientsByEndpoint.get(k) ?? [];
    if (matchingClients.length === 0) continue; // no producer found at all — can't make a claim
    const clientFields = new Set<string>();
    for (const c of matchingClients) for (const f of c.fields) clientFields.add(f);

    const missing: string[] = [];
    for (const f of s.fields) {
      if (!clientFields.has(f)) missing.push(f);
    }
    if (missing.length === 0) continue;

    const rawSource = read(s.file) ?? '';
    if (hasIgnoreAnnotation(rawSource, s.line, 'producer-consumer-field-drift')) continue;

    const key = `${s.file}:${s.line}:${k}:${missing.sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      detectorId: 'producer-consumer-field-drift',
      severity: 'high',
      confidence: 0.85,
      layer: 1,
      title:
        `Producer/consumer drift on \`${s.method.toUpperCase()} ${s.url}\` — ` +
        `server reads ${missing.length} field${missing.length === 1 ? '' : 's'} ` +
        `no client sends (${s.file}:${s.line})`,
      description:
        `\`${s.method.toUpperCase()} ${s.url}\` reads \`${missing.join('`, `')}\` from req but ` +
        `${matchingClients.length} client callsite${matchingClients.length === 1 ? '' : 's'} ` +
        `(${matchingClients.map((c) => `${c.file}:${c.line}`).join(', ')}) ` +
        `never include those keys in the request body. ` +
        `Either the client is missing the field after a refactor, or the server reads a key it doesn't actually need.`,
      evidence: [
        {
          file: s.file,
          range: { startLine: s.line, endLine: s.line },
          snippet: snippetAt(rawSource, s.line),
        },
      ],
      suggestion:
        `Align the client and server: add the missing key${missing.length === 1 ? '' : 's'} to the request body on every callsite, ` +
        `or remove the read from the handler if the field was deprecated. ` +
        `If both sides genuinely disagree on the contract, lift the request shape to a shared type (zod schema, OpenAPI generation) so it can drift only with a compile error.`,
      fingerprint: `producer-consumer-field-drift:${stableHash(key)}`,
    });
  }
  return findings;
}

// ---------- server-side parsing ----------

// Match `app.post('/url', ...)`, `router.put('/url', ...)`,
// `fastify.get('/url', ...)`. Captures method + literal URL + the
// span of the handler body (everything from after the URL to the
// next top-level closing paren).
const SERVER_ROUTE_RE =
  /\b(?:app|router|fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2\s*,/g;

function extractServerRoutes(file: string, raw: string, out: ServerReads[]): void {
  SERVER_ROUTE_RE.lastIndex = 0;
  for (const m of raw.matchAll(SERVER_ROUTE_RE)) {
    const method = m[1]!.toLowerCase();
    const url = m[3]!;
    const handlerStart = m.index! + m[0].length;
    const handlerEnd = findCallEndIndex(raw, m.index! + m[0].length - 1);
    if (handlerEnd === -1) continue;
    const body = raw.slice(handlerStart, handlerEnd);
    const fields = collectReqFieldReads(body);
    if (fields.size === 0) continue;
    out.push({
      url,
      method,
      file,
      line: lineOf(raw, m.index!),
      fields,
    });
  }
}

// Find req.body.X / req.params.X / req.query.X plus destructuring:
// `const { x, y } = req.body`. Generic enough to also pick up
// `request.body.X` (Fastify default param name).
function collectReqFieldReads(handlerBody: string): Set<string> {
  const out = new Set<string>();
  const ACCESS_RE = /\b(?:req|request|ctx)\s*\.\s*(?:body|params|query)\s*\.\s*([A-Za-z_$][\w$]*)/g;
  for (const m of handlerBody.matchAll(ACCESS_RE)) out.add(m[1]!);

  const DESTRUCTURE_RE =
    /(?:const|let|var)\s*\{\s*([^}]+?)\s*\}\s*=\s*(?:req|request|ctx)\s*\.\s*(?:body|params|query)\b/g;
  for (const m of handlerBody.matchAll(DESTRUCTURE_RE)) {
    const inner = m[1]!;
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      // Handle `foo: bar` aliasing — the LHS (foo) is the key on the
      // request body. Handle `foo = default` — the LHS is the key.
      const keyMatch = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (keyMatch) out.add(keyMatch[1]!);
    }
  }
  return out;
}

// ---------- client-side parsing ----------

// fetch('/url', { method: 'POST', body: JSON.stringify({...}) })
// fetch('/url', { method: 'POST', body: {...} })
// fetch(`/url/${x}`, ...)  ← template strings: take the literal prefix only
const FETCH_RE = /\bfetch\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1\s*,\s*([^)]*\)?)?/g;
// axios.post('/url', { ... }, opts?)
const AXIOS_RE =
  /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2\s*(,\s*\{[^]*?\})?/g;

function extractClientCalls(file: string, raw: string, out: ClientWrites[]): void {
  // fetch
  FETCH_RE.lastIndex = 0;
  for (const m of raw.matchAll(FETCH_RE)) {
    const url = stripTemplatePlaceholders(m[2]!);
    const optsBlob = m[3] ?? '';
    const method = inferMethod(optsBlob);
    if (method == null) continue; // not a write-shape fetch we can analyse
    const fields = extractBodyFieldsFromOpts(optsBlob);
    if (fields.size === 0) continue;
    out.push({ url, method, file, line: lineOf(raw, m.index!), fields });
  }

  // axios
  AXIOS_RE.lastIndex = 0;
  for (const m of raw.matchAll(AXIOS_RE)) {
    const method = m[1]!.toLowerCase();
    if (method === 'get' || method === 'delete') continue; // no body convention
    const url = stripTemplatePlaceholders(m[3]!);
    const bodyLiteralBlob = m[4] ?? '';
    const fields = extractObjectKeysFromBlob(bodyLiteralBlob);
    if (fields.size === 0) continue;
    out.push({ url, method, file, line: lineOf(raw, m.index!), fields });
  }
}

function inferMethod(optsBlob: string): string | null {
  const m = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i.exec(optsBlob);
  if (m) return m[1]!.toLowerCase();
  // fetch without `method` defaults to GET → no body shape to analyse.
  return null;
}

function extractBodyFieldsFromOpts(optsBlob: string): Set<string> {
  const out = new Set<string>();
  // body: JSON.stringify({ a, b: 1, c })
  const stringify = /body\s*:\s*JSON\.stringify\s*\(\s*(\{[^]*?\})\s*\)/.exec(optsBlob);
  if (stringify) {
    for (const k of extractObjectKeysFromBlob(stringify[1]!)) out.add(k);
    return out;
  }
  // body: { a, b: 1, c }
  const inline = /body\s*:\s*(\{[^]*?\})/.exec(optsBlob);
  if (inline) {
    for (const k of extractObjectKeysFromBlob(inline[1]!)) out.add(k);
  }
  return out;
}

// Extract the top-level KEY names from a `{ ... }` blob. Naive depth
// tracker — skips nested objects/arrays. Handles `foo`, `foo: ...`,
// shorthand, spread `...x` (ignored).
function extractObjectKeysFromBlob(blob: string): Set<string> {
  const out = new Set<string>();
  // Strip the outer braces.
  const open = blob.indexOf('{');
  const close = blob.lastIndexOf('}');
  if (open === -1 || close === -1 || close <= open) return out;
  const inner = blob.slice(open + 1, close);
  let depth = 0;
  let buf = '';
  const flush = (): void => {
    const t = buf.trim();
    buf = '';
    if (t === '' || t.startsWith('...')) return;
    const m = /^([A-Za-z_$][\w$]*)/.exec(t);
    if (m) out.add(m[1]!);
  };
  for (const ch of inner) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function stripTemplatePlaceholders(raw: string): string {
  // Take the literal prefix up to the first `${`. URLs containing
  // path params (`/api/users/${id}`) match on their prefix; the
  // alternative is to refuse to compare them, which loses too much.
  const i = raw.indexOf('${');
  return i === -1 ? raw : raw.slice(0, i);
}

function endpointKey(method: string, url: string): string {
  // Trim trailing slash for case-folding tolerance.
  const u = url.replace(/\/+$/, '');
  return `${method.toLowerCase()} ${u}`;
}

// Find the index of the `)` that closes the call beginning at the
// `(` at `openParenIdx`. Naive depth tracker that ignores strings
// and comments — good enough for handler bodies.
function findCallEndIndex(raw: string, openParenIdx: number): number {
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
    if (ch === '"' || ch === "'" || ch === '`') {
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
