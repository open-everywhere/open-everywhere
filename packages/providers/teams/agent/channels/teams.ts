import { teamsChannel, splitTeamsMessageText, type TeamsInboundMessageContext, type TeamsMessageActivity, type TeamsInboundResult } from "eve/channels/teams";
import { frontTeamsChannel, INTERNAL_TEAMS_ROUTE } from "./teams-front.js";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";
import { resolveTeamsUserType, teamsHandleRosterProbe } from "./teams-roster.js";
import { admitTeamsInputResponse } from "./teams-input-response.js";
import {
  finalMessageActionForTurn,
  isBareStop,
  postTerminalProse,
  consumeRepliedThisTurn,
  resolvePartition,
  ingressSpendGate,
  replierLabelFromAuthAttributes,
  type ChatAuditPartition,
  type ReplierLabel,
} from "@open-everywhere/core/agent/adapter-api.js";

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
    if (message.scope !== "personal" && !message.isBotMentioned) return null;

    const userType = await resolveTeamsUserType(teamsHandleRosterProbe(ctx.teams), message.conversation.id, message.from.id);

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
  turnPolicy: "queue",
  onMessage: teamsOnMessage,
  onInputResponse: (ctx, activity) => admitTeamsInputResponse(ctx, activity),
  events: {
    "turn.started": async (_data, channel, ctx) => {
      await channel.thread.startTyping();
      (channel.state as unknown as Record<string, unknown>).oeReplierLabel = replierLabelFromAuthAttributes(
        ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined,
      );
    },
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      const repliedThisTurn = consumeRepliedThisTurn();
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:teams] judged silence (${action.reason}) — nothing posted (conversation ${channel.state.conversationId ?? "?"})`);
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
        if (p && channel.state.serviceUrl && channel.state.conversationId) {
          await postTerminalProse(
            { platform: "teams", serviceUrl: channel.state.serviceUrl, conversationId: channel.state.conversationId, ...(channel.state.replyToActivityId ? { replyToActivityId: channel.state.replyToActivityId } : {}) },
            action.text,
            { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface, ...(sessionId ? { sessionId } : {}), route: "terminal" },
            (channel.state as unknown as Record<string, unknown>).oeReplierLabel as ReplierLabel | undefined,
          );
        } else {
          for (const part of splitTeamsMessageText(action.text)) {
            await channel.thread.post(part);
          }
        }
      }
    },
  },
});

export default frontTeamsChannel(native);
