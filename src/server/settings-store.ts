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
   * batching is on by default. Mlx_lm.server serialises internally so
   * setting >1 there gives little gain and may wedge the server.
   */
  llmConcurrency: number;
}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

function defaultSettings(): AppSettings {
  const detectors: Record<string, boolean> = {};
  for (const id of DETECTOR_IDS) detectors[id] = true;
  // Auto-tune LLM concurrency: default to half the CPU cores, clamped
  // to [1, 8]. Most laptops land at 4 — a sane balance between local
  // llama.cpp throughput and OS responsiveness during a scan.
  const cores = Math.max(1, os.cpus().length);
  const auto = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  return { detectors, minConfidence: 0.6, llmConcurrency: auto };
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
    };
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(s: AppSettings): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}
