import {
  discordChannel,
  type DiscordContext,
  type DiscordCommandInteraction,
} from "eve/channels/discord";
import { buildDiscordAuth, threadParentFromRawChannel, discordMemberPendingFromRaw, type OpenEverywhereDiscordAuth } from "./discord-identity.js";
import {
  finalMessageActionForTurn,
  isBareStop,
  consumeRepliedThisTurn,
  postTerminalProse,
  resolvePartition,
  type ChatAuditPartition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { frontDiscordChannel, INTERNAL_DISCORD_ROUTE } from "./discord-front.js";

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
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const repliedThisTurn = consumeRepliedThisTurn();
      if (action.kind !== "post") {
        if (action.kind === "silent" && action.reason !== "empty final message") {
          console.log(`[open-everywhere:discord] judged silence (${action.reason}) — nothing posted (channel ${channel.state.channelId ?? "?"})`);
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
        if (p && channel.state.channelId) {
          await postTerminalProse(
            { platform: "discord", channelId: channel.state.channelId },
            action.text,
            { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface, ...(sessionId ? { sessionId } : {}), route: "terminal" },
          );
        } else {
          await channel.discord.post(action.text);
        }
      }
    },
  },
});

export default frontDiscordChannel(discordInteractionChannel);
