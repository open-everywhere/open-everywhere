import { registerOperatorSecretNames } from "@open-everywhere/core/agent/adapter-api-ops.js";

export function registerDiscordOps(): void {
  registerOperatorSecretNames(["DISCORD_BOT_TOKEN", "OE_RELAY_SECRET"]);
}
