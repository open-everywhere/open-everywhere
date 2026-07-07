import { registerTrustedSurfaces } from "@open-everywhere/core/agent/identity/trust.js";
import { telegramWorkspaceKey } from "@open-everywhere/core/agent/channels/telegram-identity.js";

export const trustedSurfaces: readonly string[] = [
  telegramWorkspaceKey("-1003987814478"),

  "discord/1300000000000000100",

  "discord/300000000000000104",
];

registerTrustedSurfaces(trustedSurfaces);
