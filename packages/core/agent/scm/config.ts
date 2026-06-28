import type { GitHubAppConfig } from "./types.js";

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.OE_GITHUB_APP_ID;
  const privateKeyPem = env.OE_GITHUB_APP_PRIVATE_KEY;
  const appSlug = env.OE_GITHUB_APP_SLUG;
  if (!appId || !privateKeyPem || !appSlug) return null;

  let installations: Record<string, string> = {};
  if (env.OE_GITHUB_INSTALLATIONS) {
    try {
      const parsed = JSON.parse(env.OE_GITHUB_INSTALLATIONS) as Record<string, string>;
      if (parsed && typeof parsed === "object") installations = parsed;
    } catch {
    }
  }
  if (env.OE_GITHUB_OWNER && env.OE_GITHUB_INSTALLATION_ID) {
    installations[env.OE_GITHUB_OWNER] = env.OE_GITHUB_INSTALLATION_ID;
  }

  return {
    appId,
    clientId: env.OE_GITHUB_APP_CLIENT_ID,
    privateKeyPem,
    appSlug,
    botUserId: env.OE_GITHUB_BOT_USER_ID,
    installations,
  };
}
