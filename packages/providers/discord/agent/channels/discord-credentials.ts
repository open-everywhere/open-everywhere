import { operatorSecretOrUnset } from "@open-everywhere/core/agent/adapter-api.js";

export const DISCORD_BOT_TOKEN_NAME = "DISCORD_BOT_TOKEN";
const OE_RELAY_SECRET_NAME = "OE_RELAY_SECRET";

export async function discordBotToken(): Promise<string | undefined> {
  return await operatorSecretOrUnset(DISCORD_BOT_TOKEN_NAME);
}

export async function discordBotTokenForEve(): Promise<string> {
  const token = await discordBotToken();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required.");
  return token;
}

export async function discordRelaySecret(): Promise<string | undefined> {
  return await operatorSecretOrUnset(OE_RELAY_SECRET_NAME);
}
