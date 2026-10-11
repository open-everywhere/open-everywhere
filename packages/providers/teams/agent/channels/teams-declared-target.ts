import { surfaceKeySegment, type DeclaredTargetResolution, type DeclaredTargetSpec } from "@open-everywhere/core/agent/adapter-api.js";
import { teamsChannelGrainConversationId, teamsConversationRef, teamsPersonalConversationRef, type TeamsConversationRef } from "./teams-conversation-ref.js";
import { restoreTeamsConversationId, restoreTeamsPersonId } from "./teams-id-restore.js";

export interface TeamsDeclaredTargetDeps {
  readonly restoreConversationId?: (id: string) => Promise<string>;
  readonly conversationRef?: (conversationId: string) => Promise<TeamsConversationRef | undefined>;
  readonly restorePersonId?: (id: string) => Promise<string>;
  readonly personalRef?: (principalId: string) => Promise<TeamsConversationRef | undefined>;
}

function surfaceKeyOf(ref: TeamsConversationRef): string {
  return `teams/${surfaceKeySegment(ref.tenantId)}/${surfaceKeySegment(ref.conversationId)}`;
}

function teamsRoomKind(conversationId: string): "channel" | "groupChat" | undefined {
  const grain = teamsChannelGrainConversationId(conversationId);
  if (grain.endsWith("@thread.tacv2") || grain.endsWith("@thread.skype")) return "channel";
  if (grain.endsWith("@thread.v2")) return "groupChat";
  return undefined;
}

export async function resolveTeamsDeclaredTarget(spec: DeclaredTargetSpec, deps: TeamsDeclaredTargetDeps = {}): Promise<DeclaredTargetResolution> {
  if (spec.kind === "room") {
    const raw = await (deps.restoreConversationId ?? restoreTeamsConversationId)(spec.surface);
    const ref = await (deps.conversationRef ?? teamsConversationRef)(raw);
    if (!ref) {
      return {
        ok: false,
        reason:
          `no captured Teams conversation reference for ${spec.surface} yet. Teams accepts a proactive post only into a conversation ` +
          `the bot has heard from: add the app to that conversation and @mention it once, and the next delivery fires.`,
      };
    }
    if (surfaceKeySegment(ref.tenantId) !== spec.workspace) {
      return {
        ok: false,
        reason: `conversation ${spec.surface} belongs to Teams tenant ${ref.tenantId}, not ${spec.workspace}. Correct the target's tenant segment.`,
      };
    }
    const conversationType = teamsRoomKind(ref.conversationId);
    if (!conversationType) {
      return {
        ok: false,
        reason:
          `conversation ${spec.surface} is not a team channel or a group chat. A room target names a channel or a group chat; ` +
          `name a person's 1:1 chat as "dm:teams/<29: id>", which runs the turn as a DM.`,
      };
    }
    return {
      ok: true,
      facts: { surfaceKey: surfaceKeyOf(ref), target: { serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, tenantId: ref.tenantId, conversationType } },
    };
  }
  const principalId = await (deps.restorePersonId ?? restoreTeamsPersonId)(spec.principalId);
  const ref = await (deps.personalRef ?? teamsPersonalConversationRef)(principalId);
  if (!ref) {
    return {
      ok: false,
      reason:
        `no captured Teams 1:1 chat with ${spec.principalId} yet. Teams cannot open a chat from a bare person id: ` +
        `the person must send the bot one direct message, and the next delivery fires.`,
    };
  }
  return {
    ok: true,
    facts: {
      surfaceKey: surfaceKeyOf(ref),
      target: { serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, tenantId: ref.tenantId, conversationType: "personal" },
    },
  };
}
