import type { DispatchTarget, RoutineTestRunArm } from "@open-everywhere/core/agent/adapter-api.js";
import { dispatchTeamsReply } from "./teams-post-arm.js";
import { teamsChannelGrainConversationId } from "./teams-conversation-id.js";
import { TEAMS_REPLY_TO_ATTR } from "./teams-identity.js";

function stored(dest: DispatchTarget, key: string): string | undefined {
  const v = (dest.target as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const teamsTestRunArm: RoutineTestRunArm = {
  post: async (dest, text, anchor) => {
    const serviceUrl = stored(dest, "serviceUrl");
    const conversationId = stored(dest, "conversationId");
    if (serviceUrl === undefined || conversationId === undefined) return undefined;
    try {
      const id = await dispatchTeamsReply(
        { platform: "teams", serviceUrl, conversationId: teamsChannelGrainConversationId(conversationId), ...(anchor !== undefined ? { replyToActivityId: anchor } : {}) },
        text,
      );
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  },
  target: (dest, anchor) => ({
    ...(dest.target as Record<string, unknown>),
    conversationId: teamsChannelGrainConversationId(stored(dest, "conversationId") ?? ""),
    replyToActivityId: anchor,
  }),
  attributes: (_dest, anchor) => ({ [TEAMS_REPLY_TO_ATTR]: anchor }),
};
