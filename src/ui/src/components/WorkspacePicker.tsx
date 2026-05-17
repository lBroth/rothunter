import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { getWorkspace, setWorkspace, type WorkspaceState } from '../lib/api.js';
import { DirectoryBrowser } from './DirectoryBrowser.js';

/**
 * Dropdown that lets the operator switch the active RotHunter workspace
 * in-process. Persists across server restarts via ~/.rothunter/workspace.json.
 *
 * On a successful switch we hard-reload so every cached page (Dashboard,
 * Symbols, History) re-fetches against the new workspace. A finer-grained
 * cache-invalidation bus is overkill until we need partial refreshes.
 */
export function WorkspacePicker(): JSX.Element {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [browsing, setBrowsing] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWorkspace().then(setState).catch(() => undefined);
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const apply = async (target: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await setWorkspace(target);
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const currentName = state?.name ?? '…';
  const recent = (state?.recent ?? []).filter((p) => p !== state?.current);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs sm:text-sm font-mono hover:bg-panel"
        title={state?.current ?? 'workspace'}
      >
        <Folder size={13} className="text-muted" />
        <span className="text-ink max-w-[10ch] sm:max-w-[14ch] truncate">{currentName}</span>
        <ChevronDown size={12} className="text-muted" />
      </button>

      {open && (
        <div className="absolute left-0 mt-1 z-40 w-[min(22rem,calc(100vw-1.5rem))] rounded-md border border-border bg-panel shadow-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border-soft">
            <div className="text-[10px] uppercase tracking-widest text-muted font-mono">current</div>
            <div className="text-xs font-mono text-ink break-all mt-0.5">{state?.current ?? '—'}</div>
          </div>

          {recent.length > 0 && (
            <div className="border-b border-border-soft">
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-muted font-mono">
                recent
              </div>
              <ul className="max-h-48 overflow-y-auto">
                {recent.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void apply(p)}
                      className="w-full text-left px-3 py-1.5 text-xs font-mono text-muted hover:bg-bg hover:text-ink truncate disabled:opacity-50"
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="px-3 py-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setBrowsing(true);
              }}
              className="w-full px-2.5 py-1.5 rounded text-xs font-medium bg-accent text-panel hover:bg-accent/90 disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
              Browse folders…
            </button>
          </div>

          {err && (
            <div className="px-3 pb-2 text-[11px] text-high font-mono break-words">
              {err}
            </div>
          )}
        </div>
      )}

      {browsing && (
        <DirectoryBrowser
          initialPath={state?.current}
          onCancel={() => setBrowsing(false)}
          onSelect={(p) => {
            setBrowsing(false);
            void apply(p);
          }}
        />
      )}
    </div>
  );
}
