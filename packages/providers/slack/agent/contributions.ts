export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-slack",
  register: "agent/register.js#registerSlackProvider",
  contributions: [
    { kind: "channel", name: "slack", module: "agent/channels/slack.js", summary: "The Slack surface. Wires Slack's webhook → an OpenEverywhere session, and — the point of the \"Slack-binding\" slice — populates the session auth context with the REAL Slack identity (team/channel/user…" },
    { kind: "channel", name: "slack-commands", module: "agent/channels/slack-commands.js", summary: "The Slack SLASH-COMMAND ingestion surface for \"/oe\" — the zero-inference control-plane escape hatch (backlog item 23): pure logic, instant code-rendered responses, NO model turn, so it keeps…" },
  ],
} as const;
