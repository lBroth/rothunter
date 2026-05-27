import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPackageExportMismatch } from '../detectors/package-export-mismatch.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-pkgexp-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function pkg(extra: Record<string, unknown>): string {
  return JSON.stringify({ name: 'demo', version: '1.0.0', ...extra }, null, 2);
}

describe('package-export-mismatch detector', () => {
  it('flags `main` pointing at a path with no on-disk and no source counterpart', async () => {
    const root = setup({
      'package.json': pkg({ main: 'dist/missing.js' }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
      expect(findings[0]!.title).toContain('dist/missing.js');
      expect(findings[0]!.title).toContain('main');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `main: "dist/x.js"` when src/x.ts exists', async () => {
    const root = setup({
      'package.json': pkg({ main: 'dist/x.js' }),
      'src/x.ts': 'export const x = 1;\n',
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when the JS file itself exists (post-build scan)', async () => {
    const root = setup({
      'package.json': pkg({ main: 'dist/x.js' }),
      'dist/x.js': '"use strict";\n',
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `types` field pointing at a missing .d.ts with no .ts counterpart', async () => {
    const root = setup({
      'package.json': pkg({ types: 'dist/types.d.ts' }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('types');
      expect(findings[0]!.title).toContain('dist/types.d.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags every missing target in the `exports` map', async () => {
    const root = setup({
      'package.json': pkg({
        exports: {
          '.': { types: './dist/main.d.ts', default: './dist/main.js' },
          './utils': './dist/utils.js',
        },
      }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings.length).toBeGreaterThanOrEqual(3);
      const specs = findings.map((f) => f.title);
      expect(specs.some((s) => s.includes('dist/main.d.ts'))).toBe(true);
      expect(specs.some((s) => s.includes('dist/main.js'))).toBe(true);
      expect(specs.some((s) => s.includes('dist/utils.js'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a wildcard subpath (`./*` etc.)', async () => {
    const root = setup({
      'package.json': pkg({
        exports: { './*': './dist/*.js' },
      }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      // Wildcards are conservatively skipped — would need glob expansion.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags `bin` entries that point at missing scripts', async () => {
    const root = setup({
      'package.json': pkg({
        bin: { 'demo-cli': 'dist/cli.js', helper: 'bin/helper.js' },
      }),
      'src/cli.ts': '#!/usr/bin/env node\nconsole.log("cli");\n',
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      // demo-cli has a TS counterpart; helper does not.
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => t.includes('bin/helper.js'))).toBe(true);
      expect(titles.some((t) => t.includes('dist/cli.js'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips private packages entirely', async () => {
    const root = setup({
      'package.json': pkg({ private: true, main: 'dist/never-built.js' }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns no findings when there is no package.json', async () => {
    const root = setup({ 'src/x.ts': 'export const x = 1;\n' });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns no findings for malformed package.json', async () => {
    const root = setup({ 'package.json': '{ not valid json' });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles `exports` as a bare string', async () => {
    const root = setup({
      'package.json': pkg({ exports: './dist/missing.js' }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('dist/missing.js');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits stable, deduplicated fingerprints', async () => {
    const root = setup({
      'package.json': pkg({ main: 'dist/x.js', module: 'dist/x.js' }),
    });
    try {
      const findings = detectPackageExportMismatch({ workspaceRoot: root });
      // Two different fields (`main`, `module`) → two findings, but
      // the dedup key includes the field so they don't collapse.
      expect(findings).toHaveLength(2);
      const a = detectPackageExportMismatch({ workspaceRoot: root });
      expect(a[0]!.fingerprint).toBe(findings[0]!.fingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
