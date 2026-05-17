/**
 * Case 02 — Sequelize cross-service counter increment. TRUE POSITIVE.
 * Two webhook handlers both bump `signupCounter.value`.
 */
declare const SignupCounter: any;
declare const tx: any;

export async function bumpSignupCounterFromWebhookA(id: string, n: number): Promise<void> {
  await SignupCounter.upsert({ id, value: n }, { transaction: tx });
}
