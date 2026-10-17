import { getConfig, getOperatorSecret, OperatorSecretNotSetError } from "@open-everywhere/core/agent/adapter-api.js";
import { notionIntegrations } from "./notion-credentials.js";

export async function notionEventsReach(get: typeof getOperatorSecret = getOperatorSecret): Promise<boolean> {
  const names = [...new Set(notionIntegrations(getConfig().loadDomains()).map((i) => i.inboundSecret))];
  let failure: unknown;
  for (const name of names) {
    try {
      if ((await get(name)).value.length > 0) return true;
    } catch (err) {
      if (!(err instanceof OperatorSecretNotSetError) && failure === undefined) failure = err;
    }
  }
  if (failure !== undefined) throw failure;
  return false;
}
