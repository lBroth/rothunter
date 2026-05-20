/**
 * In-source suppression pragma — operators (and agents under operator
 * supervision) can add a `// rothunter:ignore-<detectorId>` comment
 * above a flagged line to silence the detector for that specific
 * location. `// rothunter:ignore-all` silences every detector.
 *
 * Persistent + co-located with the code being suppressed — survives
 * re-scans automatically. The convention mirrors
 * `// eslint-disable-next-line <rule>`.
 *
 * Required shape (single line above target):
 *
 *   // rothunter:ignore-<detectorId>
 *   // reason: <one short sentence explaining why this is intentional>
 *
 * Detectors call `hasIgnoreAnnotation(rawSource, line, detectorId)`
 * BEFORE emitting a finding. The matcher walks the previous 5
 * non-blank lines looking for the pragma — captures both styles:
 *
 *   // rothunter:ignore-silent-catch        ← matches detectorId
 *   // rothunter:ignore-all                 ← global ignore
 *
 * Strict matching: only line-comment `//` syntax (not block comments).
 * Block comments confuse the regex on multi-line files; agents should
 * stick to single-line line comments.
 */

export function hasIgnoreAnnotation(
  rawSource: string,
  targetLine: number,
  detectorId: string,
): boolean {
  if (!rawSource || targetLine < 1) return false;
  const lines = rawSource.split(/\r?\n/);
  const start = Math.max(0, targetLine - 1 - 5);
  const end = Math.min(lines.length, targetLine - 1);
  const allTag = 'rothunter:ignore-all';
  const detTag = `rothunter:ignore-${detectorId}`;
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('rothunter:ignore')) continue;
    // Cheap substring matches — avoid false positives from
    // `rothunter:ignore-races-something` matching `ignore-race`.
    if (line.includes(allTag) || line.includes(detTag)) return true;
  }
  return false;
}
