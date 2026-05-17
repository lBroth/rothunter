import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSecretLeaks } from '../detectors/secret-leak.js';

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-secret-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('secret-leak detector', () => {
  it('flags AWS access keys + GitHub tokens as HIGH', () => {
    const root = workspace({
      'a.ts':
        "const aws = 'AKIAABCDEFGHIJKLMNOP';\n" +
        "const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';\n",
    });
    try {
      const findings = detectSecretLeaks({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings.length).toBeGreaterThanOrEqual(2);
      expect(findings.every((f) => f.severity === 'high')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags OpenAI + Anthropic keys', () => {
    const root = workspace({
      'a.ts':
        "const o = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';\n" +
        "const a = 'sk-ant-abcdefghijklmnopqrstuvwxyz';\n",
    });
    try {
      const findings = detectSecretLeaks({ workspaceRoot: root, files: ['a.ts'] });
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => /OpenAI/.test(t))).toBe(true);
      expect(titles.some((t) => /Anthropic/.test(t))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags hardcoded localhost URLs as LOW', () => {
    const root = workspace({
      'a.ts': "const u = 'http://localhost:3000/api';\n",
    });
    try {
      const findings = detectSecretLeaks({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('low');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts the secret value in snippets', () => {
    const root = workspace({
      'a.ts': "const k = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';\n",
    });
    try {
      const findings = detectSecretLeaks({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings[0]!.evidence[0]!.snippet).toMatch(/REDACTED/);
      expect(findings[0]!.evidence[0]!.snippet).not.toMatch(/abcdefghijklmnopqrstuvwxyz123456/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores test fixtures + .env.example', () => {
    const root = workspace({
      '__fixtures__/keys.ts': "const aws = 'AKIAABCDEFGHIJKLMNOP';\n",
      '.env.example': "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\n",
    });
    try {
      const findings = detectSecretLeaks({
        workspaceRoot: root,
        files: ['__fixtures__/keys.ts', '.env.example'],
      });
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags generic password / api_key assignments', () => {
    const root = workspace({
      'a.ts':
        "const password = 'hunter2hunter2';\n" +
        "const api_key = 'live_xyz1234567890abcdef';\n",
    });
    try {
      const findings = detectSecretLeaks({ workspaceRoot: root, files: ['a.ts'] });
      expect(findings.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
