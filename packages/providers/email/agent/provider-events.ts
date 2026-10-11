import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const EMAIL_PROVIDER_EVENTS: ProviderEventDeclaration = {
  doc: "https://docs.agentmail.to/api-reference/webhooks/events/message-received",
  events: [
    { event: "message.received", routing: "none", match: [], scope: [], note: "an inbound mail the vendor accepted — the email front's conversation leg, through the gate, never a routine" },
    { event: "message.received.unauthenticated", routing: "none", match: [], scope: [], note: "an inbound mail that arrived without authentication headers, so the vendor could not check it — refused by the gate (`unauthenticated`)" },
    { event: "message.received.spam", routing: "none", match: [], scope: [], note: "an inbound mail the vendor flagged as spam — refused by the gate (`flagged`)" },
    { event: "message.received.blocked", routing: "none", match: [], scope: [], note: "an inbound mail the vendor blocked — refused by the gate (`flagged`)" },
  ],
};
