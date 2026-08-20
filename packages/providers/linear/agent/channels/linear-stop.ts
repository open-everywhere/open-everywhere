import {
  cancelAnchoredTurn,
  resolvePartition,
  turnAnchorKey,
  turnChannelKey,
  STOP_HAND_SLACK_NAME,
  STOP_HAND_UNICODE,
  type AttachSessionForCancel,
  type CancelOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildLinearAuth } from "./linear-identity.js";

export interface LinearReactionEvent {
  readonly verb: "added" | "removed";
  readonly emoji: string;
  readonly reactorId?: string;
  readonly organizationId?: string;
  readonly issueId?: string;
  readonly commentId?: string;
}

export type LinearStopOutcome =
  | { readonly stopped: false; readonly reason: string }
  | { readonly stopped: true; readonly outcome: CancelOutcome };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pick(o: unknown, k: string): unknown {
  return isObject(o) ? o[k] : undefined;
}

export function parseLinearReaction(body: string): LinearReactionEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(ev)) return null;
  if (ev["type"] !== "Reaction") return null;
  const action = ev["action"];
  if (action !== "create" && action !== "remove") return null;
  const data = ev["data"];
  const comment = pick(data, "comment");
  return {
    verb: action === "create" ? "added" : "removed",
    emoji: str(pick(data, "emoji")) ?? "",
    reactorId: str(pick(ev["actor"], "id")) ?? str(pick(pick(data, "user"), "id")) ?? str(pick(data, "userId")),
    organizationId: str(ev["organizationId"]),
    issueId:
      str(pick(data, "issueId")) ??
      str(pick(pick(data, "issue"), "id")) ??
      str(pick(comment, "issueId")) ??
      str(pick(pick(comment, "issue"), "id")),
    commentId: str(pick(data, "commentId")) ?? str(pick(comment, "id")),
  };
}

export function isLinearStopHand(emoji: string): boolean {
  const bare = emoji.trim().replace(/^:|:$/g, "");
  return bare === STOP_HAND_UNICODE || bare === STOP_HAND_SLACK_NAME || bare === "hand";
}

export interface LinearStopDeps {
  readonly attachSession: AttachSessionForCancel;
  readonly appUserId: (organizationId?: string) => Promise<string | undefined>;
  readonly cancel?: typeof cancelAnchoredTurn;
}

export async function routeLinearStopReaction(rx: LinearReactionEvent, deps: LinearStopDeps): Promise<LinearStopOutcome> {
  if (rx.verb !== "added") return { stopped: false, reason: "stop: a reaction removal never cancels" };
  if (!isLinearStopHand(rx.emoji)) return { stopped: false, reason: "stop: not the stop glyph" };
  if (!rx.organizationId) return { stopped: false, reason: "stop: no organization — cannot key the surface" };
  if (!rx.reactorId) return { stopped: false, reason: "stop: no reactor id — refusing to cancel (fail-closed)" };
  const appUser = await deps.appUserId(rx.organizationId).catch(() => undefined);
  if (!appUser) return { stopped: false, reason: "stop: app identity unresolved — refusing to cancel (fail-closed)" };
  if (rx.reactorId === appUser) return { stopped: false, reason: "stop: the reactor is the app itself — never a self-cancel" };
  if (!rx.issueId) return { stopped: false, reason: "stop: no issue — nothing to resolve a turn against" };

  const partition = resolvePartition({
    channel: { kind: "linear" },
    session: { auth: { current: buildLinearAuth({ organizationId: rx.organizationId, issueId: rx.issueId }) } },
  });
  const anchorKey = turnAnchorKey("linear", rx.issueId, rx.commentId);
  const result = await (deps.cancel ?? cancelAnchoredTurn)({
    org: partition.org,
    platform: "linear",
    workspace: partition.workspace,
    requestedBy: rx.reactorId,
    via: "reaction",
    query: { ...(anchorKey ? { anchorKey } : {}), ...(turnChannelKey("linear", rx.issueId) ? { channelKey: turnChannelKey("linear", rx.issueId)! } : {}) },
    attachSession: deps.attachSession,
  });
  return { stopped: true, outcome: result.outcome };
}
