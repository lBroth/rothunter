/**
 * Case 01 — axios.patch profile from sync worker. TRUE POSITIVE.
 */
declare const axios: { patch: (url: string, body?: unknown) => Promise<unknown> };
declare const fetchExternalProfile: (id: string) => Promise<{ displayName: string }>;

export async function syncUserProfileFromExternalProvider(userId: string): Promise<void> {
  const ext = await fetchExternalProfile(userId);
  await axios.patch(`/api/v1/profile/${userId}`, { displayName: ext.displayName });
}
