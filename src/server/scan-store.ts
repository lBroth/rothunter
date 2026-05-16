import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Finding } from '../types.js';
import type { ScanProgressEvent } from '../rothunter.js';
import { logger } from '../utils/logger.js';

/**
 * Scan lifecycle store — in-memory cache, SSE fan-out, FIFO queue,
 * per-workspace history cache, on-disk persistence under
 * `<workspace>/.rothunter/scans/<scanId>.json`.
 *
 * All scan-related mutable state lives in this module. The route layer
 * holds no scan state of its own — it calls into these helpers + reads
 * via the `scans` map. Single-thread Node guarantees the bookkeeping
 * is race-free; the queue is FIFO (acquireScanSlot returns immediately
 * when no scan is running, otherwise enqueues a resolver).
 */

/**
 * SSE event shape (server → browser). Single source of truth for the
 * scan-lifecycle wire format. The zod schema is exported so the UI can
 * `z.infer<typeof ScanSseEventSchema>` for its TS type (eliminates the
 * old hand-maintained mirror in the React app that would silently drift
 * when a new state was added on the server).
 */
export const ScanVerdictSchema = z.object({
  detectorId: z.string(),
  race: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  latencyMs: z.number().nonnegative(),
  cluster: z.string().optional(),
});

export const ScanSseEventSchema = z.object({
  scanId: z.string(),
  ts: z.number(),
  state: z.enum(['queued', 'parsing', 'detecting', 'llm-start', 'llm-verdict', 'snooze', 'done', 'error']),
  files: z.number().optional(),
  symbols: z.number().optional(),
  detector: z.string().optional(),
  llmDone: z.number().optional(),
  llmTotal: z.number().optional(),
  verdict: ScanVerdictSchema.optional(),
  findings: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

export type ScanSseEvent = z.infer<typeof ScanSseEventSchema>;
export type ScanVerdict = z.infer<typeof ScanVerdictSchema>;

/**
 * Aggregate LLM telemetry computed from `verdictLog`. Surfaced in the
 * History view + on the per-scan detail page so operators can see where
 * inference time is going. Kept on `ScanRecord` so historical scans
 * remembered from disk show the same numbers without recomputing the
 * percentiles every request.
 */
export interface LlmStats {
  /** Total verdicts emitted in this scan. */
  calls: number;
  /** Sum of per-verdict latencies, milliseconds. */
  totalLatencyMs: number;
  /** Mean latency per verdict, ms. */
  meanLatencyMs: number;
  /** Median (50th percentile) verdict latency, ms. */
  p50LatencyMs: number;
  /** 95th-percentile verdict latency, ms — the tail that defines UX. */
  p95LatencyMs: number;
  /** Per-detector breakdown. */
  byDetector: Record<string, { calls: number; totalLatencyMs: number; p95LatencyMs: number }>;
}

export function summarizeLlmStats(verdicts: ReadonlyArray<ScanVerdict>): LlmStats {
  if (verdicts.length === 0) {
    return {
      calls: 0,
      totalLatencyMs: 0,
      meanLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      byDetector: {},
    };
  }
  const lats = verdicts.map((v) => v.latencyMs).sort((a, b) => a - b);
  const total = lats.reduce((s, x) => s + x, 0);
  const byDetector: LlmStats['byDetector'] = {};
  const perDetector = new Map<string, number[]>();
  for (const v of verdicts) {
    const arr = perDetector.get(v.detectorId) ?? [];
    arr.push(v.latencyMs);
    perDetector.set(v.detectorId, arr);
  }
  for (const [id, arr] of perDetector) {
    arr.sort((a, b) => a - b);
    byDetector[id] = {
      calls: arr.length,
      totalLatencyMs: arr.reduce((s, x) => s + x, 0),
      p95LatencyMs: percentile(arr, 0.95),
    };
  }
  return {
    calls: verdicts.length,
    totalLatencyMs: total,
    meanLatencyMs: Math.round(total / verdicts.length),
    p50LatencyMs: percentile(lats, 0.5),
    p95LatencyMs: percentile(lats, 0.95),
    byDetector,
  };
}

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank method. Suitable for small N (typical scan emits 10–500
  // verdicts) — anything fancier (linear interpolation) adds zero signal
  // at this sample size.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export interface ScanRecord {
  scanId: string;
  workspaceRoot: string;
  state: ScanSseEvent['state'];
  startedAt: number;
  finishedAt?: number;
  detectorsAllow?: string[];
  detectorsDeny?: string[];
  minConfidence: number;
  // Latest progress snapshot — what the dashboard renders before the scan
  // settles. Kept narrow so the SSE payload size stays predictable.
  progress?: ScanSseEvent;
  // Captured verdict stream for replay when a late subscriber connects.
  verdictLog: Array<NonNullable<ScanSseEvent['verdict']>>;
  findings?: Finding[];
  /**
   * Findings whose fingerprint is in the workspace-scoped FP set. They
   * are excluded from the main `findings` array and surfaced in their
   * own section so the operator can still see what was detected without
   * mixing them into the real bug list.
   */
  falsePositives?: Finding[];
  symbolsCount?: number;
  /** Aggregate LLM telemetry, filled at persist time. Older scans on disk lack this — callers should treat it as optional. */
  llmStats?: LlmStats;
  error?: string;
}

// In-memory scan cache. Bounded LRU-style: oldest finished entries are
// dropped first when SCAN_CACHE_LIMIT is exceeded. Disk history under
// `<workspace>/.rothunter/scans/` remains authoritative — eviction here
// just protects long-running server memory.
const SCAN_CACHE_LIMIT = 64;
export const scans = new Map<string, ScanRecord>();
export const sseClients = new Map<string, Set<ServerResponse>>();
// Set of scanIds the operator has cancelled. The detector loop is
// synchronous so we can't truly interrupt it mid-detector, but the LLM
// confirmation pass checks this set between verdicts and bails out —
// LLM time dominates total scan duration.
export const cancelledScans = new Set<string>();

export function evictOldScans(): void {
  while (scans.size > SCAN_CACHE_LIMIT) {
    // Find the oldest scan that is not currently running/queued.
    let dropKey: string | null = null;
    let dropStart = Infinity;
    for (const [k, v] of scans) {
      if (v.state !== 'done' && v.state !== 'error') continue;
      if (v.startedAt < dropStart) {
        dropStart = v.startedAt;
        dropKey = k;
      }
    }
    if (!dropKey) break; // all live — nothing safe to drop
    scans.delete(dropKey);
    sseClients.delete(dropKey);
  }
}

// Single-flight scan execution. Concurrent POSTs to /api/scans would
// reparse the workspace and pile up LLM verdict requests, melting the
// local llama.cpp backend. We serialise: at most one running scan, the
// rest sit in a FIFO queue and report `state: 'queued'` until promoted.
let runningScanId: string | null = null;
interface QueuedScan {
  scanId: string;
  /** Promote this scan to running. */
  begin: () => void;
  /**
   * Reject the pending acquireScanSlot promise without promoting. Used by
   * dropQueuedScan to free the awaiter when a scan is cancelled before
   * it ever ran — otherwise the awaiter would pend forever and the
   * scan's async body would leak.
   */
  abort: () => void;
}
const scanQueue: QueuedScan[] = [];
export const SCAN_QUEUE_LIMIT = 8;

export function getRunningScanId(): string | null {
  return runningScanId;
}

export function getScanQueueLength(): number {
  return scanQueue.length;
}

export function acquireScanSlot(scanId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const begin = (): void => {
      runningScanId = scanId;
      resolve();
    };
    const abort = (): void => reject(new Error('queue entry dropped'));
    if (runningScanId === null) begin();
    else scanQueue.push({ scanId, begin, abort });
  });
}

