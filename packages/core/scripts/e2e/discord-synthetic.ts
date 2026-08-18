import { createHmac } from "node:crypto";

export const SYNTHETIC_DISCORD_GATEWAY_ROUTE = "/eve/v1/discord-gateway";
export const DISCORD_RELAY_SIGNATURE_HEADER = "x-oe-relay-signature";

export function signDiscordRelayRequest(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export function buildDiscordDmRelayEnvelope(input: { readonly text: string; readonly channelId: string; readonly userId: string; readonly messageId?: string }): Record<string, unknown> {
  return {
    source: "discord-gateway-relay",
    message: {
      id: input.messageId ?? `e2edm${Date.now()}`,
      content: input.text,
      channelId: input.channelId,
      channelType: "1",
      author: { id: input.userId, username: "e2e-dm-fixture", bot: false },
      mentionsBot: false,
    },
  };
}

export function buildDiscordGuildMentionRelayEnvelope(input: {
  readonly text: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly botId?: string;
  readonly botName?: string;
  readonly messageId?: string;
}): Record<string, unknown> {
  return {
    source: "discord-gateway-relay",
    message: {
      id: input.messageId ?? `e2ewake${Date.now()}`,
      content: input.text,
      channelId: input.channelId,
      channelType: "0",
      guildId: input.guildId,
      author: { id: input.userId, username: "e2e-wake-fixture", bot: false },
      mentionsBot: true,
      ...(input.botId || input.botName ? { bot: { id: input.botId, name: input.botName } } : {}),
    },
  };
}

export function buildDiscordGuildAmbientRelayEnvelope(input: {
  readonly text: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly messageId?: string;
}): Record<string, unknown> {
  return {
    source: "discord-gateway-relay",
    message: {
      id: input.messageId ?? `e2eambient${Date.now()}`,
      content: input.text,
      channelId: input.channelId,
      channelType: "0",
      guildId: input.guildId,
      author: { id: input.userId, username: "e2e-wake-fixture", bot: false },
      mentionsBot: false,
    },
  };
}

