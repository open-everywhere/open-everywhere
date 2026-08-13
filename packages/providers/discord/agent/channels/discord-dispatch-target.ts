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
  const guildId = storedString(r.target, "guildId") ?? r.surfaceKey.split("/")[1] ?? "";
  const origin: UnifiedWakeOrigin = mode === "dm" || mode === "mpim" ? { platform: "discord", channelId, dm: true } : { platform: "discord", channelId, guildId };
  return {
    channel: discord,
    target: { channelId },
    mode,
    attributes: {
      channel_id: channelId,
      guild_id: guildId,
      ...(channelType ? { channel_type: channelType } : {}),
    },
    origin,
  };
}

export function discordReportTargetFor(surfaceKey: string): Readonly<Record<string, unknown>> | null {
  const segs = surfaceKey.split("/");
  const channelId = segs.length === 3 && segs[0] === "discord" ? segs[2] : undefined;
  return channelId && channelId.length > 0 ? { channelId } : null;
}
