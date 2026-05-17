/**
 * Case 13 — per-plugin row isolation. SAFE.
 */
declare const PluginToken: any;
declare const exchangeGitlabCode: (code: string) => Promise<{ refreshToken: string }>;

export async function handleGitlabOauthCallback(userId: string, code: string): Promise<void> {
  const { refreshToken } = await exchangeGitlabCode(code);
  await PluginToken.updateOne(
    { userId, service: 'gitlab' },
    { $set: { refreshToken } },
  );
}
