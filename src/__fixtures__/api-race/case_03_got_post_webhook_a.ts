/**
 * Case 03 — two unrelated webhook handlers POSTing to same forwarder. TRUE POSITIVE.
 */
declare const got: { post: (url: string, body?: unknown) => Promise<unknown> };

export async function forwardStripeWebhook(payload: unknown): Promise<void> {
  await got.post('/forwarders/payment-webhook', { json: payload });
}
