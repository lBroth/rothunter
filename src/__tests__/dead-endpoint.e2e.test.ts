import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadep-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('dead-endpoint — full RotHunter pipeline', () => {
  it('surfaces an orphan route in the final findings', async () => {
    const root = await setup({
      'src/server.ts':
        'declare const app: any;\n' +
        "app.post('/api/orphan', (req: any, res: any) => { res.json({ ok: true }); });\n",
      'src/client.ts': "fetch('/api/used', { method: 'POST', body: JSON.stringify({}) });\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'dead-endpoint');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.title).toContain('POST /api/orphan');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('stays silent when every route has at least one client callsite', async () => {
    const root = await setup({
      'src/server.ts':
        'declare const app: any;\n' +
        "app.get('/api/users/:id', (req: any, res: any) => { res.json({}); });\n" +
        "app.post('/api/users', (req: any, res: any) => { res.json({}); });\n",
      'src/client.ts':
        'const id = 1;\n' +
        'fetch(`/api/users/${id}`);\n' +
        "fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'a' }) });\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'dead-endpoint');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('cross-package: route in services/a/ called from services/b/', async () => {
    const root = await setup({
      'services/merchants/src/server.ts':
        'declare const app: any;\n' +
        "app.get('/api/merchants', (req: any, res: any) => { res.json([]); });\n",
      'services/orders/src/client.ts': "fetch('/api/merchants');\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'dead-endpoint');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
