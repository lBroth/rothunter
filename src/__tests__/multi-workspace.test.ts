import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

/**
 * Integration coverage for the multi-workspace per-ws runner.
 *
 * Plants a parent directory with `rothunter.config.json` pointing at two
 * sibling workspaces, runs the full pipeline (LLM disabled — only
 * deterministic detectors), and verifies the orchestrator's contract:
 *
 *   1. file-walking detectors run per workspace (not silently skipped
 *      like they were pre-fix);
 *   2. evidence paths are prefixed with the workspace name so the
 *      dashboard renders globally-unique locations;
 *   3. fingerprints are namespaced with the workspace name so identically-
 *      named files across workspaces never collide in the FP store;
 *   4. always-on cross-repo detectors (duplicate-type, dead-export, …)
 *      still see the merged symbol set, so a duplicate type living in
 *      two workspaces is still flagged once.
 *
 * Uses `console-log-prod` as the per-workspace file-walking probe — it
 * emits LOW severity findings (so the LLM triage path doesn't engage)
 * and triggers on a single regex match, keeping the fixture minimal.
 */
describe('multi-workspace runner', () => {
  let parent: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-multi-'));

    // Workspace A — contains a `console.log` for the file-walking
    // probe + a SharedDto interface for the cross-workspace cluster.
    const wsA = path.join(parent, 'service-a');
    fs.mkdirSync(path.join(wsA, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsA, 'package.json'),
      JSON.stringify({ name: '@org/service-a', version: '0.0.0' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(wsA, 'src', 'config.ts'),
      [
        '// service-a config',
        "export function bootA(): void { console.log('booting service-a'); }",
        'export interface SharedDto {',
        '  id: string;',
        '  age: number;',
        '  active: boolean;',
        '  displayName: string;',
        '  createdAt: string;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Workspace B — same SharedDto + its own console.log.
    const wsB = path.join(parent, 'service-b');
    fs.mkdirSync(path.join(wsB, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsB, 'package.json'),
      JSON.stringify({ name: '@org/service-b', version: '0.0.0' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(wsB, 'src', 'config.ts'),
      [
        '// service-b config',
        "export function bootB(): void { console.log('booting service-b'); }",
        'export interface SharedDto {',
        '  id: string;',
        '  age: number;',
        '  active: boolean;',
        '  displayName: string;',
        '  createdAt: string;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    fs.writeFileSync(
      path.join(parent, 'rothunter.config.json'),
      JSON.stringify({
        workspaces: [
          { path: 'service-a', name: 'service-a', package: '@org/service-a' },
          { path: 'service-b', name: 'service-b', package: '@org/service-b' },
        ],
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('runs file-walking detectors per workspace with prefixed paths + namespaced fingerprints', async () => {
    const rothunter = new RotHunter();
    const result = await rothunter.run({
      workspaceRoot: parent,
      detectorsAllow: new Set(['console-log-prod', 'duplicate-type']),
    });

    const probeFindings = result.findings.filter((f) => f.detectorId === 'console-log-prod');
    expect(probeFindings.length).toBeGreaterThanOrEqual(2);

    const allEvidenceFiles = probeFindings.flatMap((f) => f.evidence.map((e) => e.file));
    expect(allEvidenceFiles.some((p) => p.startsWith('service-a/'))).toBe(true);
    expect(allEvidenceFiles.some((p) => p.startsWith('service-b/'))).toBe(true);
    expect(allEvidenceFiles.every((p) => /^service-[ab]\//.test(p))).toBe(true);

    const fps = probeFindings.map((f) => f.fingerprint);
    expect(fps.some((fp) => fp.startsWith('service-a:'))).toBe(true);
    expect(fps.some((fp) => fp.startsWith('service-b:'))).toBe(true);
    expect(new Set(fps).size).toBe(fps.length);
  }, 30_000);

  it('cross-repo always-on detectors still see the merged symbol set', async () => {
    const rothunter = new RotHunter();
    const result = await rothunter.run({
      workspaceRoot: parent,
      detectorsAllow: new Set(['duplicate-type']),

      llmRejectionThreshold: 0,
    });

    const dupTypes = result.findings.filter((f) => f.detectorId === 'duplicate-type');
    expect(dupTypes.length).toBeGreaterThanOrEqual(1);
    const sharedDtoCluster = dupTypes.find(
      (f) =>
        f.evidence.some((e) => e.file.startsWith('service-a/')) &&
        f.evidence.some((e) => e.file.startsWith('service-b/')),
    );
    expect(sharedDtoCluster).toBeDefined();
  }, 30_000);

  it('emits at least one finding per workspace under the disabled-LLM detector set', async () => {
    const rothunter = new RotHunter();
    const result = await rothunter.run({
      workspaceRoot: parent,
      detectorsAllow: new Set(['console-log-prod']),
    });

    const perWs = new Map<string, number>();
    for (const f of result.findings) {
      const wsName = f.fingerprint.split(':', 1)[0]!;
      perWs.set(wsName, (perWs.get(wsName) ?? 0) + 1);
    }
    expect(perWs.get('service-a')).toBeGreaterThanOrEqual(1);
    expect(perWs.get('service-b')).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
