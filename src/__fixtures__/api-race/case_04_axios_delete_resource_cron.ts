/**
 * Case 04 — cleanup cron deleting stale items. TRUE POSITIVE.
 */
declare const axios: { delete: (url: string) => Promise<unknown> };
declare const listStaleIds: () => Promise<string[]>;

export async function cleanupStaleResourcesFromCron(): Promise<void> {
  const ids = await listStaleIds();
  for (const id of ids) {
    await axios.delete(`/api/resources/${id}`);
  }
}
