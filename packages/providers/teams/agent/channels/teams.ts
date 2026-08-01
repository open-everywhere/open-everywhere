import { teamsChannel, splitTeamsMessageText, type TeamsHandle, type TeamsInboundMessageContext, type TeamsMessageActivity, type TeamsInboundResult } from "eve/channels/teams";
import { frontTeamsChannel, INTERNAL_TEAMS_ROUTE } from "./teams-front.js";
import { buildTeamsAuth, teamsMembershipType, teamsUserTypeFromMember } from "./teams-identity.js";
import {
  finalMessageActionForTurn,
  isBareStop,
  postTerminalProse,
  consumeRepliedThisTurn,
  resolvePartition,
  bindFrom,
  scopeOverBudget,
  capBypassFor,
  appendAudit,
  domainKeyOf,
  type ChatAuditPartition,
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

export const teamsOnMessage = async (ctx: TeamsInboundMessageContext, message: TeamsMessageActivity): Promise<TeamsInboundResult> => {
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

    try {
      const gBindable = { channel: { kind: "teams" as const }, session: { auth: { current: auth } } };
      const gPartition = resolvePartition(gBindable);
      const gBinding = bindFrom(gBindable);
      const verdict = await scopeOverBudget(gPartition, gBinding.mode, new Date().toISOString(), gBinding.trust, gBinding.principalId);
      if (verdict.over) {
        try {
          await appendAudit({
            org: gPartition.org, platform: gPartition.platform, workspace: gPartition.workspace, surface: gPartition.surface,
            action: "spend.gate",
            detail: { key: domainKeyOf(gPartition), mode: gBinding.mode, door: "mention", over: true, ...(verdict.reason ? { reason: verdict.reason } : {}) },
          });
        } catch {}
        const bypass = await capBypassFor({ org: gBinding.org, principalId: message.from.id, surfaceKey: domainKeyOf(gPartition), reason: verdict.reason });
        if (bypass) {
          if (bypass.warn) { try { await ctx.thread.post(`⚠️ ${verdict.reason} — proceeding because you're an admin. Ask me here to raise or clear the cap, or change it in the spend-budgets config.`); } catch {} }
        } else {
          const isDm = gBinding.mode === "dm" || gBinding.mode === "mpim";
          const scopeKey = domainKeyOf(gPartition), wsKey = `${gBinding.platform}/${gBinding.workspace}`;
          try {
            await ctx.thread.post(isDm
              ? `I'm holding off — ${verdict.reason}. This is a cap on your own usage; I can't raise it from here. Ask an org admin to raise it in the spend-budgets config, or from a channel ask me to propose an override. Scope key: \`${scopeKey}\`.`
              : `I'm holding off here — ${verdict.reason}. An admin can raise this in the spend-budgets config, or DM me to propose a temporary override. Scope keys: this surface = \`${scopeKey}\`, whole workspace = \`${wsKey}\`.`);
          } catch {}
          return null;
        }
      }
    } catch (e) {
      console.warn(`[open-everywhere:teams:spend-gate] check failed OPEN: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { auth };
};

const native = teamsChannel({
  route: INTERNAL_TEAMS_ROUTE,
  onMessage: teamsOnMessage,
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
