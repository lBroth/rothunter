import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import { detectReExportShadows } from '../detectors/re-export-shadow.js';

async function setupWorkspace(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-reshadow-'));
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

describe('re-export-shadow detector', () => {
  it('flags the same name re-exported from two different modules', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo } from './a';\nexport { Foo } from './b';\n",
      'a.ts': 'export function Foo(): number { return 1; }\n',
      'b.ts': 'export function Foo(): number { return 2; }\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toBe('Ambiguous re-export: `Foo` in index.ts');
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.description).toContain('`a.ts`');
      expect(findings[0]!.description).toContain('`b.ts`');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a re-export that shadows a sibling local declaration (HIGH)', async () => {
    const root = await setupWorkspace({
      'index.ts': "export function Foo(): number { return 0; }\nexport { Foo } from './other';\n",
      'other.ts': 'export function Foo(): number { return 99; }\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
      expect(findings[0]!.description).toContain('local declaration');
      expect(findings[0]!.suggestion).toContain('local declaration wins');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a single re-export', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo } from './a';\n",
      'a.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag different names re-exported from the same target', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo, Bar } from './a';\n",
      'a.ts': 'export function Foo(): void {}\nexport function Bar(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when one side is aliased to a distinct name', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo } from './a';\nexport { Foo as FooLegacy } from './b';\n",
      'a.ts': 'export function Foo(): void {}\n',
      'b.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      // `Foo` only re-exported from one origin (a.ts); the b.ts side lands
      // under `FooLegacy` so consumers can disambiguate.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `export * from` since name set is unknown', async () => {
    const root = await setupWorkspace({
      'index.ts': "export * from './a';\nexport * from './b';\n",
      'a.ts': 'export function Foo(): void {}\n',
      'b.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      // Star re-exports are conservative; a TS error surface (duplicate
      // identifier) handles the actual conflict at compile time.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags three or more origins of the same name', async () => {
    const root = await setupWorkspace({
      'index.ts':
        "export { Foo } from './a';\nexport { Foo } from './b';\nexport { Foo } from './c';\n",
      'a.ts': 'export function Foo(): void {}\n',
      'b.ts': 'export function Foo(): void {}\n',
      'c.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toContain('3 different origins');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a stable fingerprint per (file, name)', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo } from './a';\nexport { Foo } from './b';\n",
      'a.ts': 'export function Foo(): void {}\n',
      'b.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const a = detectReExportShadows({ symbols, imports: parsed.imports });
      const b = detectReExportShadows({ symbols, imports: parsed.imports });
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
      expect(a[0]!.fingerprint.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not cross barrel boundaries — two barrels each safe individually', async () => {
    const root = await setupWorkspace({
      'index.ts': "export { Foo } from './a';\n",
      'other.ts': "export { Foo } from './b';\n",
      'a.ts': 'export function Foo(): void {}\n',
      'b.ts': 'export function Foo(): void {}\n',
    });
    try {
      const { parsed, symbols } = await scan(root);
      const findings = detectReExportShadows({ symbols, imports: parsed.imports });
      // Two distinct barrels each re-exporting `Foo` once. Each consumer
      // imports from one barrel; no ambiguity per barrel.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
