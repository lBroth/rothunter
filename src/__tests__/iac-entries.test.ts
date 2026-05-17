import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { discoverEntryPoints } from '../graph/entry-points.js';
import { resolveIacEntryFiles } from '../graph/iac-entries.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-iac-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('entry-points: framework conventions', () => {
  it('treats Next.js app-router route handlers as entry points', async () => {
    const root = await setup({
      'app/api/users/route.ts': 'export async function GET(): Promise<Response> { return new Response("ok"); }\n',
      'src/app/api/products/route.ts': 'export async function POST(): Promise<Response> { return new Response("ok"); }\n',
      'pages/api/legacy.ts': 'export default function handler(): void {}\n',
      'middleware.ts': 'export function middleware(): Response { return new Response("ok"); }\n',
      'src/orphan.ts': 'export function lonely(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      expect(entries.has('app/api/users/route.ts')).toBe(true);
      expect(entries.has('src/app/api/products/route.ts')).toBe(true);
      expect(entries.has('pages/api/legacy.ts')).toBe(true);
      expect(entries.has('middleware.ts')).toBe(true);
      expect(entries.has('src/orphan.ts')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats Netlify functions, Vercel /api, AWS Lambda layouts as entry points', async () => {
    const root = await setup({
      'netlify/functions/foo.ts': 'export const handler = async (): Promise<void> => {};\n',
      'netlify/edge-functions/edge.ts': 'export default async (): Promise<Response> => new Response("ok");\n',
      'api/serverless.ts': 'export default async (): Promise<Response> => new Response("ok");\n',
      'src/lambdas/billing.ts': 'export async function handler(): Promise<void> {}\n',
      'src/functions/notify.ts': 'export async function handler(): Promise<void> {}\n',
      'worker.ts': "export default { async fetch(): Promise<Response> { return new Response('ok'); } };\n",
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      expect(entries.has('netlify/functions/foo.ts')).toBe(true);
      expect(entries.has('netlify/edge-functions/edge.ts')).toBe(true);
      expect(entries.has('api/serverless.ts')).toBe(true);
      expect(entries.has('src/lambdas/billing.ts')).toBe(true);
      expect(entries.has('src/functions/notify.ts')).toBe(true);
      expect(entries.has('worker.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('IaC entry resolution', () => {
  it("picks up `entry: 'src/x.ts'` from CDK NodejsFunction constructs", async () => {
    const root = await setup({
      'bin/app.ts': "import './stack';\n",
      'stack.ts':
        "class NodejsFunction { constructor(_: unknown, _id: string, _p: { entry: string }) {} }\nexport function buildStack(): void { new NodejsFunction({}, 'X', { entry: 'src/runtime/foo.ts' }); }\n",
      'src/runtime/foo.ts': 'export async function handler(): Promise<void> {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveIacEntryFiles(root, parsed.files);
      expect(entries.has('src/runtime/foo.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips the trailing `.handler` from AWS-style `handler: 'src/x.handler'` strings", async () => {
    const root = await setup({
      'stack.ts':
        "class Fn { constructor(_p: { handler: string }) {} }\nnew Fn({ handler: 'src/lambdas/billing.handler' });\n",
      'src/lambdas/billing.ts': 'export async function handler(): Promise<void> {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveIacEntryFiles(root, parsed.files);
      expect(entries.has('src/lambdas/billing.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves SST/serverless `routes: { 'GET /x': 'src/routes/x.handler' }`", async () => {
    const root = await setup({
      'stack.ts':
        "class Api { constructor(_p: { routes: Record<string, string> }) {} }\nnew Api({ routes: { 'GET /users': 'src/routes/users.handler', 'POST /orders': 'src/routes/orders.handler' } });\n",
      'src/routes/users.ts': 'export async function handler(): Promise<void> {}\n',
      'src/routes/orders.ts': 'export async function handler(): Promise<void> {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveIacEntryFiles(root, parsed.files);
      expect(entries.has('src/routes/users.ts')).toBe(true);
      expect(entries.has('src/routes/orders.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the empty set for files with no IaC constructs', async () => {
    const root = await setup({
      'src/util.ts': 'export const x = 1;\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveIacEntryFiles(root, parsed.files);
      expect(entries.size).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
