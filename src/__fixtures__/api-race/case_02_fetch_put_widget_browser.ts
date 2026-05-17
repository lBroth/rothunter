/**
 * Case 02 — fetch PUT widget from browser. TRUE POSITIVE.
 */
export async function saveWidgetFromBrowser(id: string, body: { name: string }): Promise<void> {
  await fetch(`/widgets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
