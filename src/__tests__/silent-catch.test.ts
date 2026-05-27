import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSilentCatches } from '../detectors/silent-catch.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-silent-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('silent-catch detector', () => {
  it('flags an empty catch body', () => {
    const root = workspace({
      'a.ts': "try { JSON.parse('{'); } catch (e) {}\n",
    });
    try {
      const findings = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.detectorId).toBe('silent-catch');
      expect(findings[0]!.severity).toBe('medium');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags catch with only console.log', () => {
    const root = workspace({
      'a.ts': "try { JSON.parse('{'); } catch (err) { console.log(err); }\n",
    });
    try {
      const findings = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toMatch(/only logs/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags catch with bare return', () => {
    const root = workspace({
      'a.ts': "function f() { try { return JSON.parse('{'); } catch { return; } }\n",
    });
    try {
      const findings = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag console.error (intentional reporting)', () => {
    const root = workspace({
      'a.ts': 'try { x(); } catch (e) { console.error(e); }\n',
    });
    try {
      const findings = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag catch with rethrow / real handling', () => {
    const root = workspace({
      'a.ts':
        "try { x(); } catch (e) { throw new Error('wrap'); }\n" +
        'try { y(); } catch (e) { logger.error({ err: e }); reporter.send(e); }\n',
    });
    try {
      const findings = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips .d.ts and unsupported extensions', () => {
    const root = workspace({
      'global.d.ts': 'declare const x: any;\n',
      'README.md': 'try { } catch {}\n',
    });
    try {
      const findings = detectSilentCatches({
        workspaceRoot: root,
        files: ['global.d.ts', 'README.md'],
      });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces stable fingerprints across runs', () => {
    const root = workspace({
      'a.ts': 'try { x(); } catch {}\n',
    });
    try {
      const a = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      const b = detectSilentCatches({ workspaceRoot: root, files: ['a.ts'] });
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
