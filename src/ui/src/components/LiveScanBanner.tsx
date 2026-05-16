import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Activity, ChevronRight, Loader2, RefreshCcw } from 'lucide-react';
import { subscribeScan, type ScanSseEvent } from '../lib/api.js';

type SseStatus = 'open' | 'reconnecting' | 'closed';

interface LiveScanBannerProps {
  scanId: string;
  onOpen: () => void;
  onDone: () => void;
}

/**
 * Sticky bar pinned under the TopBar. Shown whenever a scan is in flight
 * and the user is on a route other than `running`, so progress is never
 * invisible just because they navigated away.
 */
export function LiveScanBanner({ scanId, onOpen, onDone }: LiveScanBannerProps): JSX.Element {
  const [latest, setLatest] = useState<ScanSseEvent | null>(null);
  const [status, setStatus] = useState<SseStatus>('open');

  useEffect(() => {
    const unsub = subscribeScan(
      scanId,
      (e) => {
        setLatest(e);
        if (e.state === 'done' || e.state === 'error') {
          setTimeout(onDone, 800);
        }
      },
      setStatus,
    );
    return () => unsub();
  }, [scanId, onDone]);

  const pct = progressPercent(latest);
  const labelText = label(latest);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left border-b border-border bg-panel hover:bg-bg flex items-center gap-3 px-4 py-2.5 shrink-0 group"
    >
      <span className="w-7 h-7 rounded-md bg-accent/15 text-accent flex items-center justify-center shrink-0">
        {latest?.state === 'llm-verdict' || latest?.state === 'llm-start' ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Activity size={13} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs font-mono">
          <span className="text-ink font-semibold">Scan running</span>
          <span className="text-muted truncate">{labelText}</span>
          {status === 'reconnecting' && (
            <span className="inline-flex items-center gap-1 text-med shrink-0">
              <RefreshCcw size={10} className="animate-spin" /> reconnecting
            </span>
          )}
          <span className="ml-auto text-muted tabular-nums shrink-0">{Math.round(pct)}%</span>
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-bg overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <ChevronRight size={14} className="text-muted group-hover:text-ink shrink-0" />
    </button>
  );
}

function progressPercent(e: ScanSseEvent | null): number {
  if (!e) return 4;
  if (e.state === 'done') return 100;
  if (e.state === 'error') return 100;
  const llmPct = e.llmTotal && e.llmTotal > 0 ? ((e.llmDone ?? 0) / e.llmTotal) * 100 : 0;
  if (e.state === 'llm-verdict' || e.state === 'llm-start') return 30 + llmPct * 0.6;
  if (e.state === 'detecting') return 25;
  if (e.state === 'parsing') return 12;
  return 6;
}

function label(e: ScanSseEvent | null): string {
  if (!e) return 'starting…';
  switch (e.state) {
    case 'queued':
      return 'queued';
    case 'parsing':
      return `parsing · ${e.files ?? 0} files`;
    case 'detecting':
      return `detecting · ${e.detector ?? '…'}`;
    case 'llm-start':
      return `verdicts · ${e.llmTotal ?? 0} pending`;
    case 'llm-verdict':
      return `verdicts · ${e.llmDone ?? 0}/${e.llmTotal ?? 0}`;
    case 'done':
      return `done · ${e.findings ?? 0} findings`;
    case 'error':
      return `error · ${e.error ?? 'failed'}`;
    default:
      return e.state;
  }
}
