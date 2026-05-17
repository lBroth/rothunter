/**
 * Case 04 — Mongoose cross-service display name. TRUE POSITIVE.
 */
declare const Profile: any;

export async function renameProfileFromSlackBot(id: string, dn: string): Promise<void> {
  await Profile.findOneAndUpdate({ _id: id }, { $set: { displayName: dn } });
}
