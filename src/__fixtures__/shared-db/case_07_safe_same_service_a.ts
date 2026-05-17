/**
 * Case 07 — single-owner service writes via two helpers. SAFE.
 * Both files are part of the same `RegistrationService` — neither is
 * called from outside the service. The service serialises all writes
 * through a single in-memory queue (not visible here). Detector flags
 * because clustering is by-file, not by-owner; LLM should clear via
 * "same-service / same-owner" reasoning from the helper names.
 */
declare const prisma: any;

export async function RegistrationService_setEmailStep1(id: string, email: string): Promise<void> {
  await prisma.registrationDraft.update({ where: { id }, data: { regEmail: email } });
}
