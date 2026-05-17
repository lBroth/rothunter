/**
 * Case 06 — axios({ method, url }) object shape, two services. TRUE POSITIVE.
 */
declare const axios: (cfg: { method: string; url: string; data?: unknown }) => Promise<unknown>;

export async function shipOrderFromFulfillmentService(orderId: string): Promise<void> {
  await axios({
    method: 'put',
    url: `/orders/${orderId}`,
    data: { status: 'shipped' },
  });
}
