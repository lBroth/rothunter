import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { Finding, ScanDiff, ScanRecord } from '../lib/api.js';
import { generateCombinedFixPrompt, getScan, getScanDiff, listMarkedToFix } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { KpiCell, KpiStrip } from '../components/KpiStrip.js';
import { ClusterPill, SeverityChip } from '../components/Chips.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { toast } from '../lib/toast.js';
import { copyText } from '../lib/clipboard.js';

interface DashboardProps {
  scanId: string | null;
  onOpenFinding: (fingerprint: string) => void;
  onOpenFindings?: (filter?: FindingsFilter) => void;
}

/**
 * Filter payload the Dashboard can hand to the Findings page. Each KPI
 * + WhatsNew tile becomes a tap target that drills into the matching
 * filtered list — `severity` for the high/med/low cells, `view` for
 * the resolved tab, `layer` for the LLM-verdict-rate cell.
 */
export interface FindingsFilter {
  detector?: string;
  directory?: string;
  severity?: 'high' | 'medium' | 'low';
  view?: 'open' | 'false-positive';
  layer?: 3;
}

type WhatsNewTab = 'added' | 'resolved' | 'persisting';

export function Dashboard({
  scanId,
  onOpenFinding,
  onOpenFindings,
}: DashboardProps): JSX.Element {
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [diff, setDiff] = useState<ScanDiff | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<WhatsNewTab>('added');
  const [fixQueueCount, setFixQueueCount] = useState<number>(0);
  const [combinedPromptBusy, setCombinedPromptBusy] = useState<boolean>(false);
  const [combinedPrompt, setCombinedPrompt] = useState<string | null>(null);

  // Pull the fix-queue size on mount + whenever the active scan changes
  // so the dashboard's "Generate combined fix prompt" CTA shows the
  // current count.
  useEffect(() => {
    listMarkedToFix()
      .then((q) => setFixQueueCount(q.fingerprints.length))
      .catch(() => undefined);
  }, [scanId]);

  const onGenerateCombined = async (): Promise<void> => {
    if (fixQueueCount === 0) {
      toast('Mark at least one finding for fix from its detail page.', 'warn');
      return;
    }
    setCombinedPromptBusy(true);
    try {
      const r = await generateCombinedFixPrompt();
      setCombinedPrompt(r.prompt);
      toast(`Combined fix prompt ready (${r.findingCount} findings).`, 'info');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'warn');
    } finally {
      setCombinedPromptBusy(false);
    }
  };

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

  const findings = useMemo(() => scan?.findings ?? [], [scan]);
  const counts = useMemo(() => countSeverities(findings), [findings]);
  const detectorRows = useMemo(() => buildDetectorBreakdown(findings), [findings]);
  const heatmap = useMemo(() => buildRepoHeatmap(findings), [findings]);
  const highFindings = useMemo(() => findings.filter((f) => f.severity === 'high'), [findings]);

  if (err && !scan && scanId) return <div className="text-high">error: {err}</div>;
  if (scanId && !scan) return <PageSkeleton />;

  // Empty-state defaults — render the Dashboard chrome with zeroes when
  // no scan has been run yet. Replaces the old standalone EmptyState
  // page so the operator sees the same layout from minute one and
  // doesn't have to context-switch into a "real" dashboard after the
  // first scan completes. The "Run scan" affordance lives in the top
  // bar regardless of whether a scan exists.
  const workspaceLabel = scan
    ? scan.workspaceRoot.split('/').slice(-2).join(' / ')
    : 'no scan yet';
  const durationS =
    scan?.finishedAt ? Math.round((scan.finishedAt - scan.startedAt) / 1000) : null;

  return (
    <div className="space-y-8 max-w-screen-2xl">
      {fixQueueCount > 0 && (
        <section className="rounded-lg border border-accent/40 bg-accent/5 px-5 py-3 flex items-center gap-3 flex-wrap">
          <Sparkles size={14} className="text-accent" />
          <span className="text-sm text-ink">
            <span className="font-semibold">{fixQueueCount}</span>{' '}
            finding{fixQueueCount === 1 ? '' : 's'} marked to fix
          </span>
          <span className="text-xs text-muted font-mono">
            queue lives at <code>.rothunter/marked-to-fix.json</code>
          </span>
          <button
            type="button"
            disabled={combinedPromptBusy}
            onClick={() => void onGenerateCombined()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent text-panel text-xs font-medium px-3 py-1.5 hover:bg-accent/90 disabled:opacity-50"
          >
            {combinedPromptBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {combinedPromptBusy ? 'Building…' : 'Build combined fix prompt'}
          </button>
        </section>
      )}
      <SectionHeader
        eyebrow={`SCAN SUMMARY · ${workspaceLabel}`}
        title={
          scan
            ? renderSerifSentence(counts.high, diff?.added.length ?? 0)
            : (
              <span>
                <span className="text-ink">No scan yet.</span>{' '}
                <span className="text-muted">Run one from the top bar to populate the dashboard.</span>
              </span>
            )
        }
        meta={
          <div className="space-y-1">
            <div>
              {scan
                ? `scan finished in ${durationS != null ? formatDuration(durationS) : '—'}`
                : 'awaiting first scan'}
            </div>
            <div>
              verdicts by <span className="text-ink">local LLM</span>
            </div>
            <RefreshDot visible={loading} />
          </div>
        }
      />

      <KpiStrip>
        <KpiCell
          label="findings"
          value={counts.total}
          delta={diff ? diff.added.length - diff.removed.length : undefined}
          onClick={scan ? () => onOpenFindings?.() : undefined}
        />
        <KpiCell
          label="high"
          value={counts.high}
          tone="high"
          delta={diffSeverity(diff, 'high')}
          onClick={scan ? () => onOpenFindings?.({ severity: 'high' }) : undefined}
        />
        <KpiCell
          label="med"
          value={counts.med}
          tone="med"
          delta={diffSeverity(diff, 'medium')}
          onClick={scan ? () => onOpenFindings?.({ severity: 'medium' }) : undefined}
        />
        <KpiCell
          label="low"
          value={counts.low}
          tone="low"
          delta={diffSeverity(diff, 'low')}
          onClick={scan ? () => onOpenFindings?.({ severity: 'low' }) : undefined}
        />
        <KpiCell label="symbols" value={(scan?.symbolsCount ?? 0).toLocaleString('en-US')} />
        <KpiCell
          label="LLM verdict rate"
          value={`${llmVerdictPct(findings)}%`}
          tone="accent"
          onClick={scan ? () => onOpenFindings?.({ layer: 3 }) : undefined}
        />
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

      <HighFindingsCard
        findings={highFindings}
        onOpenFinding={onOpenFinding}
        onViewAll={onOpenFindings}
      />

      {combinedPrompt != null && (
        <CombinedFixPromptModal
          prompt={combinedPrompt}
          count={fixQueueCount}
          onClose={() => setCombinedPrompt(null)}
        />
      )}
    </div>
  );
}

/**
 * Modal that renders the deterministically-built combined fix prompt covering
 * every marked-to-fix finding in one block. Copy-paste into Claude
 * Code / Cursor / Copilot Chat to fix the whole batch.
 */
function CombinedFixPromptModal({
  prompt,
  count,
  onClose,
}: {
  prompt: string;
  count: number;
  onClose: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState<boolean>(false);
  const onCopy = async (): Promise<void> => {
    try {
      await copyText(prompt);
      setCopied(true);
      toast('Combined prompt copied to clipboard.', 'info');
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast(`Copy failed: ${(e as Error).message}`, 'warn');
    }
  };
  return (
    <div
      className="fixed z-50 bg-black/80 backdrop-blur-md flex items-center justify-center"
      style={{
        top: '-100px',
        left: 0,
        right: 0,
        bottom: '-100px',
        paddingTop: 'calc(100px + max(0.75rem, env(safe-area-inset-top)))',
        paddingBottom: 'calc(100px + max(0.75rem, env(safe-area-inset-bottom)))',
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-panel shadow-2xl overflow-hidden">
        <header className="px-4 py-3 border-b border-border-soft flex items-center gap-3">
          <Sparkles size={15} className="text-accent shrink-0" />
          <div className="min-w-0">
            <div className="font-serif text-base font-semibold text-ink">Combined fix prompt</div>
            <div className="text-[11px] text-muted font-mono">
              {count} finding{count === 1 ? '' : 's'} · paste into Claude Code · Codex · Cursor · Copilot Chat
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto w-7 h-7 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-bg"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-ink leading-relaxed bg-bg rounded border border-border-soft p-3">
            {prompt}
          </pre>
        </div>
        <footer className="px-4 py-3 border-t border-border-soft flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-muted hover:text-ink hover:bg-bg"
          >
            Close
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void onCopy()}
            className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-panel hover:bg-accent/90 flex items-center gap-1.5"
          >
            <Sparkles size={12} />
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </footer>
      </div>
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
        <TabPill
          active={tab === 'added'}
          tone="high"
          label="ADDED"
          value={`+${added.length}`}
          onClick={() => setTab('added')}
        />
        <TabPill
          active={tab === 'resolved'}
          tone="low"
          label="RESOLVED"
          value={`−${removed.length}`}
          onClick={() => setTab('resolved')}
        />
        <TabPill
          active={tab === 'persisting'}
          tone="ink"
          label="PERSISTING"
          value={`${persisting.length}`}
          onClick={() => setTab('persisting')}
        />
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
              <span className="text-muted font-mono w-8 shrink-0">
                +{(i + 1).toString().padStart(2, '0')}
              </span>
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
              <td
                className={
                  'text-right font-mono tabular-nums ' + (r.h > 0 ? 'text-high' : 'text-muted')
                }
              >
                {r.h}
              </td>
              <td
                className={
                  'text-right font-mono tabular-nums ' + (r.m > 0 ? 'text-med' : 'text-muted')
                }
              >
                {r.m}
              </td>
              <td
                className={
                  'text-right font-mono tabular-nums pr-5 ' + (r.l > 0 ? 'text-low' : 'text-muted')
                }
              >
                {r.l}
              </td>
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
                <span className="text-xs font-mono text-high tabular-nums w-6 text-right">
                  {r.count}
                </span>
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

function llmVerdictPct(findings: Finding[]): number {
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
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

function numberWord(n: number, lower = false): string {
  const word = n <= 20 ? WORDS[n]! : String(n);
  return lower ? word.toLowerCase() : word;
}
