import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Info, X } from 'lucide-react';
import { onToast, type ToastPayload } from '../lib/toast.js';

const TIMEOUT_MS = 3200;

export function Toaster(): JSX.Element {
  const [items, setItems] = useState<ToastPayload[]>([]);

  useEffect(() => {
    const off = onToast((p) => {
      setItems((prev) => [...prev, p]);
      setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== p.id));
      }, TIMEOUT_MS);
    });
    return off;
  }, []);

  if (items.length === 0) return <></>;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          className={
            'flex items-start gap-2 px-3 py-2 rounded-lg border bg-panel shadow-lg text-xs font-mono ' +
            (t.tone === 'warn' ? 'border-med/40 text-med' : 'border-accent/40 text-ink')
          }
        >
          <Info size={13} className="shrink-0 mt-0.5 text-accent" />
          <span className="flex-1 break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-ink"
            aria-label="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
