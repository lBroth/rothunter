import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Check, Circle, Loader2, X } from 'lucide-react';
import type { ScanSseEvent } from '../lib/api.js';
import { cancelScan, getScan, subscribeScan } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';

interface ScanRunningProps {
  scanId: string;
  onDone: () => void;
}

interface VerdictEntry {
  ts: number;
  detectorId: string;
  cluster?: string;
  race: boolean;
  confidence: number;
  reason: string;
  latencyMs: number;
}

// Display order for the pipeline view. `symbol-graph` is a synthetic
// stage (the parsing pass that builds the symbol table); every other
// id mirrors a real detector. Kept in sync with the engine's
// detector-registry — when a new detector lands the entry needs to be
// added here AND in DETECTOR_BLURB below.
const DETECTOR_ORDER = [
  'symbol-graph',
  'duplicate-type',
  'duplicate-function',
  'dead-module',
  'dead-export',
  'dead-api',
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
];

const DETECTOR_BLURB: Record<string, string> = {
  'symbol-graph': 'symbol graph build',
  'duplicate-type': 'type-shape hashing',
  'duplicate-function': 'function-body hashing',
  'dead-module': 'module reachability',
  'dead-export': 'export reachability',
  'dead-api': 'cross-repo export reachability',
  'dead-handler': 'IaC entry resolution',
  mutation: 'shared-state mutation surfaces',
  'race-condition': 'read-modify-write across await',
  'shared-db-write': 'column-write graph',
  'api-race': 'route-table races',
  'bad-config': 'tsconfig / eslint / biome anti-patterns',
  'silent-catch': 'empty / log-only catch blocks',
  'skip-tests': '.skip / .only / xdescribe',
  'long-file': 'oversized files (LOC)',
  'long-function': 'oversized functions',
  'console-log-prod': 'console.log/debug/info in prod source',
  'magic-numbers': 'numeric literals without named constants',
  'deep-nesting': 'arrow-of-doom (>4 levels)',
  'public-any': '`any` in exported signatures',
  'mutable-globals': 'top-level let/var reassignment',
  'unused-deps': 'package.json deps never imported',
  'hot-hub-file': 'import hubs (>20 callers)',
  'similar-functions': 'fuzzy fn clusters · canonical pick · package candidate',
  'todo-comments': 'TODO / FIXME / HACK / XXX inline comments',
};

