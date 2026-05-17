/**
 * Case 02 — fetch PUT widget from node-side service. TRUE POSITIVE.
 */
export async function saveWidgetFromNodeService(id: string, body: { name: string }): Promise<void> {
  await fetch(`/widgets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
