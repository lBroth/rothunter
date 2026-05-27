import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-twa-e2e-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('test-without-assertion — full RotHunter pipeline', () => {
  it(
    'surfaces an assertion-free test in the final findings list',
    async () => {
      const root = await setup({
        'src/lib.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
        'src/__tests__/lib.test.ts':
          "import { it, describe } from '@jest/globals';\n" +
          "import { add } from '../lib';\n" +
          "describe('add', () => {\n" +
          "  it('runs without crashing', () => {\n" +
          '    const r = add(1, 2);\n' +
          '    void r;\n' +
          '  });\n' +
          '});\n',
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const hits = result.findings.filter(
          (f) => f.detectorId === 'test-without-assertion',
        );
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]!.title).toContain('runs without crashing');
        expect(hits[0]!.fingerprint).toMatch(/^test-without-assertion:/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'does NOT flag a real assertion-bearing test',
    async () => {
      const root = await setup({
        'src/lib.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
        'src/__tests__/lib.test.ts':
          "import { expect, it } from '@jest/globals';\n" +
          "import { add } from '../lib';\n" +
          "it('adds', () => { expect(add(1, 2)).toBe(3); });\n",
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const hits = result.findings.filter(
          (f) => f.detectorId === 'test-without-assertion',
        );
        expect(hits).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'leaves `.skip` / `.only` / `.todo` to the skip-tests detector',
    async () => {
      const root = await setup({
        'src/lib.ts': 'export function noop(): void {}\n',
        'src/__tests__/lib.test.ts':
          "import { it } from '@jest/globals';\n" +
          "it.skip('one', () => { const a = 1; void a; });\n" +
          "it.todo('two');\n" +
          "xit('three', () => { const c = 3; void c; });\n",
      });
      try {
        const rothunter = new RotHunter();
        const result = await rothunter.run({ workspaceRoot: root });
        const twa = result.findings.filter(
          (f) => f.detectorId === 'test-without-assertion',
        );
        const skip = result.findings.filter((f) => f.detectorId === 'skip-tests');
        expect(twa).toEqual([]);
        // skip-tests should fire on these — confirms the two detectors
        // partition the test-smell space cleanly.
        expect(skip.length).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
