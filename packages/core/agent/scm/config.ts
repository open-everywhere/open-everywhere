import { operatorSecret } from "../credentials/operator-secrets.js";
import { getSettings } from "../settings/settings.js";
import type { GitHubAppConfig } from "./types.js";

export const GITHUB_APP_PRIVATE_KEY_NAME = "GITHUB_APP_PRIVATE_KEY";

export async function githubAppPrivateKey(): Promise<string | undefined> {
  return await operatorSecret(GITHUB_APP_PRIVATE_KEY_NAME);
}

export function loadGitHubAppConfig(): GitHubAppConfig | null {
  const github = getSettings().github;
  const appId = github.appId;
  const appSlug = github.appSlug;
  if (!appId || !appSlug) return null;
  return {
    appId,
    ...(github.appClientId ? { clientId: github.appClientId } : {}),
    privateKeyPem: githubAppPrivateKey,
    appSlug,
    ...(github.botUserId ? { botUserId: github.botUserId } : {}),
    installations: { ...github.installations },
  };
}
