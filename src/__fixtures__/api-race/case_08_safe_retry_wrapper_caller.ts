/**
 * Case 08 — retry wrapper looks like two callers. SAFE.
 * The same caller is wrapped in a retry helper that lives in another file —
 * the detector sees two distinct files writing the endpoint but they are
 * serialised by the retry helper's logic.
 */
import { retryWithBackoff } from './case_08_safe_retry_wrapper_helper.js';
declare const ky: { put: (url: string, body?: unknown) => Promise<unknown> };

export async function publishFeatureFlagWithRetries(
  flagId: string,
  body: { enabled: boolean },
): Promise<void> {
  await retryWithBackoff(() => ky.put(`/api/flags/${flagId}`, { json: body }), 3);
}
