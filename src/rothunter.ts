import * as path from 'node:path';
import * as fs from 'node:fs';
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
import { detectTestsWithoutAssertion } from './detectors/test-without-assertion.js';
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
import { detectReExportShadows } from './detectors/re-export-shadow.js';
import { detectDefaultExportNameDrift } from './detectors/default-export-name-drift.js';
import { detectEnvVarUndeclared } from './detectors/env-var-undeclared.js';
import { TypeScriptParser, type ParseOptions } from './parsers/typescript-parser.js';
import { TypeNormalizer } from './normalizers/type-normalizer.js';
import { buildImportGraph, reachableFrom } from './graph/import-graph.js';
import { discoverEntryPoints, isPublishedLibrary } from './graph/entry-points.js';
import { readProjectConventions } from './utils/project-conventions.js';
import { resolveIacEntryFiles } from './graph/iac-entries.js';
import { resolveDecoratorEntryFiles } from './graph/decorator-entries.js';
import type { Detector, Finding, SymbolRecord } from './types.js';
import type { LlmClient } from './adapters/llm.js';
import { loadRotHunterConfig, type WorkspaceConfig } from './config.js';
import { Project } from 'ts-morph';
import { scanWorkspaces } from './multi-workspace-scanner.js';

export interface RotHunterRunOptions extends ParseOptions {
  /** Drop a finding below `severity:'low'` when post-LLM confidence falls under this threshold. */
  llmRejectionThreshold?: number;
  /** Override the LLM client (tests, alternative model pools). Production uses the default LlmClient. */
  llm?: LlmClient;
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
   * batching is on by default).
   *
   * Defaults to `ROTHUNTER_LLM_CONCURRENCY` env var, then 1.
   */
  llmConcurrency?: number;
  /**
   * Confidence floor at which a negative LLM verdict routes a finding
   * into the auto-FP bucket. Defaults to `LLM_FP_THRESHOLD` (0.6) — set
   * lower to be more aggressive (almost every "intentional" LLM call
   * auto-FPs) or higher (only very-confident verdicts route, the rest
   * stay open at degraded confidence).
   */
  llmAutoFpThreshold?: number;
  /**
   * Optional callback invoked at scan checkpoints. Used by the rothunter
   * HTTP server to stream live progress over SSE. Never throws — exceptions
   * inside the callback are caught and logged.
   */
  onProgress?: (event: ScanProgressEvent) => void;
  /**
   * Optional cooperative cancellation. The orchestrator checks
   * `abortSignal.aborted` between LLM verdict tasks and aborts the
   * worker pool when the signal fires. Used by the HTTP server's
   * /api/scans/:scanId/cancel endpoint to free the scan slot promptly
   * instead of relying on the (lossy) "throw inside onProgress" path.
   */
  abortSignal?: AbortSignal;
}

// SSE-emitted scan-lifecycle events.
export type ScanProgressEvent =
  | { state: 'parsing'; files?: number; symbols?: number }
  | { state: 'detecting'; detector: string }
  | { state: 'llm-start'; total: number }
  | {
      state: 'llm-verdict';
      done: number;
      total: number;
      detectorId: string;
      race: boolean;
      confidence: number;
      reason: string;
      latencyMs: number;
      cluster?: string;
    }
  | { state: 'done'; findings: number; durationMs: number };

export interface RotHunterResult {
  symbols: SymbolRecord[];
  findings: Finding[];
  durationMs: number;
}

