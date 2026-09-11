import { declareSurfaceCommandScope } from "@open-everywhere/core/agent/channels/command-registration.js";

export const DISCORD_COMMAND_GUILDS: readonly string[] = [
  "1300000000000000100",
];

declareSurfaceCommandScope("discord", { scopes: DISCORD_COMMAND_GUILDS });
