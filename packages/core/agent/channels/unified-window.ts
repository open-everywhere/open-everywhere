import { randomUUID } from "node:crypto";

export type UnifiedWakeOrigin =
  | {
      readonly platform: "slack";
      readonly channelId: string;
      readonly threadTs?: string;
    }
  | {
      readonly platform: "github";
      readonly owner: string;
      readonly repo: string;
      readonly issueNumber: number;
      readonly installationId?: number;
    }
  | {
      readonly platform: "linear";
      readonly agentSessionId?: string;
      readonly ambient?: true;
      readonly issueId: string;
      readonly parentId?: string;
    }
  | {
      readonly platform: "notion";
      readonly discussionId: string;
      readonly pageId?: string;
      readonly workspaceId?: string;
    }
  | {
      readonly platform: "discord";
      readonly channelId: string;
      readonly guildId: string;
      readonly messageId?: string;
    }
  | {
      readonly platform: "teams";
      readonly serviceUrl: string;
      readonly conversationId: string;
      readonly replyToActivityId?: string;
      readonly tenantId?: string;
    };

export const WAKE_TARGET_TTL_MS = 6 * 60 * 60 * 1000;

export function mintWakeId(): string {
  return randomUUID();
}

export interface UnifiedWakeTargetStore {
  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;
}

export async function registerUnifiedWakeTarget(
  store: UnifiedWakeTargetStore,
  org: string,
  wakeId: string,
  origin: UnifiedWakeOrigin,
  atIso: string,
): Promise<void> {
  await store.putUnifiedWakeTarget(org, wakeId, JSON.stringify(origin), atIso, WAKE_TARGET_TTL_MS);
}

export async function resolveUnifiedWakeTarget(store: UnifiedWakeTargetStore, org: string, wakeId: string): Promise<UnifiedWakeOrigin | null> {
  if (typeof wakeId !== "string" || wakeId.length === 0 || wakeId.length > 200) return null;
  let json: string | null;
  try {
    json = await store.getUnifiedWakeTarget(org, wakeId);
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isUnifiedWakeOrigin(parsed) ? parsed : null;
}

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

export function isUnifiedWakeOrigin(v: unknown): v is UnifiedWakeOrigin {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  if (o.platform === "slack") {
    return typeof o.channelId === "string" && o.channelId.length > 0 && (o.threadTs === undefined || typeof o.threadTs === "string");
  }
  if (o.platform === "github") {
    return (
      typeof o.owner === "string" &&
      o.owner.length > 0 &&
      typeof o.repo === "string" &&
      o.repo.length > 0 &&
      typeof o.issueNumber === "number" &&
      Number.isFinite(o.issueNumber) &&
      o.issueNumber > 0 &&
      (o.installationId === undefined || typeof o.installationId === "number")
    );
  }
  if (o.platform === "linear") {
    if (typeof o.issueId !== "string" || o.issueId.length === 0) return false;
    if (o.parentId !== undefined && typeof o.parentId !== "string") return false;
    const isAmbient = o.ambient === true && o.agentSessionId === undefined;
    const isMention = o.ambient === undefined && typeof o.agentSessionId === "string" && o.agentSessionId.length > 0;
    return isAmbient || isMention;
  }
  if (o.platform === "notion") {
    return (
      typeof o.discussionId === "string" &&
      o.discussionId.length > 0 &&
      (o.pageId === undefined || typeof o.pageId === "string") &&
      (o.workspaceId === undefined || typeof o.workspaceId === "string")
    );
  }
  if (o.platform === "discord") {
    return (
      typeof o.channelId === "string" &&
      o.channelId.length > 0 &&
      typeof o.guildId === "string" &&
      o.guildId.length > 0 &&
      (o.messageId === undefined || typeof o.messageId === "string")
    );
  }
  if (o.platform === "teams") {
    return (
      isTrustedTeamsServiceUrl(o.serviceUrl) &&
      typeof o.conversationId === "string" &&
      o.conversationId.length > 0 &&
      (o.replyToActivityId === undefined || typeof o.replyToActivityId === "string") &&
      (o.tenantId === undefined || typeof o.tenantId === "string")
    );
  }
  return false;
}

export const OE_PLATFORM_ATTR = "oe_platform";
export const OE_WAKE_ID_ATTR = "oe_wake_id";
export const OE_ADDRESSING_ATTR = "oe_addressing";

export function stampUnifiedWindowAuth<A extends { attributes?: Record<string, unknown> }>(
  auth: A,
  platform: UnifiedWakeOrigin["platform"],
  wakeId: string,
  addressing?: "direct-mention",
): A {
  return {
    ...auth,
    attributes: {
      ...(auth.attributes ?? {}),
      [OE_PLATFORM_ATTR]: platform,
      [OE_WAKE_ID_ATTR]: wakeId,
      ...(addressing ? { [OE_ADDRESSING_ATTR]: addressing } : {}),
    },
  };
}

export function shouldBridgeAddressedProse(addressing: string | undefined, alreadyReplied: boolean): boolean {
  return addressing === "direct-mention" && !alreadyReplied;
}

export interface SingleWindowMentionPolicy {
  readonly suppressNative: boolean;
  readonly addressing: "direct-mention" | undefined;
}
export function singleWindowMentionPolicy(
  singleWindow: boolean,
  isMention: boolean,
  privacyOk: boolean,
): SingleWindowMentionPolicy {
  const on = singleWindow && privacyOk;
  return { suppressNative: on && isMention, addressing: on && isMention ? "direct-mention" : undefined };
}

export interface UnifiedWindowWake {
  readonly wakeId: string;
  readonly origin: UnifiedWakeOrigin;
  readonly addressing?: "direct-mention";
}
