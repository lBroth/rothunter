/**
 * Case 10 — both callers use If-Match / ETag optimistic locking. SAFE.
 * The server rejects the stale write with 412 Precondition Failed, so
 * concurrent flows are caught at the server. No lost-update surface.
 */
declare const axios: { put: (url: string, body?: unknown, opts?: unknown) => Promise<unknown> };

export async function patchDocumentFromCollabClientA(
  docId: string,
  body: { title: string },
  etag: string,
): Promise<void> {
  await axios.put(`/docs/${docId}`, body, {
    headers: { 'If-Match': etag },
  });
}
