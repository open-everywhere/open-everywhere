import type { Routine, DispatchTarget, SessionMode } from "@open-everywhere/core/agent/adapter-api.js";
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
  return {
    channel: discord,
    target: { channelId },
    mode,
    attributes: {
      channel_id: channelId,
      guild_id: storedString(r.target, "guildId") ?? r.surfaceKey.split("/")[1] ?? "",
      ...(channelType ? { channel_type: channelType } : {}),
    },
  };
}
