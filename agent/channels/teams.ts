import { teamsChannel } from "eve/channels/teams";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";

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
});
