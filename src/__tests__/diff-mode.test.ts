import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';

/**
 * Covers the `--diff` mode path in typescript-parser.ts: when `opts.files`
 * is provided, only those files get parsed even though the workspace
 * contains many more. Regression guard for changes that accidentally fall
 * back to the full glob.
 */
describe('TypeScriptParser --diff mode', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-diff-'));
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'export interface A { id: string; }\n', 'utf-8');
    fs.writeFileSync(
      path.join(workspace, 'b.ts'),
      'export interface B { name: string; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspace, 'c.ts'),
      'export function helper(): number { return 42; }\n',
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('full parse picks up every workspace file', async () => {
    const parser = new TypeScriptParser();
    const result = await parser.parseWorkspaceFull({ workspaceRoot: workspace });
    expect(result.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['A', 'B', 'helper']);
  });

  it('opts.files restricts parsing to the listed workspace-relative files', async () => {
    const parser = new TypeScriptParser();
    const result = await parser.parseWorkspaceFull({
      workspaceRoot: workspace,
      files: ['b.ts'],
    });
    expect(result.files).toEqual(['b.ts']);
    expect(result.symbols.map((s) => s.name)).toEqual(['B']);
  });

  it('opts.files accepts absolute paths and resolves them against the workspace', async () => {
    const parser = new TypeScriptParser();
    const result = await parser.parseWorkspaceFull({
      workspaceRoot: workspace,
      files: [path.join(workspace, 'a.ts'), path.join(workspace, 'c.ts')],
    });
    expect(result.files.sort()).toEqual(['a.ts', 'c.ts']);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['A', 'helper']);
  });

  it('opts.files with an empty array falls back to the full workspace glob', async () => {
    // `opts.files && opts.files.length > 0` gate — an empty array should
    // not be treated as "scan nothing" (operator typing `--files=` with
    // nothing after would otherwise silently skip every detector).
    const parser = new TypeScriptParser();
    const result = await parser.parseWorkspaceFull({
      workspaceRoot: workspace,
      files: [],
    });
    expect(result.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
