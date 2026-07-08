import { teamsChannel, splitTeamsMessageText } from "eve/channels/teams";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";
import { finalMessageActionForTurn, isBareStop } from "./slack-events.js";

export default teamsChannel({
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
    "message.completed": async (data, channel) => {
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:teams] judged silence (${action.reason}) — nothing posted (conversation ${channel.state.conversationId ?? "?"})`);
        }
        if (action.kind === "silent" && isBareStop(action, false)) {
          console.warn(
            `[open-everywhere:teams] BARE STOP — turn ended with no reply and no no_reply (conversation ${channel.state.conversationId ?? "?"}) — this usually means a judgment call went missing, not that one was made.`,
          );
        }
        return;
      }
      for (const part of splitTeamsMessageText(action.text)) {
        await channel.thread.post(part);
      }
    },
  },
});
