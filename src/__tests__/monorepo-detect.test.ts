import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverMonorepoWorkspaces } from '../graph/monorepo-detect.js';
import { loadRotHunterConfig } from '../config.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-monorepo-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('monorepo auto-detect', () => {
  it('picks up an npm-style `package.json#workspaces` array', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/api/package.json': JSON.stringify({ name: '@x/api' }),
      'packages/web/package.json': JSON.stringify({ name: '@x/web' }),
    });
    try {
      const ws = discoverMonorepoWorkspaces(root);
      expect(ws).not.toBeNull();
      expect(ws!.map((w) => w.name).sort()).toEqual(['api', 'web']);
      expect(ws!.find((w) => w.name === 'api')!.packageName).toBe('@x/api');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('picks up an npm `workspaces: { packages: [...] }` object form', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'root',
        private: true,
        workspaces: { packages: ['apps/*'] },
      }),
      'apps/server/package.json': JSON.stringify({ name: '@x/server' }),
    });
    try {
      const ws = discoverMonorepoWorkspaces(root);
      expect(ws).not.toBeNull();
      expect(ws!.map((w) => w.name)).toEqual(['server']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('picks up pnpm-workspace.yaml entries', async () => {
    const root = await setup({
      'pnpm-workspace.yaml':
        'packages:\n' +
        '  - "packages/*"\n' +
        '  - "!packages/legacy"\n',
      'packages/lib/package.json': JSON.stringify({ name: '@x/lib' }),
      'packages/legacy/package.json': JSON.stringify({ name: '@x/legacy' }),
    });
    try {
      const ws = discoverMonorepoWorkspaces(root);
      expect(ws).not.toBeNull();
      const names = ws!.map((w) => w.name);
      expect(names).toContain('lib');
      // Exclusion patterns currently kept (we ignore the `!`), but `legacy`
      // also exists on disk, so it shows up. Document the limitation:
      // user can write an explicit config to exclude.
      expect(names).toContain('legacy');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls through to nx.json `workspaceLayout`', async () => {
    const root = await setup({
      'nx.json': JSON.stringify({
        workspaceLayout: { libsDir: 'libs', appsDir: 'apps' },
      }),
      'libs/util/package.json': JSON.stringify({ name: '@x/util' }),
      'apps/admin/package.json': JSON.stringify({ name: '@x/admin' }),
    });
    try {
      const ws = discoverMonorepoWorkspaces(root);
      expect(ws).not.toBeNull();
      expect(ws!.map((w) => w.name).sort()).toEqual(['admin', 'util']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no workspace markers are present', async () => {
    const root = await setup({
      'package.json': JSON.stringify({ name: 'standalone' }),
    });
    try {
      expect(discoverMonorepoWorkspaces(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loadRotHunterConfig auto-uses monorepo detection when no rothunter.config.json exists', async () => {
    const root = await setup({
      'package.json': JSON.stringify({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/lib/package.json': JSON.stringify({ name: '@x/lib' }),
      'packages/lib/src/index.ts': 'export const x = 1;\n',
    });
    try {
      const cfg = loadRotHunterConfig(root);
      expect(cfg).not.toBeNull();
      expect(cfg!.workspaces.map((w) => w.name)).toEqual(['lib']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
