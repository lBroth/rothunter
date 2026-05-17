/**
 * Case 06 — same endpoint from refund service. TRUE POSITIVE.
 */
declare const axios: (cfg: { method: string; url: string; data?: unknown }) => Promise<unknown>;

export async function refundOrderFromRefundService(orderId: string): Promise<void> {
  await axios({
    method: 'put',
    url: `/orders/${orderId}`,
    data: { status: 'refunded' },
  });
}