export class RotHunter {
  private parser = new TypeScriptParser();
  private normalizer = new TypeNormalizer();
  private detectors: Detector[] = [new DuplicateTypeDetector(), new DuplicateFunctionDetector()];

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
    findings.push(...detectDeadExports({ symbols, imports: parsed.imports, entryPoints }));

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
    logger.info({ imports: parsed.imports.length }, 'RotHunter: running detector re-export-shadow');
    emit({ state: 'detecting', detector: 're-export-shadow' });
    findings.push(...detectReExportShadows({ symbols, imports: parsed.imports }));
    logger.info(
      { symbols: symbols.length },
      'RotHunter: running detector default-export-name-drift',
    );
    emit({ state: 'detecting', detector: 'default-export-name-drift' });
    findings.push(...detectDefaultExportNameDrift({ symbols, imports: parsed.imports }));

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
              target:
                i.target && i.targetWorkspace === ws.name ? stripPrefix(i.target, wsPrefix) : null,
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
            // identically-named files don't collide in the FP store.
            f.fingerprint = `${ws.name}:${f.fingerprint}`;
          }
          findings.push(...wsFindings);
        }
        // Cross-workspace race-condition pass. shared-db-write +
        // api-race fire when ≥ 2 distinct files write the same DB
        // column / hit the same API endpoint — exactly the cross-
        // service race shape that lives between packages in a
        // monorepo (billing-service writes user.tier in one repo,
        // account-service writes it from another). Running these
        // per-workspace misses every cross-service race because each
        // package has only one writer locally.
        const crossFindings = await runCrossWorkspaceRaceDetectors(config.workspaces, emit);
        findings.push(...crossFindings);
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
      Math.min(
        16,
        Math.floor(opts.llmConcurrency ?? (Number.isFinite(envConc) && envConc > 0 ? envConc : 1)),
      ),
    );
    await this.runLlmConfirmation(
      findings,
      symbols,
      threshold,
      opts.llm,
      emit,
      llmConcurrency,
      opts.abortSignal,
      opts.workspaceRoot,
      opts.llmAutoFpThreshold,
    );

    const durationMs = Date.now() - startedAt;
    emit({ state: 'done', findings: findings.length, durationMs });
    return {
      symbols,
      findings,
      durationMs,
    };
  }

  private async runLlmConfirmation(
    findings: Finding[],
    symbols: SymbolRecord[],
    threshold: number,
    injectedLlm?: LlmClient,
    emit?: (event: ScanProgressEvent) => void,
    concurrency = 1,
    abortSignal?: AbortSignal,
    workspaceRoot?: string,
    llmAutoFpThreshold?: number,
  ): Promise<void> {
    const autoFpThreshold = llmAutoFpThreshold ?? LLM_FP_THRESHOLD;
    const { LlmConfirmer } = await import('./extraction/llm-confirmer.js');
    const { MutationConfirmer } = await import('./extraction/mutation-confirmer.js');
    const { RaceConfirmer } = await import('./extraction/race-confirmer.js');
    const { SharedDbWriteConfirmer } = await import('./extraction/shared-db-write-confirmer.js');
    const { ApiRaceConfirmer } = await import('./extraction/api-race-confirmer.js');
    const { TriageConfirmer } = await import('./extraction/triage-confirmer.js');
    const { createDefaultLlmClient } = await import('./adapters/llm.js');

    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    const candidates = findings.filter((f) => requiresLlmConfirmation(f, symbolById));

    if (candidates.length === 0) return;

    const llm = injectedLlm ?? createDefaultLlmClient();
    logger.info({ count: candidates.length }, 'RotHunter: warming up LLM');
    const llmReady = await llm.warmup();
    if (!llmReady) {
      // No LLM reachable — skip the confirmation pass entirely so we
      // don't burn N × verdict-timeout on a scan that has no oracle.
      // Findings stay at their deterministic severity / confidence.
      logger.warn(
        { count: candidates.length },
        'RotHunter: LLM warmup failed; skipping confirmation pass',
      );
      emit?.({ state: 'llm-start', total: 0 });
      return;
    }
    const dupConfirmer = new LlmConfirmer(llm);
    const mutationConfirmer = new MutationConfirmer(llm);
    const raceConfirmer = new RaceConfirmer(llm);
    const sharedDbConfirmer = new SharedDbWriteConfirmer(llm);
    const apiRaceConfirmer = new ApiRaceConfirmer(llm);
    const triageConfirmer = new TriageConfirmer(llm);
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

        const projectConv = workspaceRoot
          ? readProjectConventions(workspaceRoot, a.file)
          : undefined;
        const result = await dupConfirmer.confirmSameConcept(a, b, projectConv);
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
          // Same auto-FP routing as TriageConfirmer-driven detectors:
          // a high-confidence negative verdict means the LLM is sure
          // these are not the same concept (framework idiom, env-helper
          // symmetry that project conventions endorse, …) — moving
          // them out of the open list matches the user's expectation.
          if (result.confidence >= autoFpThreshold) {
            finding.llmFalsePositive = {
              confidence: result.confidence,
              reason: result.reason,
            };
          }
        }
        reportVerdict(
          finding,
          result.same_concept,
          result.confidence,
          result.reason,
          Date.now() - verdictStart,
        );
      } else if (finding.detectorId === 'api-race') {
        // Cluster meta lives in evidence[].note as JSON (emitted by the
        // detector). Title is human-facing only — never re-parse it.
        const first = parseEvidenceNote<{ method?: string; pathPattern?: string }>(
          finding.evidence[0],
        );
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
          {
            threshold,
            positiveLabel: 'real cross-flow API race',
            negativeLabel: 'safe',
            autoFpThreshold,
          },
        );
        reportVerdict(
          finding,
          verdict.race,
          verdict.confidence,
          verdict.reason,
          Date.now() - verdictStart,
        );
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
          {
            threshold,
            positiveLabel: 'real cross-flow race',
            negativeLabel: 'safe',
            autoFpThreshold,
          },
        );
        reportVerdict(
          finding,
          verdict.race,
          verdict.confidence,
          verdict.reason,
          Date.now() - verdictStart,
        );
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
          { threshold, positiveLabel: 'real race', negativeLabel: 'safe', autoFpThreshold },
        );
        reportVerdict(
          finding,
          verdict.race,
          verdict.confidence,
          verdict.reason,
          Date.now() - verdictStart,
        );
      } else if (finding.detectorId === 'mutation') {
        const ev = finding.evidence[0];
        if (!ev || !ev.note) return;
        let meta: {
          enclosingSource?: string;
          enclosingName?: string;
          pattern?: string;
          escapes?: boolean;
        };
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
          {
            positive: !verdict.intentional,
            confidence: verdict.confidence,
            reason: verdict.reason,
          },
          {
            threshold,
            positiveLabel: 'potential bug',
            negativeLabel: 'intentional',
            autoFpThreshold,
          },
        );
        reportVerdict(
          finding,
          !verdict.intentional,
          verdict.confidence,
          verdict.reason,
          Date.now() - verdictStart,
        );
      } else if (TRIAGE_DETECTORS.has(finding.detectorId)) {
        // Generic real-vs-FP triage for detectors with no cluster
        // confirmer of their own. For reachability + hub detectors we
        // ALSO pass structural context (sibling signatures, file role)
        // so the LLM can answer "is this used through a type surface
        // or framework convention" without guessing from the snippet.
        const ev = finding.evidence[0];
        if (!ev) return;
        const verdict = await triageConfirmer.confirm({
          detectorId: finding.detectorId,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          suggestion: finding.suggestion,
          evidenceFile: ev.file,
          evidenceStartLine: ev.range.startLine,
          evidenceEndLine: ev.range.endLine,
          evidenceSnippet: ev.snippet,
          extraContext: buildTriageContext(finding, symbolById, workspaceRoot),
        });
        if (!verdict) return;
        applyClusterVerdict(
          finding,
          { positive: verdict.real, confidence: verdict.confidence, reason: verdict.reason },
          {
            threshold,
            positiveLabel: 'real defect',
            negativeLabel: 'intentional pattern',
            autoFpThreshold,
          },
        );
        reportVerdict(
          finding,
          verdict.real,
          verdict.confidence,
          verdict.reason,
          Date.now() - verdictStart,
        );
      }
    };

    // Run with a small worker pool. Each "worker" pulls the next finding
    // off the shared cursor and awaits its verdict — the LLM backend
    // dictates real throughput (llama.cpp `--parallel N -cb`, vLLM dynamic
    // batching). Concurrency 1 reproduces the original sequential flow.
    //
    // Cancellation: workers re-check `abortSignal.aborted` before
    // every verdict task. This is the only reliable abort path — the
    // old "throw inside onProgress" trick was swallowed by `emit()`'s
    // catch and never reached the pool, so cancelled scans kept
    // burning LLM calls (and blocking the queue) until they ran out
    // of findings.
    logger.info({ concurrency }, 'RotHunter: LLM concurrency');
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        if (abortSignal?.aborted) return;
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
    if (abortSignal?.aborted) {
      throw new Error('scan cancelled by operator');
    }
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

