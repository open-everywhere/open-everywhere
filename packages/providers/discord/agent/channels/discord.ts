import {
  discordChannel,
  type DiscordContext,
  type DiscordCommandInteraction,
} from "eve/channels/discord";
import { buildDiscordAuth, threadParentFromRawChannel, discordMemberPendingFromRaw, type OpenEverywhereDiscordAuth } from "./discord-identity.js";
import {
  finalMessageActionForTurn,
  NO_REPLY_SENTINEL_REASON,
  auditNoReplySentinelObserved,
  isBareStop,
  consumeRepliedThisTurn,
  dropClosingProse,
  resolvePartition,
  authPrincipalId,
  type ChatAuditPartition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { withEndsTurnFinalChannel } from "@open-everywhere/core/agent/adapter-api.js";
import { discordAppCredentials, frontDiscordChannel, INTERNAL_DISCORD_ROUTE } from "./discord-front.js";
import { withDiscordEventsRoute } from "./discord-events.js";
import { discordBotTokenForEve } from "./discord-credentials.js";

function auditPartitionForState(state: { channelId: string | null; guildId: string | null }): ChatAuditPartition | null {
  if (!state.channelId) return null;
  try {
    return resolvePartition({
      channel: { kind: "discord" },
      session: { auth: { current: buildDiscordAuth({ userId: "", guildId: state.guildId ?? undefined, channelId: state.channelId }) } },
    });
  } catch {
    return null;
  }
}

function channelTypeFromRaw(raw: Record<string, unknown>): string | undefined {
  const ch = raw["channel"];
  if (ch && typeof ch === "object") {
    const t = (ch as Record<string, unknown>)["type"];
    if (typeof t === "number") return String(t);
  }
  return undefined;
}

function authFromInteraction(interaction: DiscordCommandInteraction): OpenEverywhereDiscordAuth | null {
  if (interaction.user.isBot) return null;
  return buildDiscordAuth({
    userId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    channelType: channelTypeFromRaw(interaction.raw),
    parentChannelId: threadParentFromRawChannel(interaction.raw),
    memberPending: discordMemberPendingFromRaw(interaction.raw),
  });
}

const discordInteractionChannel = discordChannel({
  route: INTERNAL_DISCORD_ROUTE,
  credentials: { ...discordAppCredentials(), botToken: discordBotTokenForEve },
  turnPolicy: "queue",
  onCommand: async (ctx: DiscordContext, interaction: DiscordCommandInteraction) => {
    const auth = authFromInteraction(interaction);
    if (auth === null) return null;
    try {
      await ctx.discord.startTyping();
    } catch {
    }
    return { auth };
  },
  events: {
    "turn.started": async (_event, ctx) => {
      const channel = ctx.channel;
      (channel.state as unknown as Record<string, unknown>).oeReplyPrincipalId = authPrincipalId({ session: ctx.session });
      await channel.discord.startTyping();
    },
    "content.completed": async (event, ctx) => {
      const channel = ctx.channel;
      const sessionId = ctx?.session?.id;
      const turnId = event.scope?.turnId ?? ctx.session.turn?.id;
      const action = finalMessageActionForTurn(event.data, turnId);
      if (action.kind === "buffer-tool-status") return;
      const repliedThisTurn = consumeRepliedThisTurn(turnId);
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:discord] judged silence (${action.reason}) — nothing posted (channel ${channel.state.channelId ?? "?"})`);
        }
        if (action.kind === "silent" && action.reason === NO_REPLY_SENTINEL_REASON) {
          const p = auditPartitionForState(channel.state);
          if (p) await auditNoReplySentinelObserved(p, sessionId).catch(() => undefined);
        }
        if (action.kind === "silent" && isBareStop(action, repliedThisTurn)) {
          console.warn(
            `[open-everywhere:discord] BARE STOP — turn ended with no reply and no no_reply (channel ${channel.state.channelId ?? "?"}) — this usually means a judgment call went missing, not that one was made.`,
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
            anchor: { channelId: channel.state.channelId ?? null },
            log: (m) => console.warn(`[open-everywhere:discord] ${m} (channel ${channel.state.channelId ?? "?"})`),
          });
        } else {
          console.warn(
            `[open-everywhere:discord] closing prose DROPPED (${action.text.length}c) — nothing posted, and no partition to audit it under (channel ${channel.state.channelId ?? "?"})`,
          );
        }
      }
    },
  },
});

export default withEndsTurnFinalChannel(withDiscordEventsRoute(frontDiscordChannel(discordInteractionChannel)));
