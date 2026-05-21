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

// Detectors fully covered by a standard ESLint rule (or tsconfig strict).
// Off by default — users opt in via Settings if their project doesn't
// enable the equivalent lint rule. silent-catch / todo-comments /
// mutable-globals stay ON because no ESLint rule covers them with the
// same scope (silent-catch flags console-only + bare-return catches that
// no-empty does not; todo-comments scans non-TS files; no ESLint rule
// flags top-level reassigned `let` — prefer-const flags the opposite case).
const LINT_OVERLAP_DEFAULT_OFF = new Set<string>([
  'public-any', // @typescript-eslint/no-explicit-any
  'long-function', // max-lines-per-function
  'long-file', // max-lines
  'deep-nesting', // max-depth / complexity
  'magic-numbers', // no-magic-numbers
  'console-log-prod', // no-console
  'skip-tests', // jest/no-disabled-tests + jest/no-focused-tests
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
