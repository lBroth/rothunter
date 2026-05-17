import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Sparkles, X } from 'lucide-react';
import { generateFixPrompt } from '../lib/api.js';
import { toast } from '../lib/toast.js';

interface FixPromptModalProps {
  fingerprint: string;
  onClose: () => void;
}

/**
 * Modal that asks the Tier-3 sidecar to compose a prompt the operator
 * can paste into Claude Code / Codex / Copilot Chat / Cursor to apply
 * the fix. Generation is server-side; the modal only renders the result
 * and provides a one-click copy.
 */
export function FixPromptModal({ fingerprint, onClose }: FixPromptModalProps): JSX.Element {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    generateFixPrompt(fingerprint)
      .then(setPrompt)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [fingerprint]);

  const onCopy = async (): Promise<void> => {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    toast('Prompt copied to clipboard.', 'info');
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-panel shadow-2xl overflow-hidden">
        <header className="px-4 py-3 border-b border-border-soft flex items-center gap-3">
          <Sparkles size={15} className="text-accent shrink-0" />
          <div className="min-w-0">
            <div className="font-serif text-base font-semibold text-ink">Fix prompt</div>
            <div className="text-[11px] text-muted font-mono">
              copy → paste into Claude Code · Codex · Cursor · Copilot Chat
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
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted text-xs font-mono">
              <Loader2 size={14} className="animate-spin mr-2" />
              asking the Tier-3 model to compose a prompt…
            </div>
          )}
          {err && (
            <div className="rounded border border-high/40 bg-high/10 px-3 py-2 text-xs text-high font-mono break-words">
              {err}
            </div>
          )}
          {!loading && !err && prompt && (
            <pre className="whitespace-pre-wrap break-words text-xs font-mono text-ink leading-relaxed bg-bg rounded border border-border-soft p-3">
              {prompt}
            </pre>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-border-soft flex items-center gap-2">
          <span className="text-[11px] text-muted font-mono hidden sm:inline">
            Review the prompt before sending — the model may include outdated context.
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-muted hover:text-ink hover:bg-bg"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!prompt || loading}
            onClick={() => void onCopy()}
            className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-panel hover:bg-accent/90 disabled:opacity-40 flex items-center gap-1.5"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </footer>
      </div>
    </div>
  );
}
