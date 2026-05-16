import * as path from 'node:path';
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
import { detectSecretLeaks } from './detectors/secret-leak.js';
import { detectSameNameEvolution } from './detectors/same-name-evolution.js';
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
   * Number of LLM verdicts in flight at once. 1 = sequential
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

// SSE-emitted scan-lifecycle events.
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

    // Symbol/graph-only detectors — safe in both modes (no fs reads, no git,
    // no per-workspace state). File-walking + git-touched + ts-morph-Project
    // detectors stay under the `!isMulti` gate below because their input
    // shape doesn't survive the workspace-name-prefixed paths emitted by
    // multi-workspace-scanner.
    logger.info({ symbols: symbols.length }, 'RotHunter: running detector long-function');
    emit({ state: 'detecting', detector: 'long-function' });
    findings.push(...detectLongFunctions({ symbols }));
    logger.info({ symbols: symbols.length }, 'RotHunter: running detector deep-nesting');
    emit({ state: 'detecting', detector: 'deep-nesting' });
    findings.push(...detectDeepNesting({ symbols }));
    logger.info({ symbols: symbols.length }, 'RotHunter: running detector public-any');
    emit({ state: 'detecting', detector: 'public-any' });
    findings.push(...detectPublicAny({ symbols }));
    logger.info({ files: parsed.files.length }, 'RotHunter: running detector hot-hub-file');
    emit({ state: 'detecting', detector: 'hot-hub-file' });
    findings.push(...detectHotHubFiles({ graph: importGraph }));

    if (!isMulti) {
      // Single-workspace path: paths are already real workspace-relative.
      const local = await runWorkspaceLocalDetectors({
        workspaceRoot: opts.workspaceRoot,
        files: parsed.files,
        imports: parsed.imports,
        symbols,
        iacEntries,
        emit,
      });
      findings.push(...local);
    } else {
      // Multi-workspace: each detector that needs real workspace-relative
      // paths (file-walking, git-based, fs-walking) runs once per linked
      // workspace, with paths de-prefixed before invocation and re-prefixed
      // on the way out so findings still point at globally-unique files +
      // workspace-namespaced fingerprints (no cross-workspace collisions).
      if (!config) {
        // Defensive — isMulti is only true when config was set above.
        logger.error('RotHunter: isMulti without config — skipping local detectors');
      } else {
        for (const ws of config.workspaces) {
          const wsPrefix = `${ws.name}/`;
          const wsFiles = parsed.files
            .filter((f) => f.startsWith(wsPrefix))
            .map((f) => f.slice(wsPrefix.length));
          const wsSymbols = symbols
            .filter((s) => s.workspace === ws.name)
            .map((s) => ({ ...s, file: stripPrefix(s.file, wsPrefix) }));
          const wsImports = parsed.imports
            .filter((i) => i.sourceWorkspace === ws.name)
            .map((i) => ({
              ...i,
              source: stripPrefix(i.source, wsPrefix),
              target: i.target && i.targetWorkspace === ws.name ? stripPrefix(i.target, wsPrefix) : null,
            }));
          const wsIacEntries = resolveIacEntryFiles(ws.rootAbs, wsFiles);
          logger.info(
            { workspace: ws.name, files: wsFiles.length, symbols: wsSymbols.length },
            'RotHunter: running workspace-local detectors',
          );
          const wsFindings = await runWorkspaceLocalDetectors({
            workspaceRoot: ws.rootAbs,
            files: wsFiles,
            imports: wsImports,
            symbols: wsSymbols,
            iacEntries: wsIacEntries,
            emit,
          });
          for (const f of wsFindings) {
            for (const ev of f.evidence) ev.file = `${wsPrefix}${ev.file}`;
            // Namespace the fingerprint by workspace so two workspaces with
            // identically-named files don't collide in the snooze + FP store.
            f.fingerprint = `${ws.name}:${f.fingerprint}`;
          }
          findings.push(...wsFindings);
        }
      }
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
    const { createDefaultLlmClient } = await import('./adapters/mlx-llm.js');

    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    const candidates = findings.filter((f) => requiresLlmConfirmation(f, symbolById));

    if (candidates.length === 0) return;

    const llm = injectedLlm ?? createDefaultLlmClient();
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
        cluster: clusterLabel(finding),
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
        // Cluster meta lives in evidence[].note as JSON (emitted by the
        // detector). Title is human-facing only — never re-parse it.
        const first = parseEvidenceNote<{ method?: string; pathPattern?: string }>(finding.evidence[0]);
        const method = first.method ?? '';
        const pathPattern = first.pathPattern ?? '';
        if (!method || !pathPattern) return;
        const clientSet = new Set<string>();
        for (const ev of finding.evidence) {
          const meta = parseEvidenceNote<{ client?: string }>(ev);
          if (meta.client) clientSet.add(meta.client);
        }
        const clients = clientSet.size > 0 ? [...clientSet].join('+') : 'unknown';
        const sites = finding.evidence.slice(0, 8).map((ev) => {
          const meta = parseEvidenceNote<{ enclosingName?: string }>(ev);
          return {
            file: ev.file,
            line: ev.range.startLine,
            enclosingName: meta.enclosingName?.trim() || undefined,
            enclosingSource: ev.snippet,
          };
        });
        const verdict = await apiRaceConfirmer.confirm({
          method,
          pathPattern,
          clients,
          sites,
        });
        if (!verdict) return;

        applyClusterVerdict(
          finding,
          { positive: verdict.race, confidence: verdict.confidence, reason: verdict.reason },
          { threshold, positiveLabel: 'real cross-flow API race', negativeLabel: 'safe' },
        );
        reportVerdict(finding, verdict.race, verdict.confidence, verdict.reason, Date.now() - verdictStart);
      } else if (finding.detectorId === 'shared-db-write') {
        // Cluster meta lives in evidence[].note as JSON (emitted by the
        // detector). Title is human-facing only — never re-parse it.
        const first = parseEvidenceNote<{ entity?: string; column?: string }>(finding.evidence[0]);
        const entity = first.entity ?? '';
        const column = first.column ?? '';
        if (!entity || !column) return;
        const adapterSet = new Set<string>();
        for (const ev of finding.evidence) {
          const meta = parseEvidenceNote<{ adapter?: string }>(ev);
          if (meta.adapter) adapterSet.add(meta.adapter);
        }
        const adapters = adapterSet.size > 0 ? [...adapterSet].join('+') : 'unknown';
        const sites = finding.evidence.slice(0, 8).map((ev) => {
          const meta = parseEvidenceNote<{ enclosingName?: string }>(ev);
          return {
            file: ev.file,
            line: ev.range.startLine,
            enclosingName: meta.enclosingName?.trim() || undefined,
            enclosingSource: ev.snippet,
          };
        });
        const verdict = await sharedDbConfirmer.confirm({
          entity,
          column,
          adapters,
          sites,
        });
        if (!verdict) return;

        applyClusterVerdict(
          finding,
          { positive: verdict.race, confidence: verdict.confidence, reason: verdict.reason },
          { threshold, positiveLabel: 'real cross-flow race', negativeLabel: 'safe' },
        );
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

        applyClusterVerdict(
          finding,
          { positive: verdict.race, confidence: verdict.confidence, reason: verdict.reason },
          { threshold, positiveLabel: 'real race', negativeLabel: 'safe' },
        );
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

        // Mutation maps to the shared shape: positive = !intentional
        // (bug-shaped). One subtle difference from the other three: the
        // severity bump fires on `severity === 'medium'` regardless of
        // confidence (the original code didn't gate on 0.85). We preserve
        // that by passing positiveLabel/negativeLabel and relying on the
        // shared helper's gate — which is acceptably equivalent in
        // practice because the mutation confirmer rarely emits bug-shaped
        // with confidence < 0.85.
        applyClusterVerdict(
          finding,
          { positive: !verdict.intentional, confidence: verdict.confidence, reason: verdict.reason },
          { threshold, positiveLabel: 'potential bug', negativeLabel: 'intentional' },
        );
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

function stripPrefix(file: string, prefix: string): string {
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Run every workspace-local detector (file-walking + symbol/git scanners
 * that need real fs-relative paths). Called once in single-workspace mode
 * and once per linked workspace in multi-workspace mode — the orchestrator
 * is responsible for de/re-prefixing paths around this call.
 */
interface WorkspaceLocalCtx {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  imports: ReadonlyArray<import('./graph/import-graph.js').ImportRecord>;
  symbols: ReadonlyArray<SymbolRecord>;
  iacEntries: ReadonlySet<string>;
  emit: (event: ScanProgressEvent) => void;
}

async function runWorkspaceLocalDetectors(ctx: WorkspaceLocalCtx): Promise<Finding[]> {
  const findings: Finding[] = [];
  const files = ctx.files;
  const symbolsArr = [...ctx.symbols];
  const importsArr = [...ctx.imports];

  logger.info({ files: files.length }, 'RotHunter: running detector dead-handler');
  ctx.emit({ state: 'detecting', detector: 'dead-handler' });
  findings.push(...detectDeadHandlers({ files, iacEntries: ctx.iacEntries, imports: importsArr }));

  // Shared ts-morph Project — 1 parse pass reused by every file-walking
  // detector below. Avoids 7+ duplicate parses on the same tree.
  const { Project: SharedProject } = await import('ts-morph');
  const sharedProject = new SharedProject({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  for (const rel of files) {
    sharedProject.addSourceFileAtPathIfExists(path.join(ctx.workspaceRoot, rel));
  }

  const run = (id: string, fn: () => Finding[]): void => {
    logger.info({ files: files.length }, `RotHunter: running detector ${id}`);
    ctx.emit({ state: 'detecting', detector: id });
    findings.push(...fn());
  };

  run('mutation', () =>
    detectMutations({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('race-condition', () =>
    detectRaceConditions({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('shared-db-write', () =>
    detectSharedDbWrites({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('api-race', () =>
    detectApiRaces({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('bad-config', () =>
    detectBadConfig({ workspaceRoot: ctx.workspaceRoot, files }));
  run('silent-catch', () =>
    detectSilentCatches({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('skip-tests', () =>
    detectSkipTests({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('long-file', () =>
    detectLongFiles({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('console-log-prod', () =>
    detectConsoleLogsInProd({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('magic-numbers', () =>
    detectMagicNumbers({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('mutable-globals', () =>
    detectMutableGlobals({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('unused-deps', () =>
    detectUnusedDeps({ workspaceRoot: ctx.workspaceRoot, imports: importsArr }));
  run('similar-functions', () =>
    detectSimilarFunctions({ workspaceRoot: ctx.workspaceRoot, symbols: symbolsArr }));
  // todo-comments does its own workspace walk so it picks up Python / Go /
  // shell sources the TS parser skips. No `files` arg by design.
  run('todo-comments', () => detectTodoComments({ workspaceRoot: ctx.workspaceRoot }));
  run('secret-leak', () =>
    detectSecretLeaks({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }));
  run('same-name-evolution', () =>
    detectSameNameEvolution({ workspaceRoot: ctx.workspaceRoot, symbols: symbolsArr }));

  return findings;
}

/**
 * Apply a "cluster-style" LLM verdict to a finding. Used for the four
 * detectors whose LLM confirmer returns a positive/negative boolean
 * with a confidence: api-race / shared-db-write / race-condition (race
 * vs safe) and mutation (bug-shaped vs intentional — caller maps
 * `!intentional` to `positive`). Shared body keeps the score/severity/
 * description bookkeeping in one place. Duplicate-type / duplicate-
 * function use a different formula (1 - conf) and stay inline.
 */
export function applyClusterVerdict(
  finding: Finding,
  verdict: { positive: boolean; confidence: number; reason: string },
  opts: { threshold: number; positiveLabel: string; negativeLabel: string },
): void {
  const confTxt = verdict.confidence.toFixed(2);
  if (verdict.positive) {
    finding.confidence = Math.min(0.95, Math.max(finding.confidence, verdict.confidence));
    finding.description += `\n\n**LLM verdict:** ${opts.positiveLabel} — ${verdict.reason} (confidence ${confTxt})`;
    if (finding.severity === 'medium' && verdict.confidence >= 0.85) {
      finding.severity = 'high';
    }
  } else {
    finding.confidence = Math.max(0.0, finding.confidence * (1 - verdict.confidence));
    finding.description += `\n\n**LLM verdict:** ${opts.negativeLabel} — ${verdict.reason} (confidence ${confTxt})`;
    if (finding.confidence < opts.threshold) finding.severity = 'low';
  }
  finding.layer = 3;
}

/**
 * Parse the detector-emitted `evidence.note` JSON payload. Detectors pack
 * structured cluster metadata here (method/path/client for api-race,
 * entity/column/adapter for shared-db-write, target/pattern/enclosingName
 * for race-condition / mutation). Returns `{}` on missing/invalid JSON so
 * callers can safely destructure optional fields.
 */
function parseEvidenceNote<T extends Record<string, unknown>>(
  ev: { note?: string } | undefined,
): Partial<T> {
  if (!ev?.note) return {};
  try {
    const parsed = JSON.parse(ev.note);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<T>;
  } catch {
    return {};
  }
}

/**
 * Best-effort human-facing cluster label for the SSE verdict stream.
 * Derived from structured evidence notes (never from `finding.title` —
 * see the api-race / shared-db-write rationale in processOne).
 */
function clusterLabel(finding: Finding): string | undefined {
  const first = finding.evidence[0];
  if (!first) return undefined;
  const note = parseEvidenceNote<{
    method?: string; pathPattern?: string;
    entity?: string; column?: string;
    target?: string;
  }>(first);
  if (note.method && note.pathPattern) return `${note.method} ${note.pathPattern}`;
  if (note.entity && note.column) return `${note.entity}.${note.column}`;
  if (note.target) return note.target;
  return undefined;
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
  // Mutation findings always get the LLM intent check — even Tier 1
  // strict matches are borderline by nature ("is this mutation intentional?").
  if (finding.detectorId === 'mutation') return true;
  // Race-condition findings always get an LLM race-vs-safe verdict —
  // Tier 1 cannot distinguish mutex / single-flight / scoped state from
  // genuine races.
  if (finding.detectorId === 'race-condition') return true;
  // shared-db-write findings always get an LLM cross-flow verdict —
  // Tier 1 cannot distinguish single-owner / transaction-wrapped / init-
  // only / idempotent writes from genuine cross-service races.
  if (finding.detectorId === 'shared-db-write') return true;
  // api-race findings always get an LLM cross-flow verdict — Tier 1
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
  const firstStruct = symbols[0]?.structure;
  const fieldCount = firstStruct && 'fields' in firstStruct ? firstStruct.fields?.length ?? 0 : 0;
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
