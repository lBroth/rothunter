/**
 * Case 05 — ky.put user settings from UI page. TRUE POSITIVE.
 * UI page updates one setting field; bulk update job overwrites all
 * settings for the same user. Different field-level intent, same endpoint.
 */
declare const ky: { put: (url: string, body?: unknown) => Promise<unknown> };

export async function updateOneSettingFromSettingsPage(
  uid: string,
  body: { theme: string },
): Promise<void> {
  await ky.put(`/api/users/${uid}/settings`, { json: body });
}
