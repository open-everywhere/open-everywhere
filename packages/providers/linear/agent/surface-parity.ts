import type { SurfaceParityDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_SURFACE_PARITY: SurfaceParityDeclaration = {
  "identity-mapper": "supported",
  "capability-manifest": "supported",
  "post-arm": "supported",
  "wake-origin-codec": "supported",
  "origin-placement-carry": {
    unsupported:
      "the placement is INSIDE the conversation identity: `parentId` is the thread-root comment a reply nests under and it is exactly what `threadRef` keys on. `agentSessionId` is not a second axis — it selects the reply ROUTE, so carrying it would deliver an answer into a session that asked nothing",
  },
  "read-adapter": "supported",
  "reaction-feedback-ingest": { supported: "the author of the reacted comment costs one GraphQL read — the webhook does not carry it" },
  "ancillary-ops": "supported",
  "ambient-engagement-seam": "supported",
  "engaged-row-promotion": "supported",
  "owned-thread-ingress": "supported",

  "addressed-leg": "supported",
  "ambient-leg": { supported: "the ambient supervisor, not the §2.5 engagement registry" },
  "seat-catch-up": "supported",
  "seat-context-admission": "supported",
  "approval-card": { unsupported: "an issue comment carries no component plane, so there is no button to render and no route for a tap. A governed act that takes the venue walk is redirected to a card-capable room in the SAME domain, or refused when the domain holds none. The paths OUTSIDE that walk do not: the spend checkpoint (spend/checkpoint.ts `requireSessionContinuation`) fails OPEN here and records the crossing in an audit row instead" },
  "judge-lift-notice": "supported",
  "name-drop-mention": { unsupported: "not built yet — the ambient supervisor already reads every comment, so a name-drop match adds no wake" },
  "message-edit-wake": { unsupported: "the ambient leg admits `Comment` with `action: \"create\"` only — an edit returns null before the classifier" },
  threads: "supported",
  rooms: { unsupported: "no standing container — every Linear container is one issue" },
  dm: { unsupported: "no DM plane — Linear carries no person-to-person message channel" },
  mpim: { unsupported: "no DM plane — Linear carries no person-to-person message channel" },

  reply: "supported",
  edit_reply: { supported: "the ambient route only — Linear's schema has no mutation that updates an Agent Activity" },
  react: "supported",
  no_reply: { supported: "posts the host line" },
  read_channel: "supported",
  read_thread: "supported",
  search: "supported",
  post_message: { unsupported: "not built yet — no `channel` row in `access/resource-grant.ts` — OPE-1507" },
  dm_person: { unsupported: "no DM plane — Linear carries no person-to-person message channel (§4.7.2)" },
  set_dm_delivery: { unsupported: "no DM plane — the verb mounts only inside a 1:1 DM (§4.7.2)" },
  stop: { supported: "the ✋ reaction" },
  ack_stop_glyph: "supported",
  ack_cancel_note: "supported",
  stand_down: {
    supported:
      "marks the issue row; drops a top-level comment and suppresses a `prompted` agent-session follow-up on the native leg, while a `prompted` comment that @mentions the app lifts the stop; an unreadable comment body suppresses, an unclassified future action is ungated and the divert leg's copy is unpinned; refuses when no row exists",
  },
  post_file: { unsupported: "vendor limit — a Linear comment carries no file-attachment API OE can drive" },
};
