/**
 * Integration test for the full RotHunter pipeline, end-to-end, against a real
 * local mlx_lm.server (Apple Silicon native). Skipped automatically when the
 * server is unreachable.
 *
 * Requires:
 *   - mlx_lm.server running at ROTHUNTER_LLM_BASE_URL (default http://127.0.0.1:8080/v1)
 *   - Model loaded — default mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit
 *
 * Start:
 *   pip install mlx-lm
 *   mlx_lm.server --model mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit --port 8080
 *
 * The test plants three minimal scenarios in a temp workspace:
 *   1. A clear duplicate (must be reported, LLM should confirm)
 *   2. A borderline {id, name} pair across two unrelated domains
 *      (must reach LLM; LLM should reject cross-domain match → severity 'low')
 *   3. A regression guard (must NOT be reported by the deterministic layers)
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';
import { createDefaultLlmClient } from '../adapters/mlx-llm.js';

const LLM_BASE_URL = process.env.ROTHUNTER_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1';

async function isLlmReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const describeIfLlm = (await isLlmReachable()) ? describe : describe.skip;

describeIfLlm('RotHunter — full pipeline with real MLX-LM (integration)', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-integration-'));

    // File 1 — declares a clear duplicate (with a regression guard alongside).
    fs.writeFileSync(
      path.join(workspace, 'a.ts'),
      `
export interface UserA {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface BillingAccount {
  id: string;
  name: string;
}

// Regression guard — different parameter types should NOT collide.
export interface HandlerA {
  id: string;
  handle(input: string): Promise<void>;
}
`,
      'utf-8',
    );

    // File 2 — partner duplicate + the borderline cross-domain {id, name}.
    fs.writeFileSync(
      path.join(workspace, 'b.ts'),
      `
export interface UserB {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

// Cross-domain {id, name} — strict-equivalent to BillingAccount but represents
// a configuration template, not a billing record. LLM should reject this as a
// domain duplicate.
export interface NotificationTemplate {
  id: string;
  name: string;
}

// Regression guard partner — same method name, different param type.
export interface HandlerB {
  id: string;
  handle(input: number): Promise<void>;
}
`,
      'utf-8',
    );
  }, 30_000);

  afterAll(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it(
    'reports the clear duplicate, runs LLM on the borderline cluster, and leaves the regression guard alone',
    async () => {
      const rothunter = new RotHunter();
      const llm = createDefaultLlmClient();
      const result = await rothunter.run({
        workspaceRoot: workspace,
        llm,
        llmRejectionThreshold: 0.7,
      });

      const dupTypeFindings = result.findings.filter((f) => f.detectorId === 'duplicate-type');

      // 1. Clear duplicate present
      const userDup = dupTypeFindings.find((f) =>
        f.evidence.some((e) => e.snippet.includes('interface UserA')) &&
        f.evidence.some((e) => e.snippet.includes('interface UserB')),
      );
      expect(userDup).toBeDefined();
      expect(userDup?.fingerprint).toMatch(/^dup-type:strict:/);
      expect(userDup?.confidence).toBeGreaterThanOrEqual(0.95);

      // 2. Borderline cluster reached the LLM (description appended with rejection or confirmation note).
      const borderline = dupTypeFindings.find((f) =>
        f.evidence.some((e) => e.snippet.includes('interface BillingAccount')) &&
        f.evidence.some((e) => e.snippet.includes('interface NotificationTemplate')),
      );
      expect(borderline).toBeDefined();
      expect(borderline?.description).toMatch(/LLM (confirmation|rejection)/);

      // 3. Handler regression guard must NOT cluster
      const handlerCluster = dupTypeFindings.find((f) =>
        f.evidence.some((e) => e.snippet.includes('interface HandlerA')) ||
        f.evidence.some((e) => e.snippet.includes('interface HandlerB')),
      );
      expect(handlerCluster).toBeUndefined();
    },
    600_000, // up to 10 min — single LLM call on local CPU can be slow on cold start
  );
});
