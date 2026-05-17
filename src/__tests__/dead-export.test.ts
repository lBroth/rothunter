import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { discoverEntryPoints } from '../graph/entry-points.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import { detectDeadExports } from '../detectors/dead-export.js';

async function setupWorkspace(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadexp-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

async function scan(root: string) {
  const parser = new TypeScriptParser();
  const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
  const symbols = new TypeNormalizer().normalizeAll(parsed.symbols);
  const entryPoints = discoverEntryPoints(root, new Set(parsed.files));
  return { parsed, symbols, entryPoints };
}

describe('dead-export detector', () => {
  it('flags an exported symbol that no other file imports', async () => {
    const root = await setupWorkspace({
      'index.ts': "import { used } from './lib';\nexport function main(): void { used(); }\n",
      'lib.ts': 'export function used(): void {}\nexport function unused(): void {}\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      const titles = findings.map((f) => f.title);
      expect(titles).toContain('Unused export: unused in lib.ts');
      expect(titles).not.toContain(expect.stringContaining('used'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag exports re-exported through a barrel', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { helper } from './barrel';\n",
      'barrel.ts': "export { helper } from './lib';\n",
      'lib.ts': 'export function helper(): void {}\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      const titles = findings.map((f) => f.title);
      expect(titles).not.toContain('Unused export: helper in lib.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats `import * as ns from ...` as consuming every export of the target', async () => {
    const root = await setupWorkspace({
      'index.ts': "import * as utils from './lib';\nexport function main(): void { utils.useIt(); }\n",
      'lib.ts': 'export function useIt(): void {}\nexport function unusedHere(): void {}\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      const titles = findings.map((f) => f.title);
      // Both exports are conservatively kept because the namespace import could touch either.
      expect(titles).not.toContain('Unused export: unusedHere in lib.ts');
      expect(titles).not.toContain('Unused export: useIt in lib.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag entry-point file exports (CLI / package surface)', async () => {
    const root = await setupWorkspace({
      'index.ts': 'export function publicApi(): void {}\n',
      'scripts/cli.ts': 'export function commandRunner(): void {}\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      expect(findings.map((f) => f.title)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves alias-LHS as the export-key when imported via `import { a as b }`', async () => {
    const root = await setupWorkspace({
      'index.ts': "import { actualName as renamed } from './lib';\nexport function main(): void { renamed(); }\n",
      'lib.ts': 'export function actualName(): void {}\nexport function reallyDead(): void {}\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      const titles = findings.map((f) => f.title);
      expect(titles).toContain('Unused export: reallyDead in lib.ts');
      expect(titles).not.toContain('Unused export: actualName in lib.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips ambient `.d.ts` files and `__fixtures__/`', async () => {
    const root = await setupWorkspace({
      'index.ts': "import { v } from './fixtures-host';\nexport function main(): void { v(); }\n",
      'fixtures-host.ts': "export { v } from './__fixtures__/data';\n",
      '__fixtures__/data.ts': 'export function v(): void {}\nexport function alsoUnused(): void {}\n',
      'types.d.ts': 'export interface Ghost { id: string; }\n',
    });
    try {
      const { parsed, symbols, entryPoints } = await scan(root);
      const findings = detectDeadExports({ symbols, imports: parsed.imports, entryPoints });
      const titles = findings.map((f) => f.title);
      expect(titles).not.toContain('Unused export: Ghost in types.d.ts');
      // alsoUnused lives in __fixtures__/ which is in the SKIP list — not flagged.
      expect(titles).not.toContain('Unused export: alsoUnused in __fixtures__/data.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
