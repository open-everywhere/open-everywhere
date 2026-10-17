import { linearAppRegistry } from "./linear-credentials.js";

export function linearEventsReach(env: NodeJS.ProcessEnv = process.env): boolean {
  const primary = env.LINEAR_WEBHOOK_SECRET;
  if (primary !== undefined && primary.length > 0) return true;
  return linearAppRegistry(env).some((app) => app.webhookSecret !== undefined);
}
