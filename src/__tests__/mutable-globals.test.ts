import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectMutableGlobals } from '../detectors/mutable-globals.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-mglobal-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('mutable-globals detector', () => {
  it('flags top-level let reassigned later', () => {
    const root = workspace({
      'src/a.ts': 'let counter = 0;\nfunction inc() { counter = counter + 1; }\n',
    });
    try {
      const findings = detectMutableGlobals({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('medium');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag top-level let assigned only once', () => {
    const root = workspace({
      'src/a.ts': 'let constInDisguise = 42;\nfunction f() { return constInDisguise; }\n',
    });
    try {
      const findings = detectMutableGlobals({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags export let with later reassignment', () => {
    const root = workspace({
      'src/a.ts':
        "export let cfg = { mode: 'a' };\nexport function setMode(m: string) { cfg.mode = m; cfg = { mode: m }; }\n",
    });
    try {
      const findings = detectMutableGlobals({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag let inside a function', () => {
    const root = workspace({
      'src/a.ts': 'function f() { let x = 0; x = x + 1; return x; }\n',
    });
    try {
      const findings = detectMutableGlobals({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags compound assignment ops (+= etc.)', () => {
    const root = workspace({
      'src/a.ts': 'let total = 0;\nfunction add(n: number) { total += n; }\n',
    });
    try {
      const findings = detectMutableGlobals({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
