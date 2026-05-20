import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Monaco, OnMount } from '@monaco-editor/react';

// Monaco is ~3 MB of JS — lazy-load so the dashboard doesn't pay the cost
// until the user actually opens a finding-detail panel.
const Editor = lazy(() => import('@monaco-editor/react'));
import { ChevronRight, Copy, FlaskConical, Loader2, RefreshCcw, Sparkles, X } from 'lucide-react';
import type { CodeWindow, Finding } from '../lib/api.js';
import {
  getCodeWindow,
  getFinding,
  getScan,
  listFalsePositives,
  listMarkedToFix,
  listScans,
  markFalsePositive,
  markToFix,
  rerunFindingVerdict,
  unmarkFalsePositive,
  unmarkToFix,
} from '../lib/api.js';
import { neighbours } from '../lib/finding-queue.js';
import { extractCluster } from '../lib/cluster.js';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { SeverityChip, ClusterPill } from '../components/Chips.js';
import { PageSkeleton, RefreshDot } from '../components/Skeleton.js';
import { FixPromptModal } from '../components/FixPromptModal.js';
import { toast } from '../lib/toast.js';
import { copyText } from '../lib/clipboard.js';

interface FindingDetailProps {
  fingerprint: string;
  onBack: () => void;
  onOpenFinding?: (fp: string) => void;
}

interface ClusterSibling {
  fingerprint: string;
  file: string;
  line: number;
}

