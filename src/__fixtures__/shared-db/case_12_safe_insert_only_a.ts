/**
 * Case 12 — INSERT-only cluster (Mongoose-style create). SAFE.
 * Two services both `Model.create({...})` audit-log rows. Each call
 * creates a NEW row — concurrent inserts do not overwrite each other.
 */
declare const AuditLog: any;

export async function recordLoginFromAuthMiddleware(
  userId: string,
  ip: string,
  loginEvent: string,
): Promise<void> {
  await AuditLog.create({ userId, ip, loginEvent, recordedAt: new Date() });
}
