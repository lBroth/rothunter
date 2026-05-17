/**
 * Case 01 — axios.patch profile from web client. TRUE POSITIVE.
 * Browser flow updates the user profile while a background sync worker
 * also patches the same endpoint with data from a third-party provider.
 */
declare const axios: { patch: (url: string, body?: unknown) => Promise<unknown> };

export async function patchUserProfileFromWebForm(
  userId: string,
  body: { displayName: string },
): Promise<void> {
  await axios.patch(`/api/v1/profile/${userId}`, body);
}
