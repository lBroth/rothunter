import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectLongFiles } from '../detectors/long-file.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-longfile-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

function code(linesOfCode: number): string {
  return Array.from({ length: linesOfCode }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
}

describe('long-file detector', () => {
  it('flags MED when LOC >= 700 < 1200', () => {
    const root = workspace({ 'big.ts': code(800) });
    try {
      const findings = detectLongFiles({ workspaceRoot: root, files: ['big.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.title).toMatch(/800 LOC/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags HIGH when LOC >= 1200', () => {
    const root = workspace({ 'huge.ts': code(1300) });
    try {
      const findings = detectLongFiles({ workspaceRoot: root, files: ['huge.ts'] });
      expect(findings[0]!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores files under threshold', () => {
    const root = workspace({ 'short.ts': code(50) });
    try {
      const findings = detectLongFiles({ workspaceRoot: root, files: ['short.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips comments + blank lines from LOC count', () => {
    // 450 effective LOC sandwiched inside many blank/comment lines:
    const body = [
      '// header',
      '/*',
      ' * multi',
      ' * line',
      ' */',
      '',
      ...code(450).split('\n'),
      ...Array.from({ length: 200 }, () => '// trailing comment').slice(0, 200),
    ].join('\n');
    const root = workspace({ 'mixed.ts': body });
    try {
      const findings = detectLongFiles({
        workspaceRoot: root,
        files: ['mixed.ts'],
        lowThreshold: 400,
        medThreshold: 700,
      });
      // Effective LOC should be ~450 (only code lines counted), so LOW severity.
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('low');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips .d.ts and node_modules', () => {
    const root = workspace({
      'global.d.ts': code(900),
      'node_modules/x/y.ts': code(900),
    });
    try {
      const findings = detectLongFiles({
        workspaceRoot: root,
        files: ['global.d.ts', 'node_modules/x/y.ts'],
      });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors custom thresholds', () => {
    const root = workspace({ 'small.ts': code(100) });
    try {
      const findings = detectLongFiles({
        workspaceRoot: root,
        files: ['small.ts'],
        lowThreshold: 50,
        medThreshold: 75,
        highThreshold: 90,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
