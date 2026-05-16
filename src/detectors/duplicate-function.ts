import type { Detector, Finding, FunctionStructure, SymbolRecord } from '../types.js';
import { UnionFind, bucketBy, representativeHash } from '../utils/clustering.js';

type MatchedBy = 'strict' | 'structural' | 'normalized-names' | 'near-duplicate';

interface Cluster {
  hash: string;
  symbols: SymbolRecord[];
  matchedBy: MatchedBy;
  layer: 1 | 2;
  signals: ReadonlySet<MatchedBy>;
}

/** Functions shorter than this many body characters (after collapse) are too small to mean anything. */
const MIN_BODY_CHARS = 16;

// Below 0.65 Jaccard a 30%+ different body is a different function in practice.
const NEAR_DUP_THRESHOLD = 0.65;

/** Minimum shingle-set size on both sides for near-dup pairing (avoids 1-line bodies). */
const NEAR_DUP_MIN_SHINGLES = 6;

const LAYER_PRIORITY: MatchedBy[] = ['strict', 'normalized-names', 'structural', 'near-duplicate'];

export class DuplicateFunctionDetector implements Detector {
  id = 'duplicate-function';
  name = 'Duplicate function detector';

  async run(symbols: SymbolRecord[]): Promise<Finding[]> {
    const fnLike = symbols.filter(
      (s) => s.kind === 'function' && s.structure?.kind === 'function',
    );

    // Skip trivial bodies — a single `return x;` collides across unrelated helpers.
    const nonTrivial = fnLike.filter((s) => {
      const fn = s.structure as FunctionStructure;
      return fn.bodyNormalized.length >= MIN_BODY_CHARS;
    });

    const strictBuckets = bucketBy(nonTrivial, (s) => s.hashStrict);
    const normalizedBuckets = bucketBy(nonTrivial, (s) => s.hashNormalizedNames);
    const structuralBuckets = bucketBy(nonTrivial, (s) => s.hashStructural);

    const indexOf = new Map<string, number>(nonTrivial.map((s, i) => [s.id, i]));
    const uf = new UnionFind(nonTrivial.length);
    const edgeLayer = new Map<number, Set<MatchedBy>>();

    const unionBucket = (bucket: SymbolRecord[], matchedBy: MatchedBy): void => {
      if (bucket.length < 2) return;
      const firstIdx = indexOf.get(bucket[0]!.id);
      if (firstIdx == null) return;
      for (let i = 1; i < bucket.length; i++) {
        const nextIdx = indexOf.get(bucket[i]!.id);
        if (nextIdx == null) continue;
        uf.union(firstIdx, nextIdx);
      }
      for (const s of bucket) {
        const idx = indexOf.get(s.id);
        if (idx == null) continue;
        const root = uf.find(idx);
        const set = edgeLayer.get(root) ?? new Set<MatchedBy>();
        set.add(matchedBy);
        edgeLayer.set(root, set);
      }
    };

    for (const b of strictBuckets.values()) unionBucket(b, 'strict');
    for (const b of normalizedBuckets.values()) unionBucket(b, 'normalized-names');
    for (const b of structuralBuckets.values()) unionBucket(b, 'structural');

    // Layer 4 — pairwise Jaccard on body shingles, GATED on signature compatibility.
    // Picks up "this is almost the same function with one extra line + a few
    // renames" cases the exact-hash layers miss. Two functions with the same
    // body shape but different parameter or return types (e.g. `addNumbers` vs
    // `concatStrings`) must NOT cluster, hence the signature gate.
    // O(N²) but bounded by typeLike size, and the signature filter is cheap.
    const signatures = nonTrivial.map((s) => signatureKey(s.structure as FunctionStructure));
    for (let i = 0; i < nonTrivial.length; i++) {
      const a = nonTrivial[i]!.structure as FunctionStructure;
      const aIdx = indexOf.get(nonTrivial[i]!.id);
      if (aIdx == null) continue;
      if (a.bodyShingles.size < NEAR_DUP_MIN_SHINGLES) continue;
      for (let j = i + 1; j < nonTrivial.length; j++) {
        const b = nonTrivial[j]!.structure as FunctionStructure;
        const bIdx = indexOf.get(nonTrivial[j]!.id);
        if (bIdx == null) continue;
        if (b.bodyShingles.size < NEAR_DUP_MIN_SHINGLES) continue;
        if (signatures[i] !== signatures[j]) continue; // signature gate
        if (uf.find(aIdx) === uf.find(bIdx)) continue;
        const sim = jaccard(a.bodyShingles, b.bodyShingles);
        if (sim < NEAR_DUP_THRESHOLD) continue;
        uf.union(aIdx, bIdx);
        const root = uf.find(aIdx);
        const set = edgeLayer.get(root) ?? new Set<MatchedBy>();
        set.add('near-duplicate');
        edgeLayer.set(root, set);
      }
    }

    const finalSignals = new Map<number, Set<MatchedBy>>();
    for (let i = 0; i < nonTrivial.length; i++) {
      const root = uf.find(i);
      const merged = finalSignals.get(root) ?? new Set<MatchedBy>();
      for (const [k, v] of edgeLayer) {
        if (uf.find(k) === root) for (const s of v) merged.add(s);
      }
      finalSignals.set(root, merged);
    }

    const componentsByRoot = new Map<number, SymbolRecord[]>();
    for (let i = 0; i < nonTrivial.length; i++) {
      const root = uf.find(i);
      const group = componentsByRoot.get(root) ?? [];
      group.push(nonTrivial[i]!);
      componentsByRoot.set(root, group);
    }

    const clusters: Cluster[] = [];
    for (const [root, group] of componentsByRoot) {
      if (group.length < 2) continue;
      const files = new Set(group.map((g) => g.file));
      if (files.size === 1 && group.length === 2) continue;

      const signals = finalSignals.get(root) ?? new Set<MatchedBy>();
      if (signals.size === 0) continue;
      const primary = LAYER_PRIORITY.find((p) => signals.has(p)) ?? 'structural';

      clusters.push({
        hash: representativeHash(group, primary, {
          strict: (s) => s.hashStrict,
          'normalized-names': (s) => s.hashNormalizedNames,
          structural: (s) => s.hashStructural,
          'near-duplicate': (s) => s.hashStrict ?? s.hashStructural,
        }),
        symbols: group,
        matchedBy: primary,
        layer: primary === 'near-duplicate' ? 2 : primary === 'normalized-names' ? 2 : 1,
        signals,
      });
    }

    return clusters.map((c) => this.toFinding(c));
  }

