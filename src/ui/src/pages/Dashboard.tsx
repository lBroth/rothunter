import { useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import type { Finding, ScanDiff, ScanRecord } from '../lib/api.js';
import { getScan, getScanDiff, startScan } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { KpiCell, KpiStrip } from '../components/KpiStrip.js';
import { ClusterPill, SeverityChip } from '../components/Chips.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { getWorkspace } from '../lib/api.js';

interface DashboardProps {
  scanId: string | null;
  onOpenFinding: (fingerprint: string) => void;
  onScanStarted: (scanId: string) => void;
  onOpenFindings?: (filter?: { detector?: string; directory?: string }) => void;
}

type WhatsNewTab = 'added' | 'resolved' | 'persisting';

export function Dashboard({
  scanId,
  onOpenFinding,
  onScanStarted,
  onOpenFindings,
}: DashboardProps): JSX.Element {
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [diff, setDiff] = useState<ScanDiff | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<WhatsNewTab>('added');

  useEffect(() => {
    if (!scanId) {
      setScan(null);
      setDiff(null);
      return;
    }
    setLoading(true);
    // Keep showing whatever we already had on screen; only swap state
    // once the fetch resolves. The previous "setScan(null) before fetch"
    // pattern flashed a "loading…" placeholder over good content.
    let cancelled = false;
    Promise.all([getScan(scanId), getScanDiff(scanId).catch(() => null)])
      .then(([s, d]) => {
        if (cancelled) return;
        setScan(s);
        setDiff(d);
        setErr(null);
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
  }, [scanId]);

  const findings = scan?.findings ?? [];
  const counts = useMemo(() => countSeverities(findings), [findings]);
  const detectorRows = useMemo(() => buildDetectorBreakdown(findings), [findings]);
  const heatmap = useMemo(() => buildRepoHeatmap(findings), [findings]);
  const highFindings = useMemo(() => findings.filter((f) => f.severity === 'high'), [findings]);

  if (!scanId) {
    return (
      <EmptyState
        onStart={async () => {
          const { scanId: id } = await startScan({});
          onScanStarted(id);
        }}
      />
    );
  }
  if (err && !scan) return <div className="text-high">error: {err}</div>;
  if (!scan) return <PageSkeleton />;

  const durationS = scan.finishedAt
    ? Math.round(((scan.finishedAt - scan.startedAt) / 1000))
    : null;

  return (
    <div className="space-y-8 max-w-screen-2xl">
      <SectionHeader
        eyebrow={`SCAN SUMMARY · ${scan.workspaceRoot.split('/').slice(-2).join(' / ')}`}
        title={renderSerifSentence(counts.high, diff?.added.length ?? 0)}
        meta={
          <div className="space-y-1">
            <div>scan finished in {durationS != null ? formatDuration(durationS) : '—'}</div>
            <div>verdicts by <span className="text-ink">qwen2.5-coder-14b</span></div>
            <RefreshDot visible={loading} />
          </div>
        }
      />

      <KpiStrip>
        <KpiCell label="findings" value={counts.total} delta={diff ? diff.added.length - diff.removed.length : undefined} />
        <KpiCell label="high" value={counts.high} tone="high" delta={diffSeverity(diff, 'high')} />
        <KpiCell label="med" value={counts.med} tone="med" delta={diffSeverity(diff, 'medium')} />
        <KpiCell label="low" value={counts.low} tone="low" delta={diffSeverity(diff, 'low')} />
        <KpiCell label="symbols" value={(scan.symbolsCount ?? 0).toLocaleString('en-US')} />
        <KpiCell label="tier-3 verdict rate" value={`${tier3Pct(findings)}%`} tone="accent" />
      </KpiStrip>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <WhatsNewCard diff={diff} tab={tab} setTab={setTab} onOpenFinding={onOpenFinding} />
        <DetectorsCard
          rows={detectorRows}
          onClickDetector={(id) => onOpenFindings?.({ detector: id })}
        />
        <HotspotsCard
          heatmap={heatmap}
          onClickDir={(dir) => onOpenFindings?.({ directory: dir })}
        />
      </div>

      <HighFindingsCard findings={highFindings} onOpenFinding={onOpenFinding} onViewAll={onOpenFindings} />
    </div>
  );
}

function renderSerifSentence(high: number, added: number): JSX.Element {
  if (high === 0) {
    return <span>No high-severity findings. Codebase rot is in check.</span>;
  }
  const highWord = numberWord(high);
  return (
    <span>
      <span className="text-ink">{highWord} high-severity findings.</span>{' '}
      {added > 0 ? (
        <span className="text-muted">{numberWord(added, true)} are new.</span>
      ) : (
        <span className="text-muted">No new ones vs last scan.</span>
      )}
    </span>
  );
}

function EmptyState({ onStart }: { onStart: () => Promise<void> }): JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(null);
  useEffect(() => {
    getWorkspace().then((w) => setWorkspace(w.name ?? w.current)).catch(() => undefined);
  }, []);
  return (
    <div className="max-w-2xl mx-auto pt-24 text-center px-4">
      <div className="text-[11px] uppercase tracking-widest text-muted font-mono mb-3">
        no scans yet
      </div>
      <h1 className="font-serif text-4xl text-ink mb-4">
        Catch the rot in your codebase.
      </h1>
      <p className="text-muted mb-8">
        Run the first scan against{' '}
        <code className="font-mono text-ink break-all">{workspace ?? '…'}</code>.
        The local LLM sidecar verdicts every Tier-3 finding before it lands here.
        Pick a different folder from the picker in the top bar.
      </p>
      <button
        onClick={() => void onStart()}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent text-panel font-medium hover:bg-accent/90"
      >
        <Play size={14} fill="currentColor" />
        Run scan
      </button>
    </div>
  );
}

interface WhatsNewCardProps {
  diff: ScanDiff | null;
  tab: WhatsNewTab;
  setTab: (t: WhatsNewTab) => void;
  onOpenFinding: (fp: string) => void;
}

function WhatsNewCard({ diff, tab, setTab, onOpenFinding }: WhatsNewCardProps): JSX.Element {
  const added = diff?.added ?? [];
  const removed = diff?.removed ?? [];
  const persisting = diff?.persisting ?? [];
  const list = tab === 'added' ? added : tab === 'resolved' ? removed : persisting;
  return (
    <section className="lg:col-span-5 rounded-lg border border-border bg-panel">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">What's new</span>
        <span className="text-xs text-muted font-mono truncate">
          vs {diff?.base ? `scan #${diff.base.slice(0, 10)}` : 'previous scan'}
        </span>
      </header>
      <div className="px-5 pt-4 grid grid-cols-3 gap-2 text-center">
        <TabPill active={tab === 'added'} tone="high" label="ADDED" value={`+${added.length}`} onClick={() => setTab('added')} />
        <TabPill active={tab === 'resolved'} tone="low" label="RESOLVED" value={`−${removed.length}`} onClick={() => setTab('resolved')} />
        <TabPill active={tab === 'persisting'} tone="ink" label="PERSISTING" value={`${persisting.length}`} onClick={() => setTab('persisting')} />
      </div>
      <ul className="p-4 space-y-2">
        {list.length === 0 && <li className="text-xs text-muted">No items in this bucket.</li>}
        {list.slice(0, 5).map((f, i) => (
          <li key={f.fingerprint}>
            <button
              type="button"
              onClick={() => onOpenFinding(f.fingerprint)}
              className="w-full text-left flex items-start gap-3 hover:bg-bg rounded px-2 py-1.5 text-xs"
            >
              <span className="text-muted font-mono w-8 shrink-0">+{(i + 1).toString().padStart(2, '0')}</span>
              <span className="text-high text-base leading-none mt-0.5">●</span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-ink">{stripBackticks(f.title)}</span>
                <span className="block text-muted font-mono text-[10px] truncate">
                  {f.evidence[0]?.file}:{f.evidence[0]?.range.startLine}
                </span>
              </span>
              <ClusterPill name={extractCluster(f.title) ?? f.detectorId} />
            </button>
          </li>
        ))}
        {list.length > 5 && <li className="text-xs text-muted px-2">+{list.length - 5} more</li>}
      </ul>
    </section>
  );
}

interface TabPillProps {
  active: boolean;
  tone: 'high' | 'low' | 'ink';
  label: string;
  value: string;
  onClick: () => void;
}

function TabPill({ active, tone, label, value, onClick }: TabPillProps): JSX.Element {
  const colour = {
    high: 'border-high/40 text-high',
    low: 'border-low/40 text-low',
    ink: 'border-border text-ink',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border bg-bg px-3 py-2 font-mono ' +
        colour +
        (active ? ' ring-2 ring-current/40' : ' opacity-80 hover:opacity-100')
      }
    >
      <div className="text-[10px] uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-base mt-0.5 tabular-nums">{value}</div>
    </button>
  );
}

interface DetectorRow {
  detectorId: string;
  h: number;
  m: number;
  l: number;
}

function DetectorsCard({
  rows,
  onClickDetector,
}: {
  rows: DetectorRow[];
  onClickDetector: (d: string) => void;
}): JSX.Element {
  return (
    <section className="lg:col-span-4 rounded-lg border border-border bg-panel">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">Detectors</span>
        <span className="text-xs text-muted font-mono">findings · this scan</span>
      </header>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-muted font-mono">
            <th className="text-left font-normal px-5 pt-2 pb-1">detector</th>
            <th className="w-8 text-right font-normal pt-2 pb-1">H</th>
            <th className="w-8 text-right font-normal pt-2 pb-1">M</th>
            <th className="w-8 text-right font-normal pt-2 pb-1 pr-5">L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.detectorId}
              className="cursor-pointer hover:bg-bg"
              onClick={() => onClickDetector(r.detectorId)}
            >
              <td className="px-5 py-1.5 font-mono text-ink">{r.detectorId}</td>
              <td className={'text-right font-mono tabular-nums ' + (r.h > 0 ? 'text-high' : 'text-muted')}>{r.h}</td>
              <td className={'text-right font-mono tabular-nums ' + (r.m > 0 ? 'text-med' : 'text-muted')}>{r.m}</td>
              <td className={'text-right font-mono tabular-nums pr-5 ' + (r.l > 0 ? 'text-low' : 'text-muted')}>{r.l}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface HotspotRow {
  dir: string;
  count: number;
}

function HotspotsCard({
  heatmap,
  onClickDir,
}: {
  heatmap: HotspotRow[];
  onClickDir: (dir: string) => void;
}): JSX.Element {
  const max = heatmap[0]?.count ?? 1;
  return (
    <section className="lg:col-span-3 rounded-lg border border-border bg-panel">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">Hotspots</span>
        <span className="text-xs text-muted font-mono">top dirs by HIGH count</span>
      </header>
      <ul className="p-4 space-y-2">
        {heatmap.length === 0 && <li className="text-xs text-muted">no high findings</li>}
        {heatmap.map((r) => {
          const pct = Math.max(6, (r.count / max) * 100);
          return (
            <li key={r.dir}>
              <button
                type="button"
                onClick={() => onClickDir(r.dir)}
                className="w-full grid grid-cols-[1fr_auto] gap-2 items-center hover:bg-bg rounded px-1 py-1"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-mono text-ink truncate text-left">{r.dir}</div>
                  <div className="h-1 mt-1 rounded bg-bg overflow-hidden">
                    <div className="h-1 bg-high/70" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="text-xs font-mono text-high tabular-nums w-6 text-right">{r.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function HighFindingsCard({
  findings,
  onOpenFinding,
  onViewAll,
}: {
  findings: Finding[];
  onOpenFinding: (fp: string) => void;
  onViewAll?: () => void;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-panel">
      <header className="px-5 py-3 border-b border-border-soft flex items-baseline gap-3">
        <span className="text-sm font-semibold text-ink">HIGH findings</span>
        <span className="text-xs text-muted font-mono">
          {findings.length} open · sorted by cluster size
        </span>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="ml-auto text-xs text-accent hover:underline"
          >
            view all →
          </button>
        )}
      </header>
      {findings.length === 0 ? (
        <div className="p-5 text-sm text-muted">
          No high-severity findings. Codebase rot is in check.
        </div>
      ) : (
        <ul>
          {findings.slice(0, 8).map((f, i) => (
            <li key={f.fingerprint} className={i % 2 === 0 ? '' : 'bg-bg/30'}>
              <button
                type="button"
                onClick={() => onOpenFinding(f.fingerprint)}
                className="w-full text-left px-4 sm:px-5 py-2.5 border-b border-border-soft last:border-b-0 hover:bg-bg
                  flex flex-col gap-1 lg:grid lg:grid-cols-[auto_200px_1fr_auto_auto] lg:gap-3 lg:items-center"
              >
                <div className="flex items-center gap-2 lg:contents">
                  <SeverityChip severity={f.severity} />
                  <span className="text-[11px] font-mono text-muted truncate lg:w-auto">
                    {f.detectorId}
                  </span>
                </div>
                <span className="text-sm text-ink truncate">{stripBackticks(f.title)}</span>
                <div className="flex items-center gap-2 lg:contents">
                  <ClusterPill name={extractCluster(f.title) ?? f.detectorId} />
                  <span className="text-[11px] text-muted font-mono truncate lg:text-right lg:w-72">
                    {f.evidence[0]?.file}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function countSeverities(findings: Finding[]) {
  const out = { total: findings.length, high: 0, med: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === 'high') out.high += 1;
    else if (f.severity === 'medium') out.med += 1;
    else out.low += 1;
  }
  return out;
}

function diffSeverity(diff: ScanDiff | null, sev: 'high' | 'medium' | 'low'): number | undefined {
  if (!diff) return undefined;
  const added = diff.added.filter((f) => f.severity === sev).length;
  const removed = diff.removed.filter((f) => f.severity === sev).length;
  return added - removed;
}

function buildDetectorBreakdown(findings: Finding[]): DetectorRow[] {
  const map = new Map<string, DetectorRow>();
  for (const f of findings) {
    const row = map.get(f.detectorId) ?? { detectorId: f.detectorId, h: 0, m: 0, l: 0 };
    if (f.severity === 'high') row.h += 1;
    else if (f.severity === 'medium') row.m += 1;
    else row.l += 1;
    map.set(f.detectorId, row);
  }
  return [...map.values()].sort(
    (a, b) => b.h * 100 + b.m * 10 + b.l - (a.h * 100 + a.m * 10 + a.l),
  );
}

function buildRepoHeatmap(findings: Finding[]): HotspotRow[] {
  const map = new Map<string, number>();
  for (const f of findings) {
    if (f.severity !== 'high') continue;
    const file = f.evidence[0]?.file ?? '';
    const dir = topLevelDir(file);
    if (!dir) continue;
    map.set(dir, (map.get(dir) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function topLevelDir(file: string): string {
  const parts = file.split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]}/${parts[1]}`;
}

function tier3Pct(findings: Finding[]): number {
  if (findings.length === 0) return 0;
  const t = findings.filter((f) => f.layer === 3).length;
  return Math.round((t / findings.length) * 100);
}

function stripBackticks(s: string): string {
  return s.replace(/`/g, '');
}

function extractCluster(title: string): string | null {
  const m = /`([^`]+)`/.exec(title);
  return m?.[1] ?? null;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

const WORDS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen', 'Twenty',
];

function numberWord(n: number, lower = false): string {
  const word = n <= 20 ? WORDS[n]! : String(n);
  return lower ? word.toLowerCase() : word;
}
