/**
 * Case 11 — test file alongside production. SAFE.
 * Filename contains `.test.ts` — the caller is a unit test exercising
 * the production write, not a concurrent flow.
 */
declare const Profile: any;

export async function test_creates_profile_for_signup_flow(): Promise<void> {
  await Profile.create({ email: 'fixture@example.com', shippingName: 'Fixture' });
}
