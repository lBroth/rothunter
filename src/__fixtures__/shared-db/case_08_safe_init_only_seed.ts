/**
 * Case 08 — init-only writes. SAFE.
 * Seed script populates `productCatalogEntry.sku` once at deploy time.
 * Production write happens only inside the import job. The two contexts
 * are temporally disjoint — no concurrent write surface.
 */
declare const prisma: any;

export async function seedProductCatalog(): Promise<void> {
  await prisma.productCatalogEntry.create({
    data: { sku: 'init-sku-001', title: 'seed' },
  });
}
