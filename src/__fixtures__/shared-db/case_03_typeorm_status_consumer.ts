/**
 * Case 03 — TypeORM cross-service order status. TRUE POSITIVE.
 */
declare const paidOrderRepo: any;

export async function refundOrderFromKafkaConsumer(id: string): Promise<void> {
  await paidOrderRepo.update(id, { status: 'refunded' });
}
