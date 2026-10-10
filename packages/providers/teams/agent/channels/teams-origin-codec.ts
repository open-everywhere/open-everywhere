import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";
import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

type TeamsOrigin = Extract<UnifiedWakeOrigin, { platform: "teams" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export function isTrustedTeamsServiceUrl(serviceUrl: unknown): boolean {
  if (typeof serviceUrl !== "string") return false;
  let host: string;
  try {
    const u = new URL(serviceUrl);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return teamsServiceHostAllowlist().some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

const DEFAULT_TEAMS_SERVICE_HOSTS: readonly string[] = [
  "smba.trafficmanager.net",
  ".smba.trafficmanager.net",
  "botframework.com",
  ".botframework.com",
];

function teamsServiceHostAllowlist(): readonly string[] {
  const extra = getSettings().teams.serviceHosts;
  return extra.length > 0 ? [...DEFAULT_TEAMS_SERVICE_HOSTS, ...extra] : DEFAULT_TEAMS_SERVICE_HOSTS;
}

export const teamsWakeOriginCodec: WakeOriginCodec<TeamsOrigin> = {
  validate: (o) =>
    isTrustedTeamsServiceUrl(o.serviceUrl) &&
    typeof o.conversationId === "string" &&
    o.conversationId.length > 0 &&
    (o.replyToActivityId === undefined || typeof o.replyToActivityId === "string") &&
    (o.tenantId === undefined || typeof o.tenantId === "string"),
  threadRef: (origin) => ({ channelKey: noColon(`teams/${origin.conversationId}`), threadKey: noColon(origin.replyToActivityId ?? origin.conversationId) }),
  isThreadScoped: (origin) => typeof origin.replyToActivityId === "string" && origin.replyToActivityId.length > 0,
  containerId: (origin) => origin.conversationId,
};
