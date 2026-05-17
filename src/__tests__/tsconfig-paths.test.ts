import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { discoverEntryPoints } from '../graph/entry-points.js';
import { buildImportGraph, reachableFrom } from '../graph/import-graph.js';
import { loadTsconfigPaths, resolveTsconfigAlias } from '../graph/tsconfig-paths.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-tspaths-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('tsconfig paths', () => {
  it('parses a basic `paths` mapping and resolves `@/foo` to `src/foo.ts`', async () => {
    const root = await setup({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
      'src/foo.ts': 'export const x = 1;\n',
    });
    try {
      const cfg = loadTsconfigPaths(root);
      expect(cfg).not.toBeNull();
      const hit = resolveTsconfigAlias(cfg!, '@/foo');
      expect(hit).toBe(path.join(root, 'src/foo.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a non-wildcard alias to an absolute target', async () => {
    const root = await setup({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: { '@app/lib': ['packages/lib/src/index.ts'] },
        },
      }),
      'packages/lib/src/index.ts': 'export const y = 1;\n',
    });
    try {
      const cfg = loadTsconfigPaths(root);
      const hit = resolveTsconfigAlias(cfg!, '@app/lib');
      expect(hit).toBe(path.join(root, 'packages/lib/src/index.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates JSON5-style comments + trailing commas in tsconfig.json', async () => {
    const root = await setup({
      'tsconfig.json':
        '{\n' +
        '  // top comment\n' +
        '  "compilerOptions": {\n' +
        '    /* block */\n' +
        '    "paths": { "@/*": ["src/*"], },\n' +
        '  },\n' +
        '}\n',
      'src/foo.ts': 'export const v = 1;\n',
    });
    try {
      const cfg = loadTsconfigPaths(root);
      expect(cfg).not.toBeNull();
      const hit = resolveTsconfigAlias(cfg!, '@/foo');
      expect(hit).toBe(path.join(root, 'src/foo.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows `extends` and merges parent paths', async () => {
    const root = await setup({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@base/*': ['src/base/*'] } },
      }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { paths: { '@app/*': ['src/app/*'] } },
      }),
      'src/base/a.ts': 'export const a = 1;\n',
      'src/app/b.ts': 'export const b = 1;\n',
    });
    try {
      const cfg = loadTsconfigPaths(root);
      expect(cfg).not.toBeNull();
      expect(resolveTsconfigAlias(cfg!, '@base/a')).toBe(path.join(root, 'src/base/a.ts'));
      expect(resolveTsconfigAlias(cfg!, '@app/b')).toBe(path.join(root, 'src/app/b.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('integrates with parser → import graph: `@/foo` import becomes a real edge, no dead-module FP', async () => {
    const root = await setup({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/index.ts': "import { used } from '@/lib/util';\nexport function main(): void { used(); }\n",
      'src/lib/util.ts': 'export function used(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const graph = buildImportGraph(parsed.imports);
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      const reachable = reachableFrom(graph, entries);
      // `src/lib/util.ts` must be reachable from `src/index.ts` via the alias.
      expect(reachable.has('src/lib/util.ts')).toBe(true);
      // And the import record's target was resolved to the real file.
      const aliasImport = parsed.imports.find((i) => i.specifier === '@/lib/util');
      expect(aliasImport?.target).toBe('src/lib/util.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for bare specifiers with no matching alias', async () => {
    const root = await setup({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    });
    try {
      const cfg = loadTsconfigPaths(root);
      expect(resolveTsconfigAlias(cfg!, 'lodash')).toBeNull();
      expect(resolveTsconfigAlias(cfg!, 'fs')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
