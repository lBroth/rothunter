import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Finding, ScanRecord } from '../lib/api.js';
import { getScan } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { ClusterPill, SeverityChip } from '../components/Chips.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { comingSoon } from '../lib/toast.js';
import { setQueue } from '../lib/finding-queue.js';
import { extractCluster } from '../lib/cluster.js';

interface FindingsProps {
  scanId: string | null;
  onOpenFinding: (fingerprint: string) => void;
  initialDetector?: string;
  initialDirectory?: string;
}

type Sev = 'high' | 'medium' | 'low';
type SortKey = 'severity-cluster' | 'severity' | 'age' | 'detector';

const TODO = (label: string) => () => comingSoon(label);

export function Findings({
  scanId,
  onOpenFinding,
  initialDetector,
  initialDirectory,
}: FindingsProps): JSX.Element {
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [sev, setSev] = useState<Set<Sev>>(new Set(['high', 'medium', 'low']));
  const [detector, setDetector] = useState<string>(initialDetector ?? 'any');
  const [cluster, setCluster] = useState<string>('any');
  const [directory, setDirectory] = useState<string>(initialDirectory ?? 'any');
  const [query, setQuery] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('severity-cluster');
  const [grouped, setGrouped] = useState<boolean>(true);
  const [page, setPage] = useState<number>(1);
  const [view, setView] = useState<'open' | 'resolved' | 'false-positive'>('open');
  const pageSize = 18;

  useEffect(() => {
    if (!scanId) {
      setScan(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getScan(scanId)
      .then((s) => {
        if (!cancelled) {
          setScan(s);
          setErr(null);
        }
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

  // Split scan.findings into open (no resolvedAt) + resolved (has resolvedAt).
  // Both share the persisted `findings` array — the resolved bucket is a
  // virtual view on top, populated by the single-finding rerun endpoint.
  const allLive = scan?.findings ?? [];
  const openFindings = allLive.filter((f) => !f.resolvedAt);
  const resolvedFindings = allLive.filter((f) => !!f.resolvedAt);
  const fpFindings = scan?.falsePositives ?? [];
  const findings =
    view === 'false-positive' ? fpFindings : view === 'resolved' ? resolvedFindings : openFindings;

  const detectors = useMemo(
    () => ['any', ...Array.from(new Set(findings.map((f) => f.detectorId))).sort()],
    [findings],
  );
  const clusters = useMemo(
    () => [
      'any',
      ...Array.from(
        new Set(findings.map((f) => extractCluster(f)).filter(Boolean) as string[]),
      ).sort(),
    ],
    [findings],
  );
  const directories = useMemo(
    () => [
      'any',
      ...Array.from(
        new Set(
          findings.map((f) => topLevelDir(f.evidence[0]?.file ?? '')).filter((d) => d.length > 0),
        ),
      ).sort(),
    ],
    [findings],
  );

  const filtered = useMemo(() => {
    let list = findings.filter((f) => sev.has(f.severity));
    if (detector !== 'any') list = list.filter((f) => f.detectorId === detector);
    if (cluster !== 'any') list = list.filter((f) => extractCluster(f) === cluster);
    if (directory !== 'any')
      list = list.filter((f) => topLevelDir(f.evidence[0]?.file ?? '') === directory);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          f.fingerprint.toLowerCase().includes(q) ||
          (f.evidence[0]?.file ?? '').toLowerCase().includes(q),
      );
    }
    list = list.slice().sort((a, b) => {
      if (sort === 'severity-cluster')
        return sevOrder(a) - sevOrder(b) || clusterSize(a, findings) - clusterSize(b, findings);
      if (sort === 'severity') return sevOrder(a) - sevOrder(b);
      if (sort === 'age') return 0; // age unknown — TODO once persistAt is exposed per-finding
      if (sort === 'detector') return a.detectorId.localeCompare(b.detectorId);
      return 0;
    });
    return list;
  }, [findings, sev, detector, cluster, directory, query, sort]);

  interface ClusterGroup {
    key: string;
    cluster: string | null;
    findings: Finding[];
    worstSeverity: Sev;
    detectors: Set<string>;
  }

  const groups: ClusterGroup[] = useMemo(() => {
    if (!grouped) {
      return filtered.map((f) => ({
        key: f.fingerprint,
        cluster: extractCluster(f),
        findings: [f],
        worstSeverity: f.severity,
        detectors: new Set([f.detectorId]),
      }));
    }
    const map = new Map<string, ClusterGroup>();
    for (const f of filtered) {
      const cluster = extractCluster(f);
      const key = cluster ? `cluster:${cluster}` : `fp:${f.fingerprint}`;
      const g = map.get(key);
      if (g) {
        g.findings.push(f);
        if (sevOrder(f) < SEV_ORDER[g.worstSeverity]!) g.worstSeverity = f.severity;
        g.detectors.add(f.detectorId);
      } else {
        map.set(key, {
          key,
          cluster,
          findings: [f],
          worstSeverity: f.severity,
          detectors: new Set([f.detectorId]),
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      const sa = SEV_ORDER[a.worstSeverity]!;
      const sb = SEV_ORDER[b.worstSeverity]!;
      if (sa !== sb) return sa - sb;
      return b.findings.length - a.findings.length;
    });
  }, [filtered, grouped]);

  const pageStart = (page - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, groups.length);
  const pageItems = groups.slice(pageStart, pageEnd);
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));

  // Open a finding while seeding the cross-page navigation queue with
  // the CURRENT filtered ordering — FindingDetail uses it to render
  // Prev / Next buttons + auto-advance after FP / resolve actions.
  const openFinding = (fp: string): void => {
    const ordered = filtered.map((f) => f.fingerprint);
    setQueue(ordered);
    onOpenFinding(fp);
  };

  if (err && !scan) return <div className="text-high">error: {err}</div>;
  if (!scan && loading) return <PageSkeleton rows={2} />;
  if (!scan) {
    return (
      <SectionHeader
        eyebrow="ALL FINDINGS"
        title={<span>No scan yet. Run one from the top bar.</span>}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-screen-2xl">
      <SectionHeader
        eyebrow={`ALL FINDINGS · SCAN #${scan.scanId.slice(0, 12)}`}
        title={
          <span>
            <span className="text-ink tabular-nums">
              {grouped ? `${groups.length} clusters` : `${filtered.length} findings`}
            </span>{' '}
            <span className="text-muted">
              · {filtered.length}{' '}
              {view === 'false-positive' ? 'flagged' : view === 'resolved' ? 'resolved' : 'findings'} of{' '}
              {findings.length}{' '}
              {view === 'false-positive' ? 'FP' : view === 'resolved' ? 'resolved' : 'open'}
            </span>
          </span>
        }
        meta={
          <div className="flex items-center gap-3 flex-wrap">
            <RefreshDot visible={loading} />
            <div className="inline-flex rounded-md border border-border bg-panel text-[11px] font-mono overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setView('open');
                  setPage(1);
                }}
                className={
                  'px-2.5 py-1 ' +
                  (view === 'open' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink')
                }
              >
                open · {openFindings.length}
              </button>
              <button
                type="button"
                onClick={() => {
                  setView('resolved');
                  setPage(1);
                }}
                className={
                  'px-2.5 py-1 border-l border-border ' +
                  (view === 'resolved'
                    ? 'bg-low/10 text-low'
                    : 'text-muted hover:text-ink')
                }
              >
                resolved · {resolvedFindings.length}
              </button>
              <button
                type="button"
                onClick={() => {
                  setView('false-positive');
                  setPage(1);
                }}
                className={
                  'px-2.5 py-1 border-l border-border ' +
                  (view === 'false-positive'
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:text-ink')
                }
              >
                FP · {fpFindings.length}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setGrouped(!grouped)}
              className={
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-mono ' +
                (grouped
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border bg-panel text-muted hover:text-ink')
              }
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {grouped ? 'grouped by cluster' : 'ungrouped'}
            </button>
            <span>
              Sorted by <SortDropdown value={sort} setValue={setSort} />
            </span>
          </div>
        }
      />

      <FilterBar
        sev={sev}
        setSev={setSev}
        detectors={detectors}
        detector={detector}
        setDetector={setDetector}
        clusters={clusters}
        cluster={cluster}
        setCluster={setCluster}
        directories={directories}
        directory={directory}
        setDirectory={setDirectory}
        view={view}
        setView={(v) => {
          setView(v);
          setPage(1);
        }}
        query={query}
        setQuery={setQuery}
      />

      {/* Mobile — card list (≤ md). */}
      <section className="lg:hidden rounded-lg border border-border bg-panel divide-y divide-border-soft">
        {pageItems.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted text-sm">
            No findings match the current filter.
          </div>
        ) : (
          pageItems.map((g) => {
            const lead = g.findings[0]!;
            const detector =
              g.detectors.size === 1 ? [...g.detectors][0]! : `${g.detectors.size} detectors`;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => openFinding(lead.fingerprint)}
                className="w-full text-left px-4 py-3 hover:bg-bg flex flex-col gap-1.5"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <SeverityChip severity={g.worstSeverity} />
                  <span className="text-[11px] font-mono text-muted">{detector}</span>
                  {g.cluster && <ClusterPill name={g.cluster} />}
                  {g.findings.length > 1 && (
                    <span className="text-[10px] font-mono text-accent border border-accent/40 rounded px-1.5 py-px">
                      {g.findings.length} findings
                    </span>
                  )}
                </div>
                <div className="text-sm text-ink">{stripBackticks(lead.title)}</div>
                <div className="text-[11px] font-mono text-muted truncate">
                  {lead.evidence[0]?.file}:{lead.evidence[0]?.range.startLine}
                  {g.findings.length > 1 && ` · +${g.findings.length - 1} more in cluster`}
                </div>
              </button>
            );
          })
        )}
        <div className="px-4 py-3 flex items-center justify-between text-xs text-muted font-mono">
          <span>
            {filtered.length === 0 ? 0 : pageStart + 1}–{pageEnd} of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <PageButton disabled={page === 1} onClick={() => setPage(page - 1)}>
              ‹
            </PageButton>
            <span className="px-2">
              {page}/{totalPages}
            </span>
            <PageButton disabled={page === totalPages} onClick={() => setPage(page + 1)}>
              ›
            </PageButton>
          </div>
        </div>
      </section>

      {/* Desktop — full table (≥ lg). */}
      <section className="hidden lg:block rounded-lg border border-border bg-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-muted font-mono border-b border-border-soft">
              <th className="w-8 pl-4 py-3 text-left font-normal"></th>
              <th className="w-20 py-3 text-left font-normal">sev</th>
              <th className="w-56 py-3 text-left font-normal">detector</th>
              <th className="py-3 text-left font-normal">title</th>
              <th className="w-32 py-3 text-left font-normal">cluster</th>
              <th className="w-80 py-3 text-left font-normal">path</th>
              <th className="w-12 py-3 text-right font-normal">age</th>
              <th className="w-20 py-3 text-right pr-5 font-normal">status</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-muted text-sm">
                  No findings match the current filter.
                </td>
              </tr>
            ) : (
              pageItems.map((g, i) => {
                const lead = g.findings[0]!;
                const detectorLabel =
                  g.detectors.size === 1 ? [...g.detectors][0]! : `${g.detectors.size} detectors`;
                return (
                  <tr
                    key={g.key}
                    className={
                      'cursor-pointer hover:bg-bg border-b border-border-soft last:border-b-0 ' +
                      (i % 2 === 0 ? '' : 'bg-bg/30')
                    }
                    onClick={() => openFinding(lead.fingerprint)}
                  >
                    <td className="pl-4 py-2.5">
                      <input
                        type="checkbox"
                        onClick={(e) => e.stopPropagation()}
                        onChange={TODO('select for bulk action')}
                        className="accent-accent"
                      />
                    </td>
                    <td className="py-2.5">
                      <SeverityChip severity={g.worstSeverity} />
                    </td>
                    <td className="py-2.5 font-mono text-xs text-ink truncate">{detectorLabel}</td>
                    <td className="py-2.5 text-sm text-ink truncate max-w-md">
                      {stripBackticks(lead.title)}
                      {g.findings.length > 1 && (
                        <span className="ml-2 text-[10px] font-mono text-accent border border-accent/40 rounded px-1.5 py-px">
                          {g.findings.length}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5">{g.cluster && <ClusterPill name={g.cluster} />}</td>
                    <td className="py-2.5 font-mono text-xs text-muted truncate">
                      {lead.evidence[0]?.file}:{lead.evidence[0]?.range.startLine}
                    </td>
                    <td className="py-2.5 text-right font-mono text-xs text-muted">—</td>
                    <td className="py-2.5 pr-5 text-right text-xs text-muted">open</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="px-5 py-3 border-t border-border-soft flex items-center justify-between text-xs text-muted font-mono">
          <span>
            Showing{' '}
            <span className="text-ink">
              {filtered.length === 0 ? 0 : pageStart + 1}–{pageEnd}
            </span>{' '}
            of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <PageButton disabled={page === 1} onClick={() => setPage(page - 1)}>
              ‹
            </PageButton>
            {Array.from({ length: totalPages }, (_, i) => (
              <PageButton key={i} active={page === i + 1} onClick={() => setPage(i + 1)}>
                {i + 1}
              </PageButton>
            ))}
            <PageButton disabled={page === totalPages} onClick={() => setPage(page + 1)}>
              ›
            </PageButton>
          </div>
        </div>
      </section>
    </div>
  );
}

interface FilterBarProps {
  sev: Set<Sev>;
  setSev: (s: Set<Sev>) => void;
  detectors: string[];
  detector: string;
  setDetector: (v: string) => void;
  clusters: string[];
  cluster: string;
  setCluster: (v: string) => void;
  directories: string[];
  directory: string;
  setDirectory: (v: string) => void;
  view: 'open' | 'resolved' | 'false-positive';
  setView: (v: 'open' | 'resolved' | 'false-positive') => void;
  query: string;
  setQuery: (v: string) => void;
}

function FilterBar({
  sev,
  setSev,
  detectors,
  detector,
  setDetector,
  clusters,
  cluster,
  setCluster,
  directories,
  directory,
  setDirectory,
  view,
  setView,
  query,
  setQuery,
}: FilterBarProps): JSX.Element {
  const toggle = (s: Sev) => {
    const next = new Set(sev);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSev(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 -mx-1 px-1">
      <SevToggle active={sev.has('high')} onClick={() => toggle('high')} severity="high" />
      <SevToggle active={sev.has('medium')} onClick={() => toggle('medium')} severity="medium" />
      <SevToggle active={sev.has('low')} onClick={() => toggle('low')} severity="low" />
      <Dropdown label="detector" value={detector} options={detectors} onChange={setDetector} />
      <Dropdown label="cluster" value={cluster} options={clusters} onChange={setCluster} />
      <Dropdown label="directory" value={directory} options={directories} onChange={setDirectory} />
      <Dropdown
        label="status"
        value={view}
        options={['open', 'resolved', 'false-positive']}
        onChange={(v) => setView(v as 'open' | 'resolved' | 'false-positive')}
      />
      <div className="flex-1 min-w-[200px] relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by title, path or fingerprint…"
          className="w-full rounded-md border border-border bg-panel pl-9 pr-3 py-1.5 text-xs text-ink font-mono placeholder-muted focus:border-accent focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => {
          setSev(new Set(['high', 'medium', 'low']));
          setDetector('any');
          setCluster('any');
          setDirectory('any');
          setQuery('');
        }}
        className="text-xs text-muted hover:text-ink"
      >
        Reset
      </button>
    </div>
  );
}

function SevToggle({
  active,
  onClick,
  severity,
}: {
  active: boolean;
  onClick: () => void;
  severity: Sev;
}): JSX.Element {
  const cls = {
    high: active ? 'bg-high/15 border-high/60 text-high' : 'border-border text-muted',
    medium: active ? 'bg-med/15 border-med/60 text-med' : 'border-border text-muted',
    low: active ? 'bg-low/20 border-low/60 text-low' : 'border-border text-muted',
  }[severity];
  const label = severity === 'medium' ? 'MED' : severity.toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-bold tracking-wider font-mono ' +
        cls
      }
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </button>
  );
}

interface DropdownProps {
  label: string;
  value: string;
  options: string[];
  onChange: ((v: string) => void) | (() => void);
}

function Dropdown({ label, value, options, onChange }: DropdownProps): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2 px-3 py-1 rounded-md border border-border bg-panel text-xs text-muted font-mono">
      {label}
      <select
        value={value}
        onChange={(e) => (onChange as (v: string) => void)(e.target.value)}
        className="bg-transparent text-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-panel">
            {o}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="text-muted" />
    </label>
  );
}

interface SortDropdownProps {
  value: SortKey;
  setValue: (v: SortKey) => void;
}

function SortDropdown({ value, setValue }: SortDropdownProps): JSX.Element {
  return (
    <label className="inline-flex items-center gap-1 cursor-pointer">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as SortKey)}
        className="bg-panel border border-border rounded-md px-2 py-1 text-xs text-ink font-mono focus:outline-none"
        aria-label="sort"
      >
        <option value="severity-cluster">severity, then cluster size</option>
        <option value="severity">severity</option>
        <option value="age">age</option>
        <option value="detector">detector</option>
      </select>
    </label>
  );
}

function PageButton({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        'w-7 h-7 rounded text-xs font-mono ' +
        (active
          ? 'bg-ink text-panel'
          : disabled
            ? 'text-muted/40'
            : 'text-muted hover:text-ink hover:bg-bg')
      }
    >
      {children}
    </button>
  );
}

function topLevelDir(file: string): string {
  const parts = file.split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]}/${parts[1]}`;
}

function stripBackticks(s: string): string {
  return s.replace(/`/g, '');
}

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sevOrder(f: Finding): number {
  return SEV_ORDER[f.severity] ?? 9;
}

function clusterSize(f: Finding, all: Finding[]): number {
  const c = extractCluster(f);
  if (!c) return 0;
  // Negative count so larger clusters sort first inside same severity.
  return -all.filter((x) => extractCluster(x) === c).length;
}
