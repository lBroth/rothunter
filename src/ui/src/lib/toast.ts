/**
 * Tiny event-bus toast helper. Pages dispatch a CustomEvent; the
 * `<Toaster>` component mounted at the root listens and renders a brief
 * floating message. Uses no UI framework so the bundle stays small.
 *
 * Replace `alert("TODO: …")` calls with `comingSoon(label)` — feels much
 * less like a debug breakpoint.
 */
export type ToastTone = 'info' | 'warn';

export interface ToastPayload {
  id: number;
  message: string;
  tone: ToastTone;
}

const EVENT = 'rh-toast';
let nextId = 1;

export function toast(message: string, tone: ToastTone = 'info'): void {
  const detail: ToastPayload = { id: nextId++, message, tone };
  window.dispatchEvent(new CustomEvent<ToastPayload>(EVENT, { detail }));
}

export function comingSoon(label: string): void {
  toast(`Coming soon: ${label}`, 'info');
}

export function onToast(handler: (p: ToastPayload) => void): () => void {
  const listener = (e: Event): void => handler((e as CustomEvent<ToastPayload>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
