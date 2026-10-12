export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-google-chat",
  register: "agent/register.js#registerGoogleChatProvider",
  contributions: [
    { kind: "channel", name: "google-chat", module: "agent/channels/google-chat.js", summary: "Google Chat — the agent as a Chat app: @mentions in spaces and direct messages in, threaded replies out." },
  ],
} as const;
