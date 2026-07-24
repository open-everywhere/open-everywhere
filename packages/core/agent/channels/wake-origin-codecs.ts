import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";
import type { WakeOriginCodec } from "./wake-origin-codec.js";

type OriginArm<P extends UnifiedWakeOrigin["platform"]> = Extract<UnifiedWakeOrigin, { platform: P }>;

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
  const extra = (process.env.OE_TEAMS_SERVICE_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return extra.length > 0 ? [...DEFAULT_TEAMS_SERVICE_HOSTS, ...extra] : DEFAULT_TEAMS_SERVICE_HOSTS;
}

type CoreCodecPlatform = Exclude<UnifiedWakeOrigin["platform"], "notion">;

export const wakeOriginCodecs: { readonly [P in CoreCodecPlatform]: WakeOriginCodec<OriginArm<P>> } = {
  slack: {
    validate: (o) =>
      typeof o.channelId === "string" &&
      o.channelId.length > 0 &&
      (o.threadTs === undefined || typeof o.threadTs === "string") &&
      (o.replyAnchorTs === undefined || typeof o.replyAnchorTs === "string"),
    threadRef: (origin) => ({ channelKey: noColon(`slack/${origin.channelId}`), threadKey: noColon(origin.threadTs ?? origin.channelId) }),
    isThreadScoped: (origin) => typeof origin.threadTs === "string" && origin.threadTs.length > 0,
    containerId: (origin) => origin.channelId,
  },
  github: {
    validate: (o) =>
      typeof o.owner === "string" &&
      o.owner.length > 0 &&
      typeof o.repo === "string" &&
      o.repo.length > 0 &&
      typeof o.issueNumber === "number" &&
      Number.isFinite(o.issueNumber) &&
      o.issueNumber > 0 &&
      (o.installationId === undefined || typeof o.installationId === "number"),
    threadRef: (origin) => ({ channelKey: noColon(`github/${origin.owner}/${origin.repo}`), threadKey: String(origin.issueNumber) }),
    isThreadScoped: () => true,
    containerId: (origin) => `${origin.owner}/${origin.repo}`,
  },
  linear: {
    validate: (o) => {
      if (typeof o.issueId !== "string" || o.issueId.length === 0) return false;
      if (o.parentId !== undefined && typeof o.parentId !== "string") return false;
      const isAmbient = o.ambient === true && o.agentSessionId === undefined;
      const isMention = o.ambient === undefined && typeof o.agentSessionId === "string" && o.agentSessionId.length > 0;
      return isAmbient || isMention;
    },
    threadRef: (origin) => ({ channelKey: noColon(`linear/${origin.issueId}`), threadKey: noColon(origin.parentId ?? origin.issueId) }),
    isThreadScoped: () => true,
    containerId: (origin) => origin.issueId,
  },
  discord: {
    validate: (o) =>
      typeof o.channelId === "string" &&
      o.channelId.length > 0 &&
      typeof o.guildId === "string" &&
      o.guildId.length > 0 &&
      (o.messageId === undefined || typeof o.messageId === "string") &&
      (o.autoThreadName === undefined || typeof o.autoThreadName === "string"),
    threadRef: (origin) => ({ channelKey: noColon(`discord/${origin.guildId}/${origin.channelId}`), threadKey: noColon(origin.channelId) }),
    isThreadScoped: () => false,
    containerId: (origin) => origin.channelId,
  },
  teams: {
    validate: (o) =>
      isTrustedTeamsServiceUrl(o.serviceUrl) &&
      typeof o.conversationId === "string" &&
      o.conversationId.length > 0 &&
      (o.replyToActivityId === undefined || typeof o.replyToActivityId === "string") &&
      (o.tenantId === undefined || typeof o.tenantId === "string"),
    threadRef: (origin) => ({ channelKey: noColon(`teams/${origin.conversationId}`), threadKey: noColon(origin.replyToActivityId ?? origin.conversationId) }),
    isThreadScoped: (origin) => typeof origin.replyToActivityId === "string" && origin.replyToActivityId.length > 0,
    containerId: (origin) => origin.conversationId,
  },
};
