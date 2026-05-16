/**
 * Cross-page finding navigation queue.
 *
 * The Findings page renders an ordered list of findings under the active
 * filters. When the operator drills into one finding, they almost
 * always want to triage the next one in the same order without going
 * back. The queue records the sequence of fingerprints captured at
 * drill-down time so `FindingDetail` can render Prev / Next buttons
 * AND auto-advance after the operator marks a finding as false-positive
 * or resolves it via re-run.
 *
 * Persisted in `sessionStorage` so browser back/forward + reload keep
 * the same queue. Cleared explicitly when the operator starts a fresh
 * scan or switches workspace.
 */
const KEY = 'rothunter.findingQueue.v1';

export function setQueue(fingerprints: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(fingerprints));
  } catch {
    // sessionStorage disabled (private mode + quota) — degrade silently.
  }
}

export function getQueue(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function clearQueue(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // best effort
  }
}

export function neighbours(currentFp: string): { prev: string | null; next: string | null; index: number; total: number } {
  const q = getQueue();
  const idx = q.indexOf(currentFp);
  if (idx < 0) return { prev: null, next: null, index: -1, total: q.length };
  return {
    prev: idx > 0 ? (q[idx - 1] ?? null) : null,
    next: idx < q.length - 1 ? (q[idx + 1] ?? null) : null,
    index: idx,
    total: q.length,
  };
}
