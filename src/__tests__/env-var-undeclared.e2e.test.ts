import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-env-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('env-var-undeclared — full RotHunter pipeline', () => {
  it('surfaces an undeclared env var read in the final findings', async () => {
    const root = await setup({
      'src/index.ts': 'export const url = process.env.DATABASE_URL;\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter(
        (f) => f.detectorId === 'env-var-undeclared' && f.severity === 'medium',
      );
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.title).toContain('DATABASE_URL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does NOT flag when .env.example declares the variable', async () => {
    const root = await setup({
      'src/index.ts': 'export const url = process.env.DATABASE_URL;\n',
      '.env.example': 'DATABASE_URL=postgres://localhost\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const undeclared = result.findings.filter(
        (f) => f.detectorId === 'env-var-undeclared' && f.severity === 'medium',
      );
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('emits a paired dead-env finding for vars declared but never read', async () => {
    const root = await setup({
      'src/index.ts': 'export const u = process.env.USED;\n',
      '.env.example': 'USED=x\nDEAD=should_not_be_here\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const dead = result.findings.filter(
        (f) => f.detectorId === 'env-var-undeclared' && f.severity === 'low',
      );
      expect(dead).toHaveLength(1);
      expect(dead[0]!.title).toContain('DEAD');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
