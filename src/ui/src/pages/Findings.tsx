import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Ban, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import type { Finding, ScanRecord } from '../lib/api.js';
import {
  batchFalsePositives,
  batchMarkedToFix,
  generateCombinedFixPrompt,
  getScan,
  listMarkedToFix,
} from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { ClusterPill, SeverityChip } from '../components/Chips.js';
import { Checkbox } from '../components/Checkbox.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { toast } from '../lib/toast.js';
import { copyText } from '../lib/clipboard.js';
import { setQueue } from '../lib/finding-queue.js';
import { extractCluster } from '../lib/cluster.js';
import {
  FindingsFilterBar,
  PageButton,
  SortDropdown,
  type Sev,
  type SortKey,
} from '../components/FindingsFilterBar.js';

interface FindingsProps {
  scanId: string | null;
  onOpenFinding: (fingerprint: string) => void;
  initialDetector?: string;
  initialDirectory?: string;
  /** Severity pre-filter — when set, only that severity stays toggled on. */
  initialSeverity?: 'high' | 'medium' | 'low';
  /** Initial status tab — `resolved` / `false-positive` lets the dashboard
   *  drill straight into the right bucket from the KPI strip. */
  initialView?: 'open' | 'false-positive';
  /** Initial layer filter — the dashboard's LLM-verdict-rate cell sends
   *  `layer=3` so the operator lands on findings with an LLM verdict. */
  initialLayer?: 3;
}

