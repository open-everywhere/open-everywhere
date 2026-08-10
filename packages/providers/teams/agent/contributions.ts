export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-teams",
  register: "agent/register.js#registerTeamsProvider",
  contributions: [
    { kind: "channel", name: "teams", module: "agent/channels/teams.js", summary: "The Microsoft Teams surface — the THIRD platform on the identity seam (after Slack and Linear)." },
  ],
} as const;
