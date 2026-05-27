import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-defdrift-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

// Full RotHunter pipeline against a real temp workspace, no LLM
// required. Confirms the detector is wired into rothunter.ts and that
// `defaultImport` flows through the parser correctly.
describe('default-export-name-drift — full RotHunter pipeline', () => {
  it('surfaces a drifted default export in the final findings list', async () => {
    const root = await setup({
      'src/lib.ts': 'export default function getUser(): string { return "u"; }\n',
      'src/a.ts': "import getUser from './lib';\ngetUser();\n",
      'src/b.ts': "import fetchUser from './lib';\nfetchUser();\n",
      'src/c.ts': "import loadUser from './lib';\nloadUser();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const drifts = result.findings.filter((f) => f.detectorId === 'default-export-name-drift');
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.title).toContain('src/lib.ts');
      expect(drifts[0]!.title).toContain('3 different names');
      expect(drifts[0]!.severity).toBe('low');
      expect(drifts[0]!.fingerprint).toMatch(/^default-export-name-drift:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does NOT flag a workspace where every importer agrees on the name', async () => {
    const root = await setup({
      'src/lib.ts': 'export default function getUser(): string { return "u"; }\n',
      'src/a.ts': "import getUser from './lib';\ngetUser();\n",
      'src/b.ts': "import getUser from './lib';\ngetUser();\n",
      'src/c.ts': "import getUser from './lib';\ngetUser();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const drifts = result.findings.filter((f) => f.detectorId === 'default-export-name-drift');
      expect(drifts).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('flags two independent default-exporting modules separately', async () => {
    const root = await setup({
      'src/user.ts': 'export default function getUser(): void {}\n',
      'src/order.ts': 'export default function getOrder(): void {}\n',
      'src/a.ts':
        "import getUser from './user';\nimport getOrder from './order';\ngetUser(); getOrder();\n",
      'src/b.ts':
        "import fetchUser from './user';\nimport fetchOrder from './order';\nfetchUser(); fetchOrder();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const drifts = result.findings.filter((f) => f.detectorId === 'default-export-name-drift');
      expect(drifts).toHaveLength(2);
      const titles = drifts.map((f) => f.title);
      expect(titles.some((t) => t.includes('src/user.ts'))).toBe(true);
      expect(titles.some((t) => t.includes('src/order.ts'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
