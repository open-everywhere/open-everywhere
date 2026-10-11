import type {
  Routine,
  DispatchTarget,
  DeclaredTargetResolution,
  DeclaredTargetSpec,
  SessionMode,
  UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/adapter-api.js";
import discord from "./discord.js";
import { discordOpenDmChannel } from "./discord-post.js";
import { fetchDiscordInfo } from "./discord-channel-info.js";

function storedString(t: Routine["target"], key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function resolveDiscordTarget(r: Routine): DispatchTarget | null {
  const channelId = storedString(r.target, "channelId");
  if (!channelId) return null;
  const channelType = storedString(r.target, "channelType");
  const mode: SessionMode = channelType === "1" ? "dm" : channelType === "3" ? "mpim" : "channel";
  const storedGuildId = storedString(r.target, "guildId");
  const guildId = storedGuildId ?? r.surfaceKey.split("/")[1] ?? "";
  const guildEvidence = storedGuildId !== undefined || channelType !== undefined;
  const origin: UnifiedWakeOrigin | undefined =
    mode === "dm" || mode === "mpim"
      ? { platform: "discord", channelId, dm: true }
      : guildEvidence
        ? { platform: "discord", channelId, guildId }
        : undefined;
  return {
    channel: discord,
    target: { channelId },
    mode,
    attributes: {
      channel_id: channelId,
      guild_id: guildId,
      ...(channelType ? { channel_type: channelType } : {}),
    },
    ...(origin !== undefined ? { origin } : {}),
  };
}

export function discordReportTargetFor(surfaceKey: string): Readonly<Record<string, unknown>> | null {
  const segs = surfaceKey.split("/");
  const channelId = segs.length === 3 && segs[0] === "discord" ? segs[2] : undefined;
  return channelId && channelId.length > 0 ? { channelId } : null;
}

export async function resolveDiscordDeclaredTarget(
  spec: DeclaredTargetSpec,
  deps: {
    readonly openDm?: (userId: string) => Promise<string>;
    readonly channelGuild?: (channelId: string) => Promise<string | undefined>;
  } = {},
): Promise<DeclaredTargetResolution> {
  if (spec.kind === "room") {
    const guildId = await (deps.channelGuild ?? (async (id: string) => (await fetchDiscordInfo("channels", id))?.guildId))(spec.surface).catch(() => undefined);
    if (guildId !== spec.workspace) {
      return {
        ok: false,
        reason:
          guildId === undefined
            ? `Discord did not confirm that channel ${spec.surface} is in guild ${spec.workspace} (the channel lookup failed, or the bot cannot see the channel). Check DISCORD_BOT_TOKEN and that the bot is in that guild.`
            : `channel ${spec.surface} is in guild ${guildId}, not guild ${spec.workspace}. Correct the target to "discord/${guildId}/${spec.surface}".`,
      };
    }
    return { ok: true, facts: { surfaceKey: `discord/${spec.workspace}/${spec.surface}`, target: { channelId: spec.surface, guildId: spec.workspace } } };
  }
  let channelId: string;
  try {
    channelId = await (deps.openDm ?? discordOpenDmChannel)(spec.principalId);
  } catch (err) {
    return {
      ok: false,
      reason:
        `Discord could not open a DM with user ${spec.principalId} (${err instanceof Error ? err.message : String(err)}). ` +
        `The person must share a server with the bot and allow direct messages from server members.`,
    };
  }
  return { ok: true, facts: { surfaceKey: `discord/${spec.principalId}/${channelId}`, target: { channelId, channelType: "1" } } };
}
