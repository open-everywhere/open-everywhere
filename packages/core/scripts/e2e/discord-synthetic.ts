import { createHmac } from "node:crypto";
import type { SyntheticDiscordDmConfig } from "./env.js";

export const SYNTHETIC_DISCORD_GATEWAY_ROUTE = "/eve/v1/discord-gateway";
export const DISCORD_RELAY_SIGNATURE_HEADER = "x-oe-relay-signature";

export interface SyntheticResult {
  readonly status: number;
  readonly body: string;
  readonly label: string;
}

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

export class SyntheticDiscordDm {
  constructor(private readonly cfg: SyntheticDiscordDmConfig) {}

  async message(input: { text: string; messageId?: string }): Promise<SyntheticResult> {
    const rawBody = JSON.stringify(
      buildDiscordDmRelayEnvelope({ text: input.text, channelId: this.cfg.dmChannel, userId: this.cfg.dmUserId, messageId: input.messageId }),
    );
    const res = await fetch(`${this.cfg.targetUrl}${SYNTHETIC_DISCORD_GATEWAY_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DISCORD_RELAY_SIGNATURE_HEADER]: signDiscordRelayRequest(rawBody, this.cfg.relaySecret),
      },
      body: rawBody,
    });
    return { status: res.status, body: await res.text(), label: "synthetic discord DM" };
  }
}
