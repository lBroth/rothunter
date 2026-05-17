/**
 * Case 08 — retry wrapper helper that the detector sees as a second file
 * writing the same endpoint. SAFE.
 */
declare const ky: { put: (url: string, body?: unknown) => Promise<unknown> };
declare const sleep: (ms: number) => Promise<void>;

export async function retryWithBackoff(fn: () => Promise<unknown>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      await fn();
      return;
    } catch {
      await sleep(100 * 2 ** i);
    }
  }
}

// Same client call hard-coded for clustering — represents the retry path
// that calls the same write internally.
export async function lastDitchRetryForFlagPublish(
  flagId: string,
  body: { enabled: boolean },
): Promise<void> {
  await ky.put(`/api/flags/${flagId}`, { json: body });
}