export function Findings({
  scanId,
  onOpenFinding,
  initialDetector,
  initialDirectory,
  initialSeverity,
  initialView,
  initialLayer,
}: FindingsProps): JSX.Element {
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [sev, setSev] = useState<Set<Sev>>(
    initialSeverity ? new Set([initialSeverity]) : new Set(['high', 'medium', 'low']),
  );
  const [detector, setDetector] = useState<string>(initialDetector ?? 'any');
  const [directory, setDirectory] = useState<string>(initialDirectory ?? 'any');
  const [query, setQuery] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('severity-cluster');
  const [grouped, setGrouped] = useState<boolean>(true);
  const [page, setPage] = useState<number>(1);
  const [view, setView] = useState<'open' | 'false-positive'>(
    initialView === 'false-positive' ? 'false-positive' : 'open',
  );
  const [layerFilter] = useState<3 | undefined>(initialLayer);
  const pageSize = 18;
  // Bulk selection — fingerprints (lead per group) currently ticked in
  // the table. The header checkbox flips ALL filtered rows on/off.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Server-side fix-queue snapshot. Refreshed after every bulk add so
  // the "in queue" indicator stays accurate without a full reload.
  const [fixQueue, setFixQueue] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);
  const [combinedPrompt, setCombinedPrompt] = useState<string | null>(null);

  useEffect(() => {
    listMarkedToFix()
      .then((q) => setFixQueue(new Set(q.fingerprints)))
      .catch(() => undefined);
  }, [scanId]);

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

  // Per-scan findings + FPs from the server's partition. Open list
  // drops any `resolvedAt`-stamped entries — the resolved bucket was
  // dropped from the UI because in practice findings just disappear
  // when the underlying defect is fixed (the next scan won't emit
  // them), so a separate tab stayed empty in real usage.
  const openFindings = (scan?.findings ?? []).filter((f) => !f.resolvedAt);
  const fpFindings = scan?.falsePositives ?? [];
  const findings = view === 'false-positive' ? fpFindings : openFindings;

  const detectors = useMemo(
    () => ['any', ...Array.from(new Set(findings.map((f) => f.detectorId))).sort()],
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
    if (layerFilter != null) list = list.filter((f) => f.layer === layerFilter);
    if (detector !== 'any') list = list.filter((f) => f.detectorId === detector);
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
  }, [findings, sev, detector, directory, query, sort, layerFilter]);

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

  // Master select — fingerprints of the FILTERED set (every row the
  // operator currently sees, not just the current page). Lets a bulk
  // sweep cover everything matching the active filter in one click.
  const filteredFps = useMemo(() => filtered.map((f) => f.fingerprint), [filtered]);
  const allSelected = filteredFps.length > 0 && filteredFps.every((fp) => selected.has(fp));
  const someSelected = !allSelected && filteredFps.some((fp) => selected.has(fp));
  const toggleAll = (): void => {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const fp of filteredFps) next.delete(fp);
        return next;
      }
      const next = new Set(prev);
      for (const fp of filteredFps) next.add(fp);
      return next;
    });
  };
  const toggleOne = (fp: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fp)) next.delete(fp);
      else next.add(fp);
      return next;
    });
  };

  // Bulk add → POST mark-to-fix for every selected fingerprint in
  // parallel. Updates the local queue snapshot once + emits a single
  // toast with the resulting count.
  const bulkAddToFix = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const toAdd = [...selected].filter((fp) => !fixQueue.has(fp));
      // Single batched request — N parallel POSTs raced on the server's
      // JSON file write and only one survived (88 marked → 11 stored).
      await batchMarkedToFix({ add: toAdd });
      const refreshed = await listMarkedToFix();
      setFixQueue(new Set(refreshed.fingerprints));
      toast(`Added ${toAdd.length} finding${toAdd.length === 1 ? '' : 's'} to fix queue.`, 'info');
    } catch (e) {
      toast(`Bulk add failed: ${(e as Error).message}`, 'warn');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkRemoveFromFix = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const toRemove = [...selected].filter((fp) => fixQueue.has(fp));
      await batchMarkedToFix({ remove: toRemove });
      const refreshed = await listMarkedToFix();
      setFixQueue(new Set(refreshed.fingerprints));
      toast(
        `Removed ${toRemove.length} finding${toRemove.length === 1 ? '' : 's'} from fix queue.`,
        'info',
      );
    } catch (e) {
      toast(`Bulk remove failed: ${(e as Error).message}`, 'warn');
    } finally {
      setBulkBusy(false);
    }
  };

  // Bulk mark-as-FP — batches every selected fingerprint into one
  // server round-trip + refreshes the scan record so the rows move
  // from `open` into the `FP` tab without a manual reload. The single
  // POST endpoint had the same write-stomp race as mark-to-fix; the
  // batch endpoint serialises through the same mutex on the server.
  const bulkMarkFp = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const toAdd = [...selected];
      await batchFalsePositives({ add: toAdd });
      if (scanId) {
        const refreshed = await getScan(scanId);
        setScan(refreshed);
      }
      setSelected(new Set());
      toast(
        `Marked ${toAdd.length} finding${toAdd.length === 1 ? '' : 's'} as false positive.`,
        'info',
      );
    } catch (e) {
      toast(`Bulk FP failed: ${(e as Error).message}`, 'warn');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkUnmarkFp = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const toRemove = [...selected];
      await batchFalsePositives({ remove: toRemove });
      if (scanId) {
        const refreshed = await getScan(scanId);
        setScan(refreshed);
      }
      setSelected(new Set());
      toast(
        `Unmarked ${toRemove.length} finding${toRemove.length === 1 ? '' : 's'} as false positive.`,
        'info',
      );
    } catch (e) {
      toast(`Bulk unmark FP failed: ${(e as Error).message}`, 'warn');
    } finally {
      setBulkBusy(false);
    }
  };

  const onGenerateCombined = async (): Promise<void> => {
    if (fixQueue.size === 0) {
      toast('Mark at least one finding for fix first.', 'warn');
      return;
    }
    setBulkBusy(true);
    try {
      const r = await generateCombinedFixPrompt();
      setCombinedPrompt(r.prompt);
      toast(`Combined prompt ready (${r.findingCount} findings).`, 'info');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'warn');
    } finally {
      setBulkBusy(false);
    }
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
              · {filtered.length} {view === 'false-positive' ? 'flagged' : 'findings'} of{' '}
              {findings.length} {view === 'false-positive' ? 'FP' : 'open'}
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
                  setView('false-positive');
                  setPage(1);
                }}
                className={
                  'px-2.5 py-1 border-l border-border ' +
                  (view === 'false-positive'
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:text-ink')
                }
                title="False positives — LLM auto-routed and manually marked. Auto entries get an `AUTO` chip."
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

      <FindingsFilterBar
        sev={sev}
        setSev={setSev}
        detectors={detectors}
        detector={detector}
        setDetector={setDetector}
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

      {(selected.size > 0 || fixQueue.size > 0) && (
        <section className="sticky top-2 z-20 rounded-lg border border-accent/40 bg-panel/95 backdrop-blur px-4 py-3 flex items-center gap-3 flex-wrap shadow-lg shadow-accent/10">
          {selected.size > 0 ? (
            <>
              <span className="text-sm text-ink">
                <span className="font-semibold">{selected.size}</span> selected
              </span>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void bulkAddToFix()}
                className="rounded-md border border-accent/50 bg-accent/15 text-accent text-xs font-mono px-2.5 py-1 hover:bg-accent/25 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Sparkles size={11} /> Add to fix queue
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void bulkRemoveFromFix()}
                className="rounded-md border border-border bg-panel text-xs font-mono px-2.5 py-1 hover:bg-bg disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <X size={11} /> Remove from queue
              </button>
              {view === 'false-positive' ? (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void bulkUnmarkFp()}
                  className="rounded-md border border-border bg-panel text-xs font-mono px-2.5 py-1 hover:bg-bg disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <RotateCcw size={11} /> Unmark FP
                </button>
              ) : (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void bulkMarkFp()}
                  className="rounded-md border border-border bg-panel text-xs font-mono px-2.5 py-1 hover:bg-bg disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Ban size={11} /> Mark as FP
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-muted hover:text-ink"
              >
                Clear selection
              </button>
            </>
          ) : (
            <span className="text-sm text-muted">No rows selected</span>
          )}
          <span className="text-xs text-muted font-mono ml-auto">
            fix queue: <span className="text-accent">{fixQueue.size}</span>
          </span>
          {fixQueue.size > 0 && (
            <button
              type="button"
              disabled={bulkBusy}
              onClick={async () => {
                setBulkBusy(true);
                try {
                  await batchMarkedToFix({ remove: [...fixQueue] });
                  setFixQueue(new Set());
                  toast('Fix queue cleared.', 'info');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'warn');
                } finally {
                  setBulkBusy(false);
                }
              }}
              className="rounded-md border border-border bg-panel text-xs font-mono px-2.5 py-1 hover:bg-bg disabled:opacity-50 inline-flex items-center gap-1.5"
              title="Empty the fix queue without generating a prompt"
            >
              <X size={11} /> Clear queue
            </button>
          )}
          <button
            type="button"
            disabled={bulkBusy || fixQueue.size === 0}
            onClick={() => void onGenerateCombined()}
            className="rounded-md bg-accent text-panel text-xs font-medium px-3 py-1.5 hover:bg-accent/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {bulkBusy ? 'Building…' : 'Build combined fix prompt'}
          </button>
        </section>
      )}

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
              <th className="w-8 pl-4 py-3 text-left font-normal">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={toggleAll}
                  ariaLabel="select all filtered findings"
                />
              </th>
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
                      <Checkbox
                        checked={selected.has(lead.fingerprint)}
                        onChange={() => toggleOne(lead.fingerprint)}
                        stopPropagation
                        ariaLabel="select finding"
                      />
                    </td>
                    <td className="py-2.5">
                      <SeverityChip severity={g.worstSeverity} />
                    </td>
                    <td className="py-2.5 font-mono text-xs text-ink truncate">{detectorLabel}</td>
                    <td className="py-2.5 text-sm text-ink truncate max-w-md">
                      {fixQueue.has(lead.fingerprint) && (
                        <Sparkles size={11} className="inline text-accent mr-1.5" />
                      )}
                      {lead.llmFalsePositive && (
                        <span
                          className="mr-2 text-[10px] font-mono text-low border border-low/40 rounded px-1.5 py-px uppercase tracking-wider"
                          title={`LLM auto-FP — ${lead.llmFalsePositive.reason}`}
                        >
                          auto
                        </span>
                      )}
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
                    <td className="py-2.5 pr-5 text-right text-xs text-muted">
                      {view === 'false-positive'
                        ? lead.llmFalsePositive
                          ? 'auto FP'
                          : 'manual FP'
                        : 'open'}
                    </td>
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

      {combinedPrompt != null && (
        <CombinedFixPromptModal
          prompt={combinedPrompt}
          count={fixQueue.size}
          onClose={() => setCombinedPrompt(null)}
          onAfterCopy={async () => {
            // User just took the prompt to the agent — the queue has
            // served its purpose. Clear it server-side so the next
            // batch starts empty without a separate Clear click. Drop
            // the modal too: the user pasted and is done.
            if (fixQueue.size === 0) return;
            try {
              await batchMarkedToFix({ remove: [...fixQueue] });
              setFixQueue(new Set());
              setSelected(new Set());
              setCombinedPrompt(null);
              toast('Fix queue cleared.', 'info');
            } catch (e) {
              toast(`Failed to clear queue: ${(e as Error).message}`, 'warn');
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal that renders the deterministically-built combined fix prompt for every
 * finding in the fix queue. Identical shape to the dashboard's
 * version — kept inline here so the list page is self-contained.
 */
function CombinedFixPromptModal({
  prompt,
  count,
  onClose,
  onAfterCopy,
}: {
  prompt: string;
  count: number;
  onClose: () => void;
  /** Fires after a successful clipboard write — used to clear the
   * fix queue once the operator has taken the prompt away. */
  onAfterCopy?: () => void | Promise<void>;
}): JSX.Element {
  const [copied, setCopied] = useState<boolean>(false);
  const onCopy = async (): Promise<void> => {
    try {
      await copyText(prompt);
      setCopied(true);
      toast('Combined prompt copied.', 'info');
      setTimeout(() => setCopied(false), 1500);
      await onAfterCopy?.();
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
              {count} finding{count === 1 ? '' : 's'} · paste into Claude Code · Cursor · Codex
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
