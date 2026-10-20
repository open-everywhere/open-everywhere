import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";
import { githubWebhookSecret } from "./github-credentials.js";

export async function githubEventsReach(secret: () => Promise<string | undefined> = githubWebhookSecret): Promise<boolean> {
  const value = await secret();
  return (value !== undefined && value.length > 0) || getSettings().webhooks.allowUnverifiedGithub;
}
