export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-github",
  register: "agent/register.js#registerGithubProvider",
  contributions: [
    { kind: "channel", name: "github", module: "agent/channels/github.js", summary: "GitHub — a PROPER conversational surface (not just an event pipe)." },
  ],
} as const;
