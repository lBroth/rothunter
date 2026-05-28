import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_DIR } from './workspace-store.js';
import { DETECTOR_IDS } from '../detector-registry.js';

/**
 * Per-server app settings — survive restarts via ~/.rothunter/settings.json.
 * The Settings page in the dashboard edits this; scan start picks defaults
 * from here when the request body omits them.
 */
export interface AppSettings {
  detectors: Record<string, boolean>;
  minConfidence: number;
  /**
   * Number of LLM verdict requests in flight at once. 1 = sequential
   * (original behaviour). 4-8 is a good default on llama.cpp run with
   * `--parallel N -cb` (continuous batching), or on vLLM where dynamic
   * batching is on by default.
   */
  llmConcurrency: number;
  /**
   * Confidence floor at which a negative LLM verdict routes a finding
   * to the auto-FP bucket. `0.6` keeps almost every LLM "intentional"
   * call out of the open list; `0.85` is strict (only very-confident
   * verdicts auto-FP); `1` effectively disables auto-FP routing. The
   * Findings UI shows the LLM reason on every routed entry so the
   * operator can un-mark with one click if a verdict was wrong.
   */
  llmAutoFpThreshold: number;
}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// Detectors that ship OFF by default. Single principle: an id lands
// here iff a standard ESLint rule (or ESLint plugin) covers the same
// surface, in which case rothunter's signal duplicates what the
// project's own lint already produces.
//
// Every detector NOT in this set targets a hard-spot that single-file
// linters can't reach — cross-file reachability (dead-* / hot-hub),
// concurrency / data-flow (race-* / mutation), AST clustering
// (duplicate-* / similar-functions), package / config contract
// (bad-config / unused-deps / package-export-mismatch / env-var-
// undeclared), or the new cross-file heuristics in the 1.1.0 series
// (re-export-shadow, default-export-name-drift, schema-shape-
// divergence, producer-consumer-field-drift, unsanitized-input-to-
// sink). Those stay ON because that's where rothunter is uniquely
// useful.
//
// Adding an id here that doesn't yet exist in DETECTOR_IDS is a no-op
// — the merge in `readSettings()` falls back to the present-id list.
const LINT_OVERLAP_DEFAULT_OFF = new Set<string>([
  // Full overlap — standard recommended-set rules.
  'public-any', // @typescript-eslint/no-explicit-any
  'long-function', // max-lines-per-function
  'long-file', // max-lines
  'deep-nesting', // max-depth / complexity
  'magic-numbers', // no-magic-numbers
  'console-log-prod', // no-console
  'skip-tests', // jest/no-disabled-tests + jest/no-focused-tests

  // Partial overlap — a plugin or stricter config catches the same
  // surface even if the default recommended set doesn't. Off by
  // default because once a project enables the plugin / tightens the
  // rule, the rothunter finding becomes pure duplicate noise.
  'silent-catch', // no-empty with `allowEmptyCatch: false`
  'todo-comments', // no-warning-comments (JS/TS files)
  'test-without-assertion', // jest/expect-expect (jest-plugin)
]);

function defaultSettings(): AppSettings {
  const detectors: Record<string, boolean> = {};
  for (const id of DETECTOR_IDS) detectors[id] = !LINT_OVERLAP_DEFAULT_OFF.has(id);
  // Auto-tune LLM concurrency: default to half the CPU cores, clamped
  // to [1, 8]. Most laptops land at 4 — a sane balance between local
  // llama.cpp throughput and OS responsiveness during a scan.
  const cores = Math.max(1, os.cpus().length);
  const auto = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  return { detectors, minConfidence: 0.6, llmConcurrency: auto, llmAutoFpThreshold: 0.6 };
}

export function readSettings(): AppSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return defaultSettings();
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<AppSettings>;
    const base = defaultSettings();
    return {
      detectors: { ...base.detectors, ...(raw.detectors ?? {}) },
      minConfidence: typeof raw.minConfidence === 'number' ? raw.minConfidence : base.minConfidence,
      llmConcurrency:
        typeof raw.llmConcurrency === 'number' && raw.llmConcurrency >= 1
          ? Math.min(16, Math.floor(raw.llmConcurrency))
          : base.llmConcurrency,
      llmAutoFpThreshold:
        typeof raw.llmAutoFpThreshold === 'number' &&
        raw.llmAutoFpThreshold >= 0 &&
        raw.llmAutoFpThreshold <= 1
          ? raw.llmAutoFpThreshold
          : base.llmAutoFpThreshold,
    };
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(s: AppSettings): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}
