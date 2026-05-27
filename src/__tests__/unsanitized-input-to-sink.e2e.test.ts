import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-taint-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('unsanitized-input-to-sink — full RotHunter pipeline', () => {
  it('surfaces a SQL-injection-shaped flow in the final findings', async () => {
    const root = await setup({
      'src/handler.ts':
        'declare const app: any;\n' +
        'declare const db: any;\n' +
        "app.post('/u', (req: any, res: any) => {\n" +
        '  const userId = req.body.userId;\n' +
        '  db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' +
        '});\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'unsanitized-input-to-sink');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.severity).toBe('high');
      expect(hits[0]!.title).toContain('userId');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces a command-injection-shaped flow via exec()', async () => {
    const root = await setup({
      'src/handler.ts':
        'declare const app: any;\n' +
        "import { exec } from 'child_process';\n" +
        "app.post('/run', (req: any, res: any) => {\n" +
        '  const { cmd } = req.body;\n' +
        "  exec('ls ' + cmd, (e: any, out: any) => { void e; void out; });\n" +
        '});\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'unsanitized-input-to-sink');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.title).toContain('cmd');
      expect(hits[0]!.title).toContain('exec');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('stays silent on a parameterised query that uses no tainted name', async () => {
    const root = await setup({
      'src/handler.ts':
        'declare const app: any;\n' +
        'declare const db: any;\n' +
        "app.get('/static', (req: any, res: any) => {\n" +
        "  db.query('SELECT * FROM users WHERE id = $1', [1]);\n" +
        '});\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'unsanitized-input-to-sink');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
