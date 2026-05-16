import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ArrowUp, Check, File as FileIcon, Folder, FolderOpen, Loader2, X } from 'lucide-react';
import { listDirectory, type FsListing } from '../lib/api.js';

interface DirectoryBrowserProps {
  initialPath?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

/**
 * Modal file-system browser. Talks to /api/fs/list so the host's real
 * filesystem (not the browser's sandboxed picker) is what the operator
 * navigates — required because RotHunter scans need absolute paths.
 *
 * Hidden entries (.git, .DS_Store, …) are filtered by default. Toggle
 * to show them. Only directories are clickable; files are listed for
 * orientation but greyed.
 */
export function DirectoryBrowser({
  initialPath,
  onCancel,
  onSelect,
}: DirectoryBrowserProps): JSX.Element {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = (target?: string): void => {
    setLoading(true);
    setErr(null);
    listDirectory(target)
      .then((l) => {
        setListing(l);
        setLoading(false);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.isHidden);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-panel shadow-2xl overflow-hidden">
        <header className="px-4 py-3 border-b border-border-soft flex items-center gap-3">
          <FolderOpen size={16} className="text-accent shrink-0" />
          <span className="font-serif text-base font-semibold text-ink">Select folder</span>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto w-7 h-7 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-bg"
          >
            <X size={14} />
          </button>
        </header>

        <div className="px-4 py-2 border-b border-border-soft flex items-center gap-2 text-xs font-mono">
          <button
            type="button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && load(listing.parent)}
            className="w-7 h-7 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-bg disabled:opacity-30"
            title="Up one level"
          >
            <ArrowUp size={13} />
          </button>
          <span className="flex-1 truncate text-ink">{listing?.path ?? '…'}</span>
          <label className="flex items-center gap-1.5 text-muted text-[11px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="accent-accent"
            />
            hidden
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted text-xs">
              <Loader2 size={14} className="animate-spin mr-2" /> loading…
            </div>
          )}
          {err && <div className="px-4 py-6 text-high text-xs font-mono break-words">{err}</div>}
          {!loading && !err && entries.length === 0 && (
            <div className="px-4 py-12 text-center text-muted text-xs">Empty directory.</div>
          )}
          <ul className="divide-y divide-border-soft">
            {entries.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  disabled={!e.isDir}
                  onClick={() => {
                    if (!listing) return;
                    const next = listing.path.endsWith('/')
                      ? listing.path + e.name
                      : listing.path + '/' + e.name;
                    load(next);
                  }}
                  className={
                    'w-full text-left px-4 py-2 flex items-center gap-2.5 text-xs font-mono ' +
                    (e.isDir ? 'text-ink hover:bg-bg' : 'text-muted cursor-default') +
                    (e.isHidden ? ' opacity-60' : '')
                  }
                >
                  {e.isDir ? (
                    <Folder size={13} className="text-accent shrink-0" />
                  ) : (
                    <FileIcon size={13} className="text-muted shrink-0" />
                  )}
                  <span className="truncate">{e.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <footer className="px-4 py-3 border-t border-border-soft flex items-center gap-2">
          <span className="text-[11px] text-muted font-mono hidden sm:inline">
            Click a folder to navigate. Tap “Select this folder” to confirm.
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs font-medium text-muted hover:text-ink hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!listing?.path}
            onClick={() => listing && onSelect(listing.path)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-panel hover:bg-accent/90 disabled:opacity-40 flex items-center gap-1.5"
          >
            <Check size={12} /> Select this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
