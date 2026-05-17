/**
 * Case 05 — Drizzle cross-service stock decrement. TRUE POSITIVE.
 * Checkout flow and inventory-sync worker both write `stockTable.quantity`.
 */
declare const db: any;
declare const stockTable: any;
declare const eq: any;

export async function decrementStockFromCheckout(id: string, quantity: number): Promise<void> {
  await db.update(stockTable).set({ quantity }).where(eq(stockTable.id, id));
}
