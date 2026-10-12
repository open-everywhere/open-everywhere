import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const GOOGLE_CHAT_PROVIDER_EVENTS: ProviderEventDeclaration = {
  doc: "https://developers.google.com/workspace/chat/receive-respond-interactions",
  events: [
    { event: "MESSAGE", routing: "none", match: [], scope: [], note: "an @mention in a space or a direct message — the front's conversation leg, through the gate, never a routine" },
    { event: "ADDED_TO_SPACE", routing: "none", match: [], scope: [], note: "the app was added to a space — acknowledged and dropped; a space wakes nothing until a domain's `reach` lists it" },
    { event: "REMOVED_FROM_SPACE", routing: "none", match: [], scope: [], note: "the app was removed from a space — acknowledged and dropped" },
    { event: "CARD_CLICKED", routing: "none", match: [], scope: [], note: "a card button tap — acknowledged and dropped; the surface posts no card yet" },
  ],
};
