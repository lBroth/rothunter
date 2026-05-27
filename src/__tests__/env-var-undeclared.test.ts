import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectEnvVarUndeclared } from '../detectors/env-var-undeclared.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-env-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function run(root: string, files: string[]) {
  return detectEnvVarUndeclared({ workspaceRoot: root, files });
}

describe('env-var-undeclared detector', () => {
  it('flags process.env.X read but never declared anywhere', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.DATABASE_URL;\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0]!.title).toContain('DATABASE_URL');
      expect(undeclared[0]!.title).toContain('src/index.ts');
      expect(undeclared[0]!.fingerprint).toMatch(/^env-var-undeclared:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a variable present in .env.example', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.DATABASE_URL;\n',
      '.env.example': 'DATABASE_URL=postgres://localhost\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a variable declared in a Dockerfile ENV', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.API_TOKEN;\n',
      Dockerfile: 'FROM node:24\nENV API_TOKEN=changeme\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a variable declared via docker-compose environment:', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.REDIS_URL;\n',
      'docker-compose.yml':
        'services:\n  api:\n    image: foo\n    environment:\n      REDIS_URL: redis://localhost\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag well-known runtime vars (NODE_ENV, CI, …)', async () => {
    const root = setup({
      'src/index.ts':
        'export const e = process.env.NODE_ENV;\n' +
        'export const c = process.env.CI;\n' +
        'export const d = process.env.DEBUG;\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags bracket-access reads (`process.env["FOO"]`)', async () => {
    const root = setup({
      'src/index.ts': "export const x = process.env['SECRET_KEY'];\n",
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0]!.title).toContain('SECRET_KEY');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Vite-style import.meta.env reads', async () => {
    const root = setup({
      'src/main.ts': 'export const api = import.meta.env.VITE_API_URL;\n',
    });
    try {
      const findings = run(root, ['src/main.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0]!.title).toContain('VITE_API_URL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits a paired dead-env finding when .env.example lists a var no source reads', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.USED_VAR;\n',
      '.env.example': 'USED_VAR=x\nDEAD_VAR=unused\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const dead = findings.filter((f) => f.severity === 'low');
      expect(dead).toHaveLength(1);
      expect(dead[0]!.title).toContain('DEAD_VAR');
      expect(dead[0]!.title).toContain('.env.example');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('collapses multiple reads of the same var in the same file into one finding', async () => {
    const root = setup({
      'src/index.ts':
        'const a = process.env.MULTI;\n' +
        'const b = process.env.MULTI + "";\n' +
        'console.log(process.env.MULTI);\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter(
        (f) => f.severity === 'medium' && f.title.includes('MULTI'),
      );
      expect(undeclared).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits one finding per file when the same var is read in multiple files', async () => {
    const root = setup({
      'src/a.ts': 'export const a = process.env.SHARED;\n',
      'src/b.ts': 'export const b = process.env.SHARED;\n',
    });
    try {
      const findings = run(root, ['src/a.ts', 'src/b.ts']);
      const undeclared = findings.filter(
        (f) => f.severity === 'medium' && f.title.includes('SHARED'),
      );
      expect(undeclared).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects the rothunter:ignore-env-var-undeclared annotation', async () => {
    const root = setup({
      'src/index.ts':
        '// rothunter:ignore-env-var-undeclared\n' + 'export const u = process.env.INTENTIONAL;\n',
    });
    try {
      const findings = run(root, ['src/index.ts']);
      const undeclared = findings.filter((f) => f.severity === 'medium');
      expect(undeclared).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces stable fingerprints', async () => {
    const root = setup({
      'src/index.ts': 'export const u = process.env.STABLE;\n',
    });
    try {
      const a = run(root, ['src/index.ts']);
      const b = run(root, ['src/index.ts']);
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
