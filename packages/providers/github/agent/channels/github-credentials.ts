import { githubAppPrivateKey, operatorSecretOrUnset } from "@open-everywhere/core/agent/adapter-api.js";

const GITHUB_WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";

export async function githubWebhookSecret(): Promise<string | undefined> {
  return await operatorSecretOrUnset(GITHUB_WEBHOOK_SECRET_NAME);
}

export const githubEveCredentials = {
  privateKey: async (): Promise<string> => {
    const key = await githubAppPrivateKey();
    if (!key) throw new Error("githubChannel: GITHUB_APP_PRIVATE_KEY is required.");
    return key;
  },
  webhookSecret: async (): Promise<string> => {
    const secret = await githubWebhookSecret();
    if (!secret) throw new Error("githubChannel: GITHUB_WEBHOOK_SECRET is required.");
    return secret;
  },
} as const;