export function ScanRunning({ scanId, onDone }: ScanRunningProps): JSX.Element {
  const [latest, setLatest] = useState<ScanSseEvent | null>(null);
  const [files, setFiles] = useState<number | undefined>(undefined);
  const [symbols, setSymbols] = useState<number | undefined>(undefined);
  const [llmDone, setLlmDone] = useState<number>(0);
  const [llmTotal, setLlmTotal] = useState<number>(0);
  const [activeDetector, setActiveDetector] = useState<string | null>(null);
  const [doneDetectors, setDoneDetectors] = useState<Set<string>>(new Set());
  const [verdicts, setVerdicts] = useState<VerdictEntry[]>([]);
  const [sseStatus, setSseStatus] = useState<'open' | 'reconnecting' | 'closed'>('open');
  // `startedAt` is the SCAN start time, not the page-mount time. A
  // reload during a running scan used to reset the elapsed clock to 0
  // because the previous implementation captured `Date.now()` on mount.
  // We now seed from the server's persisted ScanRecord on first paint
  // so the timer survives reloads, navigation, and tab restores.
  const startedAt = useRef<number | null>(null);
  const [, setTick] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    getScan(scanId)
      .then((scan) => {
        if (cancelled) return;
        if (typeof scan.startedAt === 'number') {
          startedAt.current = scan.startedAt;
        } else {
          startedAt.current = Date.now();
        }
        setTick((t) => t + 1);
      })
      .catch(() => {
        // Scan record not (yet) on disk — fall back to mount time.
        // SSE will keep ticking; the elapsed value will undercount by
        // at most a second or two against the real scan start.
        if (!cancelled) startedAt.current = Date.now();
      });
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsub = subscribeScan(
      scanId,
      (event) => {
        setLatest(event);
        if (event.files != null) setFiles(event.files);
        if (event.symbols != null) setSymbols(event.symbols);
        if (event.detector) {
          // Promote the previously-active detector to done in lockstep
          // with switching `activeDetector` over. Reading the previous
          // value through the setState updater keeps this independent
          // of the surrounding closure — `activeDetector` is no longer
          // a useEffect dep, so the SSE subscription stays put for the
          // lifetime of the scan instead of churning on every detector
          // event (which silently dropped intermediate progress).
          setActiveDetector((prev) => {
            if (prev && prev !== event.detector) {
              setDoneDetectors((doneSet) => {
                if (doneSet.has(prev)) return doneSet;
                const next = new Set(doneSet);
                next.add(prev);
                return next;
              });
            }
            return event.detector ?? prev;
          });
        }
        if (event.state === 'llm-verdict' && event.verdict) {
          setLlmDone(event.llmDone ?? 0);
          setLlmTotal(event.llmTotal ?? 0);
          setVerdicts((prev) =>
            [
              {
                ts: event.ts,
                detectorId: event.verdict!.detectorId,
                cluster: event.verdict!.cluster,
                race: event.verdict!.race,
                confidence: event.verdict!.confidence,
                reason: event.verdict!.reason,
                latencyMs: event.verdict!.latencyMs,
              },
              ...prev,
            ].slice(0, 40),
          );
        }
        if (event.state === 'llm-start') {
          setLlmTotal(event.llmTotal ?? 0);
          // Entering the LLM pass means every detector finished — flush
          // the last active one into the done set so the pipeline view
          // doesn't leave the final detector frozen in ACTIVE.
          setActiveDetector((prev) => {
            if (prev) {
              setDoneDetectors((doneSet) => {
                if (doneSet.has(prev)) return doneSet;
                const next = new Set(doneSet);
                next.add(prev);
                return next;
              });
            }
            return null;
          });
        }
        if (event.state === 'done' || event.state === 'error') {
          setTimeout(onDone, 1200);
        }
      },
      setSseStatus,
    );
    return () => unsub();
  }, [scanId, onDone]);

  const elapsedMs = startedAt.current != null ? Date.now() - startedAt.current : 0;
  const elapsed = Math.floor(elapsedMs / 1000);
  const llmPct = llmTotal > 0 ? (llmDone / llmTotal) * 100 : 0;
  const parsedPct = files != null ? 100 : latest?.state === 'parsing' ? 30 : 0;
  const overallPct =
    latest?.state === 'done'
      ? 100
      : latest?.state === 'llm-verdict' || latest?.state === 'llm-start'
        ? 30 + llmPct * 0.6
        : latest?.state === 'detecting'
          ? Math.min(30, 5 + doneDetectors.size * 3)
          : parsedPct;

  const avgVerdictMs =
    verdicts.length > 0 ? verdicts.reduce((a, v) => a + v.latencyMs, 0) / verdicts.length : 1500;
  const verdictsLeft = Math.max(0, llmTotal - llmDone);
  const etaSec = Math.round((verdictsLeft * avgVerdictMs) / 1000);
  const doneCount =
    doneDetectors.size + (activeDetector && doneDetectors.has(activeDetector) ? 0 : 0);

  return (
    <div className="space-y-6 max-w-screen-2xl">
      <SectionHeader
        eyebrow="SCAN IN PROGRESS"
        title={
          <span>
            <span className="text-ink">Looking through {summariseWorkspace()}</span>{' '}
            <span className="text-muted">
              — {doneCount} of {DETECTOR_ORDER.length} detectors done.
            </span>
          </span>
        }
        meta={
          <div className="flex items-start gap-3 flex-wrap sm:justify-end">
            <div className="space-y-1">
              <div>
                scan <span className="text-ink">#{scanId.slice(0, 12)}</span>
              </div>
              {sseStatus === 'reconnecting' && (
                <div className="text-med inline-flex items-center gap-1.5">
                  <Loader2 size={10} className="animate-spin" /> reconnecting…
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!confirm('Cancel this scan?')) return;
                await cancelScan(scanId);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-high/40 bg-high/10 text-high px-2.5 py-1 text-xs font-mono hover:bg-high/20"
            >
              <X size={11} /> Cancel
            </button>
          </div>
        }
      />

      <KpiRow>
        <KpiCellLive
          label="elapsed"
          value={formatMin(elapsed)}
          sub={verdictsLeft > 0 ? `eta ${formatMin(etaSec)}` : null}
          progress={overallPct}
        />
        <KpiCellLive label="prog" value={`${overallPct.toFixed(0)}%`} />
        <KpiCellLive
          label="files"
          value={files != null ? `${files.toLocaleString('en-US')}` : '—'}
        />
        <KpiCellLive
          label="symbols"
          value={symbols != null ? symbols.toLocaleString('en-US') : '—'}
        />
        <KpiCellLive label="LLM" value={`${llmDone} / ${llmTotal || '—'}`} />
        <KpiCellLive
          label="avg llm"
          value={verdicts.length > 0 ? `${Math.round(avgVerdictMs)} ms` : '—'}
        />
        <KpiCellLive label="state" value={renderStateLabel(latest?.state)} />
      </KpiRow>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <DetectorPipelineCard
          activeDetector={activeDetector}
          doneDetectors={doneDetectors}
          verdicts={verdicts}
        />
        <VerdictStreamCard verdicts={verdicts} />
      </div>
    </div>
  );
}

