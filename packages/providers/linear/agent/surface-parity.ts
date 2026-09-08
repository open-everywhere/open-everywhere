import type { SurfaceParityDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_SURFACE_PARITY: SurfaceParityDeclaration = {
  "identity-mapper": "supported",
  "capability-manifest": "supported",
  "post-arm": "supported",
  "wake-origin-codec": "supported",
  "read-adapter": "supported",
  "reaction-feedback-ingest": { supported: "the author of the reacted comment costs one GraphQL read — the webhook does not carry it" },
  "ancillary-ops": "supported",
  "ambient-engagement-seam": "supported",

  "addressed-leg": "supported",
  "ambient-leg": { supported: "the ambient supervisor, not the §2.5 engagement registry" },
  "name-drop-mention": { unsupported: "not built yet — the ambient supervisor already reads every comment, so a name-drop match adds no wake" },
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
      "marks the issue row; drops a top-level comment and suppresses a `prompted` agent-session follow-up on the native leg; an unclassified future action is ungated and the divert leg's copy is unpinned; refuses when no row exists",
  },
  post_file: { unsupported: "vendor limit — a Linear comment carries no file-attachment API OE can drive" },
};
