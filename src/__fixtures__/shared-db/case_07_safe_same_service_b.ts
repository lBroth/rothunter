/**
 * Case 07 — single-owner service writes via two helpers. SAFE.
 */
declare const prisma: any;

export async function RegistrationService_setEmailStep2(id: string, email: string): Promise<void> {
  await prisma.registrationDraft.update({ where: { id }, data: { regEmail: email } });
}
