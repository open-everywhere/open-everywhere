import type { RouteHandlerArgs } from "eve/channels";
import { admitTrigger, type TriggerAdmitDeps, type TriggerReport } from "./ingress.js";
import type { TriggerDelivery } from "./event-model.js";
import { GITHUB_EVENT_SOURCE } from "./github-normalizer.js";
import "./github-entity-read.js";

const GITHUB_EVENT_HEADER = "x-github-event";

export type GitHubFanOutDeps = TriggerAdmitDeps;

export { DELIVERY_DEDUPE_TTL_MS, deliveryDedupeKey } from "./ingress.js";

export function fanOutGitHubDelivery(
  body: string,
  eventType: string,
  receive: RouteHandlerArgs["receive"],
  deliveryId?: string | null,
): Promise<void> {
  return fanOutDelivery(body, eventType, deliveryId ?? undefined, { receive }).then(() => undefined);
}

export async function fanOutDelivery(
  body: string,
  eventType: string,
  deliveryId: string | undefined,
  deps: GitHubFanOutDeps,
): Promise<TriggerReport> {
  const delivery: TriggerDelivery = {
    source: GITHUB_EVENT_SOURCE,
    headers: { [GITHUB_EVENT_HEADER]: eventType },
    body,
    ...(deliveryId ? { deliveryId } : {}),
    receivedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  return admitTrigger(delivery, deps);
}