export function FindingDetail({
  fingerprint,
  onBack,
  onOpenFinding,
}: FindingDetailProps): JSX.Element {
  const [finding, setFinding] = useState<Finding | null>(null);
  const [codeWindow, setCodeWindow] = useState<CodeWindow | null>(null);
  const [activeEvidence, setActiveEvidence] = useState<number>(0);
  const [evidenceLoading, setEvidenceLoading] = useState<boolean>(false);
  const [siblings, setSiblings] = useState<ClusterSibling[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [promptOpen, setPromptOpen] = useState<boolean>(false);
  const [isFalsePositive, setIsFalsePositive] = useState<boolean>(false);
  const [isMarkedToFix, setIsMarkedToFix] = useState<boolean>(false);
  const [rerunBusy, setRerunBusy] = useState<boolean>(false);
  const [resolved, setResolved] = useState<boolean>(false);
  // `true` when the evidence snippet captured at scan time does NOT match
  // the live file content at the same line range — operator likely edited
  // the file already. Used to badge the snippet view + trigger an auto
  // re-run so the verdict reflects reality.
  const [fileShifted, setFileShifted] = useState<boolean>(false);
  // Ref used to fire the auto-rerun exactly once per fingerprint when a
  // file shift is detected on mount. Without it the rerun would fire on
  // every render of the page.
  const autoRerunFiredRef = useRef<string | null>(null);

  // Re-run the originating detector on just this finding's files. Used
  // after the operator pastes the fix prompt into Claude Code / Codex /
  // Cursor and applies the patch locally — the button asks the engine
  // whether the issue is still detectable without paying for a full
  // workspace rescan.
  const onRerun = async (): Promise<void> => {
    if (!finding) return;
    setRerunBusy(true);
    try {
      const result = await rerunFindingVerdict(finding.fingerprint);
      if (result.status === 'resolved') {
        setResolved(true);
        // Mirror the persisted resolved flag locally so the frozen-
        // snippet view kicks in without a page reload.
        setFinding((cur) => (cur ? { ...cur, resolvedAt: result.resolvedAt } : cur));
        toast('Resolved — detector no longer flags this finding.', 'info');
      } else if (result.status === 'still-present') {
        setFinding(result.finding);
        setResolved(false);
        toast('Issue still present after re-check. Verdict refreshed.', 'warn');
      } else {
        toast(result.reason, 'warn');
      }
    } catch (e) {
      toast(`Re-run failed: ${(e as Error).message}`, 'warn');
    } finally {
      setRerunBusy(false);
    }
  };

  // Auto-rerun once per fingerprint when the live file no longer matches
  // the scan-time snippet. The operator likely applied the fix prompt
  // already and just navigated back to confirm — saving them a click.
  useEffect(() => {
    if (!finding) return;
    if (finding.resolvedAt) return;
    if (!fileShifted) return;
    if (rerunBusy) return;
    if (autoRerunFiredRef.current === finding.fingerprint) return;
    autoRerunFiredRef.current = finding.fingerprint;
    void onRerun();
    // onRerun is stable per finding identity; intentionally omitted from
    // deps to keep this a single-shot trigger per shift detection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, fileShifted, rerunBusy]);

  useEffect(() => {
    setActiveEvidence(0);
    let cancelled = false;
    setLoading(true);
    // Resolve FP flag in parallel so the action label boots in the
    // right state even before the user sees the page.
    listFalsePositives()
      .then((fps) => {
        if (!cancelled) setIsFalsePositive(fps.includes(fingerprint));
      })
      .catch(() => undefined);
    // Same shape for the marked-to-fix queue so the toggle label boots
    // in the right state.
    listMarkedToFix()
      .then((q) => {
        if (!cancelled) setIsMarkedToFix(q.fingerprints.includes(fingerprint));
      })
      .catch(() => undefined);
    // Reset shift state on every fingerprint switch so an old finding's
    // "stale" badge doesn't survive into a freshly opened one.
    setFileShifted(false);
    getFinding(fingerprint)
      .then(async (d) => {
        if (cancelled) return;
        setFinding(d.finding);
        setCodeWindow(d.codeWindow);
        // Compare scan-time snippet against the live file content at the
        // same line range. Any non-whitespace diff = file shifted →
        // surface a banner + auto-trigger the re-run so the verdict the
        // operator sees reflects current reality.
        if (!d.finding.resolvedAt && d.codeWindow && d.finding.evidence[0]) {
          const snippet = (d.finding.evidence[0].snippet ?? '').replace(/\s+/g, ' ').trim();
          const liveText = d.codeWindow.lines.join('\n').replace(/\s+/g, ' ').trim();
          if (snippet && liveText && !liveText.includes(snippet) && !snippet.includes(liveText)) {
            setFileShifted(true);
          }
        }
        const cluster = extractCluster(d.finding);
        if (cluster) {
          try {
            const list = await listScans();
            const latest = list.find((s) => s.state === 'done');
            if (latest) {
              const full = await getScan(latest.scanId);
              const sibs = (full.findings ?? [])
                .filter((f) => extractCluster(f) === cluster)
                .map((f) => ({
                  fingerprint: f.fingerprint,
                  file: f.evidence[0]?.file ?? '',
                  line: f.evidence[0]?.range.startLine ?? 0,
                }));
              setSiblings(sibs);
            }
          } catch {
            // ignore — sidebar omitted
          }
        } else {
          if (!cancelled) setSiblings([]);
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
  }, [fingerprint]);

  const onSelectEvidence = async (idx: number): Promise<void> => {
    if (!finding) return;
    if (idx === activeEvidence) return;
    const ev = finding.evidence[idx];
    if (!ev) return;
    setActiveEvidence(idx);
    setEvidenceLoading(true);
    try {
      const cw = await getCodeWindow(ev.file, ev.range.startLine, ev.range.endLine, 6);
      setCodeWindow(cw);
    } finally {
      setEvidenceLoading(false);
    }
  };

  if (err && !finding) return <div className="text-high">error: {err}</div>;
  if (!finding) return <PageSkeleton rows={3} />;

  const verdict = extractVerdictBlock(finding.description);
  const cluster = extractCluster(finding);
  const detector = finding.detectorId;
  const nav = neighbours(fingerprint);

  return (
    <div className="space-y-6 max-w-screen-2xl min-w-0">
      <div className="flex items-center gap-3 flex-wrap">
        <Breadcrumb cluster={cluster} file={finding.evidence[0]?.file} onBack={onBack} />
        <RefreshDot visible={loading} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-mono">
        <SeverityChip severity={finding.severity} />
        <span className="text-ink">{detector}</span>
        <span className="text-muted hidden sm:inline">·</span>
        <span className="text-muted">fingerprint</span>
        <span className="text-ink truncate max-w-[16ch] sm:max-w-[24ch]">{fingerprint}</span>
        <span className="text-muted hidden sm:inline">·</span>
        <span className="text-muted">conf</span>
        <span className="text-ink">{finding.confidence.toFixed(2)}</span>
        <span className="text-muted hidden sm:inline">·</span>
        <span className="text-muted">layer</span>
        <span className="text-ink">
          L{finding.layer}
          {finding.layer === 3 ? ' / LLM' : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Cross-finding navigation — seeded by Findings page on
            drill-down so the operator can sweep through the current
            filtered list without bouncing back to the list each time. */}
        {nav.total > 0 && (
          <div className="inline-flex rounded-md border border-border bg-panel text-xs font-mono">
            <button
              type="button"
              disabled={!nav.prev}
              onClick={() => nav.prev && onOpenFinding?.(nav.prev)}
              className="px-2 py-1 text-muted hover:text-ink disabled:opacity-40"
              title="Previous finding in list"
            >
              <ArrowLeft size={12} />
            </button>
            <span className="px-2 py-1 border-l border-border text-muted">
              {nav.index + 1} / {nav.total}
            </span>
            <button
              type="button"
              disabled={!nav.next}
              onClick={() => nav.next && onOpenFinding?.(nav.next)}
              className="px-2 py-1 border-l border-border text-muted hover:text-ink disabled:opacity-40"
              title="Next finding in list"
            >
              <ArrowRight size={12} />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setPromptOpen(true)}
          className="rounded-md border border-accent/50 bg-accent/10 text-accent px-2.5 py-1 text-xs font-mono inline-flex items-center gap-1.5 hover:bg-accent/15"
        >
          <Sparkles size={11} /> Generate fix prompt
        </button>
        <button
          type="button"
          disabled={rerunBusy}
          onClick={() => void onRerun()}
          className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs font-mono inline-flex items-center gap-1.5 text-ink hover:bg-bg disabled:opacity-50"
          title="Re-run the detector + LLM on this finding's files only — fastest way to confirm a local fix"
        >
          {rerunBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCcw size={11} />}
          {rerunBusy ? 'Re-checking…' : 'Re-run verdict'}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (isMarkedToFix) {
              await unmarkToFix(finding.fingerprint);
              setIsMarkedToFix(false);
              toast('Removed from fix queue.', 'info');
            } else {
              await markToFix(finding.fingerprint);
              setIsMarkedToFix(true);
              toast('Added to fix queue.', 'info');
            }
          }}
          className={
            'rounded-md border px-2.5 py-1 text-xs font-mono inline-flex items-center gap-1.5 ' +
            (isMarkedToFix
              ? 'border-accent/50 bg-accent/15 text-accent'
              : 'border-border text-ink hover:bg-bg')
          }
          title="Queue this finding for the combined fix prompt on the dashboard"
        >
          <FlaskConical size={11} />
          {isMarkedToFix ? 'In fix queue' : 'Add to fix queue'}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (isFalsePositive) {
              await unmarkFalsePositive(finding.fingerprint);
              setIsFalsePositive(false);
            } else {
              await markFalsePositive(finding.fingerprint);
              setIsFalsePositive(true);
              // After marking as false positive the finding is gone
              // from the operator's queue — auto-advance to the next
              // entry so triage flows without an extra back-and-click.
              if (nav.next && onOpenFinding) {
                onOpenFinding(nav.next);
              }
            }
          }}
          className={
            'rounded-md border px-2.5 py-1 text-xs font-mono inline-flex items-center gap-1.5 ' +
            (isFalsePositive
              ? 'border-low/40 bg-low/10 text-low'
              : 'border-border text-ink hover:bg-bg')
          }
        >
          <X size={11} /> {isFalsePositive ? 'Unmark FP' : 'Mark false positive'}
        </button>
      </div>

      {resolved && (
        <section className="rounded-lg border border-low/40 bg-low/10 px-4 py-3 text-sm text-low font-mono flex items-center gap-2">
          <span className="text-base">✓</span>
          Resolved — re-check found nothing. The persisted scan record has been updated.
        </section>
      )}

      <h1 className="font-serif text-[22px] sm:text-[32px] xl:text-[40px] leading-[1.2] text-ink tracking-tight break-words [overflow-wrap:anywhere]">
        {renderTitleWithMarks(finding.title)}
      </h1>

      <p className="text-muted max-w-3xl text-sm sm:text-base leading-relaxed break-words [overflow-wrap:anywhere]">
        {renderSubtitle(finding.description)}
      </p>

      <div className="flex items-center gap-3 flex-wrap text-xs text-muted font-mono">
        {cluster && <ClusterPill name={cluster} />}
        <span>
          {siblings.length} finding{siblings.length === 1 ? '' : 's'} in cluster
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6 min-w-0">
          {verdict && (
            <LlmVerdictCard
              verdict={verdict}
              finding={finding}
              onRerun={onRerun}
              rerunBusy={rerunBusy}
            />
          )}
          {/*
            ALWAYS render the FROZEN evidence snippet captured at scan
            time as the primary code view. The file on disk is volatile
            (the operator may have already started editing it after
            pasting the fix prompt) — re-reading at the original line
            range shows the wrong code AS-IF it were the problem.
            Drilling down to the current file content is intentionally
            a secondary action (the "current file" toggle below).
          */}
          {(() => {
            const ev = finding.evidence[activeEvidence] ?? finding.evidence[0];
            const isResolved = !!finding.resolvedAt;
            const stale = !isResolved && fileShifted;
            const tone = isResolved
              ? 'border-low/40 bg-low/5 text-low'
              : stale
                ? 'border-med/40 bg-med/5 text-med'
                : 'border-border bg-panel text-muted';
            const label = isResolved
              ? 'Frozen snippet · captured at scan time · file has since been fixed'
              : stale
                ? 'Frozen snippet · file has changed since the scan — re-run verdict to refresh'
                : 'Snippet · captured at scan time';
            return (
              <section className={`border rounded-lg p-4 space-y-3 ${tone}`}>
                <header className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-base">{isResolved ? '✓' : stale ? '⚠' : '·'}</span>
                  <span>{label}</span>
                  <span className="ml-auto text-muted">
                    {ev?.file}:{ev?.range.startLine}-{ev?.range.endLine}
                  </span>
                </header>
                <pre className="whitespace-pre-wrap break-words text-xs font-mono text-ink leading-relaxed bg-bg rounded border border-border-soft p-3">
                  {ev?.snippet ?? '(no snippet)'}
                </pre>
              </section>
            );
          })()}
          {/* Secondary: live file view. Hidden when the finding is
              resolved — there's no problem to point at any more. */}
          {!finding.resolvedAt && codeWindow && (
            <details className="border border-border rounded-lg bg-panel">
              <summary className="px-4 py-2 text-xs font-mono text-muted cursor-pointer hover:text-ink">
                Show current file content at this range
              </summary>
              <div className="border-t border-border-soft">
                <CodeView codeWindow={codeWindow} loading={evidenceLoading} />
              </div>
            </details>
          )}
          <EvidencePanel
            finding={finding}
            activeIndex={activeEvidence}
            onSelect={(idx) => void onSelectEvidence(idx)}
          />
        </div>

        <aside className="space-y-4 min-w-0">
          {finding.suggestion && <SuggestedFixCard suggestion={finding.suggestion} />}
          {siblings.length > 0 && (
            <ClusterSidebar
              current={fingerprint}
              siblings={siblings}
              onOpen={(fp) => onOpenFinding?.(fp)}
            />
          )}
        </aside>
      </div>
      {promptOpen && (
        <FixPromptModal fingerprint={finding.fingerprint} onClose={() => setPromptOpen(false)} />
      )}
    </div>
  );
}

function Breadcrumb({
  cluster,
  file,
  onBack,
}: {
  cluster: string | null;
  file?: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <nav className="flex items-center gap-1.5 text-xs text-muted font-mono flex-wrap">
      <button type="button" onClick={onBack} className="hover:text-ink">
        Dashboard
      </button>
      <ChevronRight size={12} />
      <button type="button" onClick={onBack} className="hover:text-ink">
        Findings
      </button>
      {cluster && (
        <>
          <ChevronRight size={12} />
          <span className="text-info">§{cluster}</span>
        </>
      )}
      {file && (
        <>
          <ChevronRight size={12} />
          <span className="text-ink truncate max-w-[40ch]">{file}</span>
        </>
      )}
    </nav>
  );
}

function LlmVerdictCard({
  verdict,
  finding,
  onRerun,
  rerunBusy,
}: {
  verdict: { label: string; reason: string; confidence: number };
  finding: Finding;
  onRerun: () => Promise<void>;
  rerunBusy: boolean;
}): JSX.Element {
  return (
    <section className="border border-accent/30 bg-accent/5 rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-accent/20 flex items-center gap-3 flex-wrap">
        <span className="text-[11px] uppercase tracking-widest text-accent font-mono font-semibold">
          LLM verdict
        </span>
        <span className="text-xs text-muted font-mono">local LLM</span>
        <span
          className={
            'ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-bold tracking-wider font-mono ' +
            (verdict.label === 'FP'
              ? 'border-low/60 bg-low/15 text-low'
              : 'border-high/60 bg-high/15 text-high')
          }
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {verdict.label}
        </span>
      </header>
      <div className="p-5 space-y-3">
        <p className="text-sm text-ink leading-relaxed">{verdict.reason}</p>
        <footer className="pt-3 border-t border-accent/20 flex items-center gap-4 text-[11px] text-muted font-mono flex-wrap">
          <span className="text-low flex items-center gap-1">
            <span>✓</span> verdict cached
          </span>
          <span>·</span>
          <span>
            confidence <span className="text-ink">{verdict.confidence.toFixed(2)}</span>
          </span>
          <span>·</span>
          <span>
            static (L2) score <span className="text-ink">{finding.confidence.toFixed(2)}</span>
          </span>
          <button
            type="button"
            disabled={rerunBusy}
            onClick={() => void onRerun()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 text-xs text-ink hover:bg-bg disabled:opacity-50"
          >
            {rerunBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCcw size={11} />}
            {rerunBusy ? 'RE-CHECKING…' : 'RE-RUN VERDICT'}
          </button>
        </footer>
      </div>
    </section>
  );
}

function CodeView({
  codeWindow,
  loading,
}: {
  codeWindow: CodeWindow;
  loading?: boolean;
}): JSX.Element {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const [expanded, setExpanded] = useState<boolean>(false);

  const source = codeWindow.lines.join('\n');
  const language = inferLanguage(codeWindow.file);
  const highlightStart = codeWindow.highlightFrom - codeWindow.startLine + 1;
  const highlightEnd = codeWindow.highlightTo - codeWindow.startLine + 1;
  const lines = codeWindow.lines.length;
  const visibleLines = expanded ? lines : Math.min(lines, 16);

  const applyDecorations = (): void => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (highlightEnd >= 1) {
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [
        {
          range: new monaco.Range(highlightStart, 1, highlightEnd, 1),
          options: {
            isWholeLine: true,
            className: 'rothunter-race-line',
            linesDecorationsClassName: 'rothunter-race-gutter',
          },
        },
      ]);
      editor.revealLineInCenter(highlightStart);
    } else {
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
    }
  };

  // Re-apply whenever the active evidence (and therefore highlight range
  // / source text) changes. Monaco only mounts once per render of this
  // component, so a one-shot decoration in handleMount would leave every
  // subsequent evidence click without the red gutter.
  useEffect(() => {
    applyDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeWindow.file, codeWindow.startLine, codeWindow.highlightFrom, codeWindow.highlightTo]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme('rothunter-paper', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1a1814',
        'editor.foreground': '#e6e2d8',
        'editor.lineHighlightBackground': '#221d18',
        'editorLineNumber.foreground': '#8a8478',
        'editorLineNumber.activeForeground': '#e6e2d8',
      },
    });
    monaco.editor.setTheme('rothunter-paper');
    applyDecorations();
  };

  return (
    <section className="border border-border rounded-lg bg-panel overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border-soft flex items-center justify-between gap-3 flex-wrap text-xs font-mono">
        <span className="text-ink truncate flex items-center gap-2">
          {loading && <Loader2 size={11} className="animate-spin text-muted" />}
          {codeWindow.file}{' '}
          <span className="text-muted">
            lines {codeWindow.startLine}–{codeWindow.endLine} · main
          </span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              copyText(codeWindow.lines.join('\n'))
                .then(() => toast('Snippet copied.', 'info'))
                .catch((e: Error) => toast(`Copy failed: ${e.message}`, 'warn'));
            }}
            className="rounded-md border border-border bg-bg px-2.5 py-1 text-xs text-ink hover:bg-panel flex items-center gap-1.5"
          >
            <Copy size={11} /> Copy
          </button>
        </div>
      </header>
      <div style={{ height: Math.max(220, visibleLines * 19 + 16) }}>
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center text-[11px] text-muted font-mono">
              loading editor…
            </div>
          }
        >
          <Editor
            defaultLanguage={language}
            value={source}
            onMount={handleMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: '"Geist Mono", ui-monospace, "SF Mono", monospace',
              lineNumbers: (n) => String(codeWindow.startLine + n - 1),
              scrollBeyondLastLine: false,
              renderWhitespace: 'none',
              folding: false,
              wordWrap: 'off',
              scrollbar: { vertical: 'auto', horizontal: 'auto', verticalSliderSize: 6 },
              contextmenu: false,
            }}
          />
        </Suspense>
      </div>
      <footer className="px-4 py-2 border-t border-border-soft flex items-center justify-between text-[11px] font-mono">
        <span className="text-muted">
          <span className="text-high">Race window:</span> lines{' '}
          <span className="text-ink">
            {codeWindow.highlightFrom}–{codeWindow.highlightTo}
          </span>{' '}
          · spans <span className="text-ink">await</span>
        </span>
        {lines > 16 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-accent hover:underline"
          >
            {expanded ? 'collapse' : `show ${lines - 16} more lines`}
          </button>
        )}
      </footer>
    </section>
  );
}

