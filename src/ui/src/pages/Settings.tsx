import { useEffect, useState } from 'react';
import { Check, CircleDashed, Cpu, Loader2, X } from 'lucide-react';
import {
  getSettings,
  probeLlm,
  updateSettings,
  type AppSettings,
  type LlmHealth,
} from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';

const DETECTOR_BLURB: Record<string, string> = {
  'duplicate-type':
    'Hash-equivalent type / interface shapes across files. Surfaces accidental copies that drift independently and quietly diverge.',
  'duplicate-function':
    'Function bodies that hash-equal across files (after identifier normalisation). The pair was either copy-pasted or one was meant to be deleted after a refactor.',
  'dead-module':
    'Files in the workspace that no other file imports, after honouring entry-point conventions (index.ts, IaC handlers, framework decorators).',
  'dead-export':
    'Named exports nobody imports. Candidates for deletion or for downgrading to a file-local declaration.',
  'dead-handler':
    'Handlers declared in IaC (Serverless / SST / CDK / Lambda) whose `handler:` path does not resolve to a real exported function.',
  'mutation':
    'Shared-state mutation surfaces (rate-limiters, in-memory caches, singleton config) that get written from multiple sites — the foundation race-condition / api-race look at.',
  'race-condition':
    'Read-modify-write sequences crossing an `await` boundary on a shared resource. Tier-3 LLM confirms each candidate.',
  'shared-db-write':
    'Two or more code paths writing the same database column without coordination. Tier-3 LLM filters trivial cases.',
  'api-race':
    'Two routes mutating the same key/resource without a lock or transactional boundary. Race-window snippet emitted to the dashboard.',
  'bad-config':
    'TypeScript, ESLint and Biome configuration anti-patterns: `strict:false`, `noImplicitAny:false`, `@typescript-eslint/no-explicit-any:off`, missing `noUncheckedIndexedAccess`, error-suppression flags, target ES3/ES5, CommonJS module, …',
  'silent-catch':
    'Empty `catch` blocks or catches that only `console.log` / return silently. These swallow errors with no telemetry path and are the most common root cause of "it just stopped working" incidents.',
  'skip-tests':
    '`describe.skip` / `it.skip` / `xdescribe` (silenced suites) and `.only` / `fdescribe` (CI runs only this one) left in *.test files. `.only` is HIGH because merging it disables the whole suite.',
  'long-file':
    'Files past 400 / 700 / 1200 effective lines (excluding pure-comment lines). Long files are hard to navigate, hard to test, and accumulate unrelated concerns.',
  'long-function':
    'Functions past 60 / 120 / 200 source lines. Long functions usually want to be table-driven, polymorphic, or split. Test bodies (describe/it/test) are exempt.',
  'console-log-prod':
    '`console.log`, `console.debug`, `console.info` in non-test source. Routes around the project logger so severity / redaction / sampling all get bypassed.',
  'magic-numbers':
    'Numeric literals (not 0/1/-1/2/10/100/1000) appearing inline in business logic. Re-readers must guess what the number represents — extract a named constant.',
  'deep-nesting':
    'Functions reaching ≥4 nested levels of `if` / `for` / `while` / `switch` / `try`. Past depth 4 the reader has to track too many active conditions at once.',
  'public-any':
    '`any` in the signature of an exported function (param or return type). Every caller silently loses type-safety on that boundary.',
  'mutable-globals':
    'Top-level `let` / `var` reassigned at runtime. Module-scope mutation is shared by every importer and is a notorious cross-test pollution / SSR-hydration bug source.',
  'unused-deps':
    '`dependencies` or `peerDependencies` in `package.json` that no file across the workspace imports. Inflates lockfile + install footprint and complicates security audits.',
  'hot-hub-file':
    'Files imported by more than 20 other files. Hubs concentrate change-blast-radius — every refactor of this file ripples across the whole workspace.',
  'similar-functions':
    'Cluster of functions that look like variants of the same thing — name tokens + body shingles measured together. Catches `getDbConnection` ↔ `databaseConnection`, picks the newest / largest copy as canonical, and proposes extracting the cluster into a shared package when it spans multiple directories.',
  'todo-comments':
    'Inline `TODO` / `FIXME` / `HACK` / `XXX` / `BUG` / `NOTE` / `REVIEW` / `DEPRECATED` comments across source. Surfaces accumulated tech-debt the team forgot about. FIXME / HACK / XXX are MED, TODO / NOTE / DEPRECATED are LOW.',
};

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [llm, setLlm] = useState<LlmHealth | null>(null);
  const [llmBusy, setLlmBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    getSettings().then(setSettings).catch((e: Error) => setErr(e.message));
    void runLlmProbe();
  }, []);

  const runLlmProbe = async (): Promise<void> => {
    setLlmBusy(true);
    try {
      setLlm(await probeLlm());
    } finally {
      setLlmBusy(false);
    }
  };

  const save = async (patch: { detectors?: Record<string, boolean>; minConfidence?: number; llmConcurrency?: number }): Promise<void> => {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await updateSettings(patch);
      // Merge over the previous snapshot so a partial server response
      // (older servers, edge proxies) can't strip `allDetectors` /
      // `comingSoon` / `hardware` / `llm` and blank the page.
      setSettings((prev) => (prev ? { ...prev, ...updated } : updated));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleDetector = (id: string, on: boolean): void => {
    if (!settings) return;
    // Optimistic local update for snappy UI; the POST reconciles state.
    setSettings({ ...settings, detectors: { ...settings.detectors, [id]: on } });
    void save({ detectors: { [id]: on } });
  };

  const setMinConfidence = (v: number): void => {
    if (!settings) return;
    setSettings({ ...settings, minConfidence: v });
  };

  const commitMinConfidence = (): void => {
    if (!settings) return;
    void save({ minConfidence: settings.minConfidence });
  };

  const setLlmConcurrency = (v: number): void => {
    if (!settings) return;
    setSettings({ ...settings, llmConcurrency: v });
  };

  const commitLlmConcurrency = (): void => {
    if (!settings) return;
    void save({ llmConcurrency: settings.llmConcurrency });
  };

  if (err && !settings) return <div className="text-high">error: {err}</div>;

  return (
    <div className="space-y-6 max-w-screen-lg">
      <SectionHeader
        eyebrow="SETTINGS · IN-PROCESS · NO DAEMON RESTART"
        title={<span className="text-ink">Workspace, detectors, Tier-3 model.</span>}
        meta={
          saving ? (
            <span className="text-xs font-mono text-muted inline-flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> saving…
            </span>
          ) : (
            <span className="text-xs font-mono text-muted">
              persisted to ~/.rothunter/settings.json
            </span>
          )
        }
      />

      {/* Detectors */}
      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
          <CircleDashed size={14} className="text-accent self-center" />
          <span className="text-sm font-semibold text-ink">Detectors</span>
          <span className="text-xs text-muted font-mono">
            {settings ? `${enabledCount(settings)} of ${settings.allDetectors.length} on` : '…'}
          </span>
        </header>
        <ul className="divide-y divide-border-soft">
          {settings?.allDetectors.map((id) => {
            const on = settings.detectors[id] !== false;
            return (
              <li key={id} className="px-5 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-ink">{id}</div>
                  <div className="text-[11px] text-muted mt-0.5">{DETECTOR_BLURB[id] ?? '—'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => toggleDetector(id, !on)}
                  aria-pressed={on}
                  className={
                    'relative w-10 h-5 rounded-full transition-colors shrink-0 ' +
                    (on ? 'bg-accent' : 'bg-border')
                  }
                >
                  <span
                    className={
                      'absolute top-0.5 w-4 h-4 rounded-full bg-panel transition-all shadow ' +
                      (on ? 'left-[1.375rem]' : 'left-0.5')
                    }
                  />
                </button>
              </li>
            );
          })}
        </ul>

        {settings && (
          <div className="px-5 py-4 border-t border-border-soft">
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-xs font-mono text-ink" htmlFor="minconf">
                min confidence (Tier-1 + Tier-2 floor)
              </label>
              <span className="text-xs font-mono text-accent tabular-nums">
                {settings.minConfidence.toFixed(2)}
              </span>
            </div>
            <input
              id="minconf"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
              onMouseUp={commitMinConfidence}
              onTouchEnd={commitMinConfidence}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[10px] text-muted font-mono mt-1">
              <span>0.00 · everything</span>
              <span>1.00 · only certain</span>
            </div>
          </div>
        )}

        {settings?.comingSoon && settings.comingSoon.length > 0 && (
          <div className="border-t border-border-soft">
            <header className="px-5 py-2.5 flex items-baseline gap-2 bg-bg/40">
              <span className="text-[10px] uppercase tracking-widest text-muted font-mono">coming soon</span>
            </header>
            <ul className="divide-y divide-border-soft">
              {settings.comingSoon.map((c) => (
                <li key={c.id} className="px-5 py-3 flex items-center gap-4 opacity-60">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-ink flex items-center gap-2">
                      {c.id}
                      <span className="text-[9px] uppercase tracking-widest text-accent font-mono rounded border border-accent/40 px-1 py-0.5">
                        soon
                      </span>
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">{c.blurb}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Tier-3 LLM */}
      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3 flex-wrap">
          <Cpu size={14} className="text-accent self-center" />
          <span className="text-sm font-semibold text-ink">Tier-3 model</span>
          <span className="text-xs text-muted font-mono">local llama.cpp sidecar</span>
          {settings?.hardware && (
            <span className="text-[10px] text-muted font-mono">
              · host {settings.hardware.cpuCores}c / {Math.round(settings.hardware.totalMemMb / 1024)}GB
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-mono">
            {llmBusy ? (
              <Loader2 size={11} className="animate-spin text-muted" />
            ) : llm?.ok ? (
              <>
                <span className="w-2 h-2 rounded-full bg-accent" />
                <span className="text-accent">reachable</span>
                {llm.latencyMs != null && <span className="text-muted">· {llm.latencyMs}ms</span>}
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-high" />
                <span className="text-high">unreachable</span>
              </>
            )}
          </span>
        </header>
        <dl className="px-5 py-4 grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-y-2 gap-x-4 text-xs">
          <dt className="text-muted font-mono">endpoint</dt>
          <dd className="font-mono text-ink break-all">{settings?.llm.baseUrl ?? '—'}</dd>
          <dt className="text-muted font-mono">model</dt>
          <dd className="font-mono text-ink break-all">{settings?.llm.model ?? '—'}</dd>
        </dl>
        <div className="px-5 pb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runLlmProbe()}
            disabled={llmBusy}
            className="px-2.5 py-1 rounded text-xs font-medium border border-border bg-bg hover:bg-panel text-ink flex items-center gap-1.5 disabled:opacity-40"
          >
            {llmBusy ? <Loader2 size={11} className="animate-spin" /> : null}
            Test reach
          </button>
          {llm && !llm.ok && llm.error && (
            <span className="text-xs font-mono text-high inline-flex items-center gap-1.5">
              <X size={11} /> {llm.error}
            </span>
          )}
          {llm?.ok && (
            <span className="text-xs font-mono text-muted inline-flex items-center gap-1.5">
              <Check size={11} className="text-accent" /> healthy
            </span>
          )}
        </div>
        {settings && (
          <div className="px-5 py-4 border-t border-border-soft">
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <label className="text-xs font-mono text-ink" htmlFor="llmconc">
                LLM concurrency (parallel verdicts in flight)
              </label>
              <span className="text-xs font-mono text-accent tabular-nums">
                {settings.llmConcurrency} ×
              </span>
            </div>
            <input
              id="llmconc"
              type="range"
              min={1}
              max={16}
              step={1}
              value={settings.llmConcurrency}
              onChange={(e) => setLlmConcurrency(parseInt(e.target.value, 10))}
              onMouseUp={commitLlmConcurrency}
              onTouchEnd={commitLlmConcurrency}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[10px] text-muted font-mono mt-1">
              <span>1 · sequential</span>
              <span>16 · max</span>
            </div>
            <div className="mt-3 rounded border border-border-soft bg-bg px-3 py-2 text-[11px] text-muted font-mono leading-relaxed">
              Set to match the LLM backend's batching capacity:
              <br />· <span className="text-ink">llama.cpp</span> — run with `--parallel N -cb` and pick the same N here.
              <br />· <span className="text-ink">vLLM (CUDA)</span> — dynamic batching is on by default, 4–16 is safe.
              <br />· <span className="text-ink">mlx_lm.server</span> — serialises internally; keep at 1.
              <br />Auto-tuned to half the CPU cores on first boot.
            </div>
          </div>
        )}
        <div className="px-5 pb-4">
          <div className="rounded border border-border-soft bg-bg px-3 py-2 text-[11px] text-muted font-mono">
            endpoint + model are env-driven for now (`ROTHUNTER_LLM_BASE_URL`,
            `ROTHUNTER_LLM_MODEL`). Changing them requires a server restart.
            In-process switching is on the v0.5 roadmap.
          </div>
        </div>
      </section>
    </div>
  );
}

function enabledCount(s: AppSettings): number {
  return s.allDetectors.reduce((n, id) => (s.detectors[id] !== false ? n + 1 : n), 0);
}
