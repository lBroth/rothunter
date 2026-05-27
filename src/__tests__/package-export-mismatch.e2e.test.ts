import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-pkgexp-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('package-export-mismatch — full RotHunter pipeline', () => {
  it('surfaces a missing publish target in the final findings', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        main: 'dist/missing.js',
      }),
      'src/x.ts': 'export const x = 1;\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'package-export-mismatch');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.severity).toBe('high');
      expect(hits[0]!.title).toContain('dist/missing.js');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('stays silent when every target resolves to a source counterpart', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
      }),
      'src/index.ts': 'export const x = 1;\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'package-export-mismatch');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('skips private packages', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        private: true,
        main: 'dist/never.js',
      }),
      'src/index.ts': 'export const x = 1;\n',
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const hits = result.findings.filter((f) => f.detectorId === 'package-export-mismatch');
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