/**
 * Run shared-db-write + api-race once across EVERY package in a
 * monorepo so cross-service races (different packages writing the
 * same DB column / hitting the same endpoint) are caught. The per-
 * workspace pass cannot see them because each package has only one
 * writer locally — the race lives at the merged-set level.
 *
 * Evidence file paths are emitted as `packages/<pkg>/src/...`
 * (workspace-relative against the monorepo root), so the dashboard
 * shows the literal filesystem location of each writer.
 */
async function runCrossWorkspaceRaceDetectors(
  workspaces: WorkspaceConfig[],
  emit: (event: ScanProgressEvent) => void,
): Promise<Finding[]> {
  if (workspaces.length < 2) return [];
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: 4 /* preserve */ },
  });
  for (const ws of workspaces) {
    project.addSourceFilesAtPaths([
      `${ws.rootAbs}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`,
      `!${ws.rootAbs}/**/node_modules/**`,
      `!${ws.rootAbs}/**/dist/**`,
      `!${ws.rootAbs}/**/build/**`,
    ]);
  }
  // Common root for all workspaces — used so detector evidence paths
  // come out as `packages/<pkg>/src/...` instead of an absolute path.
  const root = commonAncestor(workspaces.map((w) => w.rootAbs));
  // Map each workspace's absolute path (made relative to `root`) to
  // the workspace name. Used to bucket finding evidence per workspace
  // so we can drop intra-workspace findings — those are already
  // emitted by the per-workspace pass and would otherwise double-count.
  const wsByRelRoot = new Map<string, string>();
  for (const ws of workspaces) {
    const rel = path.relative(root, ws.rootAbs);
    wsByRelRoot.set(rel === '' ? '.' : rel, ws.name);
  }
  const out: Finding[] = [];
  emit({ state: 'detecting', detector: 'cross-shared-db-write' });
  out.push(
    ...detectSharedDbWrites({ workspaceRoot: root, files: [], project })
      .filter((f) => spansMultipleWorkspaces(f, wsByRelRoot))
      .map(tagCross),
  );
  emit({ state: 'detecting', detector: 'cross-api-race' });
  out.push(
    ...detectApiRaces({ workspaceRoot: root, files: [], project })
      .filter((f) => spansMultipleWorkspaces(f, wsByRelRoot))
      .map(tagCross),
  );
  return out;
}

