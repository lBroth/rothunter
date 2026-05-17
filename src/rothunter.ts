import { logger } from './utils/logger.js';
import { DuplicateTypeDetector } from './detectors/duplicate-type.js';
import { DuplicateFunctionDetector } from './detectors/duplicate-function.js';
import { detectDeadModules } from './detectors/dead-module.js';
import { detectDeadExports } from './detectors/dead-export.js';
import { detectDeadApis } from './detectors/dead-api.js';
import { detectDeadHandlers } from './detectors/dead-handler.js';
import { detectMutations } from './detectors/mutation.js';
import { detectRaceConditions } from './detectors/race-condition.js';
import { detectSharedDbWrites } from './detectors/shared-db-write.js';
import { detectApiRaces } from './detectors/api-race.js';
import { detectBadConfig } from './detectors/bad-config.js';
import { detectSilentCatches } from './detectors/silent-catch.js';
import { detectSkipTests } from './detectors/skip-tests.js';
import { detectLongFiles } from './detectors/long-file.js';
import { detectLongFunctions } from './detectors/long-function.js';
import { detectConsoleLogsInProd } from './detectors/console-log-prod.js';
import { detectMagicNumbers } from './detectors/magic-numbers.js';
import { detectDeepNesting } from './detectors/deep-nesting.js';
import { detectPublicAny } from './detectors/public-any.js';
import { detectMutableGlobals } from './detectors/mutable-globals.js';
import { detectUnusedDeps } from './detectors/unused-deps.js';
import { detectHotHubFiles } from './detectors/hot-hub-file.js';
import { detectSimilarFunctions } from './detectors/similar-functions.js';
import { detectTodoComments } from './detectors/todo-comments.js';
import { TypeScriptParser, type ParseOptions } from './parsers/typescript-parser.js';
import { TypeNormalizer } from './normalizers/type-normalizer.js';
import { buildImportGraph, reachableFrom } from './graph/import-graph.js';
import { discoverEntryPoints } from './graph/entry-points.js';
import { resolveIacEntryFiles } from './graph/iac-entries.js';
import { resolveDecoratorEntryFiles } from './graph/decorator-entries.js';
import type { Detector, Finding, SymbolRecord } from './types.js';
import type { MlxLlmClient } from './adapters/mlx-llm.js';
import { applySnooze, loadSnooze, type SnoozeFile } from './snooze.js';
import { loadRotHunterConfig } from './config.js';
import { scanWorkspaces } from './multi-workspace-scanner.js';

export interface RotHunterRunOptions extends ParseOptions {
  /** Drop a finding below `severity:'low'` when post-LLM confidence falls under this threshold. */
  llmRejectionThreshold?: number;
  /** Override the LLM client (tests, alternative model pools). Production uses the default MlxLlmClient. */
  llm?: MlxLlmClient;
  /** Skip loading `.rothunterignore` (tests / one-off "show everything" runs). */
  ignoreSnoozeFile?: boolean;
  /**
   * Optional allow-list of detector ids. When set, findings from detectors
   * outside this list are dropped BEFORE the LLM confirmation pass — the
   * caller will never see them in the report, so the LLM cost is wasted.
   * Mirrors the `--detectors` CLI flag.
   */
  detectorsAllow?: Set<string>;
  /** Optional deny-list of detector ids — mirrors `--no-detectors`. */
  detectorsDeny?: Set<string>;
  /**
   * Number of Tier-3 LLM verdicts in flight at once. 1 = sequential
   * (original behaviour, safe). 4-8 is a good default on llama.cpp run
   * with `--parallel N -cb` (continuous batching) or on vLLM (dynamic
   * batching is on by default). Mlx_lm.server serialises internally so
   * keep this at 1 for that backend.
   *
   * Defaults to `ROTHUNTER_LLM_CONCURRENCY` env var, then 1.
   */
  llmConcurrency?: number;
  /**
   * Optional callback invoked at scan checkpoints. Used by the rothunter
   * HTTP server to stream live progress over SSE. Never throws — exceptions
   * inside the callback are caught and logged.
   */
  onProgress?: (event: ScanProgressEvent) => void;
}

