import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectMagicNumbers } from '../detectors/magic-numbers.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-magic-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('magic-numbers detector', () => {
  it('flags business-logic magic numbers', () => {
    const root = workspace({
      'src/a.ts': "function timeout() { return retry * 47 + 3600; }\n",
    });
    try {
      const findings = detectMagicNumbers({ workspaceRoot: root, files: ['src/a.ts'] });
      // Should flag at least the 47 and 3600 (both not in whitelist).
      expect(findings.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores whitelist values (0/1/-1/2/10/100/1000)', () => {
    const root = workspace({
      'src/a.ts': "const a = 0; const b = 1; const c = -1; const d = 2; const e = 100;\n",
    });
    try {
      const findings = detectMagicNumbers({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores numbers inside strings + comments', () => {
    const root = workspace({
      'src/a.ts':
        "const msg = 'retry after 47 seconds';\n" +
        "// 12345 ABC\n" +
        "/* 67890 */\n",
    });
    try {
      const findings = detectMagicNumbers({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps per file at 5 by default', () => {
    const root = workspace({
      'src/a.ts': Array.from({ length: 20 }, (_, i) => `function f${i}() { return ${100 + i} + ${200 + i}; }`).join('\n'),
    });
    try {
      const findings = detectMagicNumbers({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings.length).toBeLessThanOrEqual(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips test files', () => {
    const root = workspace({
      'src/a.test.ts': "expect(retry).toBe(47);\n",
    });
    try {
      const findings = detectMagicNumbers({ workspaceRoot: root, files: ['src/a.test.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
