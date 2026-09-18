import {
  getOperationalStore,
  getThreadEngagement,
  markThreadEngaged,
  resolvePartition,
  shouldDeliverReply,
  type EngagementRow,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildNotionAuth, notionConversationKey } from "./notion-identity.js";
import type { NotionVia } from "./notion-scope.js";

export interface NotionSeamFacts {
  readonly workspaceId: string | undefined;
  readonly pageId: string | undefined;
  readonly principalId?: string;
  readonly credentialId?: string;
}

export function notionEngagementAnchor(f: NotionSeamFacts): string | undefined {
  return notionConversationKey(f.workspaceId, f.pageId);
}

export function notionSeamPartition(f: NotionSeamFacts): Partition | null {
  if (!f.workspaceId || !f.pageId) return null;
  try {
    const auth = buildNotionAuth({
      workspaceId: f.workspaceId,
      pageId: f.pageId,
      ...(f.principalId ? { principalId: f.principalId } : {}),
      ...(f.credentialId ? { credentialId: f.credentialId } : {}),
    });
    return resolvePartition({ channel: { kind: "notion" }, session: { auth: { current: auth } } });
  } catch {
    return null;
  }
}

export type NotionEngagementVerdict =
  | { readonly kind: "unanchored"; readonly reason: string }
  | { readonly kind: "deliver"; readonly anchor: string; readonly reason: string }
  | { readonly kind: "hold"; readonly anchor: string; readonly reason: string; readonly stopped: boolean };

export interface NotionEngagementDeps {
  readonly getEngagement?: (p: Partition, anchor: string) => Promise<EngagementRow | null>;
  readonly markEngaged?: (p: Partition, anchor: string, atIso: string) => Promise<void>;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly now?: () => string;
}

export async function resolveNotionEngagement(
  f: NotionSeamFacts,
  authorIsBot: boolean,
  deps: NotionEngagementDeps = {},
): Promise<NotionEngagementVerdict> {
  const anchor = notionEngagementAnchor(f);
  if (!anchor) return { kind: "unanchored", reason: "the delivery names no workspace and page — no row to address" };
  const partition = notionSeamPartition(f);
  if (!partition) return { kind: "unanchored", reason: "the delivery has no resolvable partition — no row to address" };

  const read = deps.getEngagement ?? ((p, key) => getThreadEngagement(p, key));
  const row = await read(partition, anchor);
  const decision = shouldDeliverReply({
    isEngaged: row !== null,
    stopped: row?.stopped ?? false,
    authorIsBot,
    isAppMention: false,
    inThread: true,
  });
  if (decision.deliver) return { kind: "deliver", anchor, reason: decision.reason };
  return { kind: "hold", anchor, reason: decision.reason, stopped: row?.stopped === true };
}

export async function markNotionEngaged(f: NotionSeamFacts, commentId: string | undefined, deps: NotionEngagementDeps = {}): Promise<string | null> {
  const anchor = notionEngagementAnchor(f);
  if (!anchor) return null;
  const partition = notionSeamPartition(f);
  if (!partition) return null;
  const now = deps.now ?? (() => new Date().toISOString());
  const atIso = now();
  if (commentId !== undefined && commentId.length > 0) {
    const seen = deps.markEventSeen ?? liveMarkEngageSeen;
    if (!(await seen(partition.org, `notion-engage:${anchor}:${commentId}`, atIso))) return null;
  }
  const mark = deps.markEngaged ?? ((p, key, at) => markThreadEngaged(p, key, at, { participating: true }));
  await mark(partition, anchor, atIso);
  return anchor;
}

export async function firstNotionDispatchOfComment(
  f: NotionSeamFacts,
  commentId: string | undefined,
  deps: NotionEngagementDeps = {},
): Promise<boolean> {
  if (commentId === undefined || commentId.length === 0) return true;
  const partition = notionSeamPartition(f);
  if (!partition) return true;
  const now = deps.now ?? (() => new Date().toISOString());
  const seen = deps.markEventSeen ?? liveMarkDispatchSeen;
  try {
    return await seen(partition.org, `notion-dispatch:${commentId}`, now());
  } catch {
    return true;
  }
}

export type NotionDispatchAddressing = "direct" | "channel-watch";

export function notionWakeAddressing(
  addressing: NotionDispatchAddressing,
  engagedFollowUp: boolean | undefined,
): "direct" | "channel-watch" | "thread-follow" {
  return addressing === "channel-watch" && engagedFollowUp === true ? "thread-follow" : addressing;
}

export interface NotionWakeAuditDetail {
  readonly addressing: "direct" | "channel-watch" | "thread-follow";
  readonly via: NotionVia;
}

export function notionWakeAuditDetail(
  addressing: NotionDispatchAddressing,
  engagedFollowUp: boolean | undefined,
  via: NotionVia | undefined,
): NotionWakeAuditDetail {
  return { addressing: notionWakeAddressing(addressing, engagedFollowUp), via: via ?? "none" };
}

const NOTION_DEDUPE_TTL_MS = 10 * 60_000;

let warnedEngageDedupe = false;
async function liveMarkEngageSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, NOTION_DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedEngageDedupe) {
      warnedEngageDedupe = true;
      console.warn(`[open-everywhere:notion-engagement] engage dedupe unavailable — a redelivered name-drop may re-mark: ${String(err)}`);
    }
    return true;
  }
}

let warnedDispatchDedupe = false;
async function liveMarkDispatchSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, NOTION_DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedDispatchDedupe) {
      warnedDispatchDedupe = true;
      console.warn(`[open-everywhere:notion-engagement] dispatch dedupe unavailable — a redelivered comment may wake a second turn: ${String(err)}`);
    }
    return true;
  }
}

export interface NotionDispatchJoinIds {
  readonly deliveryId?: string;
  readonly commentId?: string;
  readonly wakeId?: string;
}

export function notionDispatchJoinDetail(ids: NotionDispatchJoinIds): Record<string, string> {
  const out: Record<string, string> = {};
  if (ids.deliveryId) out.deliveryId = ids.deliveryId;
  if (ids.commentId) out.commentId = ids.commentId;
  if (ids.wakeId) out.wakeId = ids.wakeId;
  return out;
}
