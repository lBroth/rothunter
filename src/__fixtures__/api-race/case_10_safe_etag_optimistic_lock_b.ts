/**
 * Case 10 — both callers use If-Match / ETag optimistic locking. SAFE.
 */
declare const axios: { put: (url: string, body?: unknown, opts?: unknown) => Promise<unknown> };

export async function patchDocumentFromCollabClientB(
  docId: string,
  body: { title: string },
  etag: string,
): Promise<void> {
  await axios.put(`/docs/${docId}`, body, {
    headers: { 'If-Match': etag },
  });
}