export function releaseScanSlot(): void {
  runningScanId = null;
  const next = scanQueue.shift();
  if (next) {
    try {
      next.begin();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'queue starter threw — queue may be stuck');
    }
  }
}

export function dropQueuedScan(scanId: string): boolean {
  const idx = scanQueue.findIndex((q) => q.scanId === scanId);
  if (idx < 0) return false;
  const [entry] = scanQueue.splice(idx, 1);
  entry?.abort();
  return true;
}

export function broadcast(scanId: string, event: ScanSseEvent): void {
  const clients = sseClients.get(scanId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function applyProgressToRecord(record: ScanRecord, event: ScanProgressEvent): ScanSseEvent {
  const sse: ScanSseEvent = { scanId: record.scanId, ts: Date.now(), state: event.state as ScanSseEvent['state'] };
  switch (event.state) {
    case 'parsing':
      record.state = 'parsing';
      if (event.files != null) sse.files = event.files;
      if (event.symbols != null) sse.symbols = event.symbols;
      break;
    case 'detecting':
      record.state = 'detecting';
      sse.detector = event.detector;
      break;
    case 'llm-start':
      record.state = 'llm-start';
      sse.llmTotal = event.total;
      break;
    case 'llm-verdict':
      record.state = 'llm-verdict';
      sse.llmDone = event.done;
      sse.llmTotal = event.total;
      sse.verdict = {
        detectorId: event.detectorId,
        race: event.race,
        confidence: event.confidence,
        reason: event.reason,
        latencyMs: event.latencyMs,
        cluster: event.cluster,
      };
      record.verdictLog.push(sse.verdict);
      break;
    case 'snooze':
      record.state = 'snooze';
      break;
    case 'done':
      record.state = 'done';
      sse.findings = event.findings;
      sse.durationMs = event.durationMs;
      break;
  }
  record.progress = sse;
  return sse;
}

/**
 * Per-workspace cached scan history. Keyed on workspace root + mtime of
 * the scans/ directory; invalidated on persistScan and on workspace
 * switch. Avoids re-reading + JSON-parsing every scan record on every
 * /api/scans, /api/scans/series, /api/symbols/tree call.
 */
interface ScanHistoryCacheEntry {
  mtimeMs: number;
  records: ScanRecord[];
}
export const scanHistoryCache = new Map<string, ScanHistoryCacheEntry>();

export async function persistScan(record: ScanRecord): Promise<void> {
  const dir = path.join(record.workspaceRoot, '.rothunter', 'scans');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.scanId}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf-8');
  // Bust history cache for this workspace — the next /api/scans call
  // re-reads the new entry from disk.
  scanHistoryCache.delete(record.workspaceRoot);
}

export async function loadScanHistory(workspaceRoot: string): Promise<ScanRecord[]> {
  const dir = path.join(workspaceRoot, '.rothunter', 'scans');
  if (!existsSync(dir)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    // ignore — first read will populate
  }
  const cached = scanHistoryCache.get(workspaceRoot);
  if (cached && cached.mtimeMs === mtimeMs) return cached.records;

  const files = await fs.readdir(dir);
  const records: ScanRecord[] = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      records.push(JSON.parse(raw) as ScanRecord);
    } catch (err) {
      logger.warn({ file: f, err }, 'Failed to load scan history entry');
    }
  }
  records.sort((a, b) => b.startedAt - a.startedAt);
  scanHistoryCache.set(workspaceRoot, { mtimeMs, records });
  return records;
}
