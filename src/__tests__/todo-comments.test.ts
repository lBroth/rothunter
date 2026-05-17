import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTodoComments } from '../detectors/todo-comments.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-todo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('todo-comments detector', () => {
  it('flags TODO / FIXME / HACK with appropriate severities', () => {
    const root = workspace({
      'src/a.ts':
        '// TODO: refactor this\n' +
        '// FIXME wrong threshold\n' +
        '// HACK skip auth for demo\n',
    });
    try {
      const findings = detectTodoComments({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toHaveLength(3);
      const byMarker: Record<string, string> = {};
      for (const f of findings) {
        const m = /(\bTODO|FIXME|HACK)\b/.exec(f.title)?.[1] ?? '';
        byMarker[m] = f.severity;
      }
      expect(byMarker.TODO).toBe('low');
      expect(byMarker.FIXME).toBe('medium');
      expect(byMarker.HACK).toBe('medium');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures the comment body in the title', () => {
    const root = workspace({
      'a.ts': '// TODO: pagination broken on page 3\n',
    });
    try {
      const findings = detectTodoComments({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toMatch(/pagination broken/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches in block-comment + python-style # comments', () => {
    const root = workspace({
      'a.ts': '/* TODO finish */\n',
      'b.py': '# FIXME wrong import\n',
    });
    try {
      const findings = detectTodoComments({ workspaceRoot: root, files: ['a.ts', 'b.py'] });
      expect(findings).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects max-findings cap', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `// TODO item ${i}`).join('\n');
    const root = workspace({ 'a.ts': lines });
    try {
      const findings = detectTodoComments({
        workspaceRoot: root,
        files: ['a.ts'],
        maxFindings: 10,
      });
      expect(findings).toHaveLength(10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not match the substring TODO inside identifiers', () => {
    const root = workspace({
      'a.ts': "const TODOItems = [];\nconst x = 'not a TODO marker';\n",
    });
    try {
      const findings = detectTodoComments({ workspaceRoot: root, files: ['a.ts'] });
      // Second line has `'not a TODO marker'` inside a string literal —
      // but no comment-prefix, so should NOT match.
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips node_modules + dist + .d.ts', () => {
    const root = workspace({
      'node_modules/x/a.ts': '// TODO ignored\n',
      'dist/b.ts': '// TODO ignored\n',
      'types.d.ts': '// TODO ignored\n',
    });
    try {
      const findings = detectTodoComments({
        workspaceRoot: root,
        files: ['node_modules/x/a.ts', 'dist/b.ts', 'types.d.ts'],
      });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors custom marker list', () => {
    const root = workspace({
      'a.ts': '// TODO ignore me\n// CUSTOM hit me\n',
    });
    try {
      const findings = detectTodoComments({
        workspaceRoot: root,
        files: ['a.ts'],
        markers: ['CUSTOM'],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toMatch(/CUSTOM/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
