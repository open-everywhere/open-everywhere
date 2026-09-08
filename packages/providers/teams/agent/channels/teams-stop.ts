import {
  cancelAnchoredTurn,
  resolvePartition,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth } from "./teams-identity.js";
import { liveTeamsReactionFeedbackDeps, routeTeamsReactionFeedback, type TeamsReactionFeedbackDeps } from "./teams-reaction-feedback.js";

export const TEAMS_STOP_REACTION = "angry";

export interface TeamsReactionActivity {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly replyToId?: string;
  readonly reactorId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly tenantId?: string;
  readonly teamsChannelId?: string;
  readonly teamId?: string;
  readonly scope?: string;
}

export type TeamsStopOutcome = (
  | { readonly stopped: false; readonly reason: string }
  | { readonly stopped: true; readonly outcome: CancelOutcome }
) & {
  readonly feedback?: Promise<void>;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pick(o: unknown, k: string): unknown {
  return isObject(o) ? o[k] : undefined;
}

function reactionTypes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const member of v) {
    const t = str(pick(member, "type"));
    if (t) out.push(t.toLowerCase());
  }
  return out;
}

export function parseTeamsReaction(parsed: unknown): TeamsReactionActivity | null {
  if (!isObject(parsed)) return null;
  if (parsed["type"] !== "messageReaction") return null;
  const conversation = parsed["conversation"];
  const channelData = parsed["channelData"];
  return {
    added: reactionTypes(parsed["reactionsAdded"]),
    removed: reactionTypes(parsed["reactionsRemoved"]),
    ...(str(parsed["replyToId"]) ? { replyToId: str(parsed["replyToId"])! } : {}),
    reactorId: str(pick(parsed["from"], "id")),
    agentId: str(pick(parsed["recipient"], "id")),
    conversationId: str(pick(conversation, "id")),
    tenantId: str(parsed["tenantId"]) ?? str(pick(conversation, "tenantId")) ?? str(pick(pick(channelData, "tenant"), "id")),
    teamsChannelId: str(pick(pick(channelData, "channel"), "id")),
    teamId: str(pick(pick(channelData, "team"), "id")),
    scope: str(pick(conversation, "conversationType")),
  };
}

export interface TeamsStopDeps {
  readonly attachSession: AttachSessionForCancel;
  readonly cancel?: typeof cancelAnchoredTurn;
  readonly feedback?: TeamsReactionFeedbackDeps;
}

type TeamsStopGuard =
  | { readonly stop: false; readonly reason: string }
  | { readonly stop: true; readonly reactorId: string; readonly conversationId: string };

function stopGuard(rx: TeamsReactionActivity): TeamsStopGuard {
  if (!rx.added.includes(TEAMS_STOP_REACTION)) return { stop: false, reason: "stop: not the stop reaction" };
  if (!rx.reactorId) return { stop: false, reason: "stop: no reactor id — refusing to cancel (fail-closed)" };
  if (!rx.agentId) return { stop: false, reason: "stop: agent identity unresolved — refusing to cancel (fail-closed)" };
  if (rx.reactorId === rx.agentId || rx.reactorId.startsWith("28:")) {
    return { stop: false, reason: "stop: the reactor is a bot — never a self-cancel" };
  }
  if (!rx.conversationId) return { stop: false, reason: "stop: no conversation — nothing to resolve a turn against" };
  return { stop: true, reactorId: rx.reactorId, conversationId: rx.conversationId };
}

async function writeTeamsReactionFeedback(feedback: TeamsReactionActivity, deps: TeamsStopDeps): Promise<void> {
  await routeTeamsReactionFeedback(feedback, deps.feedback ?? liveTeamsReactionFeedbackDeps()).catch(() => undefined);
}

export const TEAMS_FEEDBACK_SETTLE_TIMEOUT_MS = 5000;

async function settleFeedback(pending: Promise<void> | undefined): Promise<void> {
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TEAMS_FEEDBACK_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([pending, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

export async function routeTeamsStopReaction(rx: TeamsReactionActivity, deps: TeamsStopDeps): Promise<TeamsStopOutcome> {
  const feedback: TeamsReactionActivity = { ...rx, added: rx.added.filter((type) => type !== TEAMS_STOP_REACTION) };
  const carries = feedback.added.length > 0 || feedback.removed.length > 0;
  const guard = stopGuard(rx);
  const pending = carries ? writeTeamsReactionFeedback(feedback, deps) : undefined;
  const rider = pending ? { feedback: pending } : {};

  if (!guard.stop) {
    await settleFeedback(pending);
    return { stopped: false, reason: guard.reason, ...rider };
  }

  const partition = resolvePartition({
    channel: { kind: "teams" },
    session: {
      auth: {
        current: buildTeamsAuth({
          userId: guard.reactorId,
          conversationId: guard.conversationId,
          ...(rx.tenantId ? { tenantId: rx.tenantId } : {}),
          ...(rx.teamsChannelId ? { channelId: rx.teamsChannelId } : {}),
          ...(rx.teamId ? { teamId: rx.teamId } : {}),
          ...(rx.scope ? { scope: rx.scope } : {}),
        }),
      },
    },
  });
  const channelKey = turnChannelKey("teams", guard.conversationId);
  if (!channelKey) {
    await settleFeedback(pending);
    return { stopped: false, reason: "stop: no conversation key", ...rider };
  }
  const result = await (deps.cancel ?? cancelAnchoredTurn)({
    org: partition.org,
    platform: "teams",
    workspace: partition.workspace,
    requestedBy: guard.reactorId,
    via: "reaction",
    query: { channelKey },
    attachSession: deps.attachSession,
  });
  await settleFeedback(pending);
  return { stopped: true, outcome: result.outcome, ...rider };
}
