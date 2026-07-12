import { teamsChannel, splitTeamsMessageText } from "eve/channels/teams";
import { frontTeamsChannel, INTERNAL_TEAMS_ROUTE } from "./teams-front.js";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";
import { finalMessageActionForTurn, isBareStop } from "./slack-events.js";
import { auditChatSilence, auditChatReply, shouldAuditChatSilence, type ChatAuditPartition } from "./chat-turn-audit.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";
import { resolvePartition } from "../memory/partition.js";

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

const native = teamsChannel({
  route: INTERNAL_TEAMS_ROUTE,
  onMessage: (_ctx, message) => {
    if (message.scope !== "personal" && !message.isBotMentioned) return null;

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
    });
    return { auth };
  },
  events: {
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      const repliedThisTurn = consumeRepliedThisTurn();
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:teams] judged silence (${action.reason}) — nothing posted (conversation ${channel.state.conversationId ?? "?"})`);
        }
        if (action.kind === "silent" && shouldAuditChatSilence(action.reason, repliedThisTurn)) {
          const p = auditPartitionForState(channel.state);
          if (p) await auditChatSilence(p, { conversationId: channel.state.conversationId, reason: action.reason }, sessionId);
        }
        if (action.kind === "silent" && isBareStop(action, repliedThisTurn)) {
          console.warn(
            `[open-everywhere:teams] BARE STOP — turn ended with no reply and no no_reply (conversation ${channel.state.conversationId ?? "?"}) — this usually means a judgment call went missing, not that one was made.`,
          );
        }
        return;
      }
      for (const part of splitTeamsMessageText(action.text)) {
        await channel.thread.post(part);
      }
      {
        const p = auditPartitionForState(channel.state);
        if (p) await auditChatReply(p, { conversationId: channel.state.conversationId, chars: action.text.length }, sessionId);
      }
    },
  },
});

export default frontTeamsChannel(native);
