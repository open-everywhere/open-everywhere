import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

export function githubEventsReach(env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  return (secret !== undefined && secret.length > 0) || getSettings().webhooks.allowUnverifiedGithub;
}
