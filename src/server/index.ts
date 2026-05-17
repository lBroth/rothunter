/**
 * RotHunter server — Fastify HTTP API + SSE scan stream + static UI host.
 *
 * Mounts the user's repository at `/workspace` (read-only) inside the Docker
 * container, exposes a thin HTTP layer over the existing `RotHunter` engine,
 * and serves the React/Vite UI from `../ui/dist/`.
 *
 * Endpoints:
 *   GET  /api/health                    — health probe + sidecar status
 *   GET  /api/workspaces                — list mounted workspaces under /workspace
 *   POST /api/scans                     — start a new scan (returns {scanId})
 *   GET  /api/scans                     — list past scans (paged)
 *   GET  /api/scans/:scanId             — single scan with full findings
 *   GET  /api/scans/:scanId/stream      — Server-Sent Events progress
 *   GET  /api/findings/:fingerprint     — single finding + code window
 *   POST /api/findings/:fp/false-positive — mark FP (workspace-scoped, sticky)
 *
 * Persistence: scans + findings live under `/workspace/.rothunter/` so a
 * remount-and-rerun preserves history across container restarts. SQLite is
 * deferred — current release stores newline-delimited JSON per scan.
 */
import Fastify from 'fastify';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RotHunter, type ScanProgressEvent } from '../rothunter.js';
import { MlxLlmClient } from '../adapters/mlx-llm.js';
import { TypeScriptParser, type ParseResult } from '../parsers/typescript-parser.js';
import { logger } from '../utils/logger.js';
import type { Finding } from '../types.js';

const PORT = Number(process.env.ROTHUNTER_PORT ?? 3000);
const HOST = process.env.ROTHUNTER_HOST ?? '0.0.0.0';
// Default `/workspace` matches the Docker mount; in dev mode (`npm run
// rothunter:dev` on the host) `/workspace` does not exist, so fall back
// to the current working directory. The active workspace is mutable
// (in-process) via POST /api/workspace and persists across restarts in
// ~/.rothunter/workspace.json — never inside the workspace itself, since
// changing the workspace would otherwise lose the pointer.
const CONFIG_DIR = path.join(os.homedir(), '.rothunter');
const CONFIG_FILE = path.join(CONFIG_DIR, 'workspace.json');

interface WorkspaceConfig {
  current: string;
  recent: string[];
}

function readWorkspaceConfig(): WorkspaceConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as WorkspaceConfig;
  } catch {
    return null;
  }
}

