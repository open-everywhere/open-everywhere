import { registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api-ops.js";

export function registerDiscordOps(): void {
  registerSurfaceCredentialProbe("discord", () => Boolean(process.env.DISCORD_BOT_TOKEN));
}