/**
 * Progress events emitted during a scan. The shape is stable across the
 * scan lifecycle: every event includes the current `state` plus optional
 * metadata for the UI to render.
 */
export type ScanProgressEvent =
  | { state: 'parsing'; files?: number; symbols?: number }
  | { state: 'detecting'; detector: string }
  | { state: 'llm-start'; total: number }
  | { state: 'llm-verdict'; done: number; total: number; detectorId: string; race: boolean; confidence: number; reason: string; latencyMs: number; cluster?: string }
  | { state: 'snooze'; kept: number; snoozed: number }
  | { state: 'done'; findings: number; durationMs: number };

export interface RotHunterResult {
  symbols: SymbolRecord[];
  /** Findings to report after snooze. */
  findings: Finding[];
  /** Findings filtered out by `.rothunterignore`. */
  snoozed: Finding[];
  /** Snooze file metadata (path + size), useful for the CLI to log. */
  snooze: SnoozeFile;
  durationMs: number;
}

export class RotHunter {
  private parser = new TypeScriptParser();
  private normalizer = new TypeNormalizer();
  private detectors: Detector[] = [
    new DuplicateTypeDetector(),
    new DuplicateFunctionDetector(),
  ];

  async run(opts: RotHunterRunOptions): Promise<RotHunterResult> {
    const startedAt = Date.now();

    // Multi-workspace mode: if a rothunter.config.json exists at the workspace
    // root, parse every linked workspace in a single pass and run the same
    // detectors over the merged graph. dead-api is the cross-repo-only
    // detector and only emits findings in this mode.
    const emit = (event: ScanProgressEvent): void => {
      if (!opts.onProgress) return;
      try {
        opts.onProgress(event);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'onProgress callback threw');
      }
    };

    emit({ state: 'parsing' });
    const config = loadRotHunterConfig(opts.workspaceRoot);
    let isMulti = false;
    let parsed: Awaited<ReturnType<TypeScriptParser['parseWorkspaceFull']>>;
    if (config) {
      logger.info(
        { configPath: config.configPath, workspaces: config.workspaces.map((w) => w.name) },
        'RotHunter: parsing multi-workspace group',
      );
      const multi = await scanWorkspaces(config);
      parsed = { symbols: multi.symbols, imports: multi.imports, files: multi.files };
      isMulti = true;
    } else {
      logger.info({ workspaceRoot: opts.workspaceRoot }, 'RotHunter: parsing workspace');
      parsed = await this.parser.parseWorkspaceFull(opts);
    }
    emit({ state: 'parsing', files: parsed.files.length, symbols: parsed.symbols.length });

    logger.info({ count: parsed.symbols.length }, 'RotHunter: normalizing symbols');
    const symbols = this.normalizer.normalizeAll(parsed.symbols);

    const findings: Finding[] = [];
    for (const detector of this.detectors) {
      logger.info({ detector: detector.id }, 'RotHunter: running detector');
      emit({ state: 'detecting', detector: detector.id });
      const detectorFindings = await detector.run(symbols);
      findings.push(...detectorFindings);
    }

    // Dead-module detection runs at file granularity, not symbol granularity,
    // so it has its own input shape. Build the import graph once and reuse it
    // for any future graph-based detectors (call graph, cross-repo lookups).
    const fileSet = new Set(parsed.files);
    const importGraph = buildImportGraph(parsed.imports);
    const entryPoints = discoverEntryPoints(opts.workspaceRoot, fileSet);
    // CDK / SST / Serverless-framework constructs reference handler files by
    // string path. Resolve those strings and add them to the entry set so
    // dead-module/dead-export don't flag lambda handlers as orphans. The
    // resolved set is also used by the dead-handler detector below to decide
    // whether a handler-convention file is actually wired.
    const iacEntries = isMulti
      ? new Set<string>()
      : resolveIacEntryFiles(opts.workspaceRoot, parsed.files);
    for (const f of iacEntries) entryPoints.add(f);
    // Framework-decorated classes (NestJS controllers, Angular components,
    // TypeORM entities, ...) are discovered by the framework at runtime —
    // never statically imported. Protect their files from dead-module.
    const decoratorEntries = isMulti
      ? new Set<string>()
      : resolveDecoratorEntryFiles(opts.workspaceRoot, parsed.files);
    for (const f of decoratorEntries) entryPoints.add(f);
    const reachable = reachableFrom(importGraph, entryPoints);
    logger.info(
      { entries: entryPoints.size, reachable: reachable.size, total: parsed.files.length },
      'RotHunter: running detector dead-module',
    );
    findings.push(
      ...detectDeadModules({ files: parsed.files, graph: importGraph, entryPoints, reachable }),
    );
    logger.info({ symbols: symbols.length }, 'RotHunter: running detector dead-export');
    findings.push(
      ...detectDeadExports({ symbols, imports: parsed.imports, entryPoints }),
    );

