import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTestsWithoutAssertion } from '../detectors/test-without-assertion.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-twa-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function run(root: string, files: string[]) {
  return detectTestsWithoutAssertion({ workspaceRoot: root, files });
}

describe('test-without-assertion detector', () => {
  it('flags an `it(...)` whose body has no assertion', async () => {
    const root = setup({
      'src/__tests__/foo.test.ts':
        "import { describe, it } from '@jest/globals';\n" +
        "describe('foo', () => {\n" +
        "  it('does something', () => {\n" +
        '    const x = 1 + 1;\n' +
        '    void x;\n' +
        '  });\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/__tests__/foo.test.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.title).toContain('does something');
      expect(findings[0]!.title).toContain('src/__tests__/foo.test.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a test that uses `expect`', async () => {
    const root = setup({
      'src/__tests__/foo.test.ts':
        "import { expect, it } from '@jest/globals';\n" +
        "it('adds', () => {\n" +
        '  expect(1 + 1).toBe(2);\n' +
        '});\n',
    });
    try {
      expect(run(root, ['src/__tests__/foo.test.ts'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag node:assert / strict / chai / sinon style', async () => {
    const root = setup({
      'src/__tests__/a.test.ts':
        "import assert from 'node:assert';\n" + "it('a', () => { assert.equal(1, 1); });\n",
      'src/__tests__/b.test.ts':
        "import { strict } from 'node:assert';\n" +
        "it('b', () => { strict.deepEqual({a:1}, {a:1}); });\n",
      'src/__tests__/c.test.ts':
        "import chai from 'chai';\n" + "it('c', () => { chai.expect(1).to.equal(1); });\n",
      'src/__tests__/d.test.ts': "it('d', () => { mock.calledWith('x'); });\n",
    });
    try {
      const findings = run(root, [
        'src/__tests__/a.test.ts',
        'src/__tests__/b.test.ts',
        'src/__tests__/c.test.ts',
        'src/__tests__/d.test.ts',
      ]);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a test that asserts via `.toThrow` / `.toReject`', async () => {
    const root = setup({
      'src/__tests__/throws.test.ts':
        "it('throws', () => {\n" +
        '  expect(() => { throw new Error(); }).toThrow();\n' +
        '});\n' +
        "it('rejects', async () => {\n" +
        '  await expect(Promise.reject(new Error())).rejects.toThrow();\n' +
        '});\n',
    });
    try {
      expect(run(root, ['src/__tests__/throws.test.ts'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `it.skip` / `it.only` / `it.todo` / `xit` / `fit`', async () => {
    const root = setup({
      'src/__tests__/skip.test.ts':
        "it.skip('skipped', () => { const x = 1; void x; });\n" +
        "it.only('only', () => { const y = 2; void y; });\n" +
        "it.todo('todo placeholder');\n" +
        "xit('x-prefixed', () => { const z = 3; void z; });\n" +
        "fit('f-prefixed', () => { const w = 4; void w; });\n",
    });
    try {
      // skip-tests owns these; test-without-assertion stays quiet.
      const findings = run(root, ['src/__tests__/skip.test.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognises project-defined helpers named `expectFoo` / `assertFoo` / `verifyFoo`', async () => {
    const root = setup({
      'src/__tests__/helpers.test.ts':
        "it('a', () => { expectValidUser({ id: 1 }); });\n" +
        "it('b', () => { assertParsesCleanly('x'); });\n" +
        "it('c', () => { verifyResponseShape(res); });\n",
    });
    try {
      expect(run(root, ['src/__tests__/helpers.test.ts'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags multiple no-assertion tests in the same file', async () => {
    const root = setup({
      'src/__tests__/many.test.ts':
        "it('one', () => { const a = 1; void a; });\n" +
        "it('two', () => { const b = 2; void b; });\n" +
        "it('three', () => { expect(true).toBe(true); });\n",
    });
    try {
      const findings = run(root, ['src/__tests__/many.test.ts']);
      expect(findings).toHaveLength(2);
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => t.includes('one'))).toBe(true);
      expect(titles.some((t) => t.includes('two'))).toBe(true);
      expect(titles.some((t) => t.includes('three'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag tests inside non-test files', async () => {
    const root = setup({
      'src/foo.ts':
        "// Looks like a test but isn't in a test file.\n" +
        'function it(name: string, fn: () => void) { fn(); }\n' +
        "it('not a real test', () => { const x = 1; void x; });\n",
    });
    try {
      expect(run(root, ['src/foo.ts'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles `it.each(...)` / `test.concurrent(...)` correctly', async () => {
    const root = setup({
      'src/__tests__/each.test.ts':
        "it.each([1, 2, 3])('case %d', (n) => { const x = n + 1; void x; });\n" +
        "test.concurrent('parallel', async () => { const y = await Promise.resolve(1); void y; });\n",
    });
    try {
      // Both should be flagged — they're real running tests without assertions.
      const findings = run(root, ['src/__tests__/each.test.ts']);
      expect(findings).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects ignore annotation', async () => {
    const root = setup({
      'src/__tests__/ignore.test.ts':
        '// rothunter:ignore-test-without-assertion\n' +
        "it('intentionally empty for now', () => {\n" +
        '  const x = 1;\n' +
        '  void x;\n' +
        '});\n',
    });
    try {
      expect(run(root, ['src/__tests__/ignore.test.ts'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a stable fingerprint per (file, line, title)', async () => {
    const root = setup({
      'src/__tests__/fp.test.ts': "it('does something', () => { const x = 1; void x; });\n",
    });
    try {
      const a = run(root, ['src/__tests__/fp.test.ts']);
      const b = run(root, ['src/__tests__/fp.test.ts']);
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
      expect(a[0]!.fingerprint).toMatch(/^test-without-assertion:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
