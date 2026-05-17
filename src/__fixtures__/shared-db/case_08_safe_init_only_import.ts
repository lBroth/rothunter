/**
 * Case 08 — init-only writes. SAFE.
 * One-shot CSV import script — runs only during bootstrap, never in
 * production HTTP path.
 */
declare const prisma: any;
declare const readCsv: () => Iterable<{ sku: string; title: string }>;

export async function importProductCatalogFromCsv(): Promise<void> {
  for (const row of readCsv()) {
    await prisma.productCatalogEntry.create({
      data: { sku: row.sku, title: row.title },
    });
  }
}
