/**
 * Thin fetch wrappers + types mirroring the rothunter HTTP API. Centralised
 * so component code never inlines URLs.
 */
export interface Evidence {
  file: string;
  range: { startLine: number; endLine: number };
  snippet: string;
  note?: string;
}

export interface Finding {
  detectorId: string;
  severity: 'high' | 'medium' | 'low';
  confidence: number;
  layer: number;
  title: string;
  description: string;
  evidence: Evidence[];
  suggestion?: string;
  fingerprint: string;
  /** Unix-ms timestamp when this finding was confirmed resolved via single-finding rerun. */
  resolvedAt?: number;
  /**
   * Auto-FP verdict from the LLM confirmer for this scan. Differs from
   * the manual FP store: scan-scoped (re-evaluated every run) and the
   * UI badges these rows so the user can tell "rothunter says intentional"
   * apart from "I told rothunter this is intentional".
   */
  llmFalsePositive?: { confidence: number; reason: string };
}

export interface ScanRecord {
  scanId: string;
  state:
    | 'queued'
    | 'parsing'
    | 'detecting'
    | 'llm-start'
    | 'llm-verdict'
    | 'done'
    | 'error';
  startedAt: number;
  finishedAt?: number;
  findings?: Finding[];
  falsePositives?: Finding[];
  symbolsCount?: number;
  workspaceRoot: string;
}

export interface ScanSseEvent {
  scanId: string;
  ts: number;
  state:
    | 'queued'
    | 'parsing'
    | 'detecting'
    | 'llm-start'
    | 'llm-verdict'
    | 'done'
    | 'error';
  files?: number;
  symbols?: number;
  detector?: string;
  llmDone?: number;
  llmTotal?: number;
  verdict?: {
    detectorId: string;
    race: boolean;
    confidence: number;
    reason: string;
    latencyMs: number;
    cluster?: string;
  };
  findings?: number;
  durationMs?: number;
  error?: string;
}

export interface CodeWindow {
  file: string;
  startLine: number;
  endLine: number;
  highlightFrom: number;
  highlightTo: number;
  lines: string[];
}

export async function listScans(): Promise<ScanRecord[]> {
  const res = await fetch('/api/scans');
  if (!res.ok) throw new Error(`/api/scans → ${res.status}`);
  const data = (await res.json()) as { scans: ScanRecord[] };
  return data.scans;
}

export async function getScan(scanId: string): Promise<ScanRecord> {
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}`);
  if (!res.ok) throw new Error(`/api/scans/${scanId} → ${res.status}`);
  return (await res.json()) as ScanRecord;
}

export async function startScan(opts: {
  detectors?: string[];
  minConfidence?: number;
}): Promise<{ scanId: string }> {
  const res = await fetch('/api/scans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`POST /api/scans → ${res.status}`);
  return (await res.json()) as { scanId: string };
}

export async function getFinding(
  fingerprint: string,
): Promise<{ finding: Finding; codeWindow: CodeWindow | null }> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}?context=6`);
  if (!res.ok) throw new Error(`/api/findings/${fingerprint} → ${res.status}`);
  return (await res.json()) as { finding: Finding; codeWindow: CodeWindow | null };
}

export interface ScanSeriesEntry {
  scanId: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  high: number;
  med: number;
  low: number;
  total: number;
  note: string | null;
  /** LLM verdicts emitted in this scan. Null on scans persisted before llmStats shipped. */
  llmCalls: number | null;
  /** Median LLM verdict latency, ms. */
  llmP50Ms: number | null;
  /** 95th-percentile LLM verdict latency, ms. */
  llmP95Ms: number | null;
}

export interface ScanSeriesSummary {
  count: number;
  currentHigh: number;
  change30d: number;
  avgDurationMs: number | null;
  /** Mean of per-scan p50 verdict latency across the window. */
  avgVerdictMs: number | null;
  /** Mean of per-scan p95 verdict latency across the window. */
  avgP95Ms: number | null;
}

export interface LlmStats {
  calls: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  byDetector: Record<string, { calls: number; totalLatencyMs: number; p95LatencyMs: number }>;
}

export type RerunResult =
  | { status: 'resolved'; resolvedAt: number }
  | { status: 'still-present'; finding: Finding }
  | { status: 'unsupported'; reason: string };

export async function rerunFindingVerdict(fingerprint: string): Promise<RerunResult> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/rerun`, {
    method: 'POST',
  });
  if (res.status === 422) {
    const body = (await res.json()) as { reason?: string };
    return { status: 'unsupported', reason: body.reason ?? 'detector not eligible for single-finding rerun' };
  }
  if (!res.ok) throw new Error(`/api/findings/${fingerprint}/rerun → ${res.status}`);
  return (await res.json()) as RerunResult;
}

export async function markToFix(fingerprint: string): Promise<{ count: number }> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/mark-to-fix`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`/api/findings/${fingerprint}/mark-to-fix → ${res.status}`);
  return (await res.json()) as { count: number };
}