function writeWorkspaceConfig(cfg: WorkspaceConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

const envWorkspace = process.env.ROTHUNTER_WORKSPACE;
const persisted = readWorkspaceConfig();
let WORKSPACE_ROOT =
  envWorkspace ??
  persisted?.current ??
  (existsSync('/workspace') ? '/workspace' : process.cwd());
let RECENT_WORKSPACES: string[] = persisted?.recent ?? [WORKSPACE_ROOT];

function persistWorkspace(): void {
  try {
    writeWorkspaceConfig({ current: WORKSPACE_ROOT, recent: RECENT_WORKSPACES });
  } catch (err) {
    logger.warn({ err }, 'Failed to persist workspace config');
  }
}

/**
 * In-process settings — survive across restarts via
 * ~/.rothunter/settings.json. The Settings page edits this; scan start
 * picks defaults from here when the request body omits them.
 */
const ALL_DETECTORS = [
  'duplicate-type',
  'duplicate-function',
  'dead-module',
  'dead-export',
  'dead-handler',
  'mutation',
  'race-condition',
  'shared-db-write',
  'api-race',
  'bad-config',
  'silent-catch',
  'skip-tests',
  'long-file',
  'long-function',
  'console-log-prod',
  'magic-numbers',
  'deep-nesting',
  'public-any',
  'mutable-globals',
  'unused-deps',
  'hot-hub-file',
  'similar-functions',
  'todo-comments',
] as const;

interface AppSettings {
  detectors: Record<string, boolean>;
  minConfidence: number;
  /**
   * Number of LLM verdict requests in flight at once. 1 = sequential
   * (original behaviour). 4-8 is a good default on llama.cpp run with
   * `--parallel N -cb` (continuous batching), or on vLLM where dynamic
   * batching is on by default. Mlx_lm.server serialises internally so
   * setting >1 there gives little gain and may wedge the server.
   */
  llmConcurrency: number;
}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

function defaultSettings(): AppSettings {
  const detectors: Record<string, boolean> = {};
  for (const id of ALL_DETECTORS) detectors[id] = true;
  // Auto-tune LLM concurrency: default to half the CPU cores, clamped
  // to [1, 8]. Most laptops land at 4 — a sane balance between local
  // llama.cpp throughput and OS responsiveness during a scan.
  const cores = Math.max(1, os.cpus().length);
  const auto = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  return { detectors, minConfidence: 0.6, llmConcurrency: auto };
}

function readSettings(): AppSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return defaultSettings();
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<AppSettings>;
    const base = defaultSettings();
    return {
      detectors: { ...base.detectors, ...(raw.detectors ?? {}) },
      minConfidence: typeof raw.minConfidence === 'number' ? raw.minConfidence : base.minConfidence,
      llmConcurrency:
        typeof raw.llmConcurrency === 'number' && raw.llmConcurrency >= 1
          ? Math.min(16, Math.floor(raw.llmConcurrency))
          : base.llmConcurrency,
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(s: AppSettings): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

let SETTINGS: AppSettings = readSettings();

const UI_DIST = path.resolve(import.meta.dirname, '../ui/dist');

/**
 * SSE event shape (server → browser). `state` is the high-level lifecycle
 * tag; the optional progress fields mirror `ScanProgressEvent` from the
 * RotHunter engine so the frontend renders the live pipeline without a
 * second schema.
 */
interface ScanSseEvent {
  scanId: string;
  ts: number;
  state: 'queued' | 'parsing' | 'detecting' | 'llm-start' | 'llm-verdict' | 'snooze' | 'done' | 'error';
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

interface ScanRecord {
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
  error?: string;
}

const scans = new Map<string, ScanRecord>();
const sseClients = new Map<string, Set<import('node:http').ServerResponse>>();
// Set of scanIds the operator has cancelled. The detector loop is
// synchronous so we can't truly interrupt it mid-detector, but the LLM
// confirmation pass checks this set between verdicts and bails out —
// LLM time dominates total scan duration.
const cancelledScans = new Set<string>();

/**
 * Cached parse result powering the Symbol-graph endpoints. Filled lazily
 * on the first /api/symbols/* request and invalidated whenever a scan
 * starts (a scan re-parses anyway, so the post-scan call returns fresh
 * data without paying a separate parse).
 */
interface CachedParse {
  parsedAt: number;
  result: ParseResult;
}
let parseCache: CachedParse | null = null;

async function getOrParseWorkspace(): Promise<ParseResult> {
  if (parseCache && Date.now() - parseCache.parsedAt < 5 * 60_000) {
    return parseCache.result;
  }
  const parser = new TypeScriptParser();
  const result = await parser.parseWorkspaceFull({ workspaceRoot: WORKSPACE_ROOT });
  parseCache = { parsedAt: Date.now(), result };
  return result;
}

function invalidateParseCache(): void {
  parseCache = null;
}

function broadcast(scanId: string, event: ScanSseEvent): void {
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

function applyProgressToRecord(record: ScanRecord, event: ScanProgressEvent): ScanSseEvent {
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

async function startScan(opts: {
  workspaceRoot: string;
  detectorsAllow?: string[];
  detectorsDeny?: string[];
  minConfidence?: number;
  llmConcurrency?: number;
}): Promise<string> {
  const scanId = `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const record: ScanRecord = {
    scanId,
    workspaceRoot: opts.workspaceRoot,
    state: 'queued',
    detectorsAllow: opts.detectorsAllow,
    detectorsDeny: opts.detectorsDeny,
    minConfidence: opts.minConfidence ?? 0.5,
    startedAt: Date.now(),
    verdictLog: [],
  };
  scans.set(scanId, record);
  invalidateParseCache(); // fresh scan = fresh parse
  broadcast(scanId, { scanId, ts: Date.now(), state: 'queued' });

  // Fire and forget — the SSE channel relays state changes.
  void (async () => {
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({
        workspaceRoot: opts.workspaceRoot,
        detectorsAllow: opts.detectorsAllow ? new Set(opts.detectorsAllow) : undefined,
        detectorsDeny: opts.detectorsDeny ? new Set(opts.detectorsDeny) : undefined,
        llmConcurrency: opts.llmConcurrency,
        onProgress: (event) => {
          // The cancel endpoint sets a flag on this scanId. Throwing
          // inside the progress callback unwinds the LLM pass on the
          // next emit; the outer catch arm marks the scan errored.
          if (cancelledScans.has(scanId)) throw new Error('cancelled by user');
          const sse = applyProgressToRecord(record, event);
          broadcast(scanId, sse);
        },
      });
      record.state = 'done';
      record.finishedAt = Date.now();
      const fpSet = readFalsePositives(opts.workspaceRoot);
      const split = splitFalsePositives(result.findings, fpSet);
      record.findings = split.findings;
      record.falsePositives = split.falsePositives;
      record.symbolsCount = result.symbols.length;
      await persistScan(record);
    } catch (err) {
      record.state = 'error';
      record.error = (err as Error).message;
      record.finishedAt = Date.now();
      broadcast(scanId, { scanId, ts: Date.now(), state: 'error', error: record.error });
      logger.error({ scanId, err }, 'RotHunter scan failed');
    }
  })();

  return scanId;
}

/**
 * Workspace-scoped false-positive store. The fingerprint set lives at
 * `<workspace>/.rothunter/false-positives.json` so it follows the repo
 * (commit it, share across the team, survive workspace switches). On
 * every scan completion we partition `result.findings` into normal vs
 * false-positives — the latter never disappear from the report but get
 * a dedicated section in the UI.
 */
function falsePositivesFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.rothunter', 'false-positives.json');
}

function readFalsePositives(workspaceRoot: string): Set<string> {
  const file = falsePositivesFile(workspaceRoot);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

function writeFalsePositives(workspaceRoot: string, set: Set<string>): void {
  const file = falsePositivesFile(workspaceRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ fingerprints: [...set].sort() }, null, 2),
    'utf-8',
  );
}

function splitFalsePositives(
  findings: Finding[],
  fpSet: ReadonlySet<string>,
): { findings: Finding[]; falsePositives: Finding[] } {
  if (fpSet.size === 0) return { findings, falsePositives: [] };
  const ok: Finding[] = [];
  const fp: Finding[] = [];
  for (const f of findings) (fpSet.has(f.fingerprint) ? fp : ok).push(f);
  return { findings: ok, falsePositives: fp };
}

async function persistScan(record: ScanRecord): Promise<void> {
  const dir = path.join(record.workspaceRoot, '.rothunter', 'scans');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.scanId}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf-8');
}

async function loadScanHistory(workspaceRoot: string): Promise<ScanRecord[]> {
  const dir = path.join(workspaceRoot, '.rothunter', 'scans');
  if (!existsSync(dir)) return [];
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
  return records.sort((a, b) => b.startedAt - a.startedAt);
}

const app = Fastify({ logger: false });

app.get('/api/health', async () => ({
  ok: true,
  version: '0.1.0',
  workspaceRoot: WORKSPACE_ROOT,
  llm: process.env.ROTHUNTER_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
}));

/**
 * GET /api/fs/list?path=/abs/path — directory listing for the folder
 * picker. Returns:
 *   {
 *     path:    "/abs/path",        // resolved
 *     parent:  "/abs" | null,      // null at fs root
 *     entries: [{ name, isDir, isHidden }]
 *   }
 *
 * Defaults to the user's home directory when `path` is missing. Files
 * are included (greyed in UI) so users see context; only dirs are
 * navigable / selectable.
 */
app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req, reply) => {
  const target = path.resolve(req.query.path?.trim() || os.homedir());
  if (!existsSync(target)) return reply.code(404).send({ error: 'path does not exist' });
  const stat = statSync(target);
  if (!stat.isDirectory()) return reply.code(400).send({ error: 'not a directory' });
  let entries: Array<{ name: string; isDir: boolean; isHidden: boolean }> = [];
  try {
    const items = await fs.readdir(target, { withFileTypes: true });
    entries = items
      .map((d) => ({
        name: d.name,
        isDir: d.isDirectory(),
        isHidden: d.name.startsWith('.'),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch (err) {
    return reply.code(403).send({ error: (err as Error).message });
  }
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
  };
});

app.get('/api/workspaces', async () => {
  if (!existsSync(WORKSPACE_ROOT)) {
    return { workspaces: [] };
  }
  const stat = statSync(WORKSPACE_ROOT);
  // Single workspace mount (the common Docker case).
  if (!stat.isDirectory()) return { workspaces: [] };
  return {
    workspaces: [
      {
        path: WORKSPACE_ROOT,
        name: path.basename(WORKSPACE_ROOT),
      },
    ],
  };
});

/**
 * GET /api/workspace — current workspace + recent list. The UI's folder
 * picker reads this on mount.
 */
app.get('/api/workspace', async () => ({
  current: WORKSPACE_ROOT,
  name: path.basename(WORKSPACE_ROOT),
  recent: RECENT_WORKSPACES,
}));

/**
 * POST /api/workspace { path } — switch the active workspace in-process,
 * persist to ~/.rothunter/workspace.json, and bust the parse cache so the
 * next /api/symbols/* re-parses the new tree. Validates that the path
 * exists, is a directory, and is absolute.
 */
app.post<{ Body: { path: string } }>('/api/workspace', async (req, reply) => {
  const target = req.body?.path?.trim();
  if (!target) return reply.code(400).send({ error: 'path required' });
  if (!path.isAbsolute(target)) return reply.code(400).send({ error: 'absolute path required' });
  if (!existsSync(target)) return reply.code(404).send({ error: 'path does not exist' });
  if (!statSync(target).isDirectory()) return reply.code(400).send({ error: 'not a directory' });
  WORKSPACE_ROOT = target;
  RECENT_WORKSPACES = [target, ...RECENT_WORKSPACES.filter((p) => p !== target)].slice(0, 8);
  invalidateParseCache();
  persistWorkspace();
  logger.info({ workspaceRoot: WORKSPACE_ROOT }, 'Workspace switched');
  return { current: WORKSPACE_ROOT, recent: RECENT_WORKSPACES };
});

app.post<{ Body: { detectors?: string[]; minConfidence?: number } }>('/api/scans', async (req) => {
  const body = req.body ?? {};
  // When the caller doesn't pin detectors, derive the allow-list from
  // persisted settings — only the ones the operator left toggled ON run.
  const allowFromSettings = ALL_DETECTORS.filter((id) => SETTINGS.detectors[id] !== false);
  const scanId = await startScan({
    workspaceRoot: WORKSPACE_ROOT,
    detectorsAllow: body.detectors ?? allowFromSettings,
    minConfidence: body.minConfidence ?? SETTINGS.minConfidence,
    llmConcurrency: SETTINGS.llmConcurrency,
  });
  return { scanId };
});

/**
 * GET /api/settings — current in-process settings. Includes the active
 * LLM endpoint (read-only here; switching backends requires an env-var
 * change + restart for now).
 */
/**
 * Detectors planned but not yet shipped. The UI shows them in the
 * Settings list with a "coming soon" pill so the operator knows what is
 * on the roadmap. They are not executed by the engine.
 */
const COMING_SOON_DETECTORS: Array<{ id: string; blurb: string }> = [
  {
    id: 'pii-leak',
    blurb:
      'PII + secret data-leak scanner powered by nullpii. Walks source + logger calls + console.info / console.warn / structured-log payloads for emails, phone numbers, national IDs, addresses, payment-card numbers, passport / driver-licence patterns, AND committed credentials (AWS / GitHub / OpenAI / Anthropic / Stripe keys + hardcoded localhost URLs). Unified redaction telemetry — supersedes the older standalone secret-leak detector.',
  },
];

function settingsPayload() {
  return {
    detectors: SETTINGS.detectors,
    minConfidence: SETTINGS.minConfidence,
    llmConcurrency: SETTINGS.llmConcurrency,
    hardware: {
      cpuCores: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    },
    llm: {
      baseUrl: process.env.ROTHUNTER_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
      model: process.env.ROTHUNTER_LLM_MODEL ?? 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
    },
    allDetectors: ALL_DETECTORS,
    comingSoon: COMING_SOON_DETECTORS,
  };
}

app.get('/api/settings', async () => settingsPayload());

app.post<{
  Body: { detectors?: Record<string, boolean>; minConfidence?: number; llmConcurrency?: number };
}>('/api/settings', async (req, reply) => {
  const body = req.body ?? {};
  if (body.minConfidence != null) {
    if (typeof body.minConfidence !== 'number' || body.minConfidence < 0 || body.minConfidence > 1) {
      return reply.code(400).send({ error: 'minConfidence must be in [0, 1]' });
    }
    SETTINGS.minConfidence = body.minConfidence;
  }
  if (body.llmConcurrency != null) {
    if (typeof body.llmConcurrency !== 'number' || body.llmConcurrency < 1 || body.llmConcurrency > 16) {
      return reply.code(400).send({ error: 'llmConcurrency must be in [1, 16]' });
    }
    SETTINGS.llmConcurrency = Math.floor(body.llmConcurrency);
  }
  if (body.detectors) {
    for (const [id, on] of Object.entries(body.detectors)) {
      if ((ALL_DETECTORS as readonly string[]).includes(id)) {
        SETTINGS.detectors[id] = !!on;
      }
    }
  }
  try {
    writeSettings(SETTINGS);
  } catch (err) {
    logger.warn({ err }, 'Failed to persist settings');
  }
  // Return the full payload (matching GET) so the UI can replace state
  // without losing `allDetectors` / `comingSoon` / `hardware` / `llm`.
  return settingsPayload();
});

/**
 * GET /api/llm/health — probes the Tier-3 LLM endpoint so the Settings
 * page can show a green/red dot without baking llama.cpp specifics into
 * the UI.
 */
/**
 * POST /api/findings/:fp/prompt
 *
 * Generates a copy-paste-ready prompt the operator can hand to a coding
 * assistant (Claude Code / Codex / Copilot Chat / Cursor) to fix the
 * finding. The Tier-3 model already has full code context loaded for
 * verdicts, so reusing it here gives a contextual prompt without spinning
 * up a second model.
 *
 * Returns `{ prompt: string }`. The UI renders it in a copyable block.
 */
app.post<{ Params: { fp: string } }>('/api/findings/:fp/prompt', async (req, reply) => {
  const fp = decodeURIComponent(req.params.fp);
  // Find the finding — prefer the latest in-memory done scan, fall back to disk.
  let finding: Finding | undefined;
  for (const s of scans.values()) {
    if (s.state !== 'done' || !s.findings) continue;
    const hit = s.findings.find((f) => f.fingerprint === fp);
    if (hit) {
      finding = hit;
      break;
    }
  }
  if (!finding) {
    const hist = await loadScanHistory(WORKSPACE_ROOT);
    for (const s of hist) {
      const hit = s.findings?.find((f) => f.fingerprint === fp);
      if (hit) {
        finding = hit;
        break;
      }
    }
  }
  if (!finding) return reply.code(404).send({ error: 'finding not found' });

  const evidenceBlock = finding.evidence
    .map((e, i) => `Evidence ${i + 1} · ${e.file}:${e.range.startLine}-${e.range.endLine}\n${e.snippet}`)
    .join('\n\n');

  const system = `You are a senior TypeScript engineer. The user is pasting your output into a coding agent (Claude Code, Codex, Cursor, Copilot Chat). Produce a single self-contained prompt that:
- explains the defect briefly
- cites file paths + line ranges exactly
- asks the agent to propose a minimal patch
- requests tests where they make sense
- ends with "respond with the unified diff"

Output ONLY the prompt body — no preamble, no markdown fence.`;

  const user = `Detector: ${finding.detectorId}
Severity: ${finding.severity}
Title: ${finding.title}

Description:
${finding.description}

Suggested direction from RotHunter:
${finding.suggestion ?? '(none)'}

Code evidence:
${evidenceBlock}

Generate the prompt now.`;

  const llm = new MlxLlmClient();
  try {
    const prompt = await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, maxTokens: 700, timeoutMs: 90_000 },
    );
    return { prompt: prompt.trim() };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

app.get('/api/llm/health', async (_, reply) => {
  const base = process.env.ROTHUNTER_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1';
  // llama.cpp exposes /health at the root, not under /v1.
  const healthUrl = base.replace(/\/v1\/?$/, '') + '/health';
  const started = Date.now();
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return reply.code(502).send({ ok: false, status: r.status, latencyMs: Date.now() - started });
    return { ok: true, status: r.status, latencyMs: Date.now() - started, url: healthUrl };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message, latencyMs: Date.now() - started });
  }
});

app.get('/api/scans', async () => {
  const history = await loadScanHistory(WORKSPACE_ROOT);
  // Live scans (still in-memory) merged in front.
  const live = [...scans.values()].filter((s) => s.state !== 'done' && s.state !== 'error');
  return { scans: [...live, ...history.slice(0, 50)] };
});

app.get<{ Params: { scanId: string } }>('/api/scans/:scanId', async (req, reply) => {
  const live = scans.get(req.params.scanId);
  if (live) return live;
  // Disk lookup
  const dir = path.join(WORKSPACE_ROOT, '.rothunter', 'scans');
  const file = path.join(dir, `${req.params.scanId}.json`);
  if (!existsSync(file)) {
    return reply.code(404).send({ error: 'scan not found' });
  }
  return JSON.parse(await fs.readFile(file, 'utf-8'));
});

/**
 * GET /api/scans/:scanId/diff?vs=<prevScanId>
 * Diff the requested scan's findings against `vs` (defaults to the
 * previous scan in history). Returned shape:
 *   {
 *     base: <prev scanId>,
 *     added:      <findings present in current but not in base>,
 *     removed:    <findings present in base but not in current>,
 *     persisting: <findings present in both>,
 *   }
 * Identity is fingerprint equality.
 */
app.get<{ Params: { scanId: string }; Querystring: { vs?: string } }>(
  '/api/scans/:scanId/diff',
  async (req, reply) => {
    const live = scans.get(req.params.scanId);
    let current: ScanRecord | undefined = live;
    if (!current) {
      const dir = path.join(WORKSPACE_ROOT, '.rothunter', 'scans');
      const file = path.join(dir, `${req.params.scanId}.json`);
      if (existsSync(file)) current = JSON.parse(await fs.readFile(file, 'utf-8')) as ScanRecord;
    }
    if (!current) return reply.code(404).send({ error: 'scan not found' });
    if (!current.findings) return reply.code(409).send({ error: 'scan still in flight' });

    const history = await loadScanHistory(WORKSPACE_ROOT);
    let base: ScanRecord | null = null;
    if (req.query.vs) {
      base = history.find((s) => s.scanId === req.query.vs) ?? null;
    } else {
      // Walk past the current scan, pick the next-newest with findings.
      const idx = history.findIndex((s) => s.scanId === req.params.scanId);
      for (let i = idx + 1; i < history.length; i++) {
        if (history[i]!.findings) {
          base = history[i]!;
          break;
        }
      }
    }
    if (!base || !base.findings) {
      return {
        base: null,
        added: current.findings,
        removed: [],
        persisting: [],
      };
    }
    const currentFp = new Set(current.findings.map((f) => f.fingerprint));
    const baseFp = new Set(base.findings.map((f) => f.fingerprint));
    return {
      base: base.scanId,
      added: current.findings.filter((f) => !baseFp.has(f.fingerprint)),
      removed: base.findings.filter((f) => !currentFp.has(f.fingerprint)),
      persisting: current.findings.filter((f) => baseFp.has(f.fingerprint)),
    };
  },
);

app.get<{ Params: { scanId: string } }>('/api/scans/:scanId/stream', (req, reply) => {
  const { scanId } = req.params;
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const set = sseClients.get(scanId) ?? new Set();
  set.add(reply.raw);
  sseClients.set(scanId, set);
  // Replay current state + verdict log so a late subscriber sees the full
  // pipeline without having to query the snapshot endpoint separately.
  const current = scans.get(scanId);
  if (current) {
    const snapshot: ScanSseEvent = current.progress ?? { scanId, ts: Date.now(), state: current.state };
    reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    for (const v of current.verdictLog) {
      const replay: ScanSseEvent = {
        scanId,
        ts: Date.now(),
        state: 'llm-verdict',
        verdict: v,
      };
      reply.raw.write(`data: ${JSON.stringify(replay)}\n\n`);
    }
  }

  req.raw.on('close', () => {
    set.delete(reply.raw);
  });
});

/**
 * GET /api/scans/series?window=30d
 * Returns the time series the Scan history page renders: scanId,
 * timestamps, duration, severity counts, and an optional `note` for the
 * recent-scans table. Sourced from the on-disk scan history under
 * `<workspace>/.rothunter/scans/*.json`, sorted newest-first.
 */
interface ScanSeriesEntry {
  scanId: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  high: number;
  med: number;
  low: number;
  total: number;
  note: string | null;
}

app.get<{ Querystring: { window?: string } }>('/api/scans/series', async (req) => {
  const win = req.query.window ?? '30d';
  const days = /^(\d+)d$/.test(win) ? Number(win.slice(0, -1)) : 30;
  const cutoff = Date.now() - days * 86400_000;

  const history = await loadScanHistory(WORKSPACE_ROOT);
  const entries: ScanSeriesEntry[] = history
    .filter((s) => s.startedAt >= cutoff)
    .map((s) => {
      const counts = { high: 0, med: 0, low: 0 };
      for (const f of s.findings ?? []) {
        if (f.severity === 'high') counts.high += 1;
        else if (f.severity === 'medium') counts.med += 1;
        else counts.low += 1;
      }
      return {
        scanId: s.scanId,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt ?? null,
        durationMs: s.finishedAt ? s.finishedAt - s.startedAt : null,
        high: counts.high,
        med: counts.med,
        low: counts.low,
        total: counts.high + counts.med + counts.low,
        note: null,
      };
    });

  // Stats for the KPI strip.
  const current = entries[0]?.high ?? 0;
  const oldest = entries[entries.length - 1]?.high ?? 0;
  const change = current - oldest;
  const avgDuration =
    entries.length === 0
      ? null
      : Math.round(
          entries
            .map((e) => e.durationMs ?? 0)
            .reduce((a, b) => a + b, 0) / entries.length,
        );
  return {
    window: win,
    entries,
    summary: {
      count: entries.length,
      currentHigh: current,
      change30d: change,
      avgDurationMs: avgDuration,
      // Avg LLM-verdict latency requires per-finding verdict events — not
      // captured per persisted scan record yet, so return null for now.
      avgVerdictMs: null,
    },
  };
});

app.post<{ Params: { scanId: string } }>('/api/scans/:scanId/cancel', async (req, reply) => {
  const { scanId } = req.params;
  const record = scans.get(scanId);
  if (!record) return reply.code(404).send({ error: 'scan not found' });
  if (record.state === 'done' || record.state === 'error') {
    return { ok: true, already: record.state };
  }
  cancelledScans.add(scanId);
  record.state = 'error';
  record.error = 'cancelled by user';
  record.finishedAt = Date.now();
  broadcast(scanId, { scanId, ts: Date.now(), state: 'error', error: 'cancelled by user' });
  return { ok: true };
});

/**
 * DELETE /api/scans/:scanId — remove a finished scan's persisted record
 * + drop it from the in-memory cache. Refuses to delete a live scan;
 * cancel it first. Leaves `.rothunterignore` untouched.
 */
app.delete<{ Params: { scanId: string } }>('/api/scans/:scanId', async (req, reply) => {
  const { scanId } = req.params;
  const live = scans.get(scanId);
  if (live && live.state !== 'done' && live.state !== 'error') {
    return reply.code(409).send({ error: 'scan still running — cancel first' });
  }
  scans.delete(scanId);
  const file = path.join(WORKSPACE_ROOT, '.rothunter', 'scans', `${scanId}.json`);
  if (existsSync(file)) {
    await fs.unlink(file);
  }
  return { ok: true };
});

/**
 * POST /api/findings/:fp/false-positive — mark a finding as a false
 * positive. The fingerprint is persisted to
 * `<workspace>/.rothunter/false-positives.json` and applied on every
 * future scan — the finding still surfaces, but in the dedicated FP
 * section, not in the main bug list.
 *
 * DELETE clears the flag (the finding re-enters the normal list on the
 * next scan).
 */
app.post<{ Params: { fp: string } }>('/api/findings/:fp/false-positive', async (req) => {
  const fp = decodeURIComponent(req.params.fp);
  const set = readFalsePositives(WORKSPACE_ROOT);
  set.add(fp);
  writeFalsePositives(WORKSPACE_ROOT, set);
  // Apply retroactively to every in-memory scan so the UI updates
  // immediately without waiting for the next scan.
  for (const s of scans.values()) {
    if (!s.findings && !s.falsePositives) continue;
    const all = [...(s.findings ?? []), ...(s.falsePositives ?? [])];
    const split = splitFalsePositives(all, set);
    s.findings = split.findings;
    s.falsePositives = split.falsePositives;
  }
  return { ok: true, count: set.size };
});

app.delete<{ Params: { fp: string } }>('/api/findings/:fp/false-positive', async (req) => {
  const fp = decodeURIComponent(req.params.fp);
  const set = readFalsePositives(WORKSPACE_ROOT);
  set.delete(fp);
  writeFalsePositives(WORKSPACE_ROOT, set);
  for (const s of scans.values()) {
    if (!s.findings && !s.falsePositives) continue;
    const all = [...(s.findings ?? []), ...(s.falsePositives ?? [])];
    const split = splitFalsePositives(all, set);
    s.findings = split.findings;
    s.falsePositives = split.falsePositives;
  }
  return { ok: true, count: set.size };
});

app.get('/api/false-positives', async () => {
  const set = readFalsePositives(WORKSPACE_ROOT);
  return { fingerprints: [...set].sort() };
});

/**
 * GET /api/findings/:fp
 * Returns the finding + a code window around the first evidence range.
 * Looks up the finding in the in-memory scan cache; falls back to disk
 * lookup of the latest scan if the live scan has rotated out.
 */
/**
 * GET /api/code-window?file=<rel>&line=<n>&end=<n?>&context=<n?>
 * Returns a CodeWindow around the requested file/line, with `context`
 * lines of padding above and below. Used to render evidence locations
 * other than the primary one shown in the finding detail.
 */
app.get<{
  Querystring: { file?: string; line?: string; end?: string; context?: string };
}>('/api/code-window', async (req, reply) => {
  const { file, line, end, context } = req.query;
  if (!file || !line) {
    return reply.code(400).send({ error: 'file and line query params are required' });
  }
  const startLine = Number(line);
  const endLine = end ? Number(end) : startLine;
  const ctx = Math.max(0, Math.min(60, Number(context ?? 6)));
  // Guard against path traversal — the resolved path must stay inside
  // the mounted workspace.
  const resolved = path.resolve(WORKSPACE_ROOT, file);
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep)) {
    return reply.code(400).send({ error: 'file is outside the workspace' });
  }
  if (!existsSync(resolved)) {
    return reply.code(404).send({ error: 'file not found' });
  }
  const fullText = await fs.readFile(resolved, 'utf-8');
  const lines = fullText.split(/\r?\n/);
  const start = Math.max(1, startLine - ctx);
  const stop = Math.min(lines.length, endLine + ctx);
  return {
    file,
    startLine: start,
    endLine: stop,
    highlightFrom: startLine,
    highlightTo: endLine,
    lines: lines.slice(start - 1, stop),
  };
});

app.get<{ Params: { fp: string }; Querystring: { context?: string } }>(
  '/api/findings/:fp',
  async (req, reply) => {
    const fp = decodeURIComponent(req.params.fp);
    const contextLines = Math.max(0, Math.min(60, Number(req.query.context ?? 6)));
    let finding: Finding | undefined;
    // Look in latest live scan first.
    for (const scan of scans.values()) {
      finding = scan.findings?.find((f) => f.fingerprint === fp);
      if (finding) break;
    }
    if (!finding) {
      // Fall back to most-recent persisted scan.
      const history = await loadScanHistory(WORKSPACE_ROOT);
      for (const r of history) {
        if (!r.findings) continue;
        finding = r.findings.find((f) => f.fingerprint === fp);
        if (finding) break;
      }
    }
    if (!finding) return reply.code(404).send({ error: 'finding not found' });
    const evidence = finding.evidence?.[0];
    if (!evidence) return { finding, codeWindow: null };
    const filePath = path.join(WORKSPACE_ROOT, evidence.file);
    if (!existsSync(filePath)) return { finding, codeWindow: null };
    const fullText = await fs.readFile(filePath, 'utf-8');
    const lines = fullText.split(/\r?\n/);
    const start = Math.max(1, evidence.range.startLine - contextLines);
    const end = Math.min(lines.length, evidence.range.endLine + contextLines);
    const windowLines = lines.slice(start - 1, end);
    return {
      finding,
      codeWindow: {
        file: evidence.file,
        startLine: start,
        endLine: end,
        highlightFrom: evidence.range.startLine,
        highlightTo: evidence.range.endLine,
        lines: windowLines,
      },
    };
  },
);

/**
 * GET /api/symbols/tree — directory tree with per-file finding counts
 * folded in from the most recent persisted scan. Each tree node:
 *   { name, path, kind: 'dir'|'file', symbolCount, h, m, l, children }
 */
interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  symbolCount: number;
  h: number;
  m: number;
  l: number;
  children: TreeNode[];
}

app.get('/api/symbols/tree', async () => {
  const parsed = await getOrParseWorkspace();
  // Index findings by file from the latest scan (in-memory live scan
  // wins; falls back to disk history).
  const findingsByFile = await loadLatestFindingsIndex();
  const symbolsByFile = new Map<string, number>();
  for (const s of parsed.symbols) {
    symbolsByFile.set(s.file, (symbolsByFile.get(s.file) ?? 0) + 1);
  }
  const root: TreeNode = {
    name: '.',
    path: '',
    kind: 'dir',
    symbolCount: 0,
    h: 0,
    m: 0,
    l: 0,
    children: [],
  };
  for (const file of parsed.files) {
    const parts = file.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const sub = cur.children.find((c) => c.name === part);
      if (sub) {
        cur = sub;
      } else {
        const child: TreeNode = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          kind: isLast ? 'file' : 'dir',
          symbolCount: 0,
          h: 0,
          m: 0,
          l: 0,
          children: [],
        };
        cur.children.push(child);
        cur = child;
      }
    }
    const counts = findingsByFile.get(file);
    if (counts) {
      cur.h = counts.h;
      cur.m = counts.m;
      cur.l = counts.l;
    }
    cur.symbolCount = symbolsByFile.get(file) ?? 0;
  }
  // Bubble counts upward.
  function bubble(n: TreeNode): { h: number; m: number; l: number; s: number } {
    let h = n.h;
    let m = n.m;
    let l = n.l;
    let s = n.symbolCount;
    for (const c of n.children) {
      const sub = bubble(c);
      h += sub.h;
      m += sub.m;
      l += sub.l;
      s += sub.s;
    }
    if (n.kind === 'dir') {
      n.h = h;
      n.m = m;
      n.l = l;
      n.symbolCount = s;
    }
    return { h, m, l, s };
  }
  bubble(root);
  // Sort directories first, then alphabetical inside each tier.
  function sort(n: TreeNode): void {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  }
  sort(root);
  return root;
});

app.get<{ Querystring: { path?: string } }>('/api/symbols/file', async (req, reply) => {
  const file = req.query.path;
  if (!file) return reply.code(400).send({ error: 'path query param required' });
  const parsed = await getOrParseWorkspace();
  const symbols = parsed.symbols.filter((s) => s.file === file);
  // In/out edges at file level — count import records linking this file
  // to others. Symbol-level call graph would need ts-morph
  // findReferencesAsNodes; not yet wired.
  const inFiles = new Set<string>();
  const outFiles = new Set<string>();
  for (const imp of parsed.imports) {
    if (!imp.target) continue;
    if (imp.target === file) inFiles.add(imp.source);
    if (imp.source === file && imp.target !== file) outFiles.add(imp.target);
  }
  const findingsByFile = await loadLatestFindingsIndex();
  const counts = findingsByFile.get(file) ?? { h: 0, m: 0, l: 0 };
  return {
    file,
    symbolCount: symbols.length,
    h: counts.h,
    m: counts.m,
    l: counts.l,
    inFiles: inFiles.size,
    outFiles: outFiles.size,
    symbols: symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      line: s.range.startLine,
      exported: s.exported,
      // Edge counts at file granularity attributed to each symbol; a
      // future symbol-level resolver will refine these.
      in: inFiles.size,
      out: outFiles.size,
    })),
  };
});

