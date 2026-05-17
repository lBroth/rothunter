/**
 * Case 05 — bulk settings update from admin job. TRUE POSITIVE.
 */
declare const ky: { put: (url: string, body?: unknown) => Promise<unknown> };

export async function bulkResetUserSettingsFromAdminJob(
  uid: string,
  body: { theme: string; locale: string; notifications: boolean },
): Promise<void> {
  await ky.put(`/api/users/${uid}/settings`, { json: body });
}
