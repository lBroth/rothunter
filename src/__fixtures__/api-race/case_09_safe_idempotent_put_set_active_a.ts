/**
 * Case 09 — idempotent PUT setting status to a constant. SAFE.
 * Both callers PUT `{ status: 'active' }` to the same activation endpoint.
 * The write is mathematically idempotent — concurrent writers all
 * converge on the same value, no information loss.
 */
declare const axios: { put: (url: string, body?: unknown) => Promise<unknown> };

export async function activateFromBillingWebhook(subId: string): Promise<void> {
  await axios.put(`/subscriptions/${subId}/state`, { status: 'active' });
}
