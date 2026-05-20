import * as crypto from 'node:crypto';

/**
 * Stable, short SHA-256 prefix used as a fingerprint suffix across
 * every detector. Centralised here so the algorithm + truncation
 * length live in ONE place — bumping from 16 to 24 hex chars only
 * requires this file, not every detector.
 *
 * 16 hex chars = 64 bits of entropy → negligible collision risk for
 * scan-sized populations (thousands of findings per scan).
 */
export function stableHash(input: string, length = 16): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}
