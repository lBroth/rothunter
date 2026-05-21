import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DETECTOR_IDS } from '../detector-registry.js';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.rothunter');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const LINT_OVERLAP_EXPECTED_OFF = [
  'public-any',
  'long-function',
  'long-file',
  'deep-nesting',
  'magic-numbers',
  'console-log-prod',
  'skip-tests',
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

  it('disables the 7 lint-overlap detectors by default', async () => {
    const { readSettings } = await import('../server/settings-store.js');
    const s = readSettings();
    for (const id of LINT_OVERLAP_EXPECTED_OFF) {
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