app.get<{ Params: { name: string }; Querystring: { file?: string } }>(
  '/api/symbols/:name',
  async (req, reply) => {
    const name = decodeURIComponent(req.params.name);
    const file = req.query.file;
    const parsed = await getOrParseWorkspace();
    const matches = parsed.symbols.filter((s) => s.name === name && (!file || s.file === file));
    if (matches.length === 0) return reply.code(404).send({ error: 'symbol not found' });
    const pick = matches[0]!;
    const callers: string[] = [];
    const callees: string[] = [];
    for (const imp of parsed.imports) {
      if (!imp.target) continue;
      if (imp.target === pick.file && imp.source !== pick.file) {
        // Only count the import if it actually pulled this symbol.
        const consumed = imp.namedImports.includes(pick.name) || imp.defaultImport === pick.name || imp.namespaceAlias;
        if (consumed) callers.push(imp.source);
      }
      if (imp.source === pick.file && imp.target !== pick.file) {
        callees.push(imp.target);
      }
    }
    return {
      name: pick.name,
      kind: pick.kind,
      file: pick.file,
      line: pick.range.startLine,
      exported: pick.exported,
      signature: pick.source.split('\n').slice(0, 3).join('\n'),
      callers: dedup(callers),
      callees: dedup(callees),
    };
  },
);

