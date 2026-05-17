import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRotHunterConfig } from '../config.js';
import { scanWorkspaces } from '../multi-workspace-scanner.js';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import { detectDeadApis } from '../detectors/dead-api.js';

async function setupMulti(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadapi-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('dead-api detector + multi-workspace scanner', () => {
  it('flags symbols exported by workspace A that no sibling workspace imports', async () => {
    const root = await setupMulti({
      'rothunter.config.json': JSON.stringify({
        workspaces: [
          { path: './backend', name: 'backend', package: '@x/backend' },
          { path: './frontend', name: 'frontend', package: '@x/frontend' },
        ],
      }),
      'backend/package.json': '{"name":"@x/backend","version":"0.1.0"}',
      'backend/src/index.ts': "export { used, unused } from './api';\n",
      'backend/src/api.ts': 'export function used(): void {}\nexport function unused(): void {}\n',
      'frontend/package.json': '{"name":"@x/frontend","version":"0.1.0"}',
      'frontend/src/index.ts': "import { used } from '@x/backend';\nexport function main(): void { used(); }\n",
    });
    try {
      const config = loadRotHunterConfig(root);
      expect(config).not.toBeNull();
      const multi = await scanWorkspaces(config!);
      const symbols = new TypeNormalizer().normalizeAll(multi.symbols);
      const findings = detectDeadApis({ symbols, imports: multi.imports });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Unused public API: unused'),
        ]),
      );
      expect(titles).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining('Unused public API: used'),
        ]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows re-export chains so symbols re-exported via a barrel are not flagged', async () => {
    const root = await setupMulti({
      'rothunter.config.json': JSON.stringify({
        workspaces: [
          { path: './backend', name: 'backend', package: '@x/backend' },
          { path: './frontend', name: 'frontend', package: '@x/frontend' },
        ],
      }),
      'backend/package.json': '{"name":"@x/backend","version":"0.1.0"}',
      'backend/src/index.ts': "export { User, getUser } from './api/users';\n",
      'backend/src/api/users.ts':
        'export interface User { id: string; }\nexport function getUser(id: string): User { return { id }; }\nexport function unused(): void {}\n',
      'frontend/package.json': '{"name":"@x/frontend","version":"0.1.0"}',
      'frontend/src/index.ts':
        "import { getUser } from '@x/backend';\nimport type { User } from '@x/backend';\nexport function show(id: string): User { return getUser(id); }\n",
    });
    try {
      const config = loadRotHunterConfig(root);
      const multi = await scanWorkspaces(config!);
      const symbols = new TypeNormalizer().normalizeAll(multi.symbols);
      const findings = detectDeadApis({ symbols, imports: multi.imports });
      const titles = findings.map((f) => f.title);
      // `unused` is genuinely unused — flagged.
      expect(titles).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Unused public API: unused'),
        ]),
      );
      // `User` and `getUser` reach a frontend consumer via the barrel — NOT flagged.
      for (const reached of ['User', 'getUser']) {
        expect(titles).not.toEqual(
          expect.arrayContaining([
            expect.stringContaining(`Unused public API: ${reached}`),
          ]),
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats `import * as ns` from another workspace as consuming every public export', async () => {
    const root = await setupMulti({
      'rothunter.config.json': JSON.stringify({
        workspaces: [
          { path: './lib', name: 'lib', package: '@x/lib' },
          { path: './consumer', name: 'consumer', package: '@x/consumer' },
        ],
      }),
      'lib/package.json': '{"name":"@x/lib","version":"0.1.0"}',
      'lib/src/index.ts': 'export function a(): void {}\nexport function b(): void {}\nexport function c(): void {}\n',
      'consumer/package.json': '{"name":"@x/consumer","version":"0.1.0"}',
      'consumer/src/index.ts': "import * as L from '@x/lib';\nexport function pick(): void { L.a(); }\n",
    });
    try {
      const config = loadRotHunterConfig(root);
      const multi = await scanWorkspaces(config!);
      const symbols = new TypeNormalizer().normalizeAll(multi.symbols);
      const findings = detectDeadApis({ symbols, imports: multi.imports });
      const titles = findings.map((f) => f.title);
      // Even though only `L.a()` is actually called, namespace consumption is
      // conservative — every export of lib is considered consumed by consumer.
      for (const name of ['a', 'b', 'c']) {
        expect(titles).not.toEqual(
          expect.arrayContaining([
            expect.stringContaining(`Unused public API: ${name} `),
          ]),
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
