import * as path from 'node:path';
import { Project, SyntaxKind, type CallExpression, type Node } from 'ts-morph';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';
import { trimSnippet, trimEnclosingSource } from '../utils/snippet.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface ApiRaceDetectorInput extends FileWalkingDetectorInput {}

interface ApiWriteCall {
  method: string; // upper-cased: PUT / PATCH / POST / DELETE
  pathPattern: string; // normalised path e.g. `/api/users/:id`
  file: string;
  line: number;
  endLine: number;
  snippet: string;
  enclosingName?: string;
  enclosingSource: string;
  client: string; // fetch | axios | got | ky | superagent
}

// Indexes PUT/PATCH/POST/DELETE calls by (method, normalized path); flags
// clusters touched by ≥2 caller files. Clients: fetch, axios, got, ky,
// superagent. GET excluded. Path interpolations + numeric segments → `:param`.
export function detectApiRaces(input: ApiRaceDetectorInput): Finding[] {
  let project: Project;
  if (input.project) {
    project = input.project;
  } else {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    for (const rel of input.files) {
      project.addSourceFileAtPathIfExists(path.join(input.workspaceRoot, rel));
    }
  }

  const calls: ApiWriteCall[] = [];
  for (const sf of project.getSourceFiles()) {
    const relativeFile = path.relative(input.workspaceRoot, sf.getFilePath());
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const matched = matchHttpClient(call);
      if (!matched) continue;
      const enclosing = findEnclosingFunction(call);
      const enclosingSource = enclosing
        ? trimEnclosingSource((enclosing as { getText(): string }).getText())
        : trimSnippet(call.getText());
      const enclosingName =
        (enclosing as { getName?: () => string | undefined } | null)?.getName?.() ?? undefined;
      calls.push({
        method: matched.method,
        pathPattern: matched.pathPattern,
        file: relativeFile,
        line: call.getStartLineNumber(),
        endLine: call.getEndLineNumber(),
        snippet: trimSnippet(call.getText()),
        enclosingName,
        enclosingSource,
        client: matched.client,
      });
    }
  }

  const byKey = new Map<string, ApiWriteCall[]>();
  for (const c of calls) {
    const key = `${c.method} ${c.pathPattern}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }

  const findings: Finding[] = [];
  for (const [key, list] of byKey) {
    const distinctFiles = new Set(list.map((c) => c.file));
    if (distinctFiles.size < 2) continue;

    const clients = [...new Set(list.map((c) => c.client))];
    const exampleFiles = [...distinctFiles].slice(0, 6).join(', ');

    findings.push({
      detectorId: 'api-race',
      severity: 'medium',
      confidence: 0.65,
      layer: 1,
      title: `Shared API write: \`${key}\` called from ${distinctFiles.size} files (${list.length} call sites, clients: ${clients.join('+')})`,
      description: [
        `Multiple functions issue mutating HTTP calls against \`${key}\`.`,
        `If any two of these can execute concurrently (browser + worker, two services, a job that retries while the user hits PATCH), the server may see two writes against the same resource — lost update if the server has no optimistic-locking version.`,
        ``,
        `Locations:`,
        ...list.map((c) => `- ${c.file}:${c.line} (${c.client}) \`${c.snippet}\``),
        ``,
        `Files involved: ${exampleFiles}${distinctFiles.size > 6 ? ', …' : ''}`,
      ].join('\n'),
      evidence: list.slice(0, 8).map((c) => ({
        file: c.file,
        range: { startLine: c.line, endLine: c.endLine },
        snippet: c.enclosingSource,
        note: JSON.stringify({
          method: c.method,
          pathPattern: c.pathPattern,
          client: c.client,
          enclosingName: c.enclosingName ?? '',
        }),
      })),
      suggestion:
        'Add an `If-Match` / version-aware update on the server, single-flight the client calls, or merge the duplicated callers into one. If the calls are guaranteed serialised by a queue, document the synchronisation and mark this finding as a false positive.',
      fingerprint: `api-race:${stableHash(key)}`,
    });
  }
  return findings;
}

interface HttpMatch {
  method: string;
  pathPattern: string;
  client: string;
}

