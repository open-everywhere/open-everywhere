import { teamsChannel, splitTeamsMessageText, type TeamsHandle } from "eve/channels/teams";
import { frontTeamsChannel, INTERNAL_TEAMS_ROUTE } from "./teams-front.js";
import { buildTeamsAuth, teamsMembershipType, teamsUserTypeFromMember } from "./teams-identity.js";
import { finalMessageActionForTurn, isBareStop } from "./slack-events.js";
import { type ChatAuditPartition } from "./chat-turn-audit.js";
import { postTerminalProse } from "./reply-post.js";
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

const TEAMS_TRUST_TTL = Number(process.env.OE_DM_TRUST_TTL_MS) || 5 * 60_000;
const teamsUserTypeCache = new Map<string, { userType: "guest" | "member"; at: number }>();

async function resolveTeamsUserType(
  teams: Pick<TeamsHandle, "request">,
  conversationId: string | undefined,
  userId: string | undefined,
): Promise<"guest" | "member" | undefined> {
  if (!conversationId || !userId) return undefined;
  const key = `${conversationId}:${userId}`;
  const hit = teamsUserTypeCache.get(key);
  if (hit && Date.now() - hit.at < TEAMS_TRUST_TTL) return hit.userType;
  try {
    const res = await teams.request(
      `v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      {},
      { method: "GET" },
    );
    if (!res.ok) return undefined;
    const userType = teamsUserTypeFromMember(res.body);
    if (userType) teamsUserTypeCache.set(key, { userType, at: Date.now() });
    return userType;
  } catch {
    return undefined;
  }
}

export function _resetTeamsUserTypeCacheForTest(): void {
  teamsUserTypeCache.clear();
}

const native = teamsChannel({
  route: INTERNAL_TEAMS_ROUTE,
  onMessage: async (ctx, message) => {
    if (message.scope !== "personal" && !message.isBotMentioned) return null;

    const userType = await resolveTeamsUserType(ctx.teams, message.conversation.id, message.from.id);

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
