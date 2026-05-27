import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectBadConfig } from '../detectors/bad-config.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-badcfg-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('bad-config detector', () => {
  it('flags tsconfig with strict:false as HIGH', () => {
    const root = workspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      expect(findings.some((f) => f.severity === 'high' && /strict/.test(f.title))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags missing strict (no strict, no sub-flags) as MED', () => {
    const root = workspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020' } }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      expect(findings.some((f) => f.severity === 'medium' && /strict.*not set/.test(f.title))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags noImplicitAny:false HIGH + strictNullChecks:false HIGH', () => {
    const root = workspace({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noImplicitAny: false, strictNullChecks: false },
      }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      const titles = findings.filter((f) => f.severity === 'high').map((f) => f.title);
      expect(titles.some((t) => /noImplicitAny/.test(t))).toBe(true);
      expect(titles.some((t) => /strictNullChecks/.test(t))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags allowJs:true without checkJs:true', () => {
    const root = workspace({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, allowJs: true },
      }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      expect(findings.some((f) => /allowJs/.test(f.title))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags eslint no-explicit-any: off as HIGH (JSON-style)', () => {
    const root = workspace({
      '.eslintrc.json': JSON.stringify({
        rules: { '@typescript-eslint/no-explicit-any': 'off' },
      }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      const hit = findings.find((f) => /no-explicit-any/.test(f.title));
      expect(hit).toBeTruthy();
      expect(hit!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags eslint flat-config script (.cjs) by regex', () => {
    const root = workspace({
      'eslint.config.cjs':
        "module.exports = [{ rules: { '@typescript-eslint/no-explicit-any': 'off' } }];",
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      const hit = findings.find((f) => /no-explicit-any/.test(f.title));
      expect(hit).toBeTruthy();
      expect(hit!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags biome.json noExplicitAny=off', () => {
    const root = workspace({
      'biome.json': JSON.stringify({
        linter: { rules: { suspicious: { noExplicitAny: 'off' } } },
      }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      const hit = findings.find((f) => /biome.*noExplicitAny/.test(f.title));
      expect(hit).toBeTruthy();
      expect(hit!.severity).toBe('high');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts JSONC comments + trailing commas in tsconfig', () => {
    const root = workspace({
      'tsconfig.json':
        '// header comment\n' +
        '{\n' +
        '  /* block */\n' +
        '  "compilerOptions": {\n' +
        '    "strict": false, // trailing\n' +
        '  },\n' +
        '}\n',
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      expect(findings.some((f) => f.severity === 'high' && /strict.*disabled/.test(f.title))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not flag clean strict tsconfig', () => {
    const root = workspace({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext' },
      }),
    });
    try {
      const findings = detectBadConfig({ workspaceRoot: root, files: [] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
