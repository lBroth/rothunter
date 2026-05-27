import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-shape-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('schema-shape-divergence — full RotHunter pipeline', () => {
  it('surfaces a User / UserDTO drift in the final findings', async () => {
    const root = await setup({
      'src/user.ts':
        'export interface User {\n' +
        '  id: string;\n' +
        '  email: string;\n' +
        '  displayName: string;\n' +
        '  createdAt: string;\n' +
        '}\n',
      'src/dto.ts':
        'export interface UserDTO {\n' +
        '  id: string;\n' +
        '  email: string;\n' +
        '  displayName: string;\n' +
        '}\n',
      'src/consumer.ts':
        "import type { User } from './user';\nimport type { UserDTO } from './dto';\nexport const x: [User, UserDTO] = null as any;\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'schema-shape-divergence');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.title).toContain('UserDTO');
      expect(hits[0]!.description).toContain('createdAt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('stays silent when two unrelated types share only one common field', async () => {
    const root = await setup({
      'src/user.ts':
        'export interface User {\n' +
        '  id: string;\n' +
        '  email: string;\n' +
        '  displayName: string;\n' +
        '}\n',
      'src/order.ts':
        'export interface Order {\n' +
        '  id: string;\n' +
        '  total: number;\n' +
        '  currency: string;\n' +
        '}\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'schema-shape-divergence');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('is silent on exact-match pairs (duplicate-type owns that case)', async () => {
    const root = await setup({
      'src/a.ts':
        'export interface User {\n' +
        '  id: string;\n' +
        '  email: string;\n' +
        '  displayName: string;\n' +
        '}\n',
      'src/b.ts':
        'export interface UserDTO {\n' +
        '  id: string;\n' +
        '  email: string;\n' +
        '  displayName: string;\n' +
        '}\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const drift = result.findings.filter((f) => f.detectorId === 'schema-shape-divergence');
      expect(drift).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
