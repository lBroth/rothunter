/**
 * Case 07 — test file + production caller. SAFE.
 * The "test" filename + the mocked axios shape signal this is a unit test
 * exercising the production path, not a concurrent flow.
 */
declare const axios: { patch: (url: string, body?: unknown) => Promise<unknown> };

export async function test_patches_inventory(id: string): Promise<void> {
  await axios.patch(`/api/inventory/${id}`, { stock: 0 });
}
