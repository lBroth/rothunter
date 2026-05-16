/**
 * Copy a string to the clipboard with a graceful fallback for non-secure
 * contexts.
 *
 * `navigator.clipboard.writeText` is only available on secure origins
 * (HTTPS or `localhost`/`127.0.0.1`). When the dashboard is opened from
 * a phone on the LAN at `http://192.168.1.x:5173` the API silently
 * disappears — the copy button does nothing and the operator never
 * learns why. Fall back to the legacy `document.execCommand('copy')`
 * path which works on any context the user can interact with.
 *
 * Throws when both paths fail so the caller can surface a toast.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path — some browsers expose the
      // API on secure contexts but still reject it (permissions,
      // focus, …).
    }
  }
  // Legacy fallback. Render a hidden textarea, select its contents,
  // dispatch the deprecated `copy` command. Works on Chrome / Safari /
  // Firefox over plain HTTP because the action is gated on user
  // interaction, not on the secure-context flag.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) {
    throw new Error('Clipboard copy not supported in this browser context.');
  }
}
