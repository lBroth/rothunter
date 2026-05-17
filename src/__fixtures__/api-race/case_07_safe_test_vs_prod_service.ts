/**
 * Case 07 — production caller. SAFE pairing (because counterpart is a test).
 */
declare const axios: { patch: (url: string, body?: unknown) => Promise<unknown> };

export async function updateInventoryFromStockSyncService(id: string, stock: number): Promise<void> {
  await axios.patch(`/api/inventory/${id}`, { stock });
}
