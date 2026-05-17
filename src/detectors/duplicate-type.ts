import type { Detector, FieldStructure, Finding, SymbolRecord } from '../types.js';
import { UnionFind, bucketBy, representativeHash } from '../utils/clustering.js';

type MatchedBy = 'strict' | 'structural' | 'normalized-names';

interface Cluster {
  hash: string;
  symbols: SymbolRecord[];
  /** Primary signal that bound this cluster (best layer that fired). */
  matchedBy: MatchedBy;
  /** Layer number to expose in the report. */
  layer: 1 | 2;
  /** Every layer that contributed at least one edge inside this cluster. */
  signals: ReadonlySet<MatchedBy>;
}

/** Minimum field count for a structural-only match to be considered non-trivial. */
const STRUCTURAL_MIN_FIELDS = 4;

/** Ranking: highest-precision layer wins when multiple fire on the same cluster. */
const LAYER_PRIORITY: MatchedBy[] = ['strict', 'normalized-names', 'structural'];

export class DuplicateTypeDetector implements Detector {
  id = 'duplicate-type';
  name = 'Duplicate type detector';

  async run(symbols: SymbolRecord[]): Promise<Finding[]> {
    const typeLike = symbols.filter(
      (s) =>
        (s.kind === 'interface' || s.kind === 'type-alias') &&
        s.structure?.kind === 'object' &&
        (s.structure.fields?.length ?? 0) > 0,
    );

    // Compute buckets per layer, sharing every typeLike symbol across all layers.
    // Old behavior excluded a symbol from later layers once its first layer fired
    // — that meant a 3-way cluster like Product/ProductDTO/Item lost Item, since
    // Product and ProductDTO bound at strict (layer 1a) and the structural layer
    // then ran on `remaining`, leaving Item alone.
    const strictBuckets = bucketBy(typeLike, (s) => s.hashStrict);
    const normalizedBuckets = bucketBy(typeLike, (s) => s.hashNormalizedNames);
    const structuralBuckets = bucketBy(
      typeLike.filter((s) => !isStructurallyTrivial(s)),
      (s) => s.hashStructural,
    );

    // Union-find — two symbols belong to the same cluster if they collide on
    // any of the three hashes.
    const indexOf = new Map<string, number>(typeLike.map((s, i) => [s.id, i]));
    const uf = new UnionFind(typeLike.length);
    const edgeLayer = new Map<number, Set<MatchedBy>>(); // root index → layers that touched

    const unionBucket = (bucket: SymbolRecord[], matchedBy: MatchedBy): void => {
      if (bucket.length < 2) return;
      const first = indexOf.get(bucket[0]!.id);
      if (first == null) return;
      for (let i = 1; i < bucket.length; i++) {
        const next = indexOf.get(bucket[i]!.id);
        if (next == null) continue;
        uf.union(first, next);
      }
      // Tag every member with the layer signal.
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

    // Re-aggregate edgeLayer keyed by the final canonical root after all unions.
    const finalSignals = new Map<number, Set<MatchedBy>>();
    for (let i = 0; i < typeLike.length; i++) {
      const root = uf.find(i);
      const merged = finalSignals.get(root) ?? new Set<MatchedBy>();
      const seenAtThis = edgeLayer.get(uf.find(i));
      if (seenAtThis) for (const s of seenAtThis) merged.add(s);
      // Also pick up signals tagged on intermediate roots that ended up under `root`.
      for (const [k, v] of edgeLayer) {
        if (uf.find(k) === root) for (const s of v) merged.add(s);
      }
      finalSignals.set(root, merged);
    }

    // Group symbols by root.
    const componentsByRoot = new Map<number, SymbolRecord[]>();
    for (let i = 0; i < typeLike.length; i++) {
      const root = uf.find(i);
      const group = componentsByRoot.get(root) ?? [];
      group.push(typeLike[i]!);
      componentsByRoot.set(root, group);
    }

    const clusters: Cluster[] = [];
    for (const [root, group] of componentsByRoot) {
      if (group.length < 2) continue;
      // Same-file size-2 skip — both members in the same file is almost always intentional.
      const files = new Set(group.map((g) => g.file));
      if (files.size === 1 && group.length === 2) continue;

      const signals = finalSignals.get(root) ?? new Set<MatchedBy>();
      if (signals.size === 0) continue; // shouldn't happen but be safe
      const primary = LAYER_PRIORITY.find((p) => signals.has(p)) ?? 'structural';

      clusters.push({
        hash: representativeHash(group, primary, {
          strict: (s) => s.hashStrict,
          'normalized-names': (s) => s.hashNormalizedNames,
          structural: (s) => s.hashStructural,
        }),
        symbols: group,
        matchedBy: primary,
        layer: primary === 'normalized-names' ? 2 : 1,
        signals,
      });
    }

    return clusters.map((c) => this.toFinding(c));
  }

  private toFinding(c: Cluster): Finding {
    const baseConfidence =
      c.matchedBy === 'strict' ? 1.0 : c.matchedBy === 'structural' ? 0.85 : 0.75;
    const distinctNames = new Set(c.symbols.map((s) => s.name)).size;
    const sameName = distinctNames === 1;
    const names = Array.from(new Set(c.symbols.map((s) => s.name))).join(', ');

    const title = sameName
      ? `'${c.symbols[0]?.name}' is defined ${c.symbols.length} times`
      : `${c.symbols.length} types appear equivalent: ${names}`;

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
        'Consolidate into a single shared definition (e.g., a shared types package) and import from one place.',
      fingerprint: `dup-type:${c.matchedBy}:${c.hash}`,
    };
  }

  private buildDescription(c: Cluster): string {
    const where = c.symbols
      .map((s) => `- ${s.file}:${s.range.startLine} (${s.kind} ${s.name})`)
      .join('\n');
    const matchedByLabel: Record<MatchedBy, string> = {
      strict: 'Same fields, same names, same types',
      structural: 'Same field types, different names (anonymous structural match)',
      'normalized-names': 'Same fields after normalizing naming convention (snake/camel + synonyms)',
    };
    const extra = c.signals.size > 1
      ? `\nAlso matches at: ${Array.from(c.signals).filter((s) => s !== c.matchedBy).join(', ')}.`
      : '';
    return `Match level: ${matchedByLabel[c.matchedBy]} (layer ${c.layer}).${extra}\nLocations:\n${where}`;
  }
}

function isStructurallyTrivial(s: SymbolRecord): boolean {
  const fields = s.structure?.fields ?? [];
  const kinds = new Set(fields.map(primitiveKindOf));
  // A complex field (method / object / array / union with non-primitive) is a
  // strong signal that the shape is meaningful. Allow it past the trivial gate
  // with ≥3 fields instead of the usual 4-field minimum.
  if (kinds.has('complex') && fields.length >= 3) return false;
  if (fields.length < STRUCTURAL_MIN_FIELDS) return true;
  return kinds.size < 2;
}

function primitiveKindOf(f: FieldStructure): string {
  const t = f.type.replace(/\s+/g, '').toLowerCase();
  if (/^(string|number|boolean|bigint|symbol|null|undefined|date)(\|.*)?$/.test(t)) {
    const head = t.split('|')[0]!;
    return head;
  }
  return 'complex';
}

