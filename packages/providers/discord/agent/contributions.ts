export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-discord",
  register: "agent/register.js#registerDiscordProvider",
  contributions: [
    { kind: "channel", name: "discord", module: "agent/channels/discord.js", summary: "The Discord surface. Wires Discord's HTTP Interactions (slash commands) → an OpenEverywhere session, and — the point of the \"Discord-binding\" slice — populates the session auth context with the REAL…" },
    { kind: "channel", name: "discord-gateway", module: "agent/channels/discord-gateway.js", summary: "The Discord GATEWAY ingestion surface — Milestone 2 of the Discord Gateway feature." },
  ],
} as const;
