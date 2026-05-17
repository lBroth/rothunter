/**
 * Case 04 — axios.delete a resource from API handler. TRUE POSITIVE.
 * User can hit the delete endpoint while a cleanup cron is also deleting
 * stale items in bulk — both hit the same path, racing against each other.
 */
declare const axios: { delete: (url: string) => Promise<unknown> };

export async function deleteResourceFromApiHandler(id: string): Promise<void> {
  await axios.delete(`/api/resources/${id}`);
}
