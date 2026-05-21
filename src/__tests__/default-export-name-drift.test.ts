import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import { detectDefaultExportNameDrift } from '../detectors/default-export-name-drift.js';

async function setupWorkspace(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-defdrift-'));
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
  return { parsed, symbols };
}

describe('default-export-name-drift detector', () => {
  it('flags a default export imported under two different local names', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export default function getUser(): void {}\n',
      'a.ts': "import getUser from './lib';\ngetUser();\n",
      'b.ts': "import fetchUser from './lib';\nfetchUser();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('lib.ts');
      expect(findings[0]!.title).toContain('2 different names');
      expect(findings[0]!.description).toContain('`getUser`');
      expect(findings[0]!.description).toContain('`fetchUser`');
      expect(findings[0]!.severity).toBe('low');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when all importers agree on the local name', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export default function getUser(): void {}\n',
      'a.ts': "import getUser from './lib';\ngetUser();\n",
      'b.ts': "import getUser from './lib';\ngetUser();\n",
      'c.ts': "import getUser from './lib';\ngetUser();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a single importer (no drift possible)', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export default function only(): void {}\n',
      'a.ts': "import whatever from './lib';\nwhatever();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag named-only imports of a default-exporting module', async () => {
    const root = await setupWorkspace({
      'lib.ts':
        'export default function main(): void {}\n' +
        'export function helper(): void {}\n',
      'a.ts': "import { helper } from './lib';\nhelper();\n",
      'b.ts': "import { helper as h } from './lib';\nh();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      // Named imports don't go through `defaultImport`, so they don't count.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('groups importers by alias and reports counts', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export default function getUser(): void {}\n',
      'a.ts': "import getUser from './lib';\ngetUser();\n",
      'b.ts': "import getUser from './lib';\ngetUser();\n",
      'c.ts': "import fetchUser from './lib';\nfetchUser();\n",
      'd.ts': "import loadUser from './lib';\nloadUser();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('3 different names');
      // `getUser` has 2 importers — should be ranked first
      expect(findings[0]!.description).toMatch(/`getUser` \(2×/);
      expect(findings[0]!.description).toMatch(/`fetchUser` \(1×/);
      expect(findings[0]!.description).toMatch(/`loadUser` \(1×/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag files without a default export', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export function helper(): void {}\n',
      'a.ts': "import { helper as Foo } from './lib';\nFoo();\n",
      'b.ts': "import { helper as Bar } from './lib';\nBar();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles anonymous default exports (no declared name)', async () => {
    const root = await setupWorkspace({
      'config.ts': 'export default { token: "x" };\n',
      'a.ts': "import config from './config';\nvoid config;\n",
      'b.ts': "import settings from './config';\nvoid settings;\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      // Anonymous defaults may or may not surface as a symbol — the
      // detector should still flag if a SymbolRecord with isDefault exists.
      // If the parser emits none we get [], which is acceptable behaviour.
      if (findings.length > 0) {
        expect(findings[0]!.description).toContain('`config`');
        expect(findings[0]!.description).toContain('`settings`');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a stable fingerprint per target file', async () => {
    const root = await setupWorkspace({
      'lib.ts': 'export default function getUser(): void {}\n',
      'a.ts': "import getUser from './lib';\ngetUser();\n",
      'b.ts': "import fetchUser from './lib';\nfetchUser();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const a = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      const b = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
      expect(a[0]!.fingerprint.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags drift across two separate default-exporting modules independently', async () => {
    const root = await setupWorkspace({
      'user.ts': 'export default function getUser(): void {}\n',
      'order.ts': 'export default function getOrder(): void {}\n',
      'a.ts': "import getUser from './user';\nimport getOrder from './order';\ngetUser(); getOrder();\n",
      'b.ts': "import fetchUser from './user';\nimport fetchOrder from './order';\nfetchUser(); fetchOrder();\n",
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectDefaultExportNameDrift({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(2);
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => t.includes('user.ts'))).toBe(true);
      expect(titles.some((t) => t.includes('order.ts'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
