import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectMutations } from '../detectors/mutation.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-mutation-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('mutation detector', () => {
  it('flags array-mutator method calls on a non-readonly parameter', async () => {
    const root = await setup({
      'src/x.ts': `
export function appendLog(items: string[], line: string): void {
  items.push(line);
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('items.push()')]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag mutation on a Readonly-typed parameter', async () => {
    const root = await setup({
      'src/x.ts': `
export function noop(items: ReadonlyArray<string>): number {
  // The cast below is a type error in real code, but we want the detector
  // to respect the declared type — the user is asserting "I won't mutate this".
  return items.length;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Object.assign when the target is a parameter', async () => {
    const root = await setup({
      'src/x.ts': `
export function merge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  Object.assign(target, src);
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('Object.assign: target')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `delete arg.x` as high severity', async () => {
    const root = await setup({
      'src/x.ts': `
export function strip(arg: { secret?: string; id: string }): { id: string } {
  delete arg.secret;
  return arg;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('high');
      expect(findings[0]?.title).toContain('delete arg');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `arg.prop = x` property assignment', async () => {
    const root = await setup({
      'src/x.ts': `
export function bumpVersion(record: { version: number }): void {
  record.version = record.version + 1;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('property assignment: record')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `this.x = y` inside a class method (intentional self-init)', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  increment(): void {
    this.value = this.value + 1;
  }
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('suppresses a finding with a `// rothunter:ignore-mutation` annotation', async () => {
    const root = await setup({
      'src/x.ts': `
export function bumpVersion(record: { version: number }): void {
  // rothunter:ignore-mutation — bump-in-place is part of this function's contract
  record.version = record.version + 1;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag mutation of a local variable (out of scope for Tier 1)', async () => {
    const root = await setup({
      'src/x.ts': `
export function build(): string[] {
  const buf: string[] = [];
  buf.push('a');
  return buf;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks arrow functions assigned to consts', async () => {
    const root = await setup({
      'src/x.ts': `
export const dropProp = (arg: { x?: number }): void => {
  delete arg.x;
};
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---- Tier 2: module-state mutation + escape analysis -------------------

  it('flags array mutation on a module-scope `let` as shared-state-write (high severity)', async () => {
    const root = await setup({
      'src/x.ts': `
let cache: string[] = [];
export function add(item: string): void {
  cache.push(item);
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.severity).toBe('high');
      expect(f.title).toContain('Shared module state');
      expect(f.fingerprint).toContain('shared-state-write');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag mutation of a module-scope `const` (binding is fixed, contents mutation is opt-in)', async () => {
    const root = await setup({
      'src/x.ts': `
const buf: string[] = [];
export function add(item: string): void {
  buf.push(item);
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('boosts severity to high when a mutated parameter ALSO escapes via return', async () => {
    const root = await setup({
      'src/x.ts': `
export function tagAndReturn(record: { id: string; tag?: string }, tag: string): { id: string; tag?: string } {
  record.tag = tag;
  return record;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      const assign = findings.find((f) => f.title.includes('property assignment'));
      expect(assign).toBeDefined();
      expect(assign?.severity).toBe('high');
      expect(assign?.title).toContain('[ESCAPES]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('boosts severity to high when a mutated parameter escapes via `this.x = arg`', async () => {
    const root = await setup({
      'src/x.ts': `
export class Box {
  private inner!: { value: number };
  hold(payload: { value: number }): void {
    payload.value = payload.value * 2;
    this.inner = payload;
  }
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      const assign = findings.find((f) => f.title.includes('property assignment'));
      expect(assign).toBeDefined();
      expect(assign?.severity).toBe('high');
      expect(assign?.title).toContain('[ESCAPES]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps severity at medium for a parameter mutation that does NOT escape', async () => {
    const root = await setup({
      'src/x.ts': `
export function annotate(record: { id: string; tag?: string }, tag: string): void {
  record.tag = tag;
}
`,
    });
    try {
      const findings = detectMutations({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('medium');
      expect(findings[0]?.title).not.toContain('[ESCAPES]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
