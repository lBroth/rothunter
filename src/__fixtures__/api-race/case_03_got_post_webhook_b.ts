/**
 * Case 03 — second webhook handler. TRUE POSITIVE.
 */
declare const got: { post: (url: string, body?: unknown) => Promise<unknown> };

export async function forwardPaypalWebhook(payload: unknown): Promise<void> {
  await got.post('/forwarders/payment-webhook', { json: payload });
}
