import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectConsoleLogsInProd } from '../detectors/console-log-prod.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-clog-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('console-log-prod detector', () => {
  it('flags console.log / debug / info', () => {
    const root = workspace({
      'src/a.ts': "console.log('a');\nconsole.debug('b');\nconsole.info('c');\n",
    });
    try {
      const findings = detectConsoleLogsInProd({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(3);
      for (const f of findings) expect(f.severity).toBe('low');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag console.warn / console.error', () => {
    const root = workspace({
      'src/a.ts': "console.warn('w');\nconsole.error('e');\n",
    });
    try {
      const findings = detectConsoleLogsInProd({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips test files', () => {
    const root = workspace({
      'src/a.test.ts': "console.log('a');\n",
      '__tests__/b.ts': "console.log('a');\n",
    });
    try {
      const findings = detectConsoleLogsInProd({
        workspaceRoot: root,
        files: ['src/a.test.ts', '__tests__/b.ts'],
      });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips commented-out lines', () => {
    const root = workspace({
      'src/a.ts': "// console.log('debug');\n",
    });
    try {
      const findings = detectConsoleLogsInProd({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
