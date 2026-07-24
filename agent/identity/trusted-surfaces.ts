import { registerTrustedSurfaces } from "@open-everywhere/core/agent/identity/trust.js";
import { telegramWorkspaceKey } from "@open-everywhere/provider-telegram/agent/channels/telegram-identity.js";

export const trustedSurfaces: readonly string[] = [
  telegramWorkspaceKey("-1003987814478"),

  "discord/1300000000000000100",

  "discord/300000000000000104",

  "teams/7e5a0000-0000-4000-8000-000000000001/19-0exampleTeamsChannel00000000000000001-thread.tacv2",

  "linear/1a000000-0000-4000-8000-000000000001",
  "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011",
  "notion/40000000-0000-4000-8000-000000000001",
  "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101",

  "github/example-owner",
  "github/example-owner/e2e-scratch",
];

registerTrustedSurfaces(trustedSurfaces);
