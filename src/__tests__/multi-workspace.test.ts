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
 *      named files across workspaces never collide in the snooze + FP
 *      store;
 *   4. always-on cross-repo detectors (duplicate-type, dead-export, …)
 *      still see the merged symbol set, so a duplicate type living in
 *      two workspaces is still flagged once.
 */
describe('multi-workspace runner', () => {
  let parent: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-multi-'));

    // Workspace A — contains a real secret leak (AWS access key) the
    // per-ws file-walking detector should catch.
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
        '// service-a config — intentionally leaks a secret to exercise the detector.',
        "export const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';",
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

    // Workspace B — different name, same DTO structure → duplicate-type
    // should cluster across workspaces. Also contains a localhost-URL
    // secret-leak finding so the per-ws path produces findings here too.
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
        '// service-b config — distinct from service-a but same DTO shape.',
        "export const API_BASE = 'http://localhost:4000/api';",
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
      // Limit to non-LLM detectors so the test runs without a live LLM
      // backend. The per-ws runner code path is identical for the others.
      detectorsAllow: new Set(['secret-leak', 'duplicate-type']),
      ignoreSnoozeFile: true,
    });

    // 1. Per-workspace file-walking ran — both workspaces produced
    //    secret-leak findings (AWS key in A, localhost URL in B).
    const secretFindings = result.findings.filter((f) => f.detectorId === 'secret-leak');
    expect(secretFindings.length).toBeGreaterThanOrEqual(2);

    // 2. Evidence paths are prefixed with the workspace name.
    const allEvidenceFiles = secretFindings.flatMap((f) => f.evidence.map((e) => e.file));
    expect(allEvidenceFiles.some((p) => p.startsWith('service-a/'))).toBe(true);
    expect(allEvidenceFiles.some((p) => p.startsWith('service-b/'))).toBe(true);
    // Nothing should leak as a bare workspace-relative path.
    expect(allEvidenceFiles.every((p) => /^service-[ab]\//.test(p))).toBe(true);

    // 3. Fingerprints are namespaced with the workspace name. Pre-fix
    //    both workspaces would have produced `secret-leak:<hash>` keys
    //    that collide whenever the relative path inside each workspace
    //    matched; post-fix they're `service-a:secret-leak:<hash>` /
    //    `service-b:secret-leak:<hash>`.
    const fps = secretFindings.map((f) => f.fingerprint);
    expect(fps.some((fp) => fp.startsWith('service-a:'))).toBe(true);
    expect(fps.some((fp) => fp.startsWith('service-b:'))).toBe(true);
    expect(new Set(fps).size).toBe(fps.length); // no collisions
  }, 30_000);

  it('cross-repo always-on detectors still see the merged symbol set', async () => {
    const rothunter = new RotHunter();
    const result = await rothunter.run({
      workspaceRoot: parent,
      detectorsAllow: new Set(['duplicate-type']),
      ignoreSnoozeFile: true,
      // Reject the duplicate-type LLM verdict outright by setting a
      // threshold so the deterministic finding survives even when the
      // LLM step is skipped — we don't have an LLM in this test env.
      llmRejectionThreshold: 0,
    });

    const dupTypes = result.findings.filter((f) => f.detectorId === 'duplicate-type');
    // The two SharedDto declarations should cluster — one finding with
    // both workspaces represented in evidence (prefixed paths).
    expect(dupTypes.length).toBeGreaterThanOrEqual(1);
    const sharedDtoCluster = dupTypes.find((f) =>
      f.evidence.some((e) => e.file.startsWith('service-a/')) &&
      f.evidence.some((e) => e.file.startsWith('service-b/')),
    );
    expect(sharedDtoCluster).toBeDefined();
  }, 30_000);

  it('emits at least one finding per workspace under the disabled-LLM detector set', async () => {
    const rothunter = new RotHunter();
    const result = await rothunter.run({
      workspaceRoot: parent,
      detectorsAllow: new Set(['secret-leak']),
      ignoreSnoozeFile: true,
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
