/**
 * Case 13 — per-plugin row isolation. SAFE.
 * Three OAuth callback handlers (figma / gitlab / linear) all write the
 * same `pluginToken.refreshToken` column, BUT each writes to its own
 * row identified by a constant `service` key. No real race — they
 * target distinct rows.
 *
 * Realistic shape harvested from the Outline v2 scan (plugins/figma/
 * server/api/figma.ts, plugins/gitlab/server/api/gitlab.ts, ...).
 */
declare const PluginToken: any;
declare const exchangeFigmaCode: (code: string) => Promise<{ refreshToken: string }>;

export async function handleFigmaOauthCallback(userId: string, code: string): Promise<void> {
  const { refreshToken } = await exchangeFigmaCode(code);
  await PluginToken.updateOne(
    { userId, service: 'figma' },
    { $set: { refreshToken } },
  );
}
