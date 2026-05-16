import type { JSX } from 'react';
import { Loader2, Moon, Play, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme.js';
import { WorkspacePicker } from './WorkspacePicker.js';

interface TopBarProps {
  lastScanId: string | null;
  lastScanAgo?: string | null;
  onRunScan: () => Promise<void> | void;
  onHome?: () => void;
  pending?: boolean;
}

export function TopBar({
  lastScanId,
  lastScanAgo,
  onRunScan,
  onHome,
  pending = false,
}: TopBarProps): JSX.Element {
  const { theme, toggle } = useTheme();

  return (
    <header className="h-14 border-b border-border bg-panel flex items-center gap-2 sm:gap-3 px-3 sm:px-4 shrink-0">
      <WorkspacePicker />
      <button
        type="button"
        onClick={onHome}
        className="hidden lg:inline-flex items-center shrink-0 hover:opacity-80"
        title="Dashboard"
        aria-label="Dashboard"
      >
        <span className="text-[10px] uppercase tracking-widest text-muted font-mono">
          v0.41 · self-hosted
        </span>
      </button>

      {/* Last scan — hidden < lg. */}
      <div className="hidden lg:flex text-xs text-muted font-mono ml-2 items-center gap-2">
        last scan
        <span className="text-ink">{lastScanId ? `#${lastScanId.slice(0, 12)}` : '—'}</span>
        {lastScanAgo && <span className="text-muted">· {lastScanAgo}</span>}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={toggle}
        className="w-9 h-9 rounded-md flex items-center justify-center text-muted hover:text-ink hover:bg-bg"
        title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <button
        type="button"
        disabled={pending}
        onClick={() => void onRunScan()}
        className={
          'px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors shrink-0 ' +
          (pending
            ? 'bg-accent/10 border border-accent/30 text-accent/60 cursor-wait'
            : 'bg-accent text-panel hover:bg-accent/90')
        }
      >
        {pending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
        <span className="hidden sm:inline">{pending ? 'Starting…' : 'Run scan'}</span>
      </button>
    </header>
  );
}
