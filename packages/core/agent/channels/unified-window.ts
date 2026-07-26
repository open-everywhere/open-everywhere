import { randomUUID } from "node:crypto";
import { encodeSources } from "./window-sources.js";
import { wakeOriginCodec } from "./wake-origin-codec.js";

export type UnifiedWakeOrigin =
  | {
      readonly platform: "slack";
      readonly channelId: string;
      readonly threadTs?: string;
      readonly replyAnchorTs?: string;
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
      readonly autoThreadName?: string;
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
  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number, windowToken?: string): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;
}

export interface UnifiedWakeRecord {
  readonly targetJson: string;
  readonly createdAt: string;
  readonly windowToken?: string;
  readonly answeredAt?: string;
  readonly answeredTurnId?: string;
}

export interface AnswerableWakeStore extends UnifiedWakeTargetStore {
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<UnifiedWakeRecord | null>;
  markUnifiedWakeAnswered(org: string, wakeId: string, at: string, turnId?: string): Promise<void>;
}

export async function registerUnifiedWakeTarget(
  store: UnifiedWakeTargetStore,
  org: string,
  wakeId: string,
  origin: UnifiedWakeOrigin,
  atIso: string,
  windowToken?: string,
): Promise<void> {
  await store.putUnifiedWakeTarget(org, wakeId, JSON.stringify(origin), atIso, WAKE_TARGET_TTL_MS, windowToken);
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

export function sameUnifiedConversation(a: UnifiedWakeOrigin, b: UnifiedWakeOrigin): boolean {
  const ra = unifiedThreadRef(a);
  const rb = unifiedThreadRef(b);
  return ra.channelKey === rb.channelKey && ra.threadKey === rb.threadKey;
}

export type AnswerableReplyResolution =
  | { readonly ok: true; readonly origin: UnifiedWakeOrigin; readonly via: "turn" | "same-conversation" | "pending" }
  | { readonly ok: false; readonly reason: "mismatch" | "expired" | "answered" };

export async function resolveAnswerableReplyTarget(
  store: AnswerableWakeStore,
  org: string,
  turnWake: string | undefined,
  windowToken: string | undefined,
  turnId: string | undefined,
  inputWake: string,
  nowMs?: number,
): Promise<AnswerableReplyResolution> {
  if (!turnWake) return { ok: false, reason: "mismatch" };
  if (inputWake === turnWake) {
    const origin = await resolveUnifiedWakeTarget(store, org, inputWake);
    return origin ? { ok: true, origin, via: "turn" } : { ok: false, reason: "expired" };
  }
  const [turnOrigin, echoedOrigin] = await Promise.all([
    resolveUnifiedWakeTarget(store, org, turnWake),
    resolveUnifiedWakeTarget(store, org, inputWake),
  ]);
  if (turnOrigin && echoedOrigin && sameUnifiedConversation(turnOrigin, echoedOrigin)) {
    return { ok: true, origin: echoedOrigin, via: "same-conversation" };
  }
  if (!windowToken) return { ok: false, reason: "mismatch" };
  if (typeof inputWake !== "string" || inputWake.length === 0 || inputWake.length > 200) return { ok: false, reason: "mismatch" };
  let row: UnifiedWakeRecord | null;
  try {
    row = await store.getUnifiedWakeRecord(org, inputWake);
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  if (!row) return { ok: false, reason: "mismatch" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.targetJson);
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  if (!isUnifiedWakeOrigin(parsed)) return { ok: false, reason: "mismatch" };
  if (!row.windowToken || row.windowToken !== windowToken) return { ok: false, reason: "mismatch" };
  const created = Date.parse(row.createdAt);
  const now = nowMs ?? Date.now();
  if (!Number.isFinite(created) || now - created > WAKE_TARGET_TTL_MS) return { ok: false, reason: "expired" };
  if (row.answeredAt !== undefined && row.answeredTurnId !== turnId) return { ok: false, reason: "answered" };
  return { ok: true, origin: parsed, via: "pending" };
}

export function isUnifiedWakeOrigin(v: unknown): v is UnifiedWakeOrigin {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const codec = typeof o.platform === "string" ? wakeOriginCodec(o.platform) : undefined;
  return codec !== undefined && codec.validate(o);
}

export interface UnifiedThreadRef {
  readonly channelKey: string;
  readonly threadKey: string;
}

export function unifiedThreadRef(origin: UnifiedWakeOrigin): UnifiedThreadRef {
  return wakeOriginCodec(origin.platform)?.threadRef(origin) as UnifiedThreadRef;
}

export function isThreadScopedWakeOrigin(origin: UnifiedWakeOrigin): boolean {
  return wakeOriginCodec(origin.platform)?.isThreadScoped(origin) as boolean;
}

export function wakeOriginContainerId(origin: UnifiedWakeOrigin): string {
  return wakeOriginCodec(origin.platform)?.containerId(origin) as string;
}

export const OE_PLATFORM_ATTR = "oe_platform";
export const OE_WAKE_ID_ATTR = "oe_wake_id";
export const OE_ADDRESSING_ATTR = "oe_addressing";
export const OE_GRAIN_ATTR = "oe_grain";
export const OE_SOURCES_ATTR = "oe_sources";
export const OE_WINDOW_TOKEN_ATTR = "oe_window_token";

export const OE_REPLY_ANCHOR_ATTR = "oe_reply_anchor";

export function rootDmGrainAttrs(isDm: boolean): Record<string, string> {
  return isDm ? { [OE_GRAIN_ATTR]: "standing" } : {};
}

export function stampUnifiedWindowAuth<A extends { attributes?: Record<string, unknown> }>(
  auth: A,
  platform: UnifiedWakeOrigin["platform"],
  wakeId: string,
  addressing?: "direct-mention",
  sources?: readonly string[],
  windowToken?: string,
  replyAnchor?: string,
): A {
  return {
    ...auth,
    attributes: {
      ...(auth.attributes ?? {}),
      [OE_PLATFORM_ATTR]: platform,
      [OE_WAKE_ID_ATTR]: wakeId,
      [OE_GRAIN_ATTR]: (auth.attributes?.[OE_GRAIN_ATTR] as string | undefined) ?? "standing",
      ...(addressing ? { [OE_ADDRESSING_ATTR]: addressing } : {}),
      ...(sources && sources.length > 0 ? { [OE_SOURCES_ATTR]: encodeSources(sources) } : {}),
      ...(windowToken && windowToken.length > 0 ? { [OE_WINDOW_TOKEN_ATTR]: windowToken } : {}),
      ...(replyAnchor && replyAnchor.length > 0 ? { [OE_REPLY_ANCHOR_ATTR]: replyAnchor } : {}),
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