export async function unmarkToFix(fingerprint: string): Promise<{ count: number }> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/mark-to-fix`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`/api/findings/${fingerprint}/mark-to-fix → ${res.status}`);
  return (await res.json()) as { count: number };
}

/**
 * Batch add / remove for the marked-to-fix queue. Single round-trip,
 * single read-modify-write on the server — used by the Findings page
 * bulk-select bar. N parallel single-fingerprint POSTs caused a
 * write-stomp race that dropped most marks; this is the safe path.
 */
export async function batchMarkedToFix(args: {
  add?: string[];
  remove?: string[];
}): Promise<{ count: number }> {
  const res = await fetch('/api/marked-to-fix/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`/api/marked-to-fix/batch → ${res.status}`);
  return (await res.json()) as { count: number };
}

export async function listMarkedToFix(): Promise<{ fingerprints: string[]; findings: Finding[] }> {
  const res = await fetch('/api/marked-to-fix');
  if (!res.ok) throw new Error(`/api/marked-to-fix → ${res.status}`);
  return (await res.json()) as { fingerprints: string[]; findings: Finding[] };
}

export async function generateCombinedFixPrompt(): Promise<{ prompt: string; findingCount: number }> {
  const res = await fetch('/api/marked-to-fix/prompt', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { prompt: string; findingCount: number };
}

export async function getScanLlmStats(scanId: string): Promise<{ scanId: string; state: string; stats: LlmStats }> {
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}/llm-stats`);
  if (!res.ok) throw new Error(`/api/scans/${scanId}/llm-stats → ${res.status}`);
  return (await res.json()) as { scanId: string; state: string; stats: LlmStats };
}

export interface ScanSeries {
  window: string;
  entries: ScanSeriesEntry[];
  summary: ScanSeriesSummary;
}

export async function getScanSeries(window = '30d'): Promise<ScanSeries> {
  const res = await fetch(`/api/scans/series?window=${encodeURIComponent(window)}`);
  if (!res.ok) throw new Error(`/api/scans/series → ${res.status}`);
  return (await res.json()) as ScanSeries;
}

export interface SymbolTreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  symbolCount: number;
  h: number;
  m: number;
  l: number;
  children: SymbolTreeNode[];
}

export interface SymbolFileEntry {
  id: string;
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  in: number;
  out: number;
}

export interface SymbolFileResponse {
  file: string;
  symbolCount: number;
  h: number;
  m: number;
  l: number;
  inFiles: number;
  outFiles: number;
  symbols: SymbolFileEntry[];
}

export interface SymbolDetail {
  name: string;
  kind: string;
  file: string;
  line: number;
  exported: boolean;
  signature: string;
  callers: string[];
  callees: string[];
}

export async function getSymbolTree(): Promise<SymbolTreeNode> {
  const res = await fetch('/api/symbols/tree');
  if (!res.ok) throw new Error(`/api/symbols/tree → ${res.status}`);
  return (await res.json()) as SymbolTreeNode;
}

export async function getSymbolFile(path: string): Promise<SymbolFileResponse> {
  const res = await fetch(`/api/symbols/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`/api/symbols/file → ${res.status}`);
  return (await res.json()) as SymbolFileResponse;
}

export async function getSymbolDetail(name: string, file?: string): Promise<SymbolDetail | null> {
  const qs = new URLSearchParams();
  if (file) qs.set('file', file);
  const res = await fetch(
    `/api/symbols/${encodeURIComponent(name)}${qs.toString() ? '?' + qs : ''}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/symbols/${name} → ${res.status}`);
  return (await res.json()) as SymbolDetail;
}

export async function cancelScan(scanId: string): Promise<void> {
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(`cancel scan → ${res.status}`);
}

export async function deleteScan(scanId: string): Promise<void> {
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete scan → ${res.status}`);
}

export interface WorkspaceState {
  current: string;
  name?: string;
  recent: string[];
}