interface KpiRowProps {
  children: React.ReactNode;
}

function KpiRow({ children }: KpiRowProps): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 divide-x divide-y sm:divide-y-0 divide-border-soft">
      {children}
    </div>
  );
}

function KpiCellLive({
  label,
  value,
  sub,
  progress,
}: {
  label: string;
  value: string;
  sub?: string | null;
  progress?: number;
}): JSX.Element {
  return (
    <div className="px-4 sm:px-5 py-3 sm:py-4 relative">
      <div className="text-[9px] sm:text-[10px] uppercase tracking-widest text-muted font-mono mb-1.5">
        {label}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-serif text-[24px] sm:text-[30px] leading-none tabular-nums text-ink">
          {value}
        </span>
        {sub && <span className="text-[11px] text-muted font-mono">{sub}</span>}
      </div>
      {progress != null && (
        <div className="mt-2 h-1 rounded-full bg-bg overflow-hidden">
          <div
            className="h-1 bg-accent transition-all duration-500 ease-linear"
            style={{ width: `${progress.toFixed(1)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function DetectorPipelineCard({
  activeDetector,
  doneDetectors,
  verdicts,
}: {
  activeDetector: string | null;
  doneDetectors: Set<string>;
  verdicts: VerdictEntry[];
}): JSX.Element {
  const countsPerDetector = (id: string) => {
    const ms = verdicts.filter((v) => v.detectorId === id);
    const races = ms.filter((v) => v.race).length;
    const safes = ms.length - races;
    return { races, safes };
  };
  return (
    <section className="rounded-lg border border-border bg-panel overflow-hidden">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">Detector pipeline</span>
        <span className="text-xs text-muted font-mono">
          {DETECTOR_ORDER.length} detectors · sequential
        </span>
      </header>
      <ul className="divide-y divide-border-soft">
        {DETECTOR_ORDER.map((d) => {
          const status: 'done' | 'live' | 'queued' = doneDetectors.has(d)
            ? 'done'
            : activeDetector === d
              ? 'live'
              : 'queued';
          const { races, safes } = countsPerDetector(d);
          return (
            <li
              key={d}
              className={
                'flex items-center gap-3 px-5 py-2.5 ' + (status === 'live' ? 'bg-accent/5' : '')
              }
            >
              <StatusDot status={status} />
              <div className="flex-1 min-w-0">
                <div
                  className={
                    'font-mono text-sm ' + (status === 'queued' ? 'text-muted' : 'text-ink')
                  }
                >
                  {d}
                </div>
                <div className="text-[11px] text-muted font-mono truncate">
                  {DETECTOR_BLURB[d] ?? ''}
                </div>
              </div>
              <span
                className={
                  'text-xs font-mono tabular-nums w-8 text-right ' +
                  (races > 0 ? 'text-high' : 'text-muted')
                }
              >
                {races}
              </span>
              <span
                className={
                  'text-xs font-mono tabular-nums w-8 text-right ' +
                  (safes > 0 ? 'text-low' : 'text-muted')
                }
              >
                {safes}
              </span>
              <span
                className={
                  'ml-2 text-[10px] uppercase tracking-widest font-mono w-14 text-right ' +
                  (status === 'done'
                    ? 'text-low'
                    : status === 'live'
                      ? 'text-accent'
                      : 'text-muted')
                }
              >
                {status}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusDot({ status }: { status: 'done' | 'live' | 'queued' }): JSX.Element {
  if (status === 'done') {
    return (
      <span className="w-5 h-5 rounded-full bg-low/20 border border-low/50 flex items-center justify-center text-low">
        <Check size={11} strokeWidth={3} />
      </span>
    );
  }
  if (status === 'live') {
    return (
      <span className="w-5 h-5 rounded-full bg-accent/20 border border-accent/50 flex items-center justify-center text-accent">
        <Loader2 size={11} className="animate-spin" />
      </span>
    );
  }
  return (
    <span className="w-5 h-5 rounded-full bg-bg border border-border flex items-center justify-center text-muted">
      <Circle size={6} fill="currentColor" />
    </span>
  );
}

function VerdictStreamCard({ verdicts }: { verdicts: VerdictEntry[] }): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-panel overflow-hidden">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">LLM verdict stream</span>
        <span className="text-xs text-muted font-mono">qwen2.5-coder-14b · llama.cpp</span>
        <span className="ml-auto text-xs text-muted font-mono">{verdicts.length}</span>
      </header>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-muted font-mono">
            <th className="text-left font-normal px-5 pt-2 pb-1 w-16">+ms</th>
            <th className="text-left font-normal pt-2 pb-1 w-20">verdict</th>
            <th className="text-left font-normal pt-2 pb-1 pr-5">detector · cluster</th>
          </tr>
        </thead>
        <tbody>
          {verdicts.length === 0 && (
            <tr>
              <td colSpan={3} className="px-5 py-4 text-muted text-sm">
                waiting for first verdict…
              </td>
            </tr>
          )}
          {verdicts.map((v, i) => (
            <tr key={`${v.ts}-${i}`} className="border-t border-border-soft">
              <td className="px-5 py-2 font-mono text-[11px] text-muted tabular-nums">
                +{formatLatency(v.latencyMs)}
              </td>
              <td className="py-2">
                <span
                  className={
                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wider font-mono ' +
                    (v.race
                      ? 'bg-high/15 border-high/60 text-high'
                      : 'bg-low/20 border-low/60 text-low')
                  }
                >
                  <span className="w-1 h-1 rounded-full bg-current" />
                  {v.race ? 'REAL' : 'FP'}
                </span>
              </td>
              <td className="py-2 pr-5">
                <div className="font-mono text-xs text-ink truncate">{v.detectorId}</div>
                {v.cluster && (
                  <div className="font-mono text-[11px] text-info truncate">§{v.cluster}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function summariseWorkspace(): string {
  // Static for now — the API exposes the workspace root, but for the
  // header sentence the org/repo string already lives in the topbar.
  return 'outline/outline';
}

function formatMin(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `0:0${(ms / 1000).toFixed(1)}`;
  const s = ms / 1000;
  return `0:${s.toFixed(1).padStart(4, '0')}`;
}

function renderStateLabel(state: ScanSseEvent['state'] | undefined): string {
  if (!state) return 'queued';
  if (state === 'llm-verdict' || state === 'llm-start') return 'verdict';
  if (state === 'detecting') return 'detecting';
  if (state === 'parsing') return 'parsing';
  if (state === 'done') return 'done';
  if (state === 'error') return 'error';
  return state;
}
