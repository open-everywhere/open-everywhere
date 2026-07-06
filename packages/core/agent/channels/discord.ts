import {
  discordChannel,
  type DiscordContext,
  type DiscordCommandInteraction,
} from "eve/channels/discord";
import { buildDiscordAuth, threadParentFromRawChannel, type OpenEverywhereDiscordAuth } from "./discord-identity.js";
import { finalMessageAction } from "./slack-events.js";
import { frontDiscordChannel, INTERNAL_DISCORD_ROUTE } from "./discord-front.js";

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
    "message.completed": async (data, channel) => {
      const action = finalMessageAction(data.finishReason, data.message);
      if (action.kind !== "post") {
        if (action.kind === "silent" && data.message) {
          console.log(`[open-everywhere:discord] judged silence (NO_REPLY) — nothing posted (channel ${channel.state.channelId ?? "?"})`);
        }
        return;
      }
      await channel.discord.post(action.text);
    },
  },
});

export default frontDiscordChannel(discordInteractionChannel);
