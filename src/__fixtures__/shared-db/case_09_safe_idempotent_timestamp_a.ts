/**
 * Case 09 — idempotent timestamp writes. SAFE.
 * Both flows set `auditTrail.lastSeenAt` to `new Date()`. Concurrent
 * writes are mathematically commutative — last-writer-wins is the
 * intended semantics, no information lost.
 */
declare const prisma: any;

export async function touchAuditTrailFromHttp(id: string): Promise<void> {
  await prisma.auditTrail.update({ where: { id }, data: { lastSeenAt: new Date() } });
}
