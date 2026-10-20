import { linearAppRegistry } from "./linear-credentials.js";
import { linearPrimaryWebhookSecret } from "./linear-webhook-verify.js";

export async function linearEventsReach(
  env: NodeJS.ProcessEnv = process.env,
  primarySecret: () => Promise<string | undefined> = linearPrimaryWebhookSecret,
): Promise<boolean> {
  const primary = await primarySecret();
  if (primary !== undefined && primary.length > 0) return true;
  return linearAppRegistry(env).some((app) => app.webhookSecret !== undefined);
}