const FETCH_LIKE = new Set(['fetch']);
const HTTP_CLIENTS = new Set(['axios', 'got', 'ky', 'superagent', 'request', 'apiClient', 'http']);
const WRITE_VERBS = new Set(['put', 'patch', 'post', 'delete']);

function matchHttpClient(call: CallExpression): HttpMatch | null {
  const callee = call.getExpression();

  // fetch(url, { method: 'PUT', ... })
  if (callee.getKind() === SyntaxKind.Identifier && FETCH_LIKE.has(callee.getText())) {
    const args = call.getArguments();
    if (args.length < 2) return null;
    const url = extractUrlLiteral(args[0]!);
    if (!url) return null;
    const method = extractFetchMethod(args[1]!);
    if (!method || method === 'GET') return null;
    return { method, pathPattern: normalisePath(url), client: 'fetch' };
  }

  // axios/got/ky/superagent/...method(url, ...)
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const verb = pa.getName().toLowerCase();
    if (!WRITE_VERBS.has(verb)) return null;
    const head = pa.getExpression();
    if (head.getKind() !== SyntaxKind.Identifier) return null;
    const clientName = head.getText();
    if (!HTTP_CLIENTS.has(clientName)) return null;
    const args = call.getArguments();
    if (args.length === 0) return null;
    const url = extractUrlLiteral(args[0]!);
    if (!url) return null;
    return { method: verb.toUpperCase(), pathPattern: normalisePath(url), client: clientName };
  }

  // axios({ url, method: 'put' })
  if (callee.getKind() === SyntaxKind.Identifier && callee.getText() === 'axios') {
    const args = call.getArguments();
    if (args.length === 0) return null;
    const obj = args[0]!;
    if (obj.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const urlNode = pickObjectProperty(obj as Node, 'url');
    const methodNode = pickObjectProperty(obj as Node, 'method');
    if (!urlNode || !methodNode) return null;
    const url = extractUrlLiteral(urlNode);
    const method = extractStringFromNode(methodNode);
    if (!url || !method) return null;
    const upper = method.toUpperCase();
    if (upper === 'GET' || !WRITE_VERBS.has(upper.toLowerCase())) return null;
    return { method: upper, pathPattern: normalisePath(url), client: 'axios' };
  }

  return null;
}

function extractUrlLiteral(node: Node): string | null {
  const strLit = node.asKind(SyntaxKind.StringLiteral) ?? node.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  if (strLit) return strLit.getLiteralText();
  if (node.getKind() === SyntaxKind.TemplateExpression) {
    // Reconstruct path with `:param` placeholders for each interpolation.
    const text = node.getText();
    return text
      .slice(1, -1) // strip the backticks
      .replace(/\$\{[^}]+\}/g, ':param');
  }
  return null;
}

function extractFetchMethod(optsNode: Node): string | null {
  if (optsNode.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const methodInit = pickObjectProperty(optsNode, 'method');
  if (!methodInit) return null;
  const m = extractStringFromNode(methodInit);
  return m ? m.toUpperCase() : null;
}

function extractStringFromNode(node: Node): string | null {
  const lit = node.asKind(SyntaxKind.StringLiteral) ?? node.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  return lit ? lit.getLiteralText() : null;
}

/**
 * Normalise a raw URL string into a comparable path pattern:
 *   - Strip protocol/host (`https://api.example.com/users/123` → `/users/123`)
 *   - Replace numeric segments with `:id`
 *   - Replace `:param` interpolation markers (already placed by extractor)
 *   - Trim trailing slash
 */
function normalisePath(raw: string): string {
  let s = raw;
  s = s.replace(/^https?:\/\/[^/]+/, '');
  s = s.replace(/\?.*$/, ''); // drop query string
  s = s.replace(/\/+\d+(?=\/|$)/g, '/:id');
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

function pickObjectProperty(obj: Node, name: string): Node | null {
  const olit = obj.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!olit) return null;
  const prop = olit.getProperty(name);
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  return (prop as { getInitializer(): Node | undefined }).getInitializer() ?? null;
}

function findEnclosingFunction(node: Node): Node | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const k = cur.getKind();
    if (
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.FunctionExpression
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return null;
}



