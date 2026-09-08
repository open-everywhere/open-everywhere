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

const ENGAGE_DEDUPE_TTL_MS = 10 * 60_000;
let warnedEngageDedupe = false;
async function liveMarkEngageSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, ENGAGE_DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedEngageDedupe) {
      warnedEngageDedupe = true;
      console.warn(`[open-everywhere:notion-engagement] engage dedupe unavailable — a redelivered name-drop may re-mark: ${String(err)}`);
    }
    return true;
  }
}
