import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectRaceConditions } from '../detectors/race-condition.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-race-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('race-condition detector', () => {
  it('flags read-modify-write across await on `this.X`', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  async bump(): Promise<void> {
    const cur = this.value;
    await new Promise<void>((res) => setTimeout(res, 1));
    this.value = cur + 1;
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.title).toContain('this.value');
      expect(findings[0]?.fingerprint).toContain('race:read-modify-write');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags read-modify-write across await on a module-scope `let`', async () => {
    const root = await setup({
      'src/x.ts': `
let counter = 0;
export async function bump(): Promise<void> {
  const cur = counter;
  await new Promise<void>((res) => setTimeout(res, 1));
  counter = cur + 1;
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.title).toContain('counter');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when there is no await between the read and write', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  bump(): void {
    const cur = this.value;
    this.value = cur + 1;
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when read + await happen but no later write to the same target', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  async log(): Promise<void> {
    const cur = this.value;
    await someAsyncWork(cur);
  }
}
async function someAsyncWork(n: number): Promise<void> { void n; }
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when the write target differs from the read target', async () => {
    const root = await setup({
      'src/x.ts': `
export class Store {
  private a = 0;
  private b = 0;
  async copy(): Promise<void> {
    const ra = this.a;
    await Promise.resolve();
    this.b = ra;
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('suppresses a finding with a `// rothunter:ignore-race` annotation on the write', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  async bump(): Promise<void> {
    const cur = this.value;
    await Promise.resolve();
    // rothunter:ignore-race — single-flighted by the caller
    this.value = cur + 1;
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `Promise.all` with two arms writing the same `this.X`', async () => {
    const root = await setup({
      'src/x.ts': `
export class Tally {
  private tally = 0;
  async bumpTwice(): Promise<void> {
    await Promise.all([
      (async () => { this.tally = this.tally + 1; })(),
      (async () => { this.tally = this.tally + 2; })(),
    ]);
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toHaveLength(1);
      expect(paf[0]?.title).toContain('this.tally');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `Promise.allSettled` with two arms writing the same module mutable', async () => {
    const root = await setup({
      'src/x.ts': `
let acc: number[] = [];
export async function fanOut(): Promise<void> {
  await Promise.allSettled([
    (async () => { acc = [...acc, 1]; })(),
    (async () => { acc = [...acc, 2]; })(),
  ]);
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toHaveLength(1);
      expect(paf[0]?.title).toContain('acc');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `Promise.all` when each arm writes a different target', async () => {
    const root = await setup({
      'src/x.ts': `
export class Pair {
  private a = 0;
  private b = 0;
  async fill(): Promise<void> {
    await Promise.all([
      (async () => { this.a = 1; })(),
      (async () => { this.b = 2; })(),
    ]);
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `Promise.all(arr.map(async))` callback writing `this.X` after await', async () => {
    const root = await setup({
      'src/x.ts': `
declare function flush(item: number): Promise<void>;
export class Aggregator {
  private tally = 0;
  async run(items: number[]): Promise<void> {
    await Promise.all(items.map(async (item) => {
      const cur = this.tally;
      await flush(item);
      this.tally = cur + 1;
    }));
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf.length).toBeGreaterThanOrEqual(1);
      expect(paf[0]?.title).toContain('this.tally');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `Promise.all(arr.map(async))` when callback only reads shared state', async () => {
    const root = await setup({
      'src/x.ts': `
declare function fetchSize(id: string): Promise<number>;
export class Sizer {
  private base = 10;
  async run(ids: string[]): Promise<number[]> {
    return Promise.all(ids.map(async (id) => {
      const n = await fetchSize(id);
      return n + this.base;
    }));
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `Promise.all(arr.map(...))` when callback is synchronous (no await)', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private n = 0;
  run(items: number[]): Promise<number[]> {
    return Promise.all(items.map((item) => {
      this.n = this.n + item;
      return Promise.resolve(this.n);
    }));
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `Promise.all` when only one arm writes the shared target', async () => {
    const root = await setup({
      'src/x.ts': `
export class Counter {
  private value = 0;
  async only(): Promise<void> {
    await Promise.all([
      (async () => { this.value = 1; })(),
      (async () => { await Promise.resolve(); })(),
    ]);
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const paf = findings.filter((f) => f.fingerprint.startsWith('race:promise-all'));
      expect(paf).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags event-emitter handler closing over an outer `let` with read-modify-write across await', async () => {
    const root = await setup({
      'src/x.ts': `
declare const emitter: { on(event: string, fn: (...args: unknown[]) => unknown): void };
declare function flush(): Promise<void>;
let buffer: number[] = [];
export function wire(): void {
  emitter.on('data', async (item: number) => {
    const cur = buffer;
    await flush();
    buffer = [...cur, item];
  });
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const handlerRaces = findings.filter(
        (f) => f.fingerprint.startsWith('race:read-modify-write') && f.title.includes('buffer'),
      );
      expect(handlerRaces).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `emitter.addListener` async handler closing over a function-scope `let`', async () => {
    const root = await setup({
      'src/x.ts': `
declare const emitter: { addListener(event: string, fn: (...args: unknown[]) => unknown): void };
declare function flush(): Promise<void>;
export function wire(): void {
  let acc = 0;
  emitter.addListener('tick', async () => {
    const cur = acc;
    await flush();
    acc = cur + 1;
  });
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      const handlerRaces = findings.filter(
        (f) => f.fingerprint.startsWith('race:read-modify-write') && f.title.includes('acc'),
      );
      expect(handlerRaces).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a non-async event handler (no await between read and write)', async () => {
    const root = await setup({
      'src/x.ts': `
declare const emitter: { on(event: string, fn: (...args: unknown[]) => unknown): void };
let acc = 0;
export function wire(): void {
  emitter.on('tick', () => {
    const cur = acc;
    acc = cur + 1;
  });
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag synchronous functions', async () => {
    const root = await setup({
      'src/x.ts': `
let counter = 0;
export function bump(): void {
  const cur = counter;
  counter = cur + 1;
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- CFG-aware reachability ----------------------------------------
  // Regression guards for the false-positive class that the source-line
  // heuristic produced: a read that is only reached on a branch that never
  // joins back into the write path is NOT a race.

  it('CFG: does NOT flag a read whose branch always returns before any await', async () => {
    const root = await setup({
      'src/x.ts': `
export class Service {
  private value = 0;
  async load(cond: boolean): Promise<number> {
    if (cond) {
      const cached = this.value;
      return cached;
    }
    await new Promise<void>((res) => setTimeout(res, 1));
    this.value = 42;
    return 42;
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      // The only read of \`this.value\` lives in the \`if (cond)\` then-branch
      // which unconditionally returns. The path that reaches the await +
      // write never touches the read, so no read-modify-write can race.
      // Pre-CFG detector flagged this on line ordering alone; CFG correctly
      // rejects because the read-block has no successor that reaches the
      // post-if join.
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('CFG: flags a straight-line read → await → write even when wrapped in an outer if', async () => {
    const root = await setup({
      'src/x.ts': `
export class Service {
  private value = 0;
  async bump(cond: boolean): Promise<void> {
    if (cond) {
      const cur = this.value;
      await new Promise<void>((res) => setTimeout(res, 1));
      this.value = cur + 1;
    }
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      // Inside the then-branch the three statements are sequential and
      // share one CFG block — the race pattern is real on the cond=true
      // path. Regression guard against the CFG rewrite being too eager
      // in rejecting non-trivial control flow.
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0]?.title).toContain('this.value');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('CFG: does NOT flag a read in a loop where the write happens after the loop exits before any await', async () => {
    const root = await setup({
      'src/x.ts': `
export class Service {
  private value = 0;
  async run(): Promise<void> {
    while (this.value < 10) {
      const cur = this.value;
      this.value = cur + 1;
    }
    await new Promise<void>((res) => setTimeout(res, 1));
  }
}
`,
    });
    try {
      const findings = detectRaceConditions({ workspaceRoot: root, files: ['src/x.ts'] });
      // No await sits between the read and the write inside the loop body
      // — both happen synchronously in the same iteration. The await is
      // after the loop, but there's no write past it. CFG correctly sees
      // no read-await-write triple.
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
