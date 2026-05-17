/**
 * Case 03 — TypeORM cross-service order status. TRUE POSITIVE.
 * HTTP API path and a Kafka consumer both update `paidOrder.status`.
 */
declare const paidOrderRepo: any;

export async function markOrderPaidFromApi(id: string): Promise<void> {
  await paidOrderRepo.update(id, { status: 'paid' });
}
