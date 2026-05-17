/**
 * Case 12 — INSERT-only cluster. SAFE.
 */
declare const AuditLog: any;

export async function recordLoginFromOauthCallback(
  userId: string,
  ip: string,
  loginEvent: string,
): Promise<void> {
  await AuditLog.create({ userId, ip, loginEvent, recordedAt: new Date() });
}
