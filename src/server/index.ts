#!/usr/bin/env node
// Fastify HTTP API + SSE scan stream + static UI host.
// Scans + findings persist under <workspace>/.rothunter/ (one JSON file per scan).
import Fastify from 'fastify';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { RotHunter } from '../rothunter.js';
import { createDefaultLlmClient } from '../adapters/llm.js';
import { TypeScriptParser, type ParseResult } from '../parsers/typescript-parser.js';
import { logger } from '../utils/logger.js';
import type { Finding } from '../types.js';
import { DETECTOR_IDS as ALL_DETECTORS } from '../detector-registry.js';
import {
  FS_ALLOW_ROOTS,
  isUnderAllowRoot,
  initWorkspaceStore,
  getWorkspaceRoot,
  setWorkspaceRoot,
  getRecentWorkspaces,
  persistCurrentWorkspace,
  readPersistedWorkspace,
} from './workspace-store.js';
import { readSettings, writeSettings, type AppSettings } from './settings-store.js';
import {
  readFalsePositives,
  writeFalsePositives,
  splitFalsePositives,
  readKeptOpen,
  writeKeptOpen,
} from './false-positives.js';
import { readMarkedToFix, writeMarkedToFix } from './marked-to-fix.js';

const PORT = Number(process.env.ROTHUNTER_PORT ?? 3000);
// Loopback by default — `npm run server` on the host should not expose the
// filesystem-reaching endpoints to the LAN. Docker sets ROTHUNTER_HOST=0.0.0.0
// explicitly when LAN exposure is intended.
const HOST = process.env.ROTHUNTER_HOST ?? '127.0.0.1';

// Boot-time workspace selection. Default `/workspace` matches the Docker
// mount; in dev mode (`npm run rothunter:dev` on the host) `/workspace`
// does not exist, so fall back to the current working directory. The
// active workspace is mutable via POST /api/workspace and persists in
// ~/.rothunter/workspace.json — never inside the workspace itself, since
// changing the workspace would otherwise lose the pointer.
const bootCandidate =
  process.env.ROTHUNTER_WORKSPACE ??
  readPersistedWorkspace()?.current ??
  (existsSync('/workspace') ? '/workspace' : process.cwd());
if (!isUnderAllowRoot(bootCandidate)) {
  // Two failure modes:
  //   1. cwd outside roots — operator probably ran `npm run server` from
  //      somewhere unexpected. Hard-fail with guidance so the workspace
  //      switch endpoint isn't immediately broken too.
  //   2. persisted/env workspace outside roots — same fix, same exit.
  logger.error(
    { candidate: bootCandidate, allowRoots: FS_ALLOW_ROOTS },
    'Boot workspace outside ROTHUNTER_FS_ROOTS. Set ROTHUNTER_FS_ROOTS or run from inside one of the allow-roots.',
  );
  process.exit(1);
}
initWorkspaceStore(bootCandidate);

const SETTINGS: AppSettings = readSettings();

/**
 * Resolve the UI bundle location, supporting layouts:
 *   - npm-installed: `dist/server/index.js` → `../ui` (vite emits there
 *     when `--outDir ../../dist/ui` is set at build time).
 *   - dev / clone-and-run: `dist/server/index.js` → `../../src/ui/dist`
 *   - docker image (tsx watch on source): `src/server/index.ts` →
 *     `../ui/dist`.
 *
 * Crucially this does NOT accept a directory just because it exists —
 * the SOURCE `src/ui/` directory always exists when running from source
 * and would otherwise match the npm-installed candidate, serving the
 * un-bundled `index.html` (with `<script src="/src/main.tsx">`) that
 * the browser can't resolve. Reported by users running the docker
 * image. Each candidate has to pass `isBuiltUiDir` — `index.html`
 * present AND an adjacent `assets/` directory, which only the Vite
 * output has.
 *
 * `ROTHUNTER_UI_DIST` env override skips the search entirely.
 */
const UI_DIST = (() => {
  const override = process.env.ROTHUNTER_UI_DIST;
  if (override && isBuiltUiDir(override)) return override;
  const here = import.meta.dirname;
  const candidates = [
    path.resolve(here, '../ui'),             // npm-installed (dist/ui)
    path.resolve(here, '../../src/ui/dist'), // dev / clone-and-run
    path.resolve(here, '../ui/dist'),        // docker tsx-from-source
  ];
  for (const c of candidates) {
    if (isBuiltUiDir(c)) return c;
  }
  return candidates[0]!;
})();

function isBuiltUiDir(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html')) && existsSync(path.join(dir, 'assets'));
}

import {
  scans,
  sseClients,
  cancelledScans,
  scanHistoryCache,
  SCAN_QUEUE_LIMIT,
  evictOldScans,
  acquireScanSlot,
  releaseScanSlot,
  dropQueuedScan,
  broadcast,
  applyProgressToRecord,
  persistScan,
  loadScanHistory,
  getRunningScanId,
  getScanQueueLength,
  summarizeLlmStats,
  type ScanRecord,
  type ScanSseEvent,
} from './scan-store.js';

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
  const result = await parser.parseWorkspaceFull({ workspaceRoot: getWorkspaceRoot() });
  parseCache = { parsedAt: Date.now(), result };
  return result;
}

function invalidateParseCache(): void {
  parseCache = null;
}

// Per-scan abort controllers. Populated when a scan promotes to running,
// flipped by the cancel endpoint, removed on scan completion. Replaces
// the old "throw inside onProgress" cancellation channel (which emit()
// swallowed, so cancels were ignored by the LLM worker pool).
const abortControllers = new Map<string, AbortController>();

