/**
 * Case 01 — Prisma cross-service email write. TRUE POSITIVE.
 * Background sync worker writes `userEmail.email` from an external feed.
 */
declare const prisma: any;
declare const fetchExternalEmail: (id: string) => Promise<string>;

export async function syncUserEmailFromExternalProvider(userId: string): Promise<void> {
  const email = await fetchExternalEmail(userId);
  await prisma.userEmail.update({ where: { id: userId }, data: { email } });
}
