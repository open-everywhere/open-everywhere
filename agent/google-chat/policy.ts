import { DEFAULT_GOOGLE_CHAT_POLICY, registerGoogleChatPolicy, type GoogleChatPolicy } from "@open-everywhere/provider-google-chat/agent/policy.js";

const googleChatPolicy: GoogleChatPolicy = {
  ...DEFAULT_GOOGLE_CHAT_POLICY,
  enabled: false,
  audience: null,
  workspace: "workspace",
  internalDomainIds: [
  ],
  directMessages: true,
};

registerGoogleChatPolicy(googleChatPolicy);
