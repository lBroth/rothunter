/**
 * Case 02 — Sequelize cross-service counter increment. TRUE POSITIVE.
 */
declare const SignupCounter: any;
declare const tx: any;

export async function bumpSignupCounterFromWebhookB(id: string, n: number): Promise<void> {
  await SignupCounter.upsert({ id, value: n }, { transaction: tx });
}
