/**
 * Case 11 — production caller paired with a .test.ts fixture. SAFE.
 */
declare const Profile: any;

export async function createProfileFromSignupService(
  email: string,
  shippingName: string,
): Promise<void> {
  await Profile.create({ email, shippingName });
}
