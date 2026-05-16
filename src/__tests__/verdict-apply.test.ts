import { describe, expect, it } from '@jest/globals';
import { applyClusterVerdict } from '../rothunter.js';
import type { Finding } from '../types.js';

/**
 * Regression suite for the shared `applyClusterVerdict` helper. Documents
 * the post-refactor semantics — in particular the mutation severity-bump
 * behavior, which subtly changed when the four near-identical verdict
 * branches were collapsed into one helper.
 *
 * Pre-refactor (rothunter.ts < server-split):
 *   mutation bug-shaped → severity 'medium' bumped to 'high' UNCONDITIONALLY.
 * Post-refactor (current):
 *   mutation bug-shaped → bumped to 'high' ONLY when verdict.confidence >= 0.85.
 *
 * In practice the mutation confirmer almost always emits >= 0.85 when it
 * sees a real bug, so the operator-visible diff is near-zero. The gate
 * matches the api-race / shared-db / race-condition branches and is
 * documented here so future refactors don't accidentally restore the
 * unconditional bump.
 */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    detectorId: 'mutation',
    severity: 'medium',
    confidence: 0.5,
    layer: 1,
    title: 'mutation',
    description: 'base',
    evidence: [],
    fingerprint: 'mutation:test',
    ...overrides,
  };
}

describe('applyClusterVerdict', () => {
  describe('positive verdict (race / bug-shaped)', () => {
    it('low confidence bug-shaped keeps severity medium (the documented gate)', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.4 });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 0.7, reason: 'looks like bug' },
        { threshold: 0.7, positiveLabel: 'potential bug', negativeLabel: 'intentional' },
      );
      expect(f.severity).toBe('medium');
      expect(f.layer).toBe(3);
      expect(f.confidence).toBeCloseTo(0.7, 3);
      expect(f.description).toContain('potential bug');
    });

    it('high confidence bug-shaped bumps medium → high', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.4 });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 0.9, reason: 'clear bug' },
        { threshold: 0.7, positiveLabel: 'potential bug', negativeLabel: 'intentional' },
      );
      expect(f.severity).toBe('high');
      expect(f.layer).toBe(3);
      expect(f.confidence).toBeCloseTo(0.9, 3);
    });

    it('confidence capped at 0.95 even when verdict says higher', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.4 });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 1.0, reason: 'certain' },
        { threshold: 0.7, positiveLabel: 'real race', negativeLabel: 'safe' },
      );
      expect(f.confidence).toBeLessThanOrEqual(0.95);
    });

    it('does not lower confidence below the deterministic floor', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.8 });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 0.5, reason: 'weak bug' },
        { threshold: 0.7, positiveLabel: 'real race', negativeLabel: 'safe' },
      );
      // max(0.8, 0.5) = 0.8, capped at 0.95
      expect(f.confidence).toBeCloseTo(0.8, 3);
    });

    it('high severity stays high (no downgrade on positive verdict)', () => {
      const f = makeFinding({ severity: 'high', confidence: 0.6 });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 0.7, reason: 'bug' },
        { threshold: 0.7, positiveLabel: 'bug', negativeLabel: 'safe' },
      );
      expect(f.severity).toBe('high');
    });
  });

  describe('negative verdict (safe / intentional)', () => {
    it('drops confidence by (1 - verdict.confidence)', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.8 });
      applyClusterVerdict(
        f,
        { positive: false, confidence: 0.9, reason: 'idempotent write' },
        { threshold: 0.7, positiveLabel: 'real race', negativeLabel: 'safe' },
      );
      // 0.8 * (1 - 0.9) = 0.08
      expect(f.confidence).toBeCloseTo(0.08, 3);
    });

    it('downgrades severity to low when post-verdict confidence < threshold', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.8 });
      applyClusterVerdict(
        f,
        { positive: false, confidence: 0.9, reason: 'safe' },
        { threshold: 0.7, positiveLabel: 'race', negativeLabel: 'safe' },
      );
      expect(f.severity).toBe('low');
    });

    it('keeps severity when post-verdict confidence still >= threshold', () => {
      const f = makeFinding({ severity: 'medium', confidence: 0.95 });
      applyClusterVerdict(
        f,
        { positive: false, confidence: 0.1, reason: 'weak rejection' },
        { threshold: 0.7, positiveLabel: 'race', negativeLabel: 'safe' },
      );
      // 0.95 * (1 - 0.1) = 0.855, above threshold
      expect(f.severity).toBe('medium');
    });

    it('always promotes finding to layer 3 regardless of direction', () => {
      const f = makeFinding({ layer: 1 });
      applyClusterVerdict(
        f,
        { positive: false, confidence: 0.9, reason: 'safe' },
        { threshold: 0.7, positiveLabel: 'race', negativeLabel: 'safe' },
      );
      expect(f.layer).toBe(3);
    });
  });

  describe('description appendage', () => {
    it('uses the positiveLabel on a positive verdict', () => {
      const f = makeFinding({ description: 'base' });
      applyClusterVerdict(
        f,
        { positive: true, confidence: 0.9, reason: 'r' },
        { threshold: 0.7, positiveLabel: 'real cross-flow race', negativeLabel: 'safe' },
      );
      expect(f.description).toContain('real cross-flow race');
      expect(f.description).toContain('0.90');
    });

    it('uses the negativeLabel on a negative verdict', () => {
      const f = makeFinding({ description: 'base' });
      applyClusterVerdict(
        f,
        { positive: false, confidence: 0.9, reason: 'r' },
        { threshold: 0.7, positiveLabel: 'race', negativeLabel: 'intentional mutation' },
      );
      expect(f.description).toContain('intentional mutation');
    });
  });
});
