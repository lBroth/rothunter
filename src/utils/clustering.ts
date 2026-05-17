import type { SymbolRecord } from '../types.js';

/** Bucket a list of symbols by a hash extractor (skipping symbols whose hash is empty). */
export function bucketBy(
  symbols: SymbolRecord[],
  hashFn: (s: SymbolRecord) => string | undefined,
): Map<string, SymbolRecord[]> {
  const out = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const h = hashFn(s);
    if (!h) continue;
    const list = out.get(h) ?? [];
    list.push(s);
    out.set(h, list);
  }
  return out;
}

/** First non-empty hash from a cluster, picked by the layer that matched. */
export function representativeHash<MatchedBy extends string>(
  group: SymbolRecord[],
  matchedBy: MatchedBy,
  pickers: Record<MatchedBy, (s: SymbolRecord) => string | undefined>,
): string {
  const pick = pickers[matchedBy];
  for (const s of group) {
    const h = pick(s);
    if (h) return h;
  }
  return 'unknown';
}

/** Flat-array union-find with path compression + rank balancing. */
export class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb;
    } else if (this.rank[ra]! > this.rank[rb]!) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
  }
}