function dedup<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

async function loadLatestFindingsIndex(): Promise<Map<string, { h: number; m: number; l: number }>> {
  const out = new Map<string, { h: number; m: number; l: number }>();
  // Prefer the in-memory latest done scan, fall back to disk.
  let findings: Finding[] | undefined;
  for (const s of scans.values()) {
    if (s.state === 'done' && s.findings && s.findings.length > 0) {
      findings = s.findings;
      break;
    }
  }
  if (!findings) {
    const hist = await loadScanHistory(WORKSPACE_ROOT);
    findings = hist.find((s) => s.findings && s.findings.length > 0)?.findings;
  }
  if (!findings) return out;
  for (const f of findings) {
    const file = f.evidence[0]?.file;
    if (!file) continue;
    const r = out.get(file) ?? { h: 0, m: 0, l: 0 };
    if (f.severity === 'high') r.h += 1;
    else if (f.severity === 'medium') r.m += 1;
    else r.l += 1;
    out.set(file, r);
  }
  return out;
}

// Static UI (built artifacts) + SPA fallback. Any non-/api/* path that
// doesn't match a static file returns index.html so the client-side
// router can handle it. This lets users deep-link to /findings,
// /finding/<fp>, /scan/<id>, etc. and use the browser back button.
if (existsSync(UI_DIST)) {
  await app.register(import('@fastify/static'), { root: UI_DIST, prefix: '/' });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: HOST });
logger.info({ port: PORT, host: HOST, workspaceRoot: WORKSPACE_ROOT }, 'RotHunter server listening');
