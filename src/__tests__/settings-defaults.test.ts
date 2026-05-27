import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DETECTOR_IDS } from '../detector-registry.js';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.rothunter');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// IDs the store ships OFF by default. Includes the 8 new cross-file /
// heuristic detectors so they land OFF the moment their PRs rebase on
// this commit and add their id to DETECTOR_IDS. While those PRs are
// still in flight the entries here are no-ops — the assertions below
// skip any id that isn't yet present in DETECTOR_IDS.
const LINT_OVERLAP_EXPECTED_OFF = [
  // ESLint / tsc overlap
  'public-any',
  'long-function',
  'long-file',
  'deep-nesting',
  'magic-numbers',
  'console-log-prod',
  'skip-tests',
  // New cross-file / heuristic detectors — conservative ship
  're-export-shadow',
  'default-export-name-drift',
  'test-without-assertion',
  'env-var-undeclared',
  'package-export-mismatch',
  'schema-shape-divergence',
  'producer-consumer-field-drift',
  'unsanitized-input-to-sink',
] as const;

const LINT_OVERLAP_EXPECTED_ON = [
  // Stay ON because no ESLint rule covers them with the same scope.
  'silent-catch',
  'todo-comments',
  'mutable-globals',
] as const;

describe('settings defaults — lint-overlap detectors', () => {
  // The store reads from `~/.rothunter/settings.json` on first call. Move
  // any real user file aside for the duration of the test so we always
  // observe the fresh defaults.
  let backup: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(SETTINGS_FILE)) {
      backup = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      fs.unlinkSync(SETTINGS_FILE);
    } else {
      backup = null;
    }
  });

  afterEach(() => {
    if (backup != null) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, backup, 'utf-8');
    } else if (fs.existsSync(SETTINGS_FILE)) {
      fs.unlinkSync(SETTINGS_FILE);
    }
  });

  it('disables every default-OFF detector that is currently registered', async () => {
    const { readSettings } = await import('../server/settings-store.js');
    const s = readSettings();
    const registered = new Set<string>(DETECTOR_IDS as readonly string[]);
    for (const id of LINT_OVERLAP_EXPECTED_OFF) {
      if (!registered.has(id)) continue; // detector PR hasn't merged yet
      expect(s.detectors[id]).toBe(false);
    }
  });

  it('keeps detectors with eslint coverage gaps ON by default', async () => {
    const { readSettings } = await import('../server/settings-store.js');
    const s = readSettings();
    for (const id of LINT_OVERLAP_EXPECTED_ON) {
      expect(s.detectors[id]).toBe(true);
    }
  });

  it('keeps every unique-value detector ON by default', async () => {
    const { readSettings } = await import('../server/settings-store.js');
    const s = readSettings();
    const offSet = new Set(LINT_OVERLAP_EXPECTED_OFF);
    for (const id of DETECTOR_IDS) {
      if (offSet.has(id as (typeof LINT_OVERLAP_EXPECTED_OFF)[number])) continue;
      expect(s.detectors[id]).toBe(true);
    }
  });

  it('returns an entry for every registered detector', async () => {
    const { readSettings } = await import('../server/settings-store.js');
    const s = readSettings();
    for (const id of DETECTOR_IDS) {
      expect(s.detectors).toHaveProperty(id);
    }
  });

  it('honours user overrides — saved `true` survives over default `false`', async () => {
    const { readSettings, writeSettings } = await import('../server/settings-store.js');
    const base = readSettings();
    // Flip a default-off detector to true; round-trip and confirm it stuck.
    await writeSettings({ ...base, detectors: { ...base.detectors, 'public-any': true } });
    const reloaded = readSettings();
    expect(reloaded.detectors['public-any']).toBe(true);
    // Other off detectors should remain off — overrides shouldn't bleed.
    expect(reloaded.detectors['long-function']).toBe(false);
  });
});
