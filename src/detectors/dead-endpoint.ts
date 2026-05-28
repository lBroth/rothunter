import type { Finding } from '../types.js';
import { makeSourceReader } from '../utils/source-reader.js';
import { stableHash } from '../utils/hash.js';
import { hasIgnoreAnnotation } from '../utils/ignore-annotation.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface DeadEndpointDetectorInput extends FileWalkingDetectorInput {}

interface ServerRoute {
  url: string;
  method: string;
  file: string;
  line: number;
}

interface ClientCall {
  url: string;
  method: string;
}

// HTTP route declared on the server side (`app.<method>('/url', …)`
// or framework equivalent) that no fetch / axios callsite anywhere in
// the workspace bucket ever hits. Best signal in monorepo mode: pass
// every service repo through `rothunter.config.json` and let the
// detector spot routes whose callers have been removed. In a
// single-repo scan the detector still fires for internal routes the
// monolith stopped using, but a public-facing API consumed by an
// unscanned frontend will look dead too — flip the detector OFF or
// mark FP if that's your shape.
//
// Companion to producer-consumer-field-drift: that detector matches
// server-reads against client-writes for the SAME url; this one
// flags routes the matching fails on because there's no client at
// all.
//
// MED severity, confidence 0.8 — same FP modes as
// producer-consumer-field-drift (untracked external callers,
// dynamically constructed URLs). The LLM triage pass routes
// borderline cases to auto-FP.
export function detectDeadEndpoints(input: DeadEndpointDetectorInput): Finding[] {
  const read = makeSourceReader(input.workspaceRoot, input.project);

  const servers: ServerRoute[] = [];
  const clients: ClientCall[] = [];

  for (const rel of input.files) {
    if (!isAnalysable(rel)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    extractServerRoutes(rel, raw, servers);
    extractClientCalls(raw, clients);
  }

  if (servers.length === 0) return [];

  const clientKeys = new Set<string>();
  for (const c of clients) clientKeys.add(endpointKey(c.method, c.url));
  // Tolerate trailing-slash mismatches both ways.
  for (const c of clients) {
    clientKeys.add(endpointKey(c.method, c.url.replace(/\/+$/, '')));
    clientKeys.add(endpointKey(c.method, c.url + '/'));
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const s of servers) {
    const k = endpointKey(s.method, s.url);
    if (clientKeys.has(k)) continue;
    if (clientKeys.has(endpointKey(s.method, s.url.replace(/\/+$/, '')))) continue;
    if (clientKeys.has(endpointKey(s.method, s.url + '/'))) continue;

    const rawSource = read(s.file) ?? '';
    if (hasIgnoreAnnotation(rawSource, s.line, 'dead-endpoint')) continue;

    const dedupKey = `${s.file}:${s.line}:${k}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    findings.push({
      detectorId: 'dead-endpoint',
      severity: 'medium',
      confidence: 0.8,
      layer: 1,
      title: `Dead endpoint: \`${s.method.toUpperCase()} ${s.url}\` in ${s.file}:${s.line} — no client callsite`,
      description:
        `${s.method.toUpperCase()} ${s.url} is declared in ${s.file} but no fetch / axios callsite anywhere ` +
        `in the workspace bucket reaches that URL. ` +
        `Either delete the handler if it's genuinely orphaned, or — if the route is consumed by an ` +
        `unscanned external client (a public web frontend, a partner integration, a third-party caller) ` +
        `— add a \`// rothunter:ignore-dead-endpoint\` annotation above the route definition with a one-line ` +
        `reason. Best signal in monorepo mode where every linked service is in the scan; on a single ` +
        `repo the detector flags every public-facing route too.`,
      evidence: [
        {
          file: s.file,
          range: { startLine: s.line, endLine: s.line },
          snippet: snippetAt(rawSource, s.line),
        },
      ],
      suggestion:
        `Confirm there's no remaining caller (\`git grep "${s.url}"\` across every workspace), ` +
        `then either delete the route handler or mark the endpoint as public-facing with the ignore annotation.`,
      fingerprint: `dead-endpoint:${stableHash(dedupKey)}`,
    });
  }
  return findings;
}

// ---------- server-side parsing ----------

// Match `app.post('/url', ...)`, `router.put('/url', ...)`,
// `fastify.get('/url', ...)`. Captures method + literal URL.
const SERVER_ROUTE_RE =
  /\b(?:app|router|fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2\s*[,)]/g;

function extractServerRoutes(file: string, raw: string, out: ServerRoute[]): void {
  SERVER_ROUTE_RE.lastIndex = 0;
  for (const m of raw.matchAll(SERVER_ROUTE_RE)) {
    const method = m[1]!.toLowerCase();
    const url = m[3]!;
    out.push({
      url,
      method,
      file,
      line: lineOf(raw, m.index!),
    });
  }
}

// ---------- client-side parsing ----------

const FETCH_RE = /\bfetch\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1\s*(?:,\s*([^)]*))?\)/g;
const AXIOS_METHOD_RE =
  /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2/g;
const AXIOS_BARE_RE = /\baxios\s*\(\s*\{[^}]*url\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1[^}]*\}/g;

function extractClientCalls(raw: string, out: ClientCall[]): void {
  FETCH_RE.lastIndex = 0;
  for (const m of raw.matchAll(FETCH_RE)) {
    const url = stripTemplatePlaceholders(m[2]!);
    const optsBlob = m[3] ?? '';
    const method = inferMethod(optsBlob);
    out.push({ url, method });
  }

  AXIOS_METHOD_RE.lastIndex = 0;
  for (const m of raw.matchAll(AXIOS_METHOD_RE)) {
    out.push({ url: stripTemplatePlaceholders(m[3]!), method: m[1]!.toLowerCase() });
  }

  AXIOS_BARE_RE.lastIndex = 0;
  for (const m of raw.matchAll(AXIOS_BARE_RE)) {
    const blob = m[0];
    const methodMatch = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i.exec(
      blob,
    );
    const method = methodMatch ? methodMatch[1]!.toLowerCase() : 'get';
    out.push({ url: stripTemplatePlaceholders(m[2]!), method });
  }
}

function inferMethod(optsBlob: string): string {
  const m = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i.exec(optsBlob);
  if (m) return m[1]!.toLowerCase();
  return 'get';
}

function stripTemplatePlaceholders(raw: string): string {
  // Template strings: keep the literal prefix only. `/api/users/${id}`
  // becomes `/api/users/` — server routes that use the same prefix
  // (`/api/users/:id`) collide on the prefix after the colon-parameter
  // normalisation below.
  const i = raw.indexOf('${');
  return i === -1 ? raw : raw.slice(0, i);
}

function endpointKey(method: string, url: string): string {
  // Both sides collapse to the literal prefix that survives the
  // first variable segment:
  //   server `/api/users/:id` → `/api/users`
  //   client `/api/users/${id}` → already prefix-stripped → `/api/users`
  // A literal client URL with no template (`/api/users/42`) keeps its
  // tail, which means the detector will NOT match it against a
  // parametrised server route. Documented limitation — the LLM
  // verdict pass catches the common shape.
  const paramSplit = url.split('/:')[0]!;
  const templateSplit = paramSplit.split('${')[0]!;
  const trimmed = templateSplit.replace(/\/+$/, '');
  return `${method.toLowerCase()} ${trimmed}`;
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
