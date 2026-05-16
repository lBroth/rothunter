import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ChevronDown, Loader2, Trash2 } from 'lucide-react';
import type { ScanSeries, ScanSeriesEntry } from '../lib/api.js';
import { deleteScan, getScanSeries } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { KpiCell, KpiStrip } from '../components/KpiStrip.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { comingSoon } from '../lib/toast.js';

interface HistoryProps {
  onOpenScan?: (scanId: string) => void;
}

type WindowKey = '7d' | '30d' | '90d';

const TODO = (label: string) => () => comingSoon(label);

export function History({ onOpenScan }: HistoryProps): JSX.Element {
  const [series, setSeries] = useState<ScanSeries | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [win, setWin] = useState<WindowKey>('30d');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Don't blank out current data while refetching — show RefreshDot
    // and only replace once the new payload lands.
    getScanSeries(win)
      .then((s) => {
        if (!cancelled) setSeries(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [win, reloadTick]);

  const onDelete = async (scanId: string): Promise<void> => {
    if (!window.confirm(`Delete scan #${scanId.slice(0, 8)}? This cannot be undone.`)) return;
    setBusyId(scanId);
    try {
      await deleteScan(scanId);
      setReloadTick((t) => t + 1);
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (err && !series) return <div className="text-high">error: {err}</div>;
  if (!series) return <PageSkeleton rows={2} />;

  const entries = series?.entries ?? [];
  const summary = series?.summary;

  return (
    <div className="space-y-6 max-w-screen-2xl">
      <SectionHeader
        eyebrow="SCAN HISTORY · OUTLINE / OUTLINE"
        title={
          <span>
            <span className="text-ink tabular-nums">{summary?.count ?? 0} scans</span>{' '}
            <span className="text-muted">· {oldestRelative(entries)}</span>
          </span>
        }
        meta={
          <div className="flex items-center gap-3">
            <RefreshDot visible={loading} />
            <WindowDropdown value={win} setValue={setWin} />
          </div>
        }
      />

      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3 flex-wrap">
          <span className="text-sm font-semibold text-ink">HIGH findings · trend</span>
          <span className="text-xs text-muted font-mono">
            last {entries.length} scan{entries.length === 1 ? '' : 's'} · area is
            open-but-not-yet-fixed
          </span>
          <button
            type="button"
            onClick={TODO('switch chart y-axis to log / linear / sqrt')}
            className="ml-auto text-xs text-muted hover:text-ink font-mono inline-flex items-center gap-1"
          >
            y-axis ranges <ChevronDown size={11} />
          </button>
        </header>
        <KpiStrip>
          <KpiCell label="current" value={summary?.currentHigh ?? 0} tone="high" />
          <KpiCell
            label="30d change"
            value={
              summary
                ? summary.change30d > 0
                  ? `+${summary.change30d}`
                  : `${summary.change30d}`
                : '0'
            }
            tone={summary && summary.change30d <= 0 ? 'low' : 'high'}
          />
          <KpiCell
            label="p50 verdict"
            value={summary?.avgVerdictMs ? `${summary.avgVerdictMs} ms` : '—'}
          />
          <KpiCell
            label="p95 verdict"
            value={summary?.avgP95Ms ? `${summary.avgP95Ms} ms` : '—'}
          />
          <KpiCell
            label="avg scan"
            value={
              summary?.avgDurationMs != null
                ? formatDuration(Math.round(summary.avgDurationMs / 1000))
                : '—'
            }
          />
        </KpiStrip>

        <div className="p-4">
          <TrendChart entries={entries} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
          <span className="text-sm font-semibold text-ink">Recent scans</span>
          <span className="text-xs text-muted font-mono">
            {Math.min(entries.length, 10)} shown · click a row to compare
          </span>
        </header>
        {entries.length === 0 ? (
          <div className="px-5 py-8 text-center text-muted text-sm">
            No scans in the selected window.
          </div>
        ) : (
          <>
            {/* Mobile cards. */}
            <ul className="lg:hidden divide-y divide-border-soft">
              {entries.slice(0, 10).map((e, i) => (
                <li key={e.scanId} className="px-4 py-3 flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenScan?.(e.scanId) ?? TODO(`compare scan #${e.scanId.slice(0, 8)}`)()
                    }
                    className="flex-1 text-left hover:bg-bg flex flex-col gap-1 text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          i === 0
                            ? 'w-1.5 h-1.5 rounded-full bg-accent'
                            : 'w-1.5 h-1.5 rounded-full bg-border'
                        }
                      />
                      <span className="text-ink">#{e.scanId.slice(0, 12)}</span>
                      <span className="text-muted ml-auto">{relative(e.startedAt)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-muted">
                      <span>
                        {e.durationMs ? formatDuration(Math.round(e.durationMs / 1000)) : '—'}
                      </span>
                      <span className={'tabular-nums ' + (e.high > 0 ? 'text-high' : 'text-muted')}>
                        H {e.high}
                      </span>
                      <span className={'tabular-nums ' + (e.med > 0 ? 'text-med' : 'text-muted')}>
                        M {e.med}
                      </span>
                      <span className={'tabular-nums ' + (e.low > 0 ? 'text-low' : 'text-muted')}>
                        L {e.low}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(e.scanId)}
                    disabled={busyId === e.scanId}
                    aria-label="Delete scan"
                    className="w-7 h-7 rounded flex items-center justify-center text-muted hover:text-high hover:bg-high/10 disabled:opacity-40"
                  >
                    {busyId === e.scanId ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {/* Desktop table. */}
            <table className="hidden lg:table w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted font-mono border-b border-border-soft">
                  <th className="text-left font-normal pl-5 py-3 w-32">scan id</th>
                  <th className="text-left font-normal py-3 w-28">when</th>
                  <th className="text-left font-normal py-3 w-28">duration</th>
                  <th className="text-right font-normal py-3 w-16">high</th>
                  <th className="text-right font-normal py-3 w-16">med</th>
                  <th className="text-right font-normal py-3 w-16">low</th>
                  <th className="text-left font-normal py-3 pl-6">note · what changed</th>
                  <th className="text-right font-normal py-3 pr-5 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(0, 10).map((e, i) => (
                  <tr
                    key={e.scanId}
                    className="hover:bg-bg border-b border-border-soft last:border-b-0"
                  >
                    <td
                      className="pl-5 py-2.5 font-mono text-xs text-ink cursor-pointer"
                      onClick={() =>
                        onOpenScan?.(e.scanId) ?? TODO(`compare scan #${e.scanId.slice(0, 8)}`)()
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={
                            i === 0
                              ? 'w-1.5 h-1.5 rounded-full bg-accent'
                              : 'w-1.5 h-1.5 rounded-full bg-border'
                          }
                        />
                        #{e.scanId.slice(0, 12)}
                      </span>
                    </td>
                    <td
                      className="py-2.5 font-mono text-xs text-muted cursor-pointer"
                      onClick={() =>
                        onOpenScan?.(e.scanId) ?? TODO(`compare scan #${e.scanId.slice(0, 8)}`)()
                      }
                    >
                      {relative(e.startedAt)}
                    </td>
                    <td
                      className="py-2.5 font-mono text-xs text-muted cursor-pointer"
                      onClick={() =>
                        onOpenScan?.(e.scanId) ?? TODO(`compare scan #${e.scanId.slice(0, 8)}`)()
                      }
                    >
                      {e.durationMs ? formatDuration(Math.round(e.durationMs / 1000)) : '—'}
                    </td>
                    <td
                      className={
                        'py-2.5 text-right font-mono tabular-nums ' +
                        (e.high > 0 ? 'text-high' : 'text-muted')
                      }
                    >
                      {e.high}
                    </td>
                    <td
                      className={
                        'py-2.5 text-right font-mono tabular-nums ' +
                        (e.med > 0 ? 'text-med' : 'text-muted')
                      }
                    >
                      {e.med}
                    </td>
                    <td
                      className={
                        'py-2.5 text-right font-mono tabular-nums ' +
                        (e.low > 0 ? 'text-low' : 'text-muted')
                      }
                    >
                      {e.low}
                    </td>
                    <td className="py-2.5 pl-6 text-xs text-muted">{e.note ?? '—'}</td>
                    <td className="py-2.5 pr-5 text-right">
                      <button
                        type="button"
                        onClick={() => void onDelete(e.scanId)}
                        disabled={busyId === e.scanId}
                        aria-label="Delete scan"
                        className="w-7 h-7 rounded inline-flex items-center justify-center text-muted hover:text-high hover:bg-high/10 disabled:opacity-40"
                      >
                        {busyId === e.scanId ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}

function WindowDropdown({
  value,
  setValue,
}: {
  value: WindowKey;
  setValue: (v: WindowKey) => void;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-panel text-xs font-mono">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as WindowKey)}
        className="bg-transparent text-ink focus:outline-none"
      >
        <option value="7d">last 7 days</option>
        <option value="30d">last 30 days</option>
        <option value="90d">last 90 days</option>
      </select>
      <ChevronDown size={11} className="text-muted" />
    </label>
  );
}

function TrendChart({ entries }: { entries: ScanSeriesEntry[] }): JSX.Element {
  const path = useMemo(() => buildTrendPath(entries), [entries]);
  const max = useMemo(() => Math.max(8, ...entries.map((e) => e.high)), [entries]);

  if (entries.length === 0) {
    return <div className="text-xs text-muted py-12 text-center">No history in this window.</div>;
  }

  return (
    <svg viewBox="0 0 600 160" className="w-full h-40" preserveAspectRatio="none">
      {/* Grid lines. */}
      <g stroke="rgb(var(--rh-border-soft))" strokeWidth="0.5" strokeDasharray="3 3">
        {[0.25, 0.5, 0.75].map((p) => (
          <line key={p} x1="0" y1={160 * p} x2="600" y2={160 * p} />
        ))}
      </g>
      {/* Filled area. */}
      <path d={path.area} fill="rgb(var(--rh-bg))" fillOpacity="0" />
      <path d={path.area} fill="#fb7185" fillOpacity="0.2" />
      <path d={path.line} fill="none" stroke="#fb7185" strokeWidth="2" />
      {/* Max-value label top-left. */}
      <text
        x="6"
        y="14"
        fill="rgb(var(--rh-muted))"
        fontSize="10"
        fontFamily="ui-monospace, monospace"
      >
        max {max}
      </text>
    </svg>
  );
}

function buildTrendPath(entries: ScanSeriesEntry[]): { line: string; area: string } {
  if (entries.length === 0) return { line: '', area: '' };
  const reversed = [...entries].reverse(); // oldest left, newest right
  const max = Math.max(8, ...reversed.map((e) => e.high));
  const w = 600;
  const h = 160;
  const stepX = reversed.length > 1 ? w / (reversed.length - 1) : 0;
  const pts = reversed.map((e, i) => {
    const x = stepX * i;
    const y = h - (e.high / max) * (h - 20) - 10;
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area = line + ` L${w},${h} L0,${h} Z`;
  return { line, area };
}

function relative(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

function oldestRelative(entries: ScanSeriesEntry[]): string {
  if (entries.length === 0) return 'no history';
  const oldest = entries[entries.length - 1]!;
  return `first scan ${relative(oldest.startedAt)}`;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}
