import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import type { SymbolRecord } from '../types.js';

async function parseInline(source: string): Promise<SymbolRecord[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-parser-'));
  const file = path.join(tmp, 'sample.ts');
  fs.writeFileSync(file, source, 'utf-8');
  try {
    const parser = new TypeScriptParser();
    return await parser.parseWorkspace({ workspaceRoot: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findField(record: SymbolRecord, name: string) {
  return record.structure?.fields?.find((f) => f.name === name);
}

describe('TypeScriptParser', () => {
  it('captures interface properties with their TypeScript-rendered types', async () => {
    const [iface] = await parseInline(`
      export interface User {
        id: string;
        age?: number;
      }
    `);
    expect(iface?.name).toBe('User');
    expect(iface?.kind).toBe('interface');
    expect(findField(iface!, 'id')).toEqual(
      expect.objectContaining({ name: 'id', type: 'string', optional: false }),
    );
    expect(findField(iface!, 'age')).toEqual(
      expect.objectContaining({ name: 'age', type: 'number', optional: true }),
    );
  });

  it('captures method signatures as `()methodName` pseudo-fields (parser-fix regression)', async () => {
    const [iface] = await parseInline(`
      export interface Runnable {
        id: string;
        run(input: string): Promise<string>;
      }
    `);
    const method = findField(iface!, '()run');
    expect(method).toBeDefined();
    expect(method?.type).toContain('=>');
    expect(method?.type).toContain('string');
    expect(method?.type).toContain('Promise<string>');
  });

  it('captures index signatures as `[keyType]` pseudo-fields', async () => {
    const [iface] = await parseInline(`
      export interface Bucket {
        [k: string]: number;
      }
    `);
    const idx = iface?.structure?.fields?.find((f) => f.name.startsWith('['));
    expect(idx).toBeDefined();
    expect(idx?.name).toBe('[string]');
    expect(idx?.type).toBe('number');
  });

  it('captures call and construct signatures', async () => {
    const [iface] = await parseInline(`
      export interface Builder {
        (x: number): string;
        new (init: string): { ok: boolean };
      }
    `);
    const call = findField(iface!, '()');
    const ctor = findField(iface!, 'new()');
    expect(call).toBeDefined();
    expect(ctor).toBeDefined();
  });

  it('parses type aliases with object literal bodies', async () => {
    const [alias] = await parseInline(`
      export type Point = {
        x: number;
        y: number;
      };
    `);
    expect(alias?.kind).toBe('type-alias');
    expect(alias?.name).toBe('Point');
    expect(alias?.structure?.fields).toHaveLength(2);
  });

  it('marks union type aliases as kind="union" with raw text preserved', async () => {
    const [alias] = await parseInline(`
      export type Status = 'ok' | 'fail';
    `);
    expect(alias?.structure?.kind).toBe('union');
    expect(alias?.structure?.raw).toContain('|');
  });

  it('captures top-level arrow functions assigned to `const` as function symbols', async () => {
    const records = await parseInline(`
      export const greet = (name: string): string => \`hello \${name}\`;
      export const Button = ({ label }: { label: string }) => '<' + label + '>';
      const internal = function (x: number) { return x + 1; };
    `);
    const names = records.filter((r) => r.kind === 'function').map((r) => r.name).sort();
    expect(names).toEqual(['Button', 'greet', 'internal']);
  });

  it('captures class declarations with properties + instance methods as object structure', async () => {
    const [cls] = await parseInline(`
      export class Counter {
        private value: number = 0;
        public name: string;
        constructor(name: string) { this.name = name; }
        increment(by: number): number {
          this.value += by;
          return this.value;
        }
        reset(): void { this.value = 0; }
      }
    `);
    expect(cls?.kind).toBe('class');
    expect(cls?.name).toBe('Counter');
    const fieldNames = cls?.structure?.fields?.map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(['value', 'name', '()increment', '()reset']));
    // Constructor not exposed as a pseudo-field — it's lifecycle, not surface.
    expect(fieldNames).not.toEqual(expect.arrayContaining(['()constructor']));
  });

  it('ignores node_modules and dist by default', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-ignore-'));
    fs.mkdirSync(path.join(tmp, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'node_modules', 'foo', 'index.ts'),
      'export interface Ghost { x: string; }',
      'utf-8',
    );
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'export interface Kept { y: string; }', 'utf-8');
    try {
      const parser = new TypeScriptParser();
      const records = await parser.parseWorkspace({ workspaceRoot: tmp });
      expect(records.map((r) => r.name)).toEqual(['Kept']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
