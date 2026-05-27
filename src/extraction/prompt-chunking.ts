// Prompt chunking for cluster confirmers. Never truncate bodies — split
// into consecutive pairs (2 sites/call), aggregate per-chunk verdicts.
// Race wins: cluster is race if any chunk says race ≥ 0.7.

// Caller code (rothunter.ts) feeds confirmers up to 8 call sites per
// cluster. Keep this cap aligned with that slice so the LLM sees the
// whole cluster — earlier versions silently dropped sites 5..8. The
// single-call vs chunked decision is delegated to estimatePromptChars
// + PROMPT_BUDGET_CHARS — small clusters still fit one prompt, large
// ones split into CHUNK_SITE_LIMIT-sized chunks.
export const MAX_SITES_PER_CALL = 8;
export const PROMPT_BUDGET_CHARS = 3500;
export const CHUNK_SITE_LIMIT = 2;

export interface ClusterSite {
  file: string;
  line: number;
  enclosingName?: string;
  enclosingSource: string;
}

export function prepareSites<T extends ClusterSite>(sites: ReadonlyArray<T>): T[] {
  return sites.slice(0, MAX_SITES_PER_CALL);
}

/**
 * Approximate prompt size in characters. Conservative — does not attempt
 * tokenizer-accurate counting.
 */
export function estimatePromptChars(
  promptTemplate: string,
  sites: ReadonlyArray<ClusterSite>,
): number {
  const sitesBlock = sites
    .map((s, i) => `[${i + 1}] ${s.file}:${s.line}\n${s.enclosingSource}`)
    .join('\n---\n');
  return promptTemplate.length + sitesBlock.length;
}

/**
 * Consecutive partition into chunks of <= `CHUNK_SITE_LIMIT` sites.
 * Function bodies are preserved in full — we trade more LLM calls for
 * loss-free context.
 */
export function splitIntoChunks<T extends ClusterSite>(sites: ReadonlyArray<T>): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < sites.length; i += CHUNK_SITE_LIMIT) {
    out.push(sites.slice(i, i + CHUNK_SITE_LIMIT));
  }
  return out;
}

export interface ChunkVerdict {
  race: boolean;
  confidence: number;
  reason: string;
}

/**
 * Aggregate per-chunk verdicts. Race wins.
 *
 *   - If ANY chunk says race with confidence ≥ 0.7 → cluster is race.
 *     Confidence = MAX across the race verdicts. Reason cites the chunk
 *     count when multiple chunks fired.
 *   - Otherwise → cluster is safe. Confidence = MIN across safe verdicts
 *     (conservative — the weakest safe verdict caps the cluster).
 */
export function aggregateChunkVerdicts(verdicts: ReadonlyArray<ChunkVerdict>): ChunkVerdict {
  const races = verdicts.filter((v) => v.race && v.confidence >= 0.7);
  if (races.length > 0) {
    const best = races.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return {
      race: true,
      confidence: best.confidence,
      reason: races.length > 1 ? `${best.reason} (across ${races.length} chunks)` : best.reason,
    };
  }
  const minConf = verdicts.reduce((m, v) => Math.min(m, v.confidence), 1);
  const reason = verdicts[0]?.reason ?? 'safe';
  return { race: false, confidence: minConf, reason };
}
