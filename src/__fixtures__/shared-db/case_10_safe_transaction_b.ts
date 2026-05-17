/**
 * Case 10 — both writes wrapped in the same transaction. SAFE.
 */
declare const prisma: any;

export async function applyTaxInsideTransactionStepB(
  tx: { taxLine: { update: (a: unknown) => Promise<unknown> } },
  id: string,
  amount: number,
): Promise<void> {
  await tx.taxLine.update({ where: { id }, data: { amount } });
}
