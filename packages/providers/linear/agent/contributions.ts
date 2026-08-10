export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-linear",
  register: "agent/register.js#registerLinearProvider",
  contributions: [
    { kind: "tool", name: "read_linear_issue", module: "agent/tools/read_linear_issue.js", summary: "Read a Linear issue — its DESCRIPTION (body) and comment thread." },

    { kind: "channel", name: "linear", module: "agent/channels/linear.js", summary: "The Linear surface — the SECOND platform, proving the identity seam generalises beyond Slack." },
  ],
} as const;
