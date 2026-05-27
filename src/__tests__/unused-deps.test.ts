import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectUnusedDeps } from '../detectors/unused-deps.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-unused-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('unused-deps detector', () => {
  it('flags deps declared but never imported', () => {
    const root = workspace({
      'package.json': JSON.stringify({
        dependencies: { react: '*', 'unused-lib': '*' },
      }),
    });
    try {
      const findings = detectUnusedDeps({
        workspaceRoot: root,
        imports: [
          {
            source: 'a.ts',
            specifier: 'react',
            target: null,
            namedImports: [],
            isReExport: false,
            isStarReExport: false,
          },
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toMatch(/unused-lib/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles scoped packages', () => {
    const root = workspace({
      'package.json': JSON.stringify({
        dependencies: { '@scope/used': '*', '@scope/unused': '*' },
      }),
    });
    try {
      const findings = detectUnusedDeps({
        workspaceRoot: root,
        imports: [
          {
            source: 'a.ts',
            specifier: '@scope/used/lib',
            target: null,
            namedImports: [],
            isReExport: false,
            isStarReExport: false,
          },
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toMatch(/@scope\/unused/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag devDependencies', () => {
    const root = workspace({
      'package.json': JSON.stringify({
        devDependencies: { jest: '*', eslint: '*' },
      }),
    });
    try {
      expect(detectUnusedDeps({ workspaceRoot: root, imports: [] })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores known runtime loaders (tsx, ts-node, etc.)', () => {
    const root = workspace({
      'package.json': JSON.stringify({ dependencies: { tsx: '*', 'ts-node': '*' } }),
    });
    try {
      expect(detectUnusedDeps({ workspaceRoot: root, imports: [] })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats node builtins as not-a-dep', () => {
    const root = workspace({
      'package.json': JSON.stringify({ dependencies: { react: '*' } }),
    });
    try {
      const findings = detectUnusedDeps({
        workspaceRoot: root,
        imports: [
          {
            source: 'a.ts',
            specifier: 'fs',
            target: null,
            namedImports: [],
            isReExport: false,
            isStarReExport: false,
          },
          {
            source: 'a.ts',
            specifier: 'node:path',
            target: null,
            namedImports: [],
            isReExport: false,
            isStarReExport: false,
          },
        ],
      });
      // react still unused since imports don't reference it.
      expect(findings.map((f) => f.title)).toEqual([expect.stringMatching(/react/)]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