/**
 * True when the finding's evidence covers ≥ 2 distinct workspaces.
 * Used to keep the cross-workspace pass from re-emitting findings the
 * per-workspace pass already produced — those have all their evidence
 * under a single workspace name and would otherwise show up twice
 * (once workspace-namespaced, once with the `cross-ws:` prefix).
 */
function spansMultipleWorkspaces(
  finding: Finding,
  wsByRelRoot: ReadonlyMap<string, string>,
): boolean {
  const wsHit = new Set<string>();
  for (const ev of finding.evidence) {
    const file = ev.file.split('\\').join('/');
    for (const [relRoot, name] of wsByRelRoot) {
      const prefix = relRoot === '.' ? '' : `${relRoot}/`;
      if (relRoot === '.' || file.startsWith(prefix)) {
        wsHit.add(name);
        break;
      }
    }
    if (wsHit.size >= 2) return true;
  }
  return wsHit.size >= 2;
}

function tagCross(f: Finding): Finding {
  // Distinct fingerprint prefix so cross-workspace findings never
  // collide with same-detector findings from the per-workspace pass.
  return { ...f, fingerprint: `cross-ws:${f.fingerprint}` };
}

function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0]!;
  const split = paths.map((p) => p.split('/'));
  const min = Math.min(...split.map((s) => s.length));
  const out: string[] = [];
  for (let i = 0; i < min; i++) {
    const seg = split[0]![i]!;
    if (split.every((s) => s[i] === seg)) out.push(seg);
    else break;
  }
  return out.join('/') || '/';
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
    detectMutations({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('race-condition', () =>
    detectRaceConditions({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('shared-db-write', () =>
    detectSharedDbWrites({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('api-race', () =>
    detectApiRaces({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('bad-config', () => detectBadConfig({ workspaceRoot: ctx.workspaceRoot, files }));
  run('silent-catch', () =>
    detectSilentCatches({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('skip-tests', () =>
    detectSkipTests({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('test-without-assertion', () =>
    detectTestsWithoutAssertion({
      workspaceRoot: ctx.workspaceRoot,
      files,
      project: sharedProject,
    }),
  );
  run('long-file', () =>
    detectLongFiles({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('console-log-prod', () =>
    detectConsoleLogsInProd({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('magic-numbers', () =>
    detectMagicNumbers({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('mutable-globals', () =>
    detectMutableGlobals({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );
  run('unused-deps', () =>
    detectUnusedDeps({ workspaceRoot: ctx.workspaceRoot, imports: importsArr }),
  );
  run('similar-functions', () =>
    detectSimilarFunctions({ workspaceRoot: ctx.workspaceRoot, symbols: symbolsArr }),
  );
  // todo-comments does its own workspace walk so it picks up Python / Go /
  // shell sources the TS parser skips. No `files` arg by design.
  run('todo-comments', () => detectTodoComments({ workspaceRoot: ctx.workspaceRoot }));
  run('env-var-undeclared', () =>
    detectEnvVarUndeclared({ workspaceRoot: ctx.workspaceRoot, files, project: sharedProject }),
  );

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
  opts: {
    threshold: number;
    positiveLabel: string;
    negativeLabel: string;
    /** Auto-FP routing floor. Defaults to LLM_FP_THRESHOLD (0.6). */
    autoFpThreshold?: number;
  },
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
    // High-confidence "intentional" / "not real" verdict — auto-route to
    // the FP bucket so the user does not have to manually mark each one.
    // The detector pattern matched but the LLM saw the surrounding intent
    // (accumulator parameter, deliberate-swallow comment, framework idiom,
    // …). Surfacing it as an open finding teaches the user that high
    // verdict confidence means nothing — exactly the rothunter-vs-lint
    // differentiator we want to preserve.
    if (verdict.confidence >= (opts.autoFpThreshold ?? LLM_FP_THRESHOLD)) {
      finding.llmFalsePositive = {
        confidence: verdict.confidence,
        reason: verdict.reason,
      };
    }
  }
  finding.layer = 3;
}

/**
 * Verdict-confidence floor at which a negative LLM verdict moves a
 * finding into the auto-FP bucket. Set low (0.6) so any reasonably
 * confident "intentional / FP" verdict routes the finding out of the
 * open list — the operator's stated preference is "if the LLM says
 * FP, treat it as auto FP, I'll un-mark if it's wrong". Below 0.6 the
 * LLM is genuinely undecided and the deterministic finding stays in
 * the open list at degraded confidence.
 */
export const LLM_FP_THRESHOLD = 0.6;

/**
 * Build per-detector structural context to attach to a TriageConfirmer
 * call. The shape is free-form text — the LLM reads it alongside the
 * primary evidence snippet — so we can evolve enrichment without
 * version-coupling the triage schema. Returns `undefined` when no
 * useful context is available so the prompt stays compact.
 */
export function buildTriageContext(
  finding: Finding,
  symbolById: Map<string, SymbolRecord>,
  workspaceRoot?: string,
): string | undefined {
  const ev = finding.evidence[0];
  if (!ev) return undefined;
  const parts: string[] = [];
  // Project conventions block: nearest CLAUDE.md walking up from the
  // evidence file. Universally prepended to every triage call — it is
  // the single biggest signal for "is this pattern intentional in
  // THIS codebase". A rule like "three similar lines better than
  // premature abstraction" turns duplicate-function on Commander
  // command registrations into an auto-FP without per-detector code.
  if (workspaceRoot) {
    const conv = readProjectConventions(workspaceRoot, ev.file);
    if (conv) {
      parts.push(
        `Project conventions (concatenated from CLAUDE.md / AGENTS.md / .cursorrules / copilot-instructions.md / CONTRIBUTING.md / … as present — treat as authoritative for this codebase, override generic best-practice when they conflict):\n${conv}`,
      );
    }
  }
  // Per-detector structural hints.
  const detectorContext = buildDetectorContext(finding, ev, symbolById, workspaceRoot);
  if (detectorContext) parts.push(detectorContext);
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function buildDetectorContext(
  finding: Finding,
  ev: Finding['evidence'][number],
  symbolById: Map<string, SymbolRecord>,
  workspaceRoot?: string,
): string | undefined {
  if (finding.detectorId === 'dead-export') {
    return buildDeadExportContext(finding, ev.file, symbolById, workspaceRoot);
  }
  if (finding.detectorId === 'magic-numbers' && workspaceRoot) {
    return buildMagicNumbersContext(ev.file, ev.range.startLine, workspaceRoot, symbolById);
  }
  if (finding.detectorId === 'hot-hub-file') {
    return 'This file is being flagged as an import hub. Decide whether the project deliberately keeps it as a single import surface (barrel / type surface) or whether it accumulates unrelated concerns.';
  }
  if (finding.detectorId === 'long-file') {
    return 'Look at the snippet shape: a recognizer / config / pattern TABLE is single-concern locality and FALSE positive; mixed unrelated logic accumulating across many features is REAL.';
  }
  if (finding.detectorId === 'todo-comments') {
    return 'Discriminate actionable TODO / FIXME / HACK / XXX from documentary NOTE comments. A NOTE that explains a design decision in adjacent code is documentation, not technical debt.';
  }
  return undefined;
}

/**
 * For a magic-numbers finding, return: the enclosing function /
 * method signature (so the LLM sees what domain the literal is in),
 * an ±8 line code window, and the leading JSDoc-style comment block
 * if one is present immediately above the enclosing function. The
 * snippet the detector emits is only the matching line — context is
 * too thin for the LLM to judge whether `12`, `127`, or `425` is a
 * domain constant, a regex internal, or a real magic number.
 */
function buildMagicNumbersContext(
  file: string,
  line: number,
  workspaceRoot: string,
  symbolById: Map<string, SymbolRecord>,
): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, file), 'utf-8');
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  // Find the symbol that contains this line — gives us the enclosing
  // function/method signature regardless of indentation depth.
  let enclosingSig: string | undefined;
  let enclosingDoc: string | undefined;
  for (const s of symbolById.values()) {
    if (s.file !== file) continue;
    if (line < s.range.startLine || line > s.range.endLine) continue;
    // Prefer the tightest match (deepest nesting).
    if (
      enclosingSig &&
      s.range.endLine - s.range.startLine >
        lines.findIndex((_, i) => i + 1 === line) - s.range.startLine
    ) {
      continue;
    }
    enclosingSig = (lines[s.range.startLine - 1] ?? '').trim();
    // Walk upward from the symbol decl for a contiguous comment block
    // — JSDoc usually lives on the line(s) immediately above the
    // signature.
    const docLines: string[] = [];
    for (let i = s.range.startLine - 2; i >= 0; i--) {
      const t = (lines[i] ?? '').trim();
      if (t === '' || (!t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'))) break;
      docLines.unshift(t);
    }
    if (docLines.length > 0) enclosingDoc = docLines.join('\n');
  }
  // Pull ±8 lines around the literal for surrounding context.
  const winFrom = Math.max(0, line - 1 - 8);
  const winTo = Math.min(lines.length, line - 1 + 8);
  const window = lines
    .slice(winFrom, winTo + 1)
    .map((l, i) => `${winFrom + i + 1 === line ? '>' : ' '} ${winFrom + i + 1}: ${l}`)
    .join('\n');
  const parts: string[] = [];
  if (enclosingSig) parts.push(`Enclosing function signature:\n\`${enclosingSig}\``);
  if (enclosingDoc) parts.push(`Doc comment on the enclosing function:\n${enclosingDoc}`);
  parts.push(`Code window (\`>\` marks the flagged line):\n\`\`\`\n${window}\n\`\`\``);
  parts.push(
    'Decide using the enclosing function + module name. If the literal is a domain constant local to this validator / encoder / parser (base58 lengths, IPv4 octets, ASCII boundary 127, retry-backoff thresholds, framework status codes) the answer is FALSE — naming each one inflates the binding count without clarifying anything. Flag REAL only when the literal is genuinely opaque business logic that a reader would have to guess about.',
  );
  return parts.join('\n\n');
}

/**
 * Render up to 6 sibling exports from the same file as signature
 * snippets so the LLM can answer "is this type-surface reachable
 * through another exported symbol's signature?" — a question pure
 * named-import counting can't answer.
 */
function buildDeadExportContext(
  finding: Finding,
  file: string,
  symbolById: Map<string, SymbolRecord>,
  workspaceRoot?: string,
): string | undefined {
  // Extract the export name from the title — detector emits
  // `Unused export: <name> in <file>`.
  const m = /Unused export:\s*(\S+)/i.exec(finding.title);
  const targetName = m?.[1];
  const siblings: string[] = [];
  for (const s of symbolById.values()) {
    if (s.file !== file) continue;
    if (!s.exported) continue;
    if (s.name === targetName) continue;
    // First non-blank line of the source — usually the declaration
    // signature for interfaces / functions / classes.
    const firstLine = s.source.split('\n').find((ln) => ln.trim().length > 0) ?? '';
    if (firstLine)
      siblings.push(`- ${s.kind} \`${s.name}\`: \`${firstLine.trim().slice(0, 160)}\``);
    if (siblings.length >= 6) break;
  }
  const parts: string[] = [];
  if (siblings.length > 0) {
    parts.push(
      `Other exports in the same file (\`${file}\`):\n${siblings.join('\n')}\n\nIf \`${targetName ?? 'this symbol'}\` appears in any of those signatures (return type, parameter, generic constraint, extends clause) it is reachable through the public type surface and a FALSE positive.`,
    );
  }
  // Published-library mode: when the workspace ships as an npm package
  // (has name + version, not private, declares main/module/exports/bin),
  // every top-level export is potentially public API surface for
  // downstream consumers. The detector cannot statically see those
  // consumers — they live in other repos — so the LLM has to weigh
  // "looks like part of a public utility set" against "genuinely dead
  // internal helper". Tell it which workspace shape we're in.
  if (workspaceRoot && isPublishedLibrary(workspaceRoot)) {
    parts.push(
      `Workspace shape: PUBLISHED npm LIBRARY (package.json has name + version, not private, declares an entry surface). Downstream consumers in OTHER repositories may import \`${targetName ?? 'this symbol'}\` even though no file inside THIS repo does. Lean toward FALSE positive when the symbol fits the library's domain (env-helper symmetry alongside other exports, types matching the package theme, utility functions named consistently with the published API) AND there is no obvious sign it is a stranded internal leftover (no \`@deprecated\` JSDoc, no \`unused-\` / \`legacy\` naming, no half-baked TODO).`,
    );
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
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
    method?: string;
    pathPattern?: string;
    entity?: string;
    column?: string;
    target?: string;
  }>(first);
  if (note.method && note.pathPattern) return `${note.method} ${note.pathPattern}`;
  if (note.entity && note.column) return `${note.entity}.${note.column}`;
  if (note.target) return note.target;
  return undefined;
}

// Detectors with no dedicated cluster confirmer that still benefit
// from a real-vs-false-positive LLM triage. Adding a detector here
// routes its medium / high findings through `TriageConfirmer` in
// processOne.
const TRIAGE_DETECTORS = new Set<string>([
  'silent-catch',
  'public-any',
  'mutable-globals',
  'bad-config',
  'long-function',
  'long-file',
  'magic-numbers',
  'hot-hub-file',
  'todo-comments',
  // Reachability detectors: deterministic check misses framework
  // conventions, dynamic loaders, structural type-surface — LLM with
  // a sibling-signature / importer-count snippet handles those FPs
  // far better than per-detector hand-coded rules.
  'dead-export',
  'dead-module',
  'dead-handler',
  'dead-api',
  // Similar-functions has a high syntactic-only FP rate — two unrelated
  // helpers can share an AST shape (template-literal builders, Commander
  // command registrations) without being refactor candidates. Route
  // medium-high findings through the triage confirmer so the LLM
  // judges semantic relatedness, not just shape similarity.
  'similar-functions',
]);

/**
 * Subset of TRIAGE_DETECTORS that get an LLM verdict on EVERY finding,
 * including low severity. These are detectors whose FP rate is high
 * even at the low tier — reachability misses, design-intent flags,
 * NOTE-vs-TODO discrimination — and the LLM cost is justified by the
 * noise reduction.
 *
 * For all other TRIAGE detectors the gate stays at `severity !== 'low'`
 * so we don't burn LLM calls on the deterministic-noise tier.
 */
const ALWAYS_TRIAGE_DETECTORS = new Set<string>([
  'dead-export',
  'dead-module',
  'dead-handler',
  'dead-api',
  'todo-comments',
  'hot-hub-file',
  'long-file',
  // long-function findings are emitted at 'low' severity but their
  // FP rate is heavily project-shape dependent: linear handlers /
  // composition-root components / state-machine bodies are legitimate
  // at 80–120 LOC in some projects and sin in others. The project's
  // own CLAUDE.md decides — and the only signal that surfaces that is
  // the LLM with project conventions in scope.
  'long-function',
  // Magic-numbers deterministic pass already cuts ~70% of FPs. The
  // remainder is domain-thresholds, byte-counts, ASCII boundaries —
  // every one a judgement call that the LLM can answer with a snippet.
  // Volume stays low because the per-file cap is 5.
  'magic-numbers',
]);

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
function requiresLlmConfirmation(finding: Finding, symbolById: Map<string, SymbolRecord>): boolean {
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
  // Detectors with no cluster confirmer but a high FP rate. Routed to
  // the generic TriageConfirmer for a real/false verdict + reason.
  // Two-tier gate: `ALWAYS_TRIAGE_DETECTORS` triages every finding
  // (reachability + design-intent — high FP even at low tier);
  // remaining TRIAGE detectors stay capped at medium+ so we don't
  // burn LLM calls on deterministic noise.
  if (TRIAGE_DETECTORS.has(finding.detectorId)) {
    if (ALWAYS_TRIAGE_DETECTORS.has(finding.detectorId)) return true;
    if (finding.severity !== 'low') return true;
  }
  if (finding.detectorId !== 'duplicate-type' && finding.detectorId !== 'duplicate-function')
    return false;
  if (finding.layer >= 2) return true;
  if (finding.confidence < 0.95) return true;
  const ids = finding.evidence
    .map((ev) => findSymbolIdForEvidence(symbolById, ev.file, ev.range.startLine))
    .filter((id): id is string => Boolean(id));
  const symbols = ids.map((id) => symbolById.get(id)).filter((s): s is SymbolRecord => Boolean(s));
  const distinctNames = new Set(symbols.map((s) => s.name)).size;
  const firstStruct = symbols[0]?.structure;
  const fieldCount = firstStruct && 'fields' in firstStruct ? (firstStruct.fields?.length ?? 0) : 0;
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
