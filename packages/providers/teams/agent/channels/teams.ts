import { teamsChannel, type TeamsInboundMessageContext, type TeamsMessageActivity, type TeamsInboundResult } from "eve/channels/teams";
import { frontTeamsChannel, INTERNAL_TEAMS_ROUTE } from "./teams-front.js";
import { teamsAppCredentials } from "./teams-connector.js";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";
import { teamsNativeAdmits } from "./teams-name-drop.js";
import { resolveTeamsUserType, teamsHandleRosterProbe, teamsIsHomeTenant } from "./teams-roster.js";
import { admitTeamsInputResponse } from "./teams-input-response.js";
import {
  finalMessageActionForTurn,
  NO_REPLY_SENTINEL_REASON,
  auditNoReplySentinelObserved,
  isBareStop,
  dropClosingProse,
  consumeRepliedThisTurn,
  resolvePartition,
  ingressSpendGate,
  authPrincipalId,
  type ChatAuditPartition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { withEndsTurnFinalChannel } from "@open-everywhere/core/agent/adapter-api.js";

function auditPartitionForState(state: {
  conversationId: string | null;
  tenantId: string | null;
  channelId: string | null;
  teamId: string | null;
  conversationType: string | null;
}): ChatAuditPartition | null {
  if (!state.conversationId) return null;
  try {
    return resolvePartition({
      channel: { kind: "teams" },
      session: {
        auth: {
          current: buildTeamsAuth({
            userId: "",
            conversationId: state.conversationId,
            tenantId: state.tenantId ?? undefined,
            channelId: state.channelId ?? undefined,
            teamId: state.teamId ?? undefined,
            scope: state.conversationType ?? undefined,
          }),
        },
      },
    });
  } catch {
    return null;
  }
}

export const teamsOnMessage = async (ctx: TeamsInboundMessageContext, message: TeamsMessageActivity): Promise<TeamsInboundResult> => {
    if (!(await teamsNativeAdmits(message))) return null;

    const userType = await resolveTeamsUserType(teamsHandleRosterProbe(ctx.teams), message.conversation.id, message.from.id);
    const homeTenant = userType === "member" ? await teamsIsHomeTenant(message.tenantId ?? message.conversation.tenantId) : undefined;

    const auth = buildTeamsAuth({
      userId: message.from.id,
      aadObjectId: message.from.aadObjectId,
      userName: message.from.name,
      tenantId: message.tenantId ?? message.conversation.tenantId,
      conversationId: message.conversation.id,
      channelId: message.teamsChannelId,
      teamId: message.teamId,
      serviceUrl: message.serviceUrl,
      scope: message.scope,
      membershipType: teamsMembershipType(message.channelData),
      userType,
      homeTenant,
    });

    if ((await ingressSpendGate({
      bindable: { channel: { kind: "teams" as const }, session: { auth: { current: auth } } },
      door: "mention",
      principalId: message.from.id,
      post: async (text) => { await ctx.thread.post(text); },
    })) === "declined") {
      return null;
    }

    return { auth };
};

const native = teamsChannel({
  route: INTERNAL_TEAMS_ROUTE,
  credentials: teamsAppCredentials(),
  turnPolicy: "queue",
  onMessage: teamsOnMessage,
  onInputResponse: (ctx, activity) => admitTeamsInputResponse(ctx, activity),
  events: {
    "turn.started": async (_data, channel, ctx) => {
      await channel.thread.startTyping();
      (channel.state as unknown as Record<string, unknown>).oeReplyPrincipalId = authPrincipalId(ctx);
    },
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const turnId = (ctx as unknown as { session?: { turn?: { id?: string } } })?.session?.turn?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message, turnId);
      const repliedThisTurn = consumeRepliedThisTurn((ctx as unknown as { session?: { turn?: { id?: string } } })?.session?.turn?.id);
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:teams] judged silence (${action.reason}) — nothing posted (conversation ${channel.state.conversationId ?? "?"})`);
        }
        if (action.kind === "silent" && action.reason === NO_REPLY_SENTINEL_REASON) {
          const p = auditPartitionForState(channel.state);
          if (p) await auditNoReplySentinelObserved(p, sessionId).catch(() => undefined);
        }
        if (action.kind === "silent" && isBareStop(action, repliedThisTurn)) {
          console.warn(
            `[open-everywhere:teams] BARE STOP — turn ended with no reply and no no_reply (conversation ${channel.state.conversationId ?? "?"}) — this usually means a judgment call went missing, not that one was made.`,
          );
        }
        return;
      }
      {
        const p = auditPartitionForState(channel.state);
        if (p) {
          await dropClosingProse({
            row: {
              org: p.org,
              platform: p.platform,
              workspace: p.workspace,
              surface: p.surface,
              principalId: (channel.state as unknown as Record<string, unknown>).oeReplyPrincipalId as string | undefined,
            },
            chars: action.text.length,
            ...(sessionId ? { sessionId } : {}),
            anchor: { conversationId: channel.state.conversationId ?? null },
            log: (m) => console.warn(`[open-everywhere:teams] ${m} (conversation ${channel.state.conversationId ?? "?"})`),
          });
        } else {
          console.warn(
            `[open-everywhere:teams] closing prose DROPPED (${action.text.length}c) — nothing posted, and no partition to audit it under (conversation ${channel.state.conversationId ?? "?"})`,
          );
        }
      }
    },
  },
});

export default withEndsTurnFinalChannel(frontTeamsChannel(native));
