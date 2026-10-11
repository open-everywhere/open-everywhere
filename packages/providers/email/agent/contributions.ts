export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-email",
  register: "agent/register.js#registerEmailProvider",
  contributions: [
    { kind: "channel", name: "email", module: "agent/channels/email.js", summary: "Email — the agent's own inboxes on the org's domains: allowed senders in, threaded replies out." },
  ],
} as const;
