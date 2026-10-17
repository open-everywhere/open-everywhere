import { getConfig } from "../access/config.js";
import { findWebhook, type WebhookHook } from "../webhooks/config.js";

export type EventReachProbe = () => boolean | Promise<boolean>;

export type EventReach = "reaches" | "deaf" | "unknown";

const PROBES = new Map<string, EventReachProbe>();

export function registerEventReach(source: string, probe: EventReachProbe): void {
  PROBES.set(source, probe);
}

export function registeredEventReachSources(): readonly string[] {
  return [...PROBES.keys()].sort();
}

export interface EventReachDeps {
  readonly hooks?: () => readonly WebhookHook[];
}

export async function eventReach(source: string, deps: EventReachDeps = {}): Promise<EventReach> {
  try {
    const hooks = (deps.hooks ?? (() => getConfig().loadWebhooks?.() ?? []))();
    if (findWebhook(hooks, source) !== undefined) return "reaches";
  } catch {
  }
  const probe = PROBES.get(source);
  if (probe === undefined) return "unknown";
  try {
    return (await probe()) ? "reaches" : "deaf";
  } catch {
    return "unknown";
  }
}
