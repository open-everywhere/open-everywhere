import type { SurfaceParityDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const TEAMS_SURFACE_PARITY: SurfaceParityDeclaration = {
  "identity-mapper": "supported",
  "capability-manifest": "supported",
  "post-arm": "supported",
  "wake-origin-codec": "supported",
  "read-adapter": "supported",
  "reaction-feedback-ingest": { supported: "the vendor fence is the guarantee — Teams delivers the event only for the agent's own messages, and carries no author to compare" },
  "ancillary-ops": "supported",
  "ambient-engagement-seam": {
    supported: "the seam is wired; plain follow-ups reach it only where the tenant consented to `ChannelMessage.Read.Group` / `ChatMessage.Read.Chat`, which no API can probe",
  },

  "addressed-leg": "supported",
  "ambient-leg": { supported: "the single-window front's Leg A, not the §2.5 engagement registry" },
  "name-drop-mention": { unsupported: "not built yet — Leg A wakes on an @mention or room chatter, never on a name-drop match" },
  "message-edit-wake": { unsupported: "an edit arrives as a `messageUpdate` activity, and the inbound parser admits `message`, `invoke` and `conversationUpdate` only" },
  threads: "supported",
  rooms: "supported",
  dm: "supported",
  mpim: "supported",

  reply: "supported",
  edit_reply: "supported",
  react: { unsupported: "vendor limit — Graph's outbound reaction route refuses an application-only identity" },
  no_reply: "supported",
  read_channel: "supported",
  read_thread: "supported",
  search: { unsupported: "no work-search adapter — Teams is a chat surface, not a work corpus (§4.7)" },
  post_message: "supported",
  dm_person: "supported",
  set_dm_delivery: "supported",
  stop: { supported: "the `angry` reaction — Teams' six fixed values carry no ✋" },
  ack_stop_glyph: { unsupported: "vendor limit — Teams' fixed six-value reaction vocabulary has no raised hand" },
  ack_cancel_note: "supported",
  stand_down: { supported: "marks the conversation row; refuses on a 1:1 and when no row exists" },
  post_file: { unsupported: "not built yet — no Teams attachment transport is wired (§7.3)" },
};