export async function getWorkspace(): Promise<WorkspaceState> {
  const res = await fetch('/api/workspace');
  if (!res.ok) throw new Error(`/api/workspace → ${res.status}`);
  return (await res.json()) as WorkspaceState;
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  isHidden: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export async function listDirectory(path?: string): Promise<FsListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(`/api/fs/list${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `/api/fs/list → ${res.status}`);
  }
  return (await res.json()) as FsListing;
}

export interface AppSettings {
  detectors: Record<string, boolean>;
  minConfidence: number;
  llmConcurrency: number;
  /** Confidence floor at which a negative LLM verdict auto-routes a finding to the FP bucket. */
  llmAutoFpThreshold: number;
  hardware?: { cpuCores: number; totalMemMb: number };
  llm: { baseUrl: string; model: string };
  allDetectors: string[];
  comingSoon?: Array<{ id: string; blurb: string }>;
}

export async function getSettings(): Promise<AppSettings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`/api/settings → ${res.status}`);
  return (await res.json()) as AppSettings;
}

export async function updateSettings(patch: {
  detectors?: Record<string, boolean>;
  minConfidence?: number;
  llmConcurrency?: number;
  llmAutoFpThreshold?: number;
}): Promise<AppSettings> {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `update settings → ${res.status}`);
  }
  return (await res.json()) as AppSettings;
}

export interface LlmHealth {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  url?: string;
  error?: string;
}

export async function probeLlm(): Promise<LlmHealth> {
  const res = await fetch('/api/llm/health');
  return (await res.json()) as LlmHealth;
}

export async function setWorkspace(path: string): Promise<WorkspaceState> {
  const res = await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `set workspace → ${res.status}`);
  }
  return (await res.json()) as WorkspaceState;
}

export async function generateFixPrompt(fingerprint: string): Promise<string> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/prompt`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `prompt → ${res.status}`);
  }
  const data = (await res.json()) as { prompt: string };
  return data.prompt;
}

export async function listFalsePositives(): Promise<string[]> {
  const res = await fetch('/api/false-positives');
  if (!res.ok) throw new Error(`/api/false-positives → ${res.status}`);
  const d = (await res.json()) as { fingerprints: string[] };
  return d.fingerprints;
}

export async function markFalsePositive(fingerprint: string): Promise<number> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/false-positive`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`mark FP → ${res.status}`);
  const d = (await res.json()) as { count: number };
  return d.count;
}

export async function unmarkFalsePositive(fingerprint: string): Promise<number> {
  const res = await fetch(`/api/findings/${encodeURIComponent(fingerprint)}/false-positive`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`unmark FP → ${res.status}`);
  const d = (await res.json()) as { count: number };
  return d.count;
}

/**
 * Batch mark / unmark as false-positive. Mirrors `batchMarkedToFix`
 * — single round-trip, single read-modify-write on the server so
 * parallel single-fingerprint calls cannot stomp each other.
 */
export async function batchFalsePositives(args: {
  add?: string[];
  remove?: string[];
}): Promise<{ count: number }> {
  const res = await fetch('/api/false-positives/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`/api/false-positives/batch → ${res.status}`);
  return (await res.json()) as { count: number };
}

export async function getCodeWindow(
  file: string,
  startLine: number,
  endLine?: number,
  context = 6,
): Promise<CodeWindow | null> {
  const qs = new URLSearchParams({
    file,
    line: String(startLine),
    context: String(context),
  });
  if (endLine != null) qs.set('end', String(endLine));
  const res = await fetch(`/api/code-window?${qs.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/code-window → ${res.status}`);
  return (await res.json()) as CodeWindow;
}

export interface ScanDiff {
  base: string | null;
  added: Finding[];
  removed: Finding[];
  persisting: Finding[];
}

export async function getScanDiff(scanId: string): Promise<ScanDiff> {
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}/diff`);
  if (!res.ok) throw new Error(`diff → ${res.status}`);
  return (await res.json()) as ScanDiff;
}

/**
 * SSE subscription with explicit reconnect + backoff.
 *
 * The browser auto-reconnects an `EventSource` on transient network blips,
 * but if the server fully restarts (tsx watch + dev mode) the in-memory
 * scan is gone and `/stream` 404s forever. We catch that case by closing
 * the dead source and re-opening on a backoff schedule so a freshly-
 * started scan reconnects without a page reload.
 *
 * Also reports lifecycle to `onStatus` so the UI can render a "reconnecting…"
 * pill instead of going silent.
 */
export function subscribeScan(
  scanId: string,
  onEvent: (e: ScanSseEvent) => void,
  onStatus?: (s: 'open' | 'reconnecting' | 'closed') => void,
): () => void {
  const url = `/api/scans/${encodeURIComponent(scanId)}/stream`;
  let source: EventSource | null = null;
  let retry = 0;
  let closed = false;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource(url);
    source.onopen = () => {
      retry = 0;
      onStatus?.('open');
    };
    source.onmessage = (raw) => {
      try {
        onEvent(JSON.parse(raw.data) as ScanSseEvent);
      } catch {
        // ignore malformed payloads
      }
    };
    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      onStatus?.('reconnecting');
      // Cap backoff at ~10s. First retry ~500ms, then 1s, 2s, 4s, 8s, 10s, …
      const delay = Math.min(10_000, 500 * Math.pow(2, retry));
      retry += 1;
      backoffTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    onStatus?.('closed');
    if (backoffTimer) clearTimeout(backoffTimer);
    source?.close();
  };
}
