/**
 * Case 01 — Prisma cross-service email write. TRUE POSITIVE.
 * HTTP handler writes `userEmail.email` independently of the sync worker.
 */
declare const prisma: any;

export async function patchUserEmailFromApi(userId: string, email: string): Promise<void> {
  await prisma.userEmail.update({ where: { id: userId }, data: { email } });
}
