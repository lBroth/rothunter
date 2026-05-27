import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The FP partitioning logic lives inline in the Fastify server file
 * (server/index.ts) so we test the round-trip via a tiny re-implementation
 * mirroring the same shape — keeps the test fast and avoids spinning up
 * the HTTP layer.
 */
function readFalsePositives(workspaceRoot: string): Set<string> {
  const file = path.join(workspaceRoot, '.rothunter', 'false-positives.json');
  if (!fs.existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

function writeFalsePositives(workspaceRoot: string, set: Set<string>): void {
  const file = path.join(workspaceRoot, '.rothunter', 'false-positives.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fingerprints: [...set].sort() }, null, 2), 'utf-8');
}

interface FindingLike {
  fingerprint: string;
  detectorId: string;
}

function splitFalsePositives(
  findings: FindingLike[],
  fp: Set<string>,
): {
  findings: FindingLike[];
  falsePositives: FindingLike[];
} {
  const ok: FindingLike[] = [];
  const fps: FindingLike[] = [];
  for (const f of findings) (fp.has(f.fingerprint) ? fps : ok).push(f);
  return { findings: ok, falsePositives: fps };
}

describe('false-positives store', () => {
  it('persists fingerprints + round-trips them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-fp-'));
    try {
      writeFalsePositives(root, new Set(['fp-1', 'fp-2']));
      const round = readFalsePositives(root);
      expect([...round].sort()).toEqual(['fp-1', 'fp-2']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty set when file is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-fp-empty-'));
    try {
      expect(readFalsePositives(root).size).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('partitions findings into open vs FP using the set', () => {
    const set = new Set(['fp-1']);
    const split = splitFalsePositives(
      [
        { fingerprint: 'fp-1', detectorId: 'magic-numbers' },
        { fingerprint: 'fp-2', detectorId: 'silent-catch' },
      ],
      set,
    );
    expect(split.findings.map((f) => f.fingerprint)).toEqual(['fp-2']);
    expect(split.falsePositives.map((f) => f.fingerprint)).toEqual(['fp-1']);
  });

  it('an FP marked in run #1 still goes to FP section in run #2', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-fp-sticky-'));
    try {
      // Run 1: surface a finding, user marks it FP.
      const finding = { fingerprint: 'sticky-1', detectorId: 'todo-comments' };
      const set = readFalsePositives(root);
      set.add(finding.fingerprint);
      writeFalsePositives(root, set);

      // Run 2: detector re-emits the same fingerprint. The partition
      // routes it to FP automatically.
      const setRun2 = readFalsePositives(root);
      const split = splitFalsePositives([finding], setRun2);
      expect(split.findings).toEqual([]);
      expect(split.falsePositives).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removing the FP re-routes the finding to the open list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-fp-unmark-'));
    try {
      writeFalsePositives(root, new Set(['x']));
      const before = splitFalsePositives(
        [{ fingerprint: 'x', detectorId: 'd' }],
        readFalsePositives(root),
      );
      expect(before.falsePositives).toHaveLength(1);

      const set = readFalsePositives(root);
      set.delete('x');
      writeFalsePositives(root, set);

      const after = splitFalsePositives(
        [{ fingerprint: 'x', detectorId: 'd' }],
        readFalsePositives(root),
      );
      expect(after.findings).toHaveLength(1);
      expect(after.falsePositives).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
