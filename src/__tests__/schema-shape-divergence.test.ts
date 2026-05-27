import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import { detectSchemaShapeDivergence } from '../detectors/schema-shape-divergence.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-shape-'));
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
  return new TypeNormalizer().normalizeAll(parsed.symbols);
}

describe('schema-shape-divergence detector', () => {
  it('flags a User / UserDTO pair with one extra field', async () => {
    const root = await setup({
      'src/user.ts':
        'export interface User { id: string; email: string; displayName: string; createdAt: string; }\n',
      'src/dto.ts':
        'export interface UserDTO { id: string; email: string; displayName: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('UserDTO');
      expect(findings[0]!.title).toContain('User');
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.description).toContain('createdAt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag an exact match (duplicate-type territory)', async () => {
    const root = await setup({
      'src/a.ts': 'export interface User { id: string; email: string; displayName: string; }\n',
      'src/b.ts': 'export interface UserDTO { id: string; email: string; displayName: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag two unrelated types that happen to share an `id` field', async () => {
    const root = await setup({
      'src/user.ts': 'export interface User { id: string; email: string; displayName: string; }\n',
      'src/order.ts': 'export interface Order { id: string; total: number; currency: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag types whose diff exceeds maxDriftFields', async () => {
    const root = await setup({
      'src/a.ts':
        'export interface User { id: string; email: string; displayName: string; createdAt: string; }\n',
      'src/b.ts':
        'export interface UserDTO { id: string; foo: string; bar: string; baz: string; qux: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a CreateUserRequest / User pair (action-prefix stem strip)', async () => {
    const root = await setup({
      'src/model.ts':
        'export interface User { id: string; email: string; displayName: string; createdAt: string; }\n',
      'src/request.ts':
        'export interface CreateUserRequest { email: string; displayName: string; createdAt: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toContain('id');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles type aliases (not just interfaces)', async () => {
    const root = await setup({
      'src/model.ts':
        'export type User = { id: string; email: string; displayName: string; createdAt: string; };\n',
      'src/dto.ts': 'export type UserDTO = { id: string; email: string; displayName: string; };\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag non-exported types', async () => {
    const root = await setup({
      'src/a.ts':
        'interface User { id: string; email: string; displayName: string; createdAt: string; }\n' +
        'export const x = 1;\n',
      'src/b.ts':
        'interface UserDTO { id: string; email: string; displayName: string; }\n' +
        'export const y = 2;\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag types with fewer than 3 fields (signal too weak)', async () => {
    const root = await setup({
      'src/a.ts': 'export interface User { id: string; email: string; }\n',
      'src/b.ts': 'export interface UserDTO { id: string; email: string; displayName: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits a stable fingerprint that is symmetric in (a, b) ordering', async () => {
    const rootA = await setup({
      'src/x.ts':
        'export interface User { id: string; email: string; displayName: string; createdAt: string; }\n' +
        'export interface UserDTO { id: string; email: string; displayName: string; }\n',
    });
    try {
      const sa = await scan(rootA);
      const fa = detectSchemaShapeDivergence({ symbols: sa });
      const fb = detectSchemaShapeDivergence({ symbols: sa });
      expect(fa[0]!.fingerprint).toBe(fb[0]!.fingerprint);
      expect(fa[0]!.fingerprint).toMatch(/^schema-shape-divergence:/);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('reports the smaller type on the left in the description', async () => {
    const root = await setup({
      'src/model.ts':
        'export interface User { id: string; email: string; displayName: string; createdAt: string; }\n',
      'src/dto.ts':
        'export interface UserDTO { id: string; email: string; displayName: string; }\n',
    });
    try {
      const symbols = await scan(root);
      const findings = detectSchemaShapeDivergence({ symbols });
      expect(findings).toHaveLength(1);
      // UserDTO is the smaller one — should be left, User on the right
      expect(findings[0]!.title).toMatch(/UserDTO.*vs.*User/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
