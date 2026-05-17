/**
 * Case 06 — Raw SQL cross-service balance write. TRUE POSITIVE.
 */
declare const knex: { raw: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function reconcileWalletBalanceFromCron(id: string, balance: number): Promise<void> {
  await knex.raw('UPDATE walletAccount SET balance = ? WHERE id = ?', [balance, id]);
}