async function startScan(opts: {
  workspaceRoot: string;
  detectorsAllow?: string[];
  detectorsDeny?: string[];
  minConfidence?: number;
  llmConcurrency?: number;
  llmAutoFpThreshold?: number;
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
  evictOldScans();
  broadcast(scanId, { scanId, ts: Date.now(), state: 'queued' });

  // Fire and forget — the SSE channel relays state changes.
  void (async () => {
    try {
      await acquireScanSlot(scanId);
    } catch {
      // Queue entry was dropped (cancel while queued). Record is already
      // marked errored by the cancel handler; nothing else to do.
      return;
    }
    // Cancellation that fired while we were queued — release the slot
    // and skip the parse. The record is already marked errored.
    if (cancelledScans.has(scanId) || record.state === 'error') {
      releaseScanSlot();
      return;
    }
    invalidateParseCache(); // fresh scan = fresh parse
    // Cooperative abort signal — wired through `RotHunter.run` so the
    // LLM worker pool tears itself down promptly on cancel. The old
    // implementation tried to throw inside onProgress, but emit()'s
    // catch swallowed the throw and the workers kept running.
    const abortController = new AbortController();
    if (cancelledScans.has(scanId)) abortController.abort();
    abortControllers.set(scanId, abortController);
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({
        workspaceRoot: opts.workspaceRoot,
        detectorsAllow: opts.detectorsAllow ? new Set(opts.detectorsAllow) : undefined,
        detectorsDeny: opts.detectorsDeny ? new Set(opts.detectorsDeny) : undefined,
        llmConcurrency: opts.llmConcurrency,
        llmAutoFpThreshold: opts.llmAutoFpThreshold,
        abortSignal: abortController.signal,
        onProgress: (event) => {
          const sse = applyProgressToRecord(record, event);
          broadcast(scanId, sse);
        },
      });
      record.state = 'done';
      record.finishedAt = Date.now();
      const fpSet = readFalsePositives(opts.workspaceRoot);
      const keptOpenSet = readKeptOpen(opts.workspaceRoot);
      const split = splitFalsePositives(result.findings, fpSet, keptOpenSet);
      record.findings = split.findings;
      record.falsePositives = split.falsePositives;
      record.symbolsCount = result.symbols.length;
      record.llmStats = summarizeLlmStats(record.verdictLog);
      await persistScan(record);
    } catch (err) {
      record.state = 'error';
      record.error = (err as Error).message;
      record.finishedAt = Date.now();
      broadcast(scanId, { scanId, ts: Date.now(), state: 'error', error: record.error });
      logger.error({ scanId, err }, 'RotHunter scan failed');
    } finally {
      releaseScanSlot();
      abortControllers.delete(scanId);
      // Drain SSE client set for this scan — listeners auto-prune on close
      // (line ~895) but the outer Map entry survives. Force the cleanup so
      // long-running servers don't accumulate empty Sets keyed by completed
      // scanIds. The disconnect close handler still no-ops if the entry is
      // gone (Set.delete on a removed Set just throws nothing visible).
      const clients = sseClients.get(scanId);
      if (clients) {
        for (const res of clients) {
          try {
            res.end();
          } catch {
            // socket may already be torn down
          }
        }
        sseClients.delete(scanId);
      }
    }
  })();

  return scanId;
}

const app = Fastify({ logger: false });

app.get('/api/health', async () => ({
  ok: true,
  version: '0.1.0',
  workspaceRoot: getWorkspaceRoot(),
  llm: process.env.ROTHUNTER_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
}));

// GET /api/fs/list?path — directory listing for the folder picker.
// Defaults to $HOME. Files included for context; only dirs navigable.
app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req, reply) => {
  const target = path.resolve(req.query.path?.trim() || os.homedir());
  if (!isUnderAllowRoot(target)) {
    return reply.code(403).send({ error: 'path outside allowed roots' });
  }
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
  if (!existsSync(getWorkspaceRoot())) {
    return { workspaces: [] };
  }
  const stat = statSync(getWorkspaceRoot());
  // Single workspace mount (the common Docker case).
  if (!stat.isDirectory()) return { workspaces: [] };
  return {
    workspaces: [
      {
        path: getWorkspaceRoot(),
        name: path.basename(getWorkspaceRoot()),
      },
    ],
  };
});

/**
 * GET /api/workspace — current workspace + recent list. The UI's folder
 * picker reads this on mount.
 */
