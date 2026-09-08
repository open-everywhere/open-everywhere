import {
  getOperationalStore,
  getThreadEngagement,
  markThreadEngaged,
  resolvePartition,
  shouldDeliverReply,
  type EngagementRow,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildLinearAuth } from "./linear-identity.js";
import type { LinearAmbientAddressing } from "./linear-supervisor.js";

export interface LinearSeamFacts {
  readonly organizationId: string | undefined;
  readonly teamId: string | undefined;
  readonly issueId: string | undefined;
  readonly principalId?: string;
  readonly isPrivate?: boolean;
}

export function linearEngagementAnchor(f: LinearSeamFacts): string | undefined {
  return f.issueId && f.issueId.length > 0 ? f.issueId : undefined;
}

export function linearSeamPartition(f: LinearSeamFacts): Partition | null {
  if (!f.organizationId || !f.teamId || !f.issueId) return null;
  try {
    const auth = buildLinearAuth({
      organizationId: f.organizationId,
      teamId: f.teamId,
      issueId: f.issueId,
      ...(f.principalId ? { principalId: f.principalId } : {}),
      ...(f.isPrivate === undefined ? {} : { isPrivate: f.isPrivate }),
    });
    return resolvePartition({ channel: { kind: "linear" }, session: { auth: { current: auth } } });
  } catch {
    return null;
  }
}

export type LinearEngagementVerdict =
  | { readonly kind: "unanchored"; readonly reason: string }
  | { readonly kind: "deliver"; readonly anchor: string; readonly reason: string }
  | { readonly kind: "hold"; readonly anchor: string; readonly reason: string; readonly stopped: boolean };

export interface LinearEngagementDeps {
  readonly getEngagement?: (p: Partition, anchor: string) => Promise<EngagementRow | null>;
  readonly markEngaged?: (p: Partition, anchor: string, atIso: string) => Promise<void>;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly now?: () => string;
}

export async function resolveLinearEngagement(
  f: LinearSeamFacts,
  authorIsBot: boolean,
  deps: LinearEngagementDeps = {},
): Promise<LinearEngagementVerdict> {
  const anchor = linearEngagementAnchor(f);
  if (!anchor) return { kind: "unanchored", reason: "the delivery names no issue — no row to address" };
  const partition = linearSeamPartition(f);
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

export async function linearStandDownHolds(f: LinearSeamFacts, deps: LinearEngagementDeps = {}): Promise<string | null> {
  const anchor = linearEngagementAnchor(f);
  if (!anchor) return null;
  const partition = linearSeamPartition(f);
  if (!partition) return null;
  const read = deps.getEngagement ?? ((p, key) => getThreadEngagement(p, key));
  const row = await read(partition, anchor);
  return row?.stopped === true ? anchor : null;
}

export async function markLinearEngaged(f: LinearSeamFacts, agentSessionId: string | undefined, deps: LinearEngagementDeps = {}): Promise<string | null> {
  const anchor = linearEngagementAnchor(f);
  if (!anchor) return null;
  const partition = linearSeamPartition(f);
  if (!partition) return null;
  const now = deps.now ?? (() => new Date().toISOString());
  const atIso = now();
  if (agentSessionId !== undefined && agentSessionId.length > 0) {
    const seen = deps.markEventSeen ?? liveMarkEngageSeen;
    if (!(await seen(partition.org, `linear-engage:${anchor}:${agentSessionId}`, atIso))) return null;
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
      console.warn(`[open-everywhere:linear-engagement] engage dedupe unavailable — a redelivered address may re-mark: ${String(err)}`);
    }
    return true;
  }
}

export function linearWakeAddressing(
  addressing: LinearAmbientAddressing,
  engagedFollowUp: boolean | undefined,
): LinearAmbientAddressing | "thread-follow" {
  return addressing === "channel-watch" && engagedFollowUp === true ? "thread-follow" : addressing;
}
