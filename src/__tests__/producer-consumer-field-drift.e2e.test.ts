import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-pcfd-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('producer-consumer-field-drift — full RotHunter pipeline', () => {
  it(
    'surfaces a server-reads / client-misses drift in the final findings',
    async () => {
      const root = await setup({
        'src/server.ts':
          "declare const app: any;\n" +
          "app.post('/api/users', (req: any, res: any) => {\n" +
          '  const { email, displayName, role } = req.body;\n' +
          '  void email; void displayName; void role;\n' +
          '  res.json({ ok: true });\n' +
          '});\n',
        'src/client.ts':
          "fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'a@b', displayName: 'A' }) });\n",
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const hits = result.findings.filter(
          (f) => f.detectorId === 'producer-consumer-field-drift',
        );
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]!.severity).toBe('high');
        expect(hits[0]!.title).toContain('POST /api/users');
        expect(hits[0]!.description).toContain('role');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'stays silent when every server-read field is in the client body',
    async () => {
      const root = await setup({
        'src/server.ts':
          "declare const app: any;\n" +
          "app.post('/api/users', (req: any, res: any) => {\n" +
          '  const { email, displayName } = req.body;\n' +
          '  void email; void displayName;\n' +
          '});\n',
        'src/client.ts':
          "fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'a@b', displayName: 'A', extra: 1 }) });\n",
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const hits = result.findings.filter(
          (f) => f.detectorId === 'producer-consumer-field-drift',
        );
        expect(hits).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'does NOT flag a server route with no client callsite (cannot make a claim)',
    async () => {
      const root = await setup({
        'src/server.ts':
          "declare const app: any;\n" +
          "app.post('/api/orphan', (req: any, res: any) => { const { x } = req.body; void x; });\n",
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const hits = result.findings.filter(
          (f) => f.detectorId === 'producer-consumer-field-drift',
        );
        expect(hits).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
