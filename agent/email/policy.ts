import { DEFAULT_EMAIL_POLICY, registerEmailPolicy, type EmailPolicy } from "@open-everywhere/core/agent/email/policy.js";
import { EMAIL_SENDERS } from "./senders.js";

const emailPolicy: EmailPolicy = {
  ...DEFAULT_EMAIL_POLICY,
  enabled: false,
  transport: "agentmail",
  orgDomains: [
  ],
  inboxes: [
  ],
};

registerEmailPolicy(emailPolicy, EMAIL_SENDERS);
