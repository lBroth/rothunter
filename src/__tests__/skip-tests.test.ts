import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSkipTests } from '../detectors/skip-tests.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-skip-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('skip-tests detector', () => {
  it('flags it.skip / describe.skip in *.test.ts files', () => {
    const root = workspace({
      'a.test.ts': [
        "describe.skip('outer', () => {});",
        "it.skip('a', () => {});",
        "test.skip('b', () => {});",
      ].join('\n'),
    });
    try {
      const findings = detectSkipTests({ workspaceRoot: root, files: ['a.test.ts'] });
      expect(findings).toHaveLength(3);
      for (const f of findings) {
        expect(f.severity).toBe('medium');
        expect(f.detectorId).toBe('skip-tests');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags .only as HIGH (most dangerous)', () => {
    const root = workspace({
      'a.test.ts': "it.only('only this', () => {});",
    });
    try {
      const findings = detectSkipTests({ workspaceRoot: root, files: ['a.test.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Jasmine x-prefix + f-prefix', () => {
    const root = workspace({
      'a.test.ts': [
        "xdescribe('x', () => {});",
        "xit('x', () => {});",
        "fdescribe('f', () => {});",
        "fit('f', () => {});",
      ].join('\n'),
    });
    try {
      const findings = detectSkipTests({ workspaceRoot: root, files: ['a.test.ts'] });
      expect(findings).toHaveLength(4);
      const sevs = findings.map((f) => f.severity).sort();
      expect(sevs).toEqual(['high', 'high', 'medium', 'medium']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-test files', () => {
    const root = workspace({
      'src/app.ts': "it.only('not a test file path', () => {});",
    });
    try {
      const findings = detectSkipTests({ workspaceRoot: root, files: ['src/app.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('picks up files under __tests__ folder', () => {
    const root = workspace({
      '__tests__/a.ts': "it.only('hit', () => {});",
    });
    try {
      const findings = detectSkipTests({ workspaceRoot: root, files: ['__tests__/a.ts'] });
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
