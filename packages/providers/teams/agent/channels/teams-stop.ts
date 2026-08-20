import {
  cancelAnchoredTurn,
  resolvePartition,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth } from "./teams-identity.js";

export const TEAMS_STOP_REACTION = "angry";

export interface TeamsReactionActivity {
  readonly added: readonly string[];
  readonly reactorId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly tenantId?: string;
  readonly teamsChannelId?: string;
  readonly teamId?: string;
  readonly scope?: string;
}

export type TeamsStopOutcome =
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
}

export async function routeTeamsStopReaction(rx: TeamsReactionActivity, deps: TeamsStopDeps): Promise<TeamsStopOutcome> {
  if (!rx.added.includes(TEAMS_STOP_REACTION)) return { stopped: false, reason: "stop: not the stop reaction" };
  if (!rx.reactorId) return { stopped: false, reason: "stop: no reactor id — refusing to cancel (fail-closed)" };
  if (!rx.agentId) return { stopped: false, reason: "stop: agent identity unresolved — refusing to cancel (fail-closed)" };
  if (rx.reactorId === rx.agentId || rx.reactorId.startsWith("28:")) {
    return { stopped: false, reason: "stop: the reactor is a bot — never a self-cancel" };
  }
  if (!rx.conversationId) return { stopped: false, reason: "stop: no conversation — nothing to resolve a turn against" };

  const partition = resolvePartition({
    channel: { kind: "teams" },
    session: {
      auth: {
        current: buildTeamsAuth({
          userId: rx.reactorId,
          conversationId: rx.conversationId,
          ...(rx.tenantId ? { tenantId: rx.tenantId } : {}),
          ...(rx.teamsChannelId ? { channelId: rx.teamsChannelId } : {}),
          ...(rx.teamId ? { teamId: rx.teamId } : {}),
          ...(rx.scope ? { scope: rx.scope } : {}),
        }),
      },
    },
  });
  const channelKey = turnChannelKey("teams", rx.conversationId);
  if (!channelKey) return { stopped: false, reason: "stop: no conversation key" };
  const result = await (deps.cancel ?? cancelAnchoredTurn)({
    org: partition.org,
    platform: "teams",
    workspace: partition.workspace,
    requestedBy: rx.reactorId,
    via: "reaction",
    query: { channelKey },
    attachSession: deps.attachSession,
  });
  return { stopped: true, outcome: result.outcome };
}
