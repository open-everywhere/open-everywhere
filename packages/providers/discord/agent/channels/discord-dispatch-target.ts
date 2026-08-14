import type { Routine, DispatchTarget, SessionMode, UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
import discord from "./discord.js";

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
