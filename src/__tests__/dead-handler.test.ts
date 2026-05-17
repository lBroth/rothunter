import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { resolveIacEntryFiles } from '../graph/iac-entries.js';
import { detectDeadHandlers } from '../detectors/dead-handler.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadhandler-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('dead-handler detector', () => {
  it('flags a handler file no IaC construct references', async () => {
    const root = await setup({
      'bin/app.ts': "import './stack';\n",
      'stack.ts':
        "class NodejsFunction { constructor(_id: string, _p: { entry: string }) {} }\nnew NodejsFunction('LiveHandler', { entry: 'src/handlers/live.ts' });\n",
      'src/handlers/live.ts': 'export async function handler(): Promise<void> {}\n',
      'src/handlers/orphan.ts': 'export async function handler(): Promise<void> {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const iac = resolveIacEntryFiles(root, parsed.files);
      const findings = detectDeadHandlers({ files: parsed.files, iacEntries: iac, imports: parsed.imports });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(
        expect.arrayContaining([expect.stringContaining('Handler with no IaC wiring: src/handlers/orphan.ts')]),
      );
      expect(titles).not.toEqual(
        expect.arrayContaining([expect.stringContaining('src/handlers/live.ts')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag Next.js / Vercel /api routes (file-system-wired, no IaC needed)', async () => {
    const root = await setup({
      'app/api/users/route.ts': 'export async function GET(): Promise<Response> { return new Response("ok"); }\n',
      'pages/api/legacy.ts': 'export default function handler(): void {}\n',
      'api/serverless.ts': 'export default async (): Promise<Response> => new Response("ok");\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const findings = detectDeadHandlers({
        files: parsed.files,
        iacEntries: new Set(),
        imports: parsed.imports,
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a handler that is statically imported by something else', async () => {
    const root = await setup({
      'src/test-rig.ts': "import { handler } from './handlers/imported';\nexport function callIt(): unknown { return handler({}); }\n",
      'src/handlers/imported.ts': 'export function handler(_e: unknown): unknown { return null; }\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const findings = detectDeadHandlers({
        files: parsed.files,
        iacEntries: new Set(),
        imports: parsed.imports,
      });
      const titles = findings.map((f) => f.title);
      expect(titles).not.toEqual(
        expect.arrayContaining([expect.stringContaining('src/handlers/imported.ts')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Netlify functions that the netlify.toml config does not bind', async () => {
    const root = await setup({
      'netlify/functions/wired.ts':
        "// some non-TS config wires this — we can't see it. Treat as orphan today;\n// snoozeable in .rothunterignore. This test documents the conservative behavior.\nexport const handler = async (): Promise<void> => {};\n",
      'netlify/functions/orphan.ts': 'export const handler = async (): Promise<void> => {};\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const findings = detectDeadHandlers({
        files: parsed.files,
        iacEntries: new Set(),
        imports: parsed.imports,
      });
      const titles = findings.map((f) => f.title);
      expect(titles.length).toBe(2);
      expect(titles).toEqual(
        expect.arrayContaining([
          expect.stringContaining('netlify/functions/orphan.ts'),
          expect.stringContaining('netlify/functions/wired.ts'),
        ]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
