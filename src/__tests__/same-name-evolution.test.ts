import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectSameNameEvolution } from '../detectors/same-name-evolution.js';
import type { SymbolRecord } from '../types.js';

function git(cmd: string[], cwd: string): void {
  execFileSync('git', cmd, { cwd, stdio: 'ignore' });
}

function fn(name: string, file: string, source: string): SymbolRecord {
  const lines = source.split('\n');
  return {
    id: `${file}:${name}`,
    kind: 'function',
    name,
    file,
    range: { startLine: 1, endLine: lines.length },
    source,
    exported: true,
  };
}

describe('same-name-evolution detector', () => {
  it('returns empty when not a git repo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-evolution-nogit-'));
    try {
      const out = detectSameNameEvolution({
        workspaceRoot: root,
        symbols: [fn('foo', 'a.ts', 'function foo() { return 1; }'), fn('foo', 'b.ts', 'function foo() { return 2; }')],
      });
      expect(out).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags same-name fns when git history is >= minDayGap apart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-evolution-'));
    try {
      // Initialise a tiny git repo, commit a.ts in the distant past, b.ts now.
      git(['init', '-q', '-b', 'main'], root);
      git(['config', 'user.email', 'rh@test'], root);
      git(['config', 'user.name', 'RH'], root);
      fs.writeFileSync(path.join(root, 'a.ts'), 'function foo() { return 1; }\n');
      git(['add', 'a.ts'], root);
      execFileSync('git', ['commit', '-q', '-m', 'a', '--date=2024-01-01T00:00:00'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00', GIT_COMMITTER_DATE: '2024-01-01T00:00:00' },
      });
      fs.writeFileSync(path.join(root, 'b.ts'), 'function foo() { return 2; }\n');
      git(['add', 'b.ts'], root);
      execFileSync('git', ['commit', '-q', '-m', 'b'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_DATE: '2024-06-01T00:00:00', GIT_COMMITTER_DATE: '2024-06-01T00:00:00' },
      });

      const findings = detectSameNameEvolution({
        workspaceRoot: root,
        minDayGap: 30,
        minLines: 1,
        symbols: [
          fn('foo', 'a.ts', 'function foo() { return 1; }'),
          fn('foo', 'b.ts', 'function foo() { return 2; }'),
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.evidence.length).toBe(2);
      expect(findings[0]!.title).toMatch(/foo/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when both copies committed at the same time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-evolution-same-'));
    try {
      git(['init', '-q', '-b', 'main'], root);
      git(['config', 'user.email', 'rh@test'], root);
      git(['config', 'user.name', 'RH'], root);
      fs.writeFileSync(path.join(root, 'a.ts'), 'function foo() { return 1; }\n');
      fs.writeFileSync(path.join(root, 'b.ts'), 'function foo() { return 2; }\n');
      git(['add', 'a.ts', 'b.ts'], root);
      git(['commit', '-q', '-m', 'init'], root);

      const findings = detectSameNameEvolution({
        workspaceRoot: root,
        minDayGap: 30,
        minLines: 1,
        symbols: [
          fn('foo', 'a.ts', 'function foo() { return 1; }'),
          fn('foo', 'b.ts', 'function foo() { return 2; }'),
        ],
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