app.get('/api/workspace', async () => ({
  current: getWorkspaceRoot(),
  name: path.basename(getWorkspaceRoot()),
  recent: getRecentWorkspaces(),
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
  if (!isUnderAllowRoot(target)) {
    return reply.code(403).send({ error: 'workspace outside allowed roots' });
  }
  if (!existsSync(target)) return reply.code(404).send({ error: 'path does not exist' });
  if (!statSync(target).isDirectory()) return reply.code(400).send({ error: 'not a directory' });
  setWorkspaceRoot(target);
  invalidateParseCache();
  scanHistoryCache.delete(target);
  await persistCurrentWorkspace();
  logger.info({ workspaceRoot: target }, 'Workspace switched');
  return { current: target, recent: getRecentWorkspaces() };
});

app.post<{ Body: { detectors?: string[]; minConfidence?: number } }>('/api/scans', async (req, reply) => {
  const queued = getScanQueueLength() + (getRunningScanId() ? 1 : 0);
  if (queued >= SCAN_QUEUE_LIMIT) {
    return reply
      .code(429)
      .send({ error: `scan queue full (${queued}/${SCAN_QUEUE_LIMIT}); wait for the current scan to finish` });
  }
  const body = req.body ?? {};
  // When the caller doesn't pin detectors, derive the allow-list from
  // persisted settings — only the ones the operator left toggled ON run.
  const allowFromSettings = ALL_DETECTORS.filter((id) => SETTINGS.detectors[id] !== false);
  const scanId = await startScan({
    workspaceRoot: getWorkspaceRoot(),
    detectorsAllow: body.detectors ?? allowFromSettings,
    minConfidence: body.minConfidence ?? SETTINGS.minConfidence,
    llmConcurrency: SETTINGS.llmConcurrency,
    llmAutoFpThreshold: SETTINGS.llmAutoFpThreshold,
  });
  return { scanId, queuePosition: getScanQueueLength() };
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
 *
 * Roadmap entries live in private/ROADMAP.md — don't list unshipped
 * detectors here unless they are imminent. Surfacing speculative items
 * on the dashboard becomes a public promise.
 */
const COMING_SOON_DETECTORS: Array<{ id: string; blurb: string }> = [];

function settingsPayload() {
  return {
    detectors: SETTINGS.detectors,
    minConfidence: SETTINGS.minConfidence,
    llmConcurrency: SETTINGS.llmConcurrency,
    llmAutoFpThreshold: SETTINGS.llmAutoFpThreshold,
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
  Body: {
    detectors?: Record<string, boolean>;
    minConfidence?: number;
    llmConcurrency?: number;
    llmAutoFpThreshold?: number;
  };
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
  if (body.llmAutoFpThreshold != null) {
    if (
      typeof body.llmAutoFpThreshold !== 'number' ||
      body.llmAutoFpThreshold < 0 ||
      body.llmAutoFpThreshold > 1
    ) {
      return reply.code(400).send({ error: 'llmAutoFpThreshold must be in [0, 1]' });
    }
    SETTINGS.llmAutoFpThreshold = body.llmAutoFpThreshold;
  }
  if (body.detectors) {
    for (const [id, on] of Object.entries(body.detectors)) {
      if ((ALL_DETECTORS as readonly string[]).includes(id)) {
        SETTINGS.detectors[id] = !!on;
      }
    }
  }
  try {
    await writeSettings(SETTINGS);
  } catch (err) {
    logger.warn({ err }, 'Failed to persist settings');
  }
  // Return the full payload (matching GET) so the UI can replace state
  // without losing `allDetectors` / `comingSoon` / `hardware` / `llm`.
  return settingsPayload();
});

// POST /api/findings/:fp/prompt — copy-paste prompt for an agent (Claude
// Code / Cursor / Copilot Chat) to fix the finding via the LLM.
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
    const hist = await loadScanHistory(getWorkspaceRoot());
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
    .map(
      (e, i) =>
        `Evidence ${i + 1} — \`${e.file}:${e.range.startLine}-${e.range.endLine}\`\n\`\`\`\n${e.snippet}\n\`\`\``,
    )
    .join('\n\n');
  const filesToInspect = Array.from(new Set(finding.evidence.map((e) => e.file)));
  const filesBlock = filesToInspect.map((f) => `- \`${f}\``).join('\n');

  const system = `You are a senior TypeScript engineer drafting a prompt for ANOTHER coding agent (Claude Code, Codex, Cursor, Copilot Chat) to fix a static-analysis finding. The user will copy-paste your output verbatim into that agent. Your output must therefore be a SELF-CONTAINED instruction set, not a description.

Hard rules for the prompt you produce:

1. Open with a one-sentence statement of the defect (severity + detector).
2. Include a "## Files to inspect" section listing every file path verbatim as a backtick-quoted bullet list — the agent must open every one before proposing changes.
3. Include a "## Evidence" section with each \`file:lineStart-lineEnd\` location followed by the code snippet in a fenced code block. Preserve line numbers exactly.
4. Include a "## Required behaviour" section that summarises what the code SHOULD do after the fix, derived from the description + suggestion.
5. Include a "## Constraints" section that explicitly forbids workarounds. Use these literal bullets (adapt wording only if a constraint genuinely doesn't apply):
   - Fix the ROOT CAUSE — no try/catch swallowing, no \`@ts-ignore\` / \`any\` casts, no commented-out code.
   - Do NOT add backwards-compatibility shims, feature flags, or "TODO later" stubs.
   - Do NOT widen types, suppress lint rules, or skip tests to make the error go away.
   - Keep the change MINIMAL — touch only what the defect requires.
   - Match existing project conventions (imports, formatting, error handling).
   - Add or update unit tests when the file already has a sibling test; otherwise note why tests are not added.
6. Include a "## Suppression — if AND ONLY IF this is intentional" section. The default path is to FIX the finding. When the agent is CONFIDENT the finding is intentional design (framework idiom, deliberate pattern, detector heuristic false positive) AND not a real defect, the agent has two options:

   (a) **Add a rothunter pragma directly in source** — preferred when the suppression should live with the code (signals intent to future readers + survives every rescan). Place TWO lines IMMEDIATELY above the flagged line:

   \`\`\`
   // rothunter:ignore-<detectorId>
   // reason: <one short sentence explaining why this is intentional>
   \`\`\`

   Both lines required. Replace \`<detectorId>\` with the literal detector id from the finding (e.g. \`silent-catch\`, \`mutation\`, \`race-condition\`, \`magic-numbers\`, \`console-log-prod\`, \`mutable-globals\`, \`dead-export\`, \`long-function\`).

   (b) **STOP and ask the operator to confirm**, including a one-paragraph rationale. The operator can then click "Mark false positive" in the dashboard if they agree — rothunter persists that decision so the finding stops surfacing on future scans.

   NEVER use either path to silence a real bug. The pragma is permanent; the dashboard mark is shared with the team. When in doubt, prefer (b).

7. End with: "Apply the fix directly to the files listed above. If the right fix would require a larger refactor than the constraints allow, STOP and explain in plain text instead of editing — do not patch around the constraints."

Output ONLY the prompt body. No preamble. No markdown fence around the whole thing. Use Markdown section headings inside the body.`;

  const user = `Detector: ${finding.detectorId}
Severity: ${finding.severity}
Title: ${finding.title}

Description:
${finding.description}

Suggested direction from RotHunter:
${finding.suggestion ?? '(none)'}

Files to inspect (must appear verbatim in the "## Files to inspect" section of the output):
${filesBlock}

Code evidence (must appear verbatim in the "## Evidence" section of the output):
${evidenceBlock}

Generate the prompt now.`;

  const llm = createDefaultLlmClient();
  try {
    const prompt = await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, maxTokens: 1400, timeoutMs: 120_000 },
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

/**
 * POST /api/findings/:fp/rerun — re-run the originating detector on the
 * subset of files referenced by the finding, then re-run the LLM
 * confirmer if the finding survives the deterministic pass. Returns:
 *
 *   - { status: 'resolved' }                  — detector no longer
 *     reports the issue when re-run on the evidence files alone.
 *   - { status: 'still-present', finding }    — issue still detected;
 *     `finding` is the refreshed object (new confidence / severity /
 *     verdict after the LLM pass).
 *
 * Cross-file detectors (duplicate-type, dead-export, dead-api,
 * dead-module, similar-functions, unused-deps,
 * hot-hub-file, todo-comments) are technically less accurate when run
 * on a subset — they rely on whole-workspace state to declare a symbol
 * unused, a type a duplicate, an import unreferenced, etc. The endpoint
 * still runs them on the evidence subset and reports the result as the
 * operator's intent: "did MY change fix MY finding?". The persisted
 * scan record is updated either way so History / Findings views
 * reflect the resolution without a manual rescan.
 */
app.post<{ Params: { fp: string } }>('/api/findings/:fp/rerun', async (req, reply) => {
  const fp = decodeURIComponent(req.params.fp);

  // Locate the originating scan + finding. Walk live scans first (most
  // common case: user just finished a scan, clicked into the finding,
  // pasted the fix prompt into Claude Code, came back). Fall back to
  // disk history if not in memory.
  let owningScan: ScanRecord | undefined;
  let finding: Finding | undefined;
  for (const s of scans.values()) {
    if (s.state !== 'done' || !s.findings) continue;
    const hit = s.findings.find((f) => f.fingerprint === fp);
    if (hit) {
      owningScan = s;
      finding = hit;
      break;
    }
  }
  if (!finding) {
    const hist = await loadScanHistory(getWorkspaceRoot());
    for (const s of hist) {
      const hit = s.findings?.find((f) => f.fingerprint === fp);
      if (hit) {
        owningScan = s;
        finding = hit;
        break;
      }
    }
  }
  if (!finding || !owningScan) return reply.code(404).send({ error: 'finding not found' });

  const filesFromEvidence = Array.from(new Set(finding.evidence.map((e) => e.file)));
  if (filesFromEvidence.length === 0) {
    return reply.code(422).send({ status: 'unsupported', reason: 'finding has no file evidence to re-check' });
  }

  // Multi-workspace findings carry workspace-prefixed paths
  // (e.g. `service-a/src/foo.ts`) that the single-workspace parser
  // would interpret as literal paths under the monorepo root and
  // fail to find. Detect the prefix shape and refuse — the rerun
  // path doesn't support cross-workspace findings yet, but at
  // least we surface a clear error instead of an incorrect
  // "resolved" verdict.
  const looksMultiWorkspace = filesFromEvidence.some((f) => {
    const head = f.split('/')[0] ?? '';
    if (!head) return false;
    const candidate = path.join(owningScan!.workspaceRoot, head);
    return !existsSync(candidate);
  });
  if (looksMultiWorkspace) {
    return reply.code(422).send({
      status: 'unsupported',
      reason: 'single-finding rerun does not support multi-workspace findings yet — kick off a full scan to refresh this finding',
    });
  }

  // Re-run just this detector against just the evidence files.
  const rothunter = new RotHunter();
  let result;
  try {
    result = await rothunter.run({
      workspaceRoot: owningScan.workspaceRoot,
      files: filesFromEvidence,
      detectorsAllow: new Set([finding.detectorId]),
      llmConcurrency: SETTINGS.llmConcurrency,
    });
  } catch (err) {
    return reply.code(502).send({ status: 'error', error: (err as Error).message });
  }

  const refreshed = result.findings.find((f) => f.fingerprint === fp);

  if (!refreshed) {
    // Finding gone — flip the persisted record to resolved instead of
    // deleting it. Operators want a paper trail: which findings did we
    // fix, when, in which scan? Deleting the entry hides that history
    // and breaks the "show resolved" filter in the Findings page.
    const now = Date.now();
    if (owningScan.findings) {
      owningScan.findings = owningScan.findings.map((f) =>
        f.fingerprint === fp ? { ...f, resolvedAt: now } : f,
      );
    }
    try {
      await persistScan(owningScan);
    } catch (err) {
      logger.warn({ err, scanId: owningScan.scanId }, 'rerun: failed to persist resolved finding');
    }
    return { status: 'resolved' as const, resolvedAt: now };
  }

  // Still present — update in-place. Same fingerprint, possibly new
  // confidence / severity / description from the re-issued LLM verdict.
  if (owningScan.findings) {
    owningScan.findings = owningScan.findings.map((f) => (f.fingerprint === fp ? refreshed : f));
  }
  try {
    await persistScan(owningScan);
  } catch (err) {
    logger.warn({ err, scanId: owningScan.scanId }, 'rerun: failed to persist refreshed finding');
  }
  return { status: 'still-present' as const, finding: refreshed };
});

app.get('/api/scans', async () => {
  const ws = getWorkspaceRoot();
  const history = await loadScanHistory(ws);
  // Live scans (still in-memory) merged in front. Filter to the active
  // workspace — without this, scans launched against a different
  // workspace bleed into the current listing after a switch and
  // confuse the dashboard / live banner.
  const live = [...scans.values()].filter(
    (s) => s.workspaceRoot === ws && s.state !== 'done' && s.state !== 'error',
  );
  // Disk-loaded history is partitioned at scan-completion time. Re-apply
  // the current FP + kept-open overrides so unmark FP clicks made AFTER
  // a scan stay visible across page reloads.
  const repartitionedHistory = history.slice(0, 50).map((s) => repartitionScanRecord(s, ws));
  return { scans: [...live, ...repartitionedHistory] };
});

app.get<{ Params: { scanId: string } }>('/api/scans/:scanId', async (req, reply) => {
  if (!SCAN_ID_RE.test(req.params.scanId)) {
    return reply.code(400).send({ error: 'invalid scan id' });
  }
  const ws = getWorkspaceRoot();
  const live = scans.get(req.params.scanId);
  // Workspace-scope the lookup. The in-memory `scans` Map is global,
  // so without this guard a scan started against workspace A would
  // still be reachable by id from workspace B (the picker reload
  // doesn't kill the server-side state). The disk path is already
  // scoped because `dir` is built from getWorkspaceRoot().
  if (live && live.workspaceRoot === ws) return live;
  const dir = path.join(ws, '.rothunter', 'scans');
  const file = path.join(dir, `${req.params.scanId}.json`);
  if (!existsSync(file)) {
    return reply.code(404).send({ error: 'scan not found' });
  }
  const record = JSON.parse(await fs.readFile(file, 'utf-8')) as ScanRecord;
  // Re-apply the partition against the CURRENT FP + kept-open stores.
  // The persisted JSON only reflects the split at scan-completion time;
  // mark / unmark FP after the fact must be visible on a page reload
  // even though the disk copy is stale. The persisted file stays
  // immutable — repartition is a read-time concern.
  return repartitionScanRecord(record, ws);
});

/**
 * Apply the workspace's current FP + kept-open overrides to a scan
 * record loaded from disk. Pure — never writes back, so the operator's
 * "snapshot at scan time" record stays auditable while the displayed
 * partition follows the latest user / LLM decisions.
 */
function repartitionScanRecord(record: ScanRecord, ws: string): ScanRecord {
  if (!record.findings && !record.falsePositives) return record;
  const fpSet = readFalsePositives(ws);
  const keptOpen = readKeptOpen(ws);
  const all = [...(record.findings ?? []), ...(record.falsePositives ?? [])];
  const split = splitFalsePositives(all, fpSet, keptOpen);
  return { ...record, findings: split.findings, falsePositives: split.falsePositives };
}

/**
 * GET /api/scans/:scanId/llm-stats — aggregate LLM telemetry.
 *
 * Computed once at scan-finish and persisted on `ScanRecord.llmStats`.
 * For historical scans (persisted before this endpoint shipped), the
 * stats are recomputed on the fly from `verdictLog` so the History view
 * shows numbers without a manual migration. Mid-flight scans return
 * stats for the verdicts seen so far — useful to spot a wedged backend
 * (p95 climbing scan-over-scan).
 */
app.get<{ Params: { scanId: string } }>('/api/scans/:scanId/llm-stats', async (req, reply) => {
  if (!SCAN_ID_RE.test(req.params.scanId)) {
    return reply.code(400).send({ error: 'invalid scan id' });
  }
  let record = scans.get(req.params.scanId);
  if (!record) {
    const file = path.join(getWorkspaceRoot(), '.rothunter', 'scans', `${req.params.scanId}.json`);
    if (!existsSync(file)) return reply.code(404).send({ error: 'scan not found' });
    try {
      record = JSON.parse(await fs.readFile(file, 'utf-8')) as ScanRecord;
    } catch {
      return reply.code(500).send({ error: 'scan record unreadable' });
    }
  }
  const stats = record.llmStats ?? summarizeLlmStats(record.verdictLog ?? []);
  return { scanId: record.scanId, state: record.state, stats };
});

// GET /api/scans/:scanId/diff?vs=<id> — { base, added, removed, persisting }
// by fingerprint equality. `vs` defaults to previous scan with findings.
app.get<{ Params: { scanId: string }; Querystring: { vs?: string } }>(
  '/api/scans/:scanId/diff',
  async (req, reply) => {
    if (!SCAN_ID_RE.test(req.params.scanId)) {
      return reply.code(400).send({ error: 'invalid scan id' });
    }
    if (req.query.vs && !SCAN_ID_RE.test(req.query.vs)) {
      return reply.code(400).send({ error: 'invalid vs scan id' });
    }
    const live = scans.get(req.params.scanId);
    let current: ScanRecord | undefined = live;
    if (!current) {
      const dir = path.join(getWorkspaceRoot(), '.rothunter', 'scans');
      const file = path.join(dir, `${req.params.scanId}.json`);
      if (existsSync(file)) current = JSON.parse(await fs.readFile(file, 'utf-8')) as ScanRecord;
    }
    if (!current) return reply.code(404).send({ error: 'scan not found' });
    if (!current.findings) return reply.code(409).send({ error: 'scan still in flight' });

    const history = await loadScanHistory(getWorkspaceRoot());
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
  if (!SCAN_ID_RE.test(scanId)) {
    return reply.code(400).send({ error: 'invalid scan id' });
  }
  // Refuse to stream a scan that belongs to a different workspace.
  // Without this the LiveScanBanner on workspace B could subscribe to
  // a scan still running against workspace A (the scanId is reachable
  // from anywhere) and the operator would see ghost progress events.
  const ws = getWorkspaceRoot();
  const current = scans.get(scanId);
  if (current && current.workspaceRoot !== ws) {
    return reply.code(404).send({ error: 'scan belongs to a different workspace' });
  }
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const set = sseClients.get(scanId) ?? new Set();
  set.add(reply.raw);
  sseClients.set(scanId, set);
  // Replay accumulated scan state so a late subscriber (reload mid-scan)
  // sees the full pipeline without having to query the snapshot endpoint
  // separately. We replay:
  //   1. A synthetic parsing event carrying files/symbols counts.
  //   2. One detecting event per completed detector, then the active one.
  //   3. A snapshot of LLM progress (done / total).
  //   4. The verdict log so the verdict-stream panel repopulates.
  //   5. The latest progress event (state machine).
  if (current) {
    if (current.filesCount != null || current.symbolsCount != null) {
      reply.raw.write(
        `data: ${JSON.stringify({
          scanId,
          ts: Date.now(),
          state: 'parsing',
          files: current.filesCount,
          symbols: current.symbolsCount,
        })}\n\n`,
      );
    }
    for (const det of current.doneDetectors ?? []) {
      reply.raw.write(
        `data: ${JSON.stringify({ scanId, ts: Date.now(), state: 'detecting', detector: det })}\n\n`,
      );
    }
    if (current.activeDetector) {
      reply.raw.write(
        `data: ${JSON.stringify({
          scanId,
          ts: Date.now(),
          state: 'detecting',
          detector: current.activeDetector,
        })}\n\n`,
      );
    }
    if (current.llmTotal != null) {
      reply.raw.write(
        `data: ${JSON.stringify({
          scanId,
          ts: Date.now(),
          state: 'llm-start',
          llmTotal: current.llmTotal,
        })}\n\n`,
      );
    }
    for (const v of current.verdictLog) {
      const replay: ScanSseEvent = {
        scanId,
        ts: Date.now(),
        state: 'llm-verdict',
        verdict: v,
      };
      reply.raw.write(`data: ${JSON.stringify(replay)}\n\n`);
    }
    // Final state snapshot last so the UI's state machine lands on the
    // current phase after consuming all the historical events above.
    const snapshot: ScanSseEvent = current.progress ?? { scanId, ts: Date.now(), state: current.state };
    reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  req.raw.on('close', () => {
    set.delete(reply.raw);
  });
});

// GET /api/scans/series?window=30d — time series for the History page.
// Sourced from <workspace>/.rothunter/scans/*.json, newest first.
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
  /** LLM verdicts emitted in this scan, when persisted. */
  llmCalls: number | null;
  /** Median LLM verdict latency, ms. Null on pre-llmStats scans. */
  llmP50Ms: number | null;
  /** 95th-percentile LLM verdict latency, ms. Null on pre-llmStats scans. */
  llmP95Ms: number | null;
}

app.get<{ Querystring: { window?: string } }>('/api/scans/series', async (req) => {
  const win = req.query.window ?? '30d';
  const days = /^(\d+)d$/.test(win) ? Number(win.slice(0, -1)) : 30;
  const cutoff = Date.now() - days * 86400_000;

  const history = await loadScanHistory(getWorkspaceRoot());
  const entries: ScanSeriesEntry[] = history
    .filter((s) => s.startedAt >= cutoff)
    .map((s) => {
      const counts = { high: 0, med: 0, low: 0 };
      for (const f of s.findings ?? []) {
        if (f.severity === 'high') counts.high += 1;
        else if (f.severity === 'medium') counts.med += 1;
        else counts.low += 1;
      }
      // Prefer persisted llmStats; fall back to a lazy recompute from
      // verdictLog so old scans (persisted before llmStats shipped) still
      // surface latency in the History view.
      const stats = s.llmStats ?? (s.verdictLog?.length ? summarizeLlmStats(s.verdictLog) : null);
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
        llmCalls: stats?.calls ?? null,
        llmP50Ms: stats?.p50LatencyMs ?? null,
        llmP95Ms: stats?.p95LatencyMs ?? null,
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
  // Average verdict latency across the window — only counts scans that
  // emitted at least one verdict so empty fast scans don't pull the mean
  // toward zero.
  const withLlm = entries.filter((e) => e.llmP50Ms != null && e.llmCalls && e.llmCalls > 0);
  const avgVerdictMs =
    withLlm.length === 0
      ? null
      : Math.round(withLlm.reduce((s, e) => s + (e.llmP50Ms ?? 0), 0) / withLlm.length);
  const avgP95Ms =
    withLlm.length === 0
      ? null
      : Math.round(withLlm.reduce((s, e) => s + (e.llmP95Ms ?? 0), 0) / withLlm.length);
  return {
    window: win,
    entries,
    summary: {
      count: entries.length,
      currentHigh: current,
      change30d: change,
      avgDurationMs: avgDuration,
      avgVerdictMs,
      avgP95Ms,
    },
  };
});

app.post<{ Params: { scanId: string } }>('/api/scans/:scanId/cancel', async (req, reply) => {
  const { scanId } = req.params;
  if (!SCAN_ID_RE.test(scanId)) {
    return reply.code(400).send({ error: 'invalid scan id' });
  }
  const record = scans.get(scanId);
  if (!record) return reply.code(404).send({ error: 'scan not found' });
  if (record.state === 'done' || record.state === 'error') {
    return { ok: true, already: record.state };
  }
  cancelledScans.add(scanId);
  // Fire the abort signal — the LLM worker pool inside RotHunter checks
  // it between verdicts and bails out, freeing the scan slot promptly
  // so the queued next scan can run.
  abortControllers.get(scanId)?.abort();
  record.state = 'error';
  record.error = 'cancelled by user';
  record.finishedAt = Date.now();
  broadcast(scanId, { scanId, ts: Date.now(), state: 'error', error: 'cancelled by user' });
  // If still queued, drop the starter so the slot promotes immediately.
  // (The acquireScanSlot promise inside the scan flow stays pending; the
  // outer flow short-circuits on the cancel flag before it ever runs.)
  dropQueuedScan(scanId);
  return { ok: true };
});

/**
 * DELETE /api/scans/:scanId — remove a finished scan's persisted record
 * + drop it from the in-memory cache. Refuses to delete a live scan;
 * cancel it first. Leaves `.rothunterignore` untouched.
 */
app.delete<{ Params: { scanId: string } }>('/api/scans/:scanId', async (req, reply) => {
  const { scanId } = req.params;
  // Strict allow-list for the scan id shape (`scan_<base36-ts>_<rand>`).
  // `req.params.scanId` lands directly in a `path.join` below — without
  // validation a request like `../../../etc/passwd` would unlink an
  // arbitrary file the process can write.
  if (!SCAN_ID_RE.test(scanId)) {
    return reply.code(400).send({ error: 'invalid scan id' });
  }
  const live = scans.get(scanId);
  if (live && live.state !== 'done' && live.state !== 'error') {
    return reply.code(409).send({ error: 'scan still running — cancel first' });
  }
  scans.delete(scanId);
  sseClients.delete(scanId);
  const file = path.join(getWorkspaceRoot(), '.rothunter', 'scans', `${scanId}.json`);
  if (existsSync(file)) {
    await fs.unlink(file);
  }
  scanHistoryCache.delete(getWorkspaceRoot());
  return { ok: true };
});

/**
 * Stable scan-id shape emitted by `startScan`: `scan_<base36-ts>_<rand>`.
 * Used as a strict allow-list anywhere `req.params.scanId` reaches the
 * filesystem, to keep path traversal off the table.
 */
const SCAN_ID_RE = /^scan_[a-z0-9]+_[a-z0-9]+$/i;

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
  // Mark FP: add to FP store AND remove from kept-open store (user is
  // now saying "yes, this IS an FP" — overrides any prior un-FP they
  // may have set).
  await mutateKeptOpen((s) => s.delete(fp));
  return mutateFalsePositives((s) => s.add(fp));
});

app.delete<{ Params: { fp: string } }>('/api/findings/:fp/false-positive', async (req) => {
  const fp = decodeURIComponent(req.params.fp);
  // Unmark FP: remove from FP store AND record the explicit "keep open"
  // override so the LLM auto-FP path (per-scan) cannot route this back
  // into the FP bucket. Without the second step a user-unmarked finding
  // bounces straight back to FP on the next scan when the LLM re-runs.
  await mutateFalsePositives((s) => s.delete(fp));
  return mutateKeptOpen((s) => s.add(fp));
});

/**
 * Batch mark / unmark as false-positive. Same shape + same race
 * mitigation as `/api/marked-to-fix/batch` — N parallel POSTs would
 * stomp each other's JSON file write; one batched request + one
 * critical section keeps the store consistent.
 *
 * Add ⇒ FP store gets the fingerprint, kept-open store loses it.
 * Remove ⇒ FP store loses the fingerprint, kept-open store gets it.
 * That two-store dance is what makes the UI's Unmark button stick.
 */
app.post<{ Body: { add?: string[]; remove?: string[] } }>('/api/false-positives/batch', async (req) => {
  const body = req.body ?? {};
  const add = body.add ?? [];
  const remove = body.remove ?? [];
  await mutateKeptOpen((s) => {
    for (const fp of add) s.delete(fp);
    for (const fp of remove) s.add(fp);
  });
  return mutateFalsePositives((s) => {
    for (const fp of add) s.add(fp);
    for (const fp of remove) s.delete(fp);
  });
});

app.get('/api/false-positives', async () => {
  const set = readFalsePositives(getWorkspaceRoot());
  return { fingerprints: [...set].sort() };
});

/**
 * Serialise read-modify-write on the false-positive store. The
 * promise chain queues every incoming request behind the previous —
 * Node is single-threaded so the chain itself is race-free; the queue
 * just prevents one request's read from interleaving with another
 * request's write. Mirrors `mutateMarkedToFix`.
 *
 * The retroactive in-memory split keeps every running scan record
 * partitioned correctly so the Findings UI updates without a rescan.
 */
let falsePositiveMutation: Promise<unknown> = Promise.resolve();
async function mutateFalsePositives(
  mutate: (s: Set<string>) => void,
): Promise<{ ok: true; count: number }> {
  const next = falsePositiveMutation.then(async () => {
    const ws = getWorkspaceRoot();
    const set = readFalsePositives(ws);
    mutate(set);
    await writeFalsePositives(ws, set);
    await reapplySplitToScans(ws);
    return { ok: true as const, count: set.size };
  });
  falsePositiveMutation = next.catch(() => undefined);
  return next;
}

/**
 * Mirror of `mutateFalsePositives` for the kept-open override store.
 * Same serialisation pattern + same retroactive split so the UI sees
 * the unmark immediately on every in-memory scan record.
 */
let keptOpenMutation: Promise<unknown> = Promise.resolve();
async function mutateKeptOpen(
  mutate: (s: Set<string>) => void,
): Promise<{ ok: true; count: number }> {
  const next = keptOpenMutation.then(async () => {
    const ws = getWorkspaceRoot();
    const set = readKeptOpen(ws);
    mutate(set);
    await writeKeptOpen(ws, set);
    await reapplySplitToScans(ws);
    return { ok: true as const, count: set.size };
  });
  keptOpenMutation = next.catch(() => undefined);
  return next;
}

/**
 * Re-split every in-memory scan against the CURRENT FP + kept-open
 * stores. Called by both mutators so a single click triggers exactly
 * one re-partition — the two mutators chain through their own queues
 * but converge on this helper.
 */
async function reapplySplitToScans(ws: string): Promise<void> {
  const fpSet = readFalsePositives(ws);
  const keptOpen = readKeptOpen(ws);
  for (const s of scans.values()) {
    if (!s.findings && !s.falsePositives) continue;
    const all = [...(s.findings ?? []), ...(s.falsePositives ?? [])];
    const split = splitFalsePositives(all, fpSet, keptOpen);
    s.findings = split.findings;
    s.falsePositives = split.falsePositives;
  }
}

/**
 * Marked-to-fix queue. Operator picks findings from the detail page;
 * the dashboard can then ask the LLM to compose a single combined
 * prompt for the whole queue — useful for fixing a batch in one
 * paste into Claude Code / Cursor instead of repeating the
 * generate-prompt flow per finding.
 *
 * POST   /api/findings/:fp/mark-to-fix    — add fingerprint
 * DELETE /api/findings/:fp/mark-to-fix    — remove fingerprint
 * GET    /api/marked-to-fix               — list fingerprints + matching findings
 * POST   /api/marked-to-fix/prompt        — deterministically-built combined prompt
 */
app.post<{ Params: { fp: string } }>('/api/findings/:fp/mark-to-fix', async (req) => {
  const fp = decodeURIComponent(req.params.fp);
  return mutateMarkedToFix((s) => s.add(fp));
});

app.delete<{ Params: { fp: string } }>('/api/findings/:fp/mark-to-fix', async (req) => {
  const fp = decodeURIComponent(req.params.fp);
  return mutateMarkedToFix((s) => s.delete(fp));
});

/**
 * Batch mark / unmark. Bulk-select on the Findings page previously
 * fired N parallel POSTs, each doing a read-modify-write on the same
 * JSON file. Concurrent writes raced + only the last write survived
 * (operator marked 88 findings, file ended with 11). This endpoint
 * mutates the set in one critical section.
 */
app.post<{ Body: { add?: string[]; remove?: string[] } }>('/api/marked-to-fix/batch', async (req) => {
  const body = req.body ?? {};
  return mutateMarkedToFix((s) => {
    for (const fp of body.add ?? []) s.add(fp);
    for (const fp of body.remove ?? []) s.delete(fp);
  });
});

// Serialise read-modify-write on the marked-to-fix store. The
// `mutationQueue` chains every incoming request behind the previous
// one — Node is single-threaded so the chain itself is race-free; the
// queue just keeps an in-flight write from being interleaved with the
// next request's read.
let markedToFixMutation: Promise<unknown> = Promise.resolve();
async function mutateMarkedToFix(
  mutate: (s: Set<string>) => void,
): Promise<{ ok: true; count: number }> {
  const next = markedToFixMutation.then(async () => {
    const ws = getWorkspaceRoot();
    const set = readMarkedToFix(ws);
    mutate(set);
    await writeMarkedToFix(ws, set);
    return { ok: true as const, count: set.size };
  });
  markedToFixMutation = next.catch(() => undefined);
  return next;
}

app.get('/api/marked-to-fix', async () => {
  const ws = getWorkspaceRoot();
  const set = readMarkedToFix(ws);
  // Resolve fingerprints to findings via live scans + disk history so
  // the dashboard can render titles + file paths without round-tripping
  // per-finding through `/api/findings/:fp`.
  const seen = new Map<string, Finding>();
  for (const s of scans.values()) {
    if (s.workspaceRoot !== ws || !s.findings) continue;
    for (const f of s.findings) if (set.has(f.fingerprint) && !seen.has(f.fingerprint)) seen.set(f.fingerprint, f);
  }
  if (seen.size < set.size) {
    const hist = await loadScanHistory(ws);
    for (const s of hist) {
      for (const f of s.findings ?? []) {
        if (set.has(f.fingerprint) && !seen.has(f.fingerprint)) seen.set(f.fingerprint, f);
      }
      if (seen.size >= set.size) break;
    }
  }
  return {
    fingerprints: [...set].sort(),
    findings: [...seen.values()],
  };
});

app.post('/api/marked-to-fix/prompt', async (_req, reply) => {
  const ws = getWorkspaceRoot();
  const set = readMarkedToFix(ws);
  if (set.size === 0) {
    return reply.code(400).send({ error: 'no findings marked to fix' });
  }
  // Same finding-resolution dance as the GET endpoint — pull live first
  // then disk history.
  const findings: Finding[] = [];
  const seenFp = new Set<string>();
  for (const s of scans.values()) {
    if (s.workspaceRoot !== ws || !s.findings) continue;
    for (const f of s.findings) {
      if (set.has(f.fingerprint) && !seenFp.has(f.fingerprint)) {
        findings.push(f);
        seenFp.add(f.fingerprint);
      }
    }
  }
  if (findings.length < set.size) {
    const hist = await loadScanHistory(ws);
    for (const s of hist) {
      for (const f of s.findings ?? []) {
        if (set.has(f.fingerprint) && !seenFp.has(f.fingerprint)) {
          findings.push(f);
          seenFp.add(f.fingerprint);
        }
      }
      if (findings.length >= set.size) break;
    }
  }
  if (findings.length === 0) {
    return reply.code(404).send({ error: 'marked fingerprints have no matching findings on record' });
  }

  const prompt = renderCombinedFixPrompt(findings);
  return { prompt, findingCount: findings.length };
});

/**
 * Build the combined fix prompt deterministically — no LLM call.
 *
 * Why no LLM: every section that was previously asked of the model
 * was either fixed boilerplate (#1, #4–#7) or a direct render of the
 * finding data (#2, #3). The LLM was contributing zero synthesis and
 * routinely overflowed the 8 K context window (50+ findings produced
 * 18 K-token prompts). Rendering in JS is faster, deterministic, and
 * has no token budget.
 */
function renderCombinedFixPrompt(findings: Finding[]): string {
  const sevCount = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const f of findings) sevCount[f.severity] = (sevCount[f.severity] ?? 0) + 1;
  const sevMix = (['high', 'medium', 'low'] as const)
    .filter((s) => (sevCount[s] ?? 0) > 0)
    .map((s) => `${sevCount[s]} ${s}`)
    .join(', ');

  const uniqueFiles = Array.from(
    new Set(findings.flatMap((f) => f.evidence.map((e) => e.file))),
  ).sort();
  const filesBullets = uniqueFiles.map((p) => `- \`${p}\``).join('\n');

  const findingBlocks = findings
    .map((f, i) => {
      const primary = f.evidence[0];
      const loc = primary
        ? `\`${primary.file}:${primary.range.startLine}-${primary.range.endLine}\``
        : '(no evidence)';
      const evidence = f.evidence
        .map(
          (e) =>
            `\`${e.file}:${e.range.startLine}-${e.range.endLine}\`\n\`\`\`\n${e.snippet}\n\`\`\``,
        )
        .join('\n\n');
      return `### ${i + 1}. ${f.detectorId} · ${f.severity} · ${loc}
**Title:** ${f.title}

${f.description}

**Suggested direction:** ${f.suggestion ?? '(none)'}

${evidence}`;
    })
    .join('\n\n');

  return `Fix the following ${findings.length} static-analysis finding${findings.length === 1 ? '' : 's'} surfaced by rothunter (${sevMix}).

## Files to inspect
${filesBullets}

## Findings
${findingBlocks}

## Required behaviour
Each fix must remove the root cause of its finding while preserving the file's existing public contract and tests. The end state: every finding above no longer reproduces, the surrounding code still reads idiomatically for this project, and no new lint / type errors appear.

## Constraints
- Fix the ROOT CAUSE for each finding — no try/catch swallowing, no \`@ts-ignore\` / \`any\` casts, no commented-out code.
- Do NOT add backwards-compatibility shims, feature flags, or "TODO later" stubs.
- Do NOT widen types, suppress lint rules, or skip tests to make errors disappear.
- Keep each change MINIMAL — touch only what its defect requires.
- Match existing project conventions (imports, formatting, error handling).
- Add or update unit tests when the file already has a sibling test.

## Suppression — if AND ONLY IF intentional, per-finding
Default path is to FIX. For any finding you are CONFIDENT is intentional design (framework idiom, deliberate pattern, detector heuristic false positive) AND not a real defect, you have two options:

**(a) Add a rothunter pragma directly in source** — preferred when the suppression should live with the code (signals intent to future readers + survives every rescan). Place TWO lines IMMEDIATELY above the flagged line:

\`\`\`
// rothunter:ignore-<detectorId>
// reason: <one short sentence explaining why this is intentional>
\`\`\`

Both lines required. Replace \`<detectorId>\` with the literal detector id from the finding (e.g. \`silent-catch\`, \`mutation\`, \`race-condition\`, \`magic-numbers\`, \`console-log-prod\`, \`mutable-globals\`, \`dead-export\`, \`long-function\`).

**(b) STOP at that finding and ask the operator to confirm**, with a one-paragraph rationale. The operator can then click "Mark false positive" in the dashboard if they agree — rothunter persists that decision so the finding stops surfacing on future scans.

NEVER use either path to silence a real bug. The pragma is permanent; the dashboard mark is shared with the team. When in doubt, prefer (b).

Apply the fixes directly to the files listed above. Work through the findings in the order given. If any fix would require a larger refactor than the constraints allow, STOP at that finding and explain in plain text instead of editing.`;
}

// GET /api/code-window?file&line&end?&context? — CodeWindow with `context`
// lines of padding for non-primary evidence locations.
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
  const resolved = path.resolve(getWorkspaceRoot(), file);
  if (!resolved.startsWith(path.resolve(getWorkspaceRoot()) + path.sep)) {
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
      const history = await loadScanHistory(getWorkspaceRoot());
      for (const r of history) {
        if (!r.findings) continue;
        finding = r.findings.find((f) => f.fingerprint === fp);
        if (finding) break;
      }
    }
    if (!finding) return reply.code(404).send({ error: 'finding not found' });
    const evidence = finding.evidence?.[0];
    if (!evidence) return { finding, codeWindow: null };
    // Evidence paths come from a detector run against this workspace,
    // but the scan record is read off disk and could be tampered with
    // (or, in multi-workspace mode, point at a sibling repo). Resolve
    // against the workspace root and refuse anything that escapes.
    const ws = path.resolve(getWorkspaceRoot());
    const filePath = path.resolve(ws, evidence.file);
    if (!filePath.startsWith(ws + path.sep) && filePath !== ws) {
      return { finding, codeWindow: null };
    }
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
    const hist = await loadScanHistory(getWorkspaceRoot());
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
logger.info(
  { port: PORT, host: HOST, workspaceRoot: getWorkspaceRoot(), fsAllowRoots: FS_ALLOW_ROOTS },
  'RotHunter server listening',
);
