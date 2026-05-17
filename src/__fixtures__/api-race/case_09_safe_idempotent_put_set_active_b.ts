/**
 * Case 09 — idempotent PUT setting status to a constant. SAFE.
 */
declare const axios: { put: (url: string, body?: unknown) => Promise<unknown> };

export async function activateFromManualOverrideButton(subId: string): Promise<void> {
  await axios.put(`/subscriptions/${subId}/state`, { status: 'active' });
}
