/**
 * Escape every regex metacharacter in `s` so it can be embedded as a
 * literal inside a new RegExp. Centralised because four detectors
 * shipped their own copy of the same one-liner — when a future bug
 * (e.g. forgetting to escape `-` inside character classes) needs a
 * fix, doing it here propagates everywhere.
 */
export function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