    if (isMulti) {
      logger.info({ symbols: symbols.length }, 'RotHunter: running detector dead-api');
      findings.push(...detectDeadApis({ symbols, imports: parsed.imports }));
    }

    if (!isMulti) {
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector dead-handler');
      emit({ state: 'detecting', detector: 'dead-handler' });
      findings.push(
        ...detectDeadHandlers({ files: parsed.files, iacEntries, imports: parsed.imports }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector mutation');
      emit({ state: 'detecting', detector: 'mutation' });
      findings.push(
        ...detectMutations({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector race-condition');
      emit({ state: 'detecting', detector: 'race-condition' });
      findings.push(
        ...detectRaceConditions({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector shared-db-write');
      emit({ state: 'detecting', detector: 'shared-db-write' });
      findings.push(
        ...detectSharedDbWrites({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector api-race');
      emit({ state: 'detecting', detector: 'api-race' });
      findings.push(
        ...detectApiRaces({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector bad-config');
      emit({ state: 'detecting', detector: 'bad-config' });
      findings.push(
        ...detectBadConfig({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector silent-catch');
      emit({ state: 'detecting', detector: 'silent-catch' });
      findings.push(
        ...detectSilentCatches({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector skip-tests');
      emit({ state: 'detecting', detector: 'skip-tests' });
      findings.push(
        ...detectSkipTests({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector long-file');
      emit({ state: 'detecting', detector: 'long-file' });
      findings.push(
        ...detectLongFiles({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ symbols: symbols.length }, 'RotHunter: running detector long-function');
      emit({ state: 'detecting', detector: 'long-function' });
      findings.push(
        ...detectLongFunctions({ symbols }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector console-log-prod');
      emit({ state: 'detecting', detector: 'console-log-prod' });
      findings.push(
        ...detectConsoleLogsInProd({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector magic-numbers');
      emit({ state: 'detecting', detector: 'magic-numbers' });
      findings.push(
        ...detectMagicNumbers({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ symbols: symbols.length }, 'RotHunter: running detector deep-nesting');
      emit({ state: 'detecting', detector: 'deep-nesting' });
      findings.push(...detectDeepNesting({ symbols }));
      logger.info({ symbols: symbols.length }, 'RotHunter: running detector public-any');
      emit({ state: 'detecting', detector: 'public-any' });
      findings.push(...detectPublicAny({ symbols }));
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector mutable-globals');
      emit({ state: 'detecting', detector: 'mutable-globals' });
      findings.push(
        ...detectMutableGlobals({ workspaceRoot: opts.workspaceRoot, files: parsed.files }),
      );
      logger.info({ imports: parsed.imports.length }, 'RotHunter: running detector unused-deps');
      emit({ state: 'detecting', detector: 'unused-deps' });
      findings.push(
        ...detectUnusedDeps({ workspaceRoot: opts.workspaceRoot, imports: parsed.imports }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector hot-hub-file');
      emit({ state: 'detecting', detector: 'hot-hub-file' });
      findings.push(...detectHotHubFiles({ graph: importGraph }));
      logger.info({ symbols: symbols.length }, 'RotHunter: running detector similar-functions');
      emit({ state: 'detecting', detector: 'similar-functions' });
      findings.push(
        ...detectSimilarFunctions({ workspaceRoot: opts.workspaceRoot, symbols }),
      );
      logger.info({ files: parsed.files.length }, 'RotHunter: running detector todo-comments');
      emit({ state: 'detecting', detector: 'todo-comments' });
      // No `files` arg → detector does its own workspace walk so it
      // picks up Python / Go / shell sources the TS parser skips.
      findings.push(...detectTodoComments({ workspaceRoot: opts.workspaceRoot }));
    }

    // Drop findings the caller has explicitly de-selected BEFORE the LLM
    // pass — they would be filtered out post-LLM anyway and the verdict cost
    // is wasted otherwise. Most relevant on big repos where the user runs a
    // narrow `--detectors race-condition,shared-db-write,api-race` scan: the
    // dup-type / dup-function / mutation candidates can otherwise dominate
    // LLM cost (e.g. Outline: 715 LLM candidates, ~95 % dup-type).
    if (opts.detectorsAllow || opts.detectorsDeny) {
      const allow = opts.detectorsAllow;
      const deny = opts.detectorsDeny;
      const before = findings.length;
      const kept = findings.filter((f) => {
        if (allow && !allow.has(f.detectorId)) return false;
        if (deny && deny.has(f.detectorId)) return false;
        return true;
      });
      findings.length = 0;
      findings.push(...kept);
      if (kept.length !== before) {
        logger.info(
          { kept: kept.length, dropped: before - kept.length },
          'RotHunter: applied detector allow/deny filter before LLM pass',
        );
      }
    }

    const threshold = opts.llmRejectionThreshold ?? 0.7;
    const envConc = Number(process.env.ROTHUNTER_LLM_CONCURRENCY);
    const llmConcurrency = Math.max(
      1,
      Math.min(16, Math.floor(opts.llmConcurrency ?? (Number.isFinite(envConc) && envConc > 0 ? envConc : 1))),
    );
    await this.runLlmConfirmation(findings, symbols, threshold, opts.llm, emit, llmConcurrency);

    const snooze = opts.ignoreSnoozeFile
      ? { path: '', fingerprints: new Set<string>(), exists: false }
      : loadSnooze(opts.workspaceRoot);
    const { kept, snoozed } = applySnooze(findings, snooze);
    if (snoozed.length > 0) {
      logger.info({ count: snoozed.length, file: snooze.path }, 'RotHunter: applied .rothunterignore');
    }
    emit({ state: 'snooze', kept: kept.length, snoozed: snoozed.length });

    const durationMs = Date.now() - startedAt;
    emit({ state: 'done', findings: kept.length, durationMs });
    return {
      symbols,
      findings: kept,
      snoozed,
      snooze,
      durationMs,
    };
  }

  private async runLlmConfirmation(
    findings: Finding[],
    symbols: SymbolRecord[],
    threshold: number,
    injectedLlm?: MlxLlmClient,
    emit?: (event: ScanProgressEvent) => void,
    concurrency = 1,
  ): Promise<void> {
    const { LlmConfirmer } = await import('./extraction/llm-confirmer.js');
    const { MutationConfirmer } = await import('./extraction/mutation-confirmer.js');
    const { RaceConfirmer } = await import('./extraction/race-confirmer.js');
    const { SharedDbWriteConfirmer } = await import('./extraction/shared-db-write-confirmer.js');
    const { ApiRaceConfirmer } = await import('./extraction/api-race-confirmer.js');
    const { MlxLlmClient } = await import('./adapters/mlx-llm.js');

    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    const candidates = findings.filter((f) => requiresLlmConfirmation(f, symbolById));

    if (candidates.length === 0) return;

    const llm = injectedLlm ?? new MlxLlmClient();
    logger.info({ count: candidates.length }, 'RotHunter: warming up MLX-LM');
    await llm.warmup();
    const dupConfirmer = new LlmConfirmer(llm);
    const mutationConfirmer = new MutationConfirmer(llm);
    const raceConfirmer = new RaceConfirmer(llm);
    const sharedDbConfirmer = new SharedDbWriteConfirmer(llm);
    const apiRaceConfirmer = new ApiRaceConfirmer(llm);
    logger.info({ count: candidates.length }, 'RotHunter: LLM confirmation pass');
    emit?.({ state: 'llm-start', total: candidates.length });

    let llmDone = 0;
    const reportVerdict = (
      finding: Finding,
      race: boolean,
      confidence: number,
      reason: string,
      latencyMs: number,
    ): void => {
      llmDone += 1;
      emit?.({
        state: 'llm-verdict',
        done: llmDone,
        total: candidates.length,
        detectorId: finding.detectorId,
        race,
        confidence,
        reason: reason.slice(0, 120),
        latencyMs,
        cluster: finding.title.match(/`([^`]+)`/)?.[1],
      });
    };

    const processOne = async (finding: Finding): Promise<void> => {
      const verdictStart = Date.now();
      if (finding.detectorId === 'duplicate-type' || finding.detectorId === 'duplicate-function') {
        const ids = finding.evidence
          .map((ev) => findSymbolId(symbols, ev.file, ev.range.startLine))
          .filter((id): id is string => Boolean(id));
        if (ids.length < 2) return;

        const a = symbolById.get(ids[0]!);
        const b = symbolById.get(ids[1]!);
        if (!a || !b) return;

        const result = await dupConfirmer.confirmSameConcept(a, b);
        if (!result) return;

        if (result.same_concept) {
          finding.confidence = Math.min(0.97, Math.max(finding.confidence, result.confidence));
          finding.description += `\n\n**LLM confirmation:** ${result.reason} (confidence ${result.confidence.toFixed(2)})`;
          finding.layer = 3;
        } else {
          finding.confidence = Math.min(finding.confidence, 1 - result.confidence) * 0.7;
          finding.description += `\n\n**LLM rejection:** ${result.reason} — not considered a domain duplicate.`;
          if (finding.confidence < threshold) {
            finding.severity = 'low';
          }
        }
        reportVerdict(finding, result.same_concept, result.confidence, result.reason, Date.now() - verdictStart);
      } else if (finding.detectorId === 'api-race') {
        // Title shape: `Shared API write: \`PATCH /api/foo/:param\` called from ...
        // clients: axios+got)`
        const clusterMatch = /`([^`]+)`/.exec(finding.title);
        const clientsMatch = /clients: ([^)]+)/.exec(finding.title);
        const cluster = clusterMatch?.[1] ?? '';
        const [method, ...pathParts] = cluster.split(' ');
        const pathPattern = pathParts.join(' ');
        if (!method || !pathPattern) return;
        const sites = finding.evidence.slice(0, 8).map((ev) => {
          let enclosingName: string | undefined;
          try {
            enclosingName = (JSON.parse(ev.note ?? '{}') as { enclosingName?: string }).enclosingName?.trim() || undefined;
          } catch {
            // ignore
          }
          return {
            file: ev.file,
            line: ev.range.startLine,
            enclosingName,
            enclosingSource: ev.snippet,
          };
        });
        const verdict = await apiRaceConfirmer.confirm({
          method,
          pathPattern,
          clients: clientsMatch?.[1] ?? 'unknown',
          sites,
        });
        if (!verdict) return;

        if (verdict.race) {
          finding.confidence = Math.min(0.95, Math.max(finding.confidence, verdict.confidence));
          finding.description += `\n\n**LLM verdict:** real cross-flow API race — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.severity === 'medium' && verdict.confidence >= 0.85) {
            finding.severity = 'high';
          }
          finding.layer = 3;
        } else {
          finding.confidence = Math.max(0.0, finding.confidence * (1 - verdict.confidence));
          finding.description += `\n\n**LLM verdict:** safe — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.confidence < threshold) finding.severity = 'low';
          finding.layer = 3;
        }
        reportVerdict(finding, verdict.race, verdict.confidence, verdict.reason, Date.now() - verdictStart);
      } else if (finding.detectorId === 'shared-db-write') {
        // Parse entity + column from the cluster key `<entity>.<column>` (the
        // detector embeds it in the title between backticks). Adapter list
        // follows the literal `adapters: ` token in the same title.
        const clusterMatch = /`([^`]+)`/.exec(finding.title);
        const adaptersMatch = /adapters: ([^)]+)/.exec(finding.title);
        const cluster = clusterMatch?.[1] ?? '';
        const [entity, column] = cluster.split('.');
        if (!entity || !column) return;
        const sites = finding.evidence.slice(0, 8).map((ev) => {
          let enclosingName: string | undefined;
          try {
            enclosingName = (JSON.parse(ev.note ?? '{}') as { enclosingName?: string }).enclosingName?.trim() || undefined;
          } catch {
            // ignore
          }
          return {
            file: ev.file,
            line: ev.range.startLine,
            enclosingName,
            enclosingSource: ev.snippet,
          };
        });
        const verdict = await sharedDbConfirmer.confirm({
          entity,
          column,
          adapters: adaptersMatch?.[1] ?? 'unknown',
          sites,
        });
        if (!verdict) return;

        if (verdict.race) {
          finding.confidence = Math.min(0.95, Math.max(finding.confidence, verdict.confidence));
          finding.description += `\n\n**LLM verdict:** real cross-flow race — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.severity === 'medium' && verdict.confidence >= 0.85) {
            finding.severity = 'high';
          }
          finding.layer = 3;
        } else {
          finding.confidence = Math.max(0.0, finding.confidence * (1 - verdict.confidence));
          finding.description += `\n\n**LLM verdict:** safe — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.confidence < threshold) finding.severity = 'low';
          finding.layer = 3;
        }
        reportVerdict(finding, verdict.race, verdict.confidence, verdict.reason, Date.now() - verdictStart);
      } else if (finding.detectorId === 'race-condition') {
        const ev = finding.evidence[0];
        if (!ev || !ev.note) return;
        let meta: { target?: string; pattern?: string; enclosingName?: string };
        try {
          meta = JSON.parse(ev.note) as typeof meta;
        } catch {
          return;
        }
        const isPromiseAll = finding.fingerprint.startsWith('race:promise-all');
        const pattern: 'read-modify-write' | 'promise-all' | 'emitter-handler' = isPromiseAll
          ? 'promise-all'
          : /emitter/i.test(meta.enclosingName ?? '')
            ? 'emitter-handler'
            : 'read-modify-write';
        const verdict = await raceConfirmer.confirm({
          file: ev.file,
          line: ev.range.startLine,
          pattern,
          target: meta.target ?? 'unknown',
          enclosingSource: ev.snippet,
          enclosingName: meta.enclosingName || undefined,
        });
        if (!verdict) return;

        if (verdict.race) {
          finding.confidence = Math.min(0.95, Math.max(finding.confidence, verdict.confidence));
          finding.description += `\n\n**LLM verdict:** real race — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.severity === 'medium' && verdict.confidence >= 0.85) {
            finding.severity = 'high';
          }
          finding.layer = 3;
        } else {
          finding.confidence = Math.max(0.0, finding.confidence * (1 - verdict.confidence));
          finding.description += `\n\n**LLM verdict:** safe — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.confidence < threshold) finding.severity = 'low';
          finding.layer = 3;
        }
        reportVerdict(finding, verdict.race, verdict.confidence, verdict.reason, Date.now() - verdictStart);
      } else if (finding.detectorId === 'mutation') {
        const ev = finding.evidence[0];
        if (!ev || !ev.note) return;
        let meta: { enclosingSource?: string; enclosingName?: string; pattern?: string; escapes?: boolean };
        try {
          meta = JSON.parse(ev.note) as typeof meta;
        } catch {
          return;
        }
        const verdict = await mutationConfirmer.confirm({
          file: ev.file,
          line: ev.range.startLine,
          pattern: meta.pattern ?? 'mutation',
          escapes: Boolean(meta.escapes),
          snippet: ev.snippet,
          enclosingSource: meta.enclosingSource ?? ev.snippet,
          enclosingName: meta.enclosingName || undefined,
        });
        if (!verdict) return;

        if (verdict.intentional) {
          // Drop confidence + severity for intentional mutations so they fade
          // into the long tail of the digest.
          finding.confidence = Math.max(0.0, finding.confidence * (1 - verdict.confidence));
          finding.description += `\n\n**LLM verdict:** intentional — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.confidence < threshold) {
            finding.severity = 'low';
          }
          finding.layer = 3;
        } else {
          // Confirmed bug-shaped — boost confidence and elevate to layer 3.
          finding.confidence = Math.min(0.95, Math.max(finding.confidence, verdict.confidence));
          finding.description += `\n\n**LLM verdict:** potential bug — ${verdict.reason} (confidence ${verdict.confidence.toFixed(2)})`;
          if (finding.severity === 'medium') finding.severity = 'high';
          finding.layer = 3;
        }
        // Mutation verdict semantics: race = !intentional (bug-shaped).
        reportVerdict(finding, !verdict.intentional, verdict.confidence, verdict.reason, Date.now() - verdictStart);
      }
    };

    // Run with a small worker pool. Each "worker" pulls the next finding
    // off the shared cursor and awaits its verdict — the LLM backend
    // dictates real throughput (llama.cpp `--parallel N -cb`, vLLM dynamic
    // batching). Concurrency 1 reproduces the original sequential flow.
    logger.info({ concurrency }, 'RotHunter: LLM concurrency');
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= candidates.length) return;
        try {
          await processOne(candidates[idx]!);
        } catch (err) {
          // A single bad finding must not poison the whole pool. The
          // verdict is already accounted for in reportVerdict; log + move on.
          logger.warn(
            { err: (err as Error).message, detector: candidates[idx]!.detectorId },
            'LLM verdict task threw',
          );
        }
      }
    });
    await Promise.all(workers);
  }
}

function findSymbolId(
  symbols: SymbolRecord[],
  file: string,
  startLine: number,
): string | undefined {
  return symbols.find((s) => s.file === file && s.range.startLine === startLine)?.id;
}

/**
 * Decide whether a finding is borderline enough to warrant LLM confirmation.
 *
 * Always-confirm cases:
 *   - Layer 2 (normalized-names) — synonym/normalization map can produce false matches.
 *   - Layer 1 structural — anonymous type collisions are the largest FP source.
 *   - Layer 1 strict but the cluster spans ≥2 distinct names AND ≤3 fields. Small
 *     `{id, name}`-style shapes regularly collide across unrelated DTOs and need
 *     a semantic check (the smoke case Template/RegistryAuth/Document/Catalog).
 */
function requiresLlmConfirmation(
  finding: Finding,
  symbolById: Map<string, SymbolRecord>,
): boolean {
  // Mutation findings always get the LLM Tier-3 intent check — even Tier 1
  // strict matches are borderline by nature ("is this mutation intentional?").
  if (finding.detectorId === 'mutation') return true;
  // Race-condition findings always get a Tier-3 race-vs-safe verdict —
  // Tier 1 cannot distinguish mutex / single-flight / scoped state from
  // genuine races.
  if (finding.detectorId === 'race-condition') return true;
  // shared-db-write findings always get a Tier-3 cross-flow verdict —
  // Tier 1 cannot distinguish single-owner / transaction-wrapped / init-
  // only / idempotent writes from genuine cross-service races.
  if (finding.detectorId === 'shared-db-write') return true;
  // api-race findings always get a Tier-3 cross-flow verdict — Tier 1
  // cannot distinguish test fixtures / retry wrappers / idempotent
  // payloads / etag-locked writes from genuine HTTP races.
  if (finding.detectorId === 'api-race') return true;
  if (finding.detectorId !== 'duplicate-type' && finding.detectorId !== 'duplicate-function') return false;
  if (finding.layer >= 2) return true;
  if (finding.confidence < 0.95) return true;
  const ids = finding.evidence
    .map((ev) => findSymbolIdForEvidence(symbolById, ev.file, ev.range.startLine))
    .filter((id): id is string => Boolean(id));
  const symbols = ids
    .map((id) => symbolById.get(id))
    .filter((s): s is SymbolRecord => Boolean(s));
  const distinctNames = new Set(symbols.map((s) => s.name)).size;
  const fieldCount = symbols[0]?.structure?.fields?.length ?? 0;
  return distinctNames >= 2 && fieldCount > 0 && fieldCount <= 3;
}

function findSymbolIdForEvidence(
  symbolById: Map<string, SymbolRecord>,
  file: string,
  startLine: number,
): string | undefined {
  for (const s of symbolById.values()) {
    if (s.file === file && s.range.startLine === startLine) return s.id;
  }
  return undefined;
}
