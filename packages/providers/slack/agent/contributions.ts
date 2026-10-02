export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-slack",
  register: "agent/register.js#registerSlackProvider",
  contributions: [
    { kind: "channel", name: "slack", module: "agent/channels/slack.js", summary: "The Slack surface. Wires Slack's webhook → an OpenEverywhere session, and — the point of the \"Slack-binding\" slice — populates the session auth context with the REAL Slack identity (team/channel/user…" },
    { kind: "channel", name: "slack-commands", module: "agent/channels/slack-commands.js", summary: "The Slack SLASH-COMMAND ingestion surface for \"/oe\" — the zero-inference control-plane escape hatch (backlog item 23): pure logic, instant code-rendered responses, NO model turn, so it keeps…" },
    { kind: "channel", name: "slack-setup-page", module: "agent/channels/slack-setup-page.js", summary: "The agent-led Slack setup page (OPE-2231) — `GET`/`POST /setup` create the Slack app from the shipped manifest with one pasted app configuration token, and `GET /setup/callback` takes the OAuth install's bot token. All three 404 until the credential vault is armed AND no install is recorded." },
  ],
} as const;