function SuggestedFixCard({ suggestion }: { suggestion: string }): JSX.Element {
  return (
    <section className="border border-border bg-panel rounded-lg overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
        <span className="text-sm font-semibold text-ink">Suggested fix</span>
        <span className="text-xs text-muted font-mono">static · text only</span>
      </header>
      <p className="px-4 py-3 text-sm text-ink leading-relaxed whitespace-pre-line">{suggestion}</p>
    </section>
  );
}

function ClusterSidebar({
  current,
  siblings,
  onOpen,
}: {
  current: string;
  siblings: ClusterSibling[];
  onOpen: (fp: string) => void;
}): JSX.Element {
  return (
    <section className="border border-border bg-panel rounded-lg overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
        <span className="text-sm font-semibold text-ink">Cluster</span>
        <span className="text-xs text-muted font-mono">
          {siblings.length} finding{siblings.length === 1 ? '' : 's'} · same root
        </span>
      </header>
      <ul className="divide-y divide-border-soft">
        {siblings.map((s) => {
          const isCurrent = s.fingerprint === current;
          return (
            <li key={s.fingerprint}>
              <button
                type="button"
                onClick={() => !isCurrent && onOpen(s.fingerprint)}
                disabled={isCurrent}
                className={
                  'w-full text-left flex items-center gap-3 px-4 py-2 text-xs font-mono ' +
                  (isCurrent ? 'text-ink' : 'text-muted hover:text-ink hover:bg-bg')
                }
              >
                <span
                  className={'w-1.5 h-1.5 rounded-full ' + (isCurrent ? 'bg-accent' : 'bg-border')}
                />
                <span className="truncate flex-1">
                  {s.file.split('/').pop()}:{s.line}
                </span>
                {isCurrent && <span className="text-[10px] text-accent tracking-widest">CURR</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EvidencePanel({
  finding,
  activeIndex,
  onSelect,
}: {
  finding: Finding;
  activeIndex: number;
  onSelect: (idx: number) => void;
}): JSX.Element {
  return (
    <section className="border border-border bg-panel rounded-lg overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
        <FlaskConical size={14} className="text-muted" />
        <span className="text-sm font-semibold text-ink">Evidence</span>
        <span className="text-xs text-muted font-mono">
          click any line to load it in the viewer above
        </span>
      </header>
      <ul className="divide-y divide-border-soft">
        {finding.evidence.map((ev, i) => {
          const active = i === activeIndex;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                className={
                  'w-full text-left px-4 py-2 text-xs font-mono flex items-center gap-3 ' +
                  (active ? 'bg-accent/10 text-ink' : 'text-muted hover:bg-bg hover:text-ink')
                }
              >
                <span className="w-6 text-right tabular-nums">{i + 1}.</span>
                <span
                  className={'w-1.5 h-1.5 rounded-full ' + (active ? 'bg-accent' : 'bg-border')}
                />
                <span className="truncate flex-1">
                  {ev.file}:{ev.range.startLine}
                </span>
                {active && <span className="text-[10px] tracking-widest text-accent">CURR</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function renderTitleWithMarks(title: string): JSX.Element {
  const parts = title.split(/`/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 0 ? (
          <span key={i}>{p}</span>
        ) : (
          <span
            key={i}
            className="inline-block align-baseline px-2 py-0.5 mx-1 rounded-md border border-border bg-panel-alt font-mono text-[0.7em] text-ink break-all [overflow-wrap:anywhere] max-w-full"
          >
            {p}
          </span>
        ),
      )}
    </>
  );
}

function renderSubtitle(description: string): string {
  const head = description.split(/\n\n\*\*LLM verdict:/)[0] ?? description;
  const firstPara = head.split(/\n\n/)[0] ?? '';
  return firstPara.replace(/`/g, '').slice(0, 320);
}

function extractVerdictBlock(
  description: string,
): { label: string; reason: string; confidence: number } | null {
  const m = /\*\*LLM verdict:\*\*\s*([^\n]+)/.exec(description);
  if (!m) return null;
  const line = m[1]!;
  const confMatch = /\(confidence (\d+(?:\.\d+)?)\)/.exec(line);
  const reason = line.replace(/^[^—]+—\s*/, '').replace(/\s*\(confidence [^)]+\)\s*$/, '');
  // Detector-specific positive/negative labels come from
  // applyClusterVerdict in the engine. Normalise the prefix to a
  // single REAL / FP badge so the operator never has to learn the
  // legacy race-vs-safe vocabulary just to read a dead-export or
  // magic-numbers verdict.
  const head = line.toLowerCase().split('—')[0]!.trim();
  const isFp =
    head.startsWith('safe') ||
    head.startsWith('intentional') ||
    head.startsWith('different concept') ||
    head.startsWith('false positive');
  return {
    label: isFp ? 'FP' : 'REAL',
    reason,
    confidence: confMatch ? Number(confMatch[1]) : 0.5,
  };
}

function inferLanguage(file: string): string {
  if (file.endsWith('.tsx') || file.endsWith('.ts')) return 'typescript';
  if (file.endsWith('.jsx') || file.endsWith('.js')) return 'javascript';
  if (file.endsWith('.json')) return 'json';
  if (file.endsWith('.sql')) return 'sql';
  return 'plaintext';
}
