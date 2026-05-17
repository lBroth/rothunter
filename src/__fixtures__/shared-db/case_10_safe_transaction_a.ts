/**
 * Case 10 — both writes wrapped in the same transaction. SAFE.
 * `taxLine.amount` is set twice in two helper functions but both run
 * inside a single Prisma $transaction — atomicity guarantees no
 * lost-update.
 */
declare const prisma: any;

export async function applyTaxInsideTransactionStepA(
  tx: { taxLine: { update: (a: unknown) => Promise<unknown> } },
  id: string,
  amount: number,
): Promise<void> {
  await tx.taxLine.update({ where: { id }, data: { amount } });
}
