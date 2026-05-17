/**
 * Case 04 — Mongoose cross-service display name. TRUE POSITIVE.
 * GraphQL mutation and a Slack-bot reaction handler both rename `Profile.displayName`.
 */
declare const Profile: any;

export async function setProfileNameFromGraphql(id: string, name: string): Promise<void> {
  await Profile.updateOne({ _id: id }, { $set: { displayName: name } });
}
