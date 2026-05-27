import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-reshadow-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

// End-to-end exercise: full RotHunter pipeline against a real workspace,
// no LLM required (warmup fails gracefully on tests). Confirms the
// detector is actually wired into `rothunter.ts` and not just present in
// the directory.
describe('re-export-shadow — full RotHunter pipeline', () => {
  it('surfaces a shadowed re-export in the final findings list', async () => {
    const root = await setup({
      'src/index.ts': "export { handler } from './v1';\nexport { handler } from './v2';\n",
      'src/v1.ts': 'export function handler(): string { return "v1"; }\n',
      'src/v2.ts': 'export function handler(): string { return "v2"; }\n',
      // Give the workspace one real consumer so dead-export doesn't drown
      // the report — we only care about re-export-shadow here.
      'src/consumer.ts': "import { handler } from './index';\nhandler();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const shadows = result.findings.filter((f) => f.detectorId === 're-export-shadow');
      expect(shadows.length).toBeGreaterThanOrEqual(1);
      expect(shadows[0]!.title).toContain('handler');
      expect(shadows[0]!.title).toContain('src/index.ts');
      // Fingerprint should be stable + namespaced.
      expect(shadows[0]!.fingerprint).toMatch(/^re-export-shadow:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a re-export shadowing a sibling local declaration with HIGH severity', async () => {
    const root = await setup({
      'src/index.ts':
        "export function handler(): string { return 'local'; }\n" +
        "export { handler } from './other';\n",
      'src/other.ts': 'export function handler(): string { return "other"; }\n',
      'src/consumer.ts': "import { handler } from './index';\nhandler();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const shadows = result.findings.filter((f) => f.detectorId === 're-export-shadow');
      expect(shadows).toHaveLength(1);
      expect(shadows[0]!.severity).toBe('high');
      expect(shadows[0]!.description).toContain('local declaration');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT emit a finding on a clean workspace', async () => {
    const root = await setup({
      'src/index.ts': "export { handler } from './only';\n",
      'src/only.ts': 'export function handler(): string { return "ok"; }\n',
      'src/consumer.ts': "import { handler } from './index';\nhandler();\n",
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root });
      const shadows = result.findings.filter((f) => f.detectorId === 're-export-shadow');
      expect(shadows).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
