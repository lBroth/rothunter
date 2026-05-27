import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { buildImportGraph, reachableFrom, resolveImport } from '../graph/import-graph.js';
import { discoverEntryPoints } from '../graph/entry-points.js';
import { detectDeadModules } from '../detectors/dead-module.js';

async function setupWorkspace(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadmod-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('import graph + dead-module detector', () => {
  it('resolveImport finds sibling .ts files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-resolve-'));
    fs.writeFileSync(path.join(root, 'a.ts'), '', 'utf-8');
    fs.writeFileSync(path.join(root, 'b.ts'), '', 'utf-8');
    try {
      expect(resolveImport(root, 'a.ts', './b')).toBe('b.ts');
      expect(resolveImport(root, 'a.ts', './missing')).toBeNull();
      expect(resolveImport(root, 'a.ts', 'fs')).toBeNull();
      expect(resolveImport(root, 'a.ts', '@scope/pkg')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reachableFrom does BFS over the workspace import graph', () => {
    const graph = buildImportGraph([
      { source: 'index.ts', specifier: './a', target: 'a.ts' },
      { source: 'a.ts', specifier: './b', target: 'b.ts' },
      { source: 'b.ts', specifier: './c', target: 'c.ts' },
      { source: 'orphan.ts', specifier: 'fs', target: null },
    ]);
    const reachable = reachableFrom(graph, ['index.ts']);
    expect([...reachable].sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'index.ts']);
    expect(reachable.has('orphan.ts')).toBe(false);
  });

  it('detects an unreachable module on a real parsed workspace', async () => {
    const root = await setupWorkspace({
      'index.ts': "import { used } from './used';\nexport function main(): void { used(); }\n",
      'used.ts': 'export function used(): void {}\n',
      'lonely.ts': 'export function lonely(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const graph = buildImportGraph(parsed.imports);
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      // index.ts is picked up by the conventional-filename heuristic.
      expect(entries.has('index.ts')).toBe(true);
      const reachable = reachableFrom(graph, entries);
      const findings = detectDeadModules({
        files: parsed.files,
        graph,
        entryPoints: entries,
        reachable,
      });
      const deadFiles = findings.map((f) => f.evidence[0]!.file);
      expect(deadFiles).toContain('lonely.ts');
      expect(deadFiles).not.toContain('used.ts');
      expect(deadFiles).not.toContain('index.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats files matched by `scripts/` / `tests/` conventions as entry points', async () => {
    const root = await setupWorkspace({
      'scripts/setup.ts': 'export function setup(): void {}\n',
      'tests/example.test.ts': 'export function noop(): void {}\n',
      'src/orphan.ts': 'export function orphan(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const graph = buildImportGraph(parsed.imports);
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      const reachable = reachableFrom(graph, entries);
      const findings = detectDeadModules({
        files: parsed.files,
        graph,
        entryPoints: entries,
        reachable,
      });
      expect(findings.map((f) => f.evidence[0]!.file)).toEqual(['src/orphan.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats files referenced by `package.json` scripts as entry points', async () => {
    const root = await setupWorkspace({
      'package.json': JSON.stringify(
        {
          name: 'pkg',
          scripts: {
            dev: 'tsx watch packages/gateway/src/dev.ts',
            seed: 'node ./scripts/seed.ts',
          },
        },
        null,
        2,
      ),
      'packages/gateway/src/dev.ts': 'export function dev(): void {}\n',
      'scripts/seed.ts': 'export function seed(): void {}\n',
      'src/orphan.ts': 'export function orphan(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const graph = buildImportGraph(parsed.imports);
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      // Both scripts-referenced files marked as entry points → never
      // surfaced by dead-module. `src/orphan.ts` still flagged.
      expect(entries.has('packages/gateway/src/dev.ts')).toBe(true);
      // `scripts/seed.ts` is ALSO under the `scripts/` convention so
      // it would be reachable regardless; the value here is the gateway
      // dev file which has no convention coverage.
      const reachable = reachableFrom(graph, entries);
      const findings = detectDeadModules({
        files: parsed.files,
        graph,
        entryPoints: entries,
        reachable,
      });
      const deadFiles = findings.map((f) => f.evidence[0]!.file);
      expect(deadFiles).toContain('src/orphan.ts');
      expect(deadFiles).not.toContain('packages/gateway/src/dev.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips ambient declaration files (`*.d.ts`)', async () => {
    const root = await setupWorkspace({
      'index.ts': 'export {};\n',
      'global.d.ts': 'declare const X: number;\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const graph = buildImportGraph(parsed.imports);
      const entries = discoverEntryPoints(root, new Set(parsed.files));
      const reachable = reachableFrom(graph, entries);
      const findings = detectDeadModules({
        files: parsed.files,
        graph,
        entryPoints: entries,
        reachable,
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