  private toFinding(c: Cluster): Finding {
    const baseConfidence =
      c.matchedBy === 'strict'
        ? 0.97
        : c.matchedBy === 'structural'
          ? 0.82
          : c.matchedBy === 'normalized-names'
            ? 0.72
            : 0.68; // near-duplicate
    const distinctNames = new Set(c.symbols.map((s) => s.name)).size;
    const sameName = distinctNames === 1;
    const names = Array.from(new Set(c.symbols.map((s) => s.name))).join(', ');

    const title = sameName
      ? `'${c.symbols[0]?.name}' is defined ${c.symbols.length} times`
      : `${c.symbols.length} functions appear equivalent: ${names}`;

    return {
      detectorId: this.id,
      severity: c.symbols.length >= 3 ? 'high' : 'medium',
      confidence: baseConfidence,
      layer: c.layer,
      title,
      description: this.buildDescription(c),
      evidence: c.symbols.map((s) => ({
        file: s.file,
        range: s.range,
        snippet: s.source,
      })),
      suggestion:
        'Consolidate into a single shared definition (e.g., a shared utils module) and import from one place.',
      fingerprint: `dup-fn:${c.matchedBy}:${c.hash}`,
    };
  }

  private buildDescription(c: Cluster): string {
    const where = c.symbols
      .map((s) => `- ${s.file}:${s.range.startLine} (function ${s.name})`)
      .join('\n');
    const matchedByLabel: Record<MatchedBy, string> = {
      strict: 'Same signature + same body (verbatim after whitespace/comment collapse)',
      structural: 'Same skeleton — identifiers anonymised, signature shape and body shape match',
      'normalized-names': 'Same signature + body after parameter-name normalisation (snake/camel + synonyms)',
      'near-duplicate': `Near-duplicate body (Jaccard ≥ ${NEAR_DUP_THRESHOLD} on 4-token shingles)`,
    };
    const extra =
      c.signals.size > 1
        ? `\nAlso matches at: ${Array.from(c.signals).filter((s) => s !== c.matchedBy).join(', ')}.`
        : '';
    return `Match level: ${matchedByLabel[c.matchedBy]} (layer ${c.layer}).${extra}\nLocations:\n${where}`;
  }
}

/**
 * Stable signature string used as the Layer-4 compatibility gate. Two functions
 * cluster as near-duplicates only when their async/generator flags + parameter
 * types (in order) + return type all match — modulo whitespace normalisation.
 */
function signatureKey(fn: FunctionStructure): string {
  const flags = `${fn.async ? 'a' : ''}${fn.generator ? 'g' : ''}`;
  const params = fn.params.map((p) => p.type.replace(/\s+/g, '')).join(',');
  return `${flags}(${params})=>${fn.returnType.replace(/\s+/g, '')}`;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

