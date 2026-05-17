/**
 * Case 06 — Raw SQL cross-service balance write. TRUE POSITIVE.
 * Payment-webhook handler and a daily reconciliation cron both write
 * `walletAccount.balance` via different surfaces.
 */
declare const pg: { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function setWalletBalanceFromPaymentWebhook(id: string, balance: number): Promise<void> {
  await pg.query('UPDATE walletAccount SET balance = $1 WHERE id = $2', [balance, id]);
}
