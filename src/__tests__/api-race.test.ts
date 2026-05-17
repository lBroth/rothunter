import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectApiRaces } from '../detectors/api-race.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-api-race-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('api-race detector', () => {
  it('flags two files issuing PUT against the same path pattern', async () => {
    const root = await setup({
      'src/ui/save.ts': `
export async function save(id: string, body: unknown): Promise<void> {
  await fetch(\`/api/users/\${id}\`, { method: 'PUT', body: JSON.stringify(body) });
}
`,
      'src/jobs/sync.ts': `
export async function syncUser(id: string, body: unknown): Promise<void> {
  await fetch(\`/api/users/\${id}\`, { method: 'PUT', body: JSON.stringify(body) });
}
`,
    });
    try {
      const findings = detectApiRaces({
        workspaceRoot: root,
        files: ['src/ui/save.ts', 'src/jobs/sync.ts'],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.title).toContain('PUT /api/users/:param');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags axios.patch with the same path across files', async () => {
    const root = await setup({
      'src/ui/edit.ts': `
declare const axios: any;
export async function edit(id: string, data: unknown): Promise<void> {
  await axios.patch(\`/api/orders/\${id}\`, data);
}
`,
      'src/worker/retry.ts': `
declare const axios: any;
export async function retry(id: string, data: unknown): Promise<void> {
  await axios.patch(\`/api/orders/\${id}\`, data);
}
`,
    });
    try {
      const findings = detectApiRaces({
        workspaceRoot: root,
        files: ['src/ui/edit.ts', 'src/worker/retry.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('PATCH /api/orders/:param')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags axios({ method: "put", url }) config-object call', async () => {
    const root = await setup({
      'src/a.ts': `
declare const axios: any;
export async function a(id: string): Promise<void> {
  await axios({ method: 'put', url: \`/api/items/\${id}\` });
}
`,
      'src/b.ts': `
declare const axios: any;
export async function b(id: string, data: unknown): Promise<void> {
  await axios.put(\`/api/items/\${id}\`, data);
}
`,
    });
    try {
      const findings = detectApiRaces({
        workspaceRoot: root,
        files: ['src/a.ts', 'src/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('PUT /api/items/:param')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalises numeric path segments to `:id` for clustering', async () => {
    const root = await setup({
      'src/a.ts': `
export async function a(): Promise<void> {
  await fetch('/api/users/123', { method: 'DELETE' });
}
`,
      'src/b.ts': `
export async function b(): Promise<void> {
  await fetch('/api/users/456', { method: 'DELETE' });
}
`,
    });
    try {
      const findings = detectApiRaces({
        workspaceRoot: root,
        files: ['src/a.ts', 'src/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('DELETE /api/users/:id')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag GET (read-only, no race effect)', async () => {
    const root = await setup({
      'src/a.ts': `
export async function a(id: string): Promise<unknown> {
  return fetch(\`/api/users/\${id}\`, { method: 'GET' }).then((r) => r.json());
}
`,
      'src/b.ts': `
export async function b(id: string): Promise<unknown> {
  return fetch(\`/api/users/\${id}\`, { method: 'GET' }).then((r) => r.json());
}
`,
    });
    try {
      const findings = detectApiRaces({
        workspaceRoot: root,
        files: ['src/a.ts', 'src/b.ts'],
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a path that only one file calls', async () => {
    const root = await setup({
      'src/a.ts': `
export async function a(id: string): Promise<void> {
  await fetch(\`/api/posts/\${id}\`, { method: 'PUT' });
}
`,
    });
    try {
      const findings = detectApiRaces({ workspaceRoot: root, files: ['src/a.ts'] });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
