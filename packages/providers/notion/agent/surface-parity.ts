import type { SurfaceParityDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const NOTION_SURFACE_PARITY: SurfaceParityDeclaration = {
  "identity-mapper": "supported",
  "capability-manifest": "supported",
  "post-arm": "supported",
  "wake-origin-codec": "supported",
  "unified-action-plane": {
    unsupported:
      "a Notion discussion comment is rich text with no component plane — the API offers no tappable button an integration may render into one, so there is nothing for a tap route to receive. The bridged approval posts as prose, which the question bridge already renders complete",
  },
  "origin-placement-carry": {
    unsupported:
      "the placement is INSIDE the conversation identity: a reply targets `discussionId`, which is exactly what `threadRef` keys on, so two origins that pass the conversation test name the same discussion and cannot disagree about placement",
  },
  "read-adapter": "supported",
  "reaction-feedback-ingest": { unsupported: "vendor limit — Notion pushes no reaction event and its comment object exposes no reaction resource, so there is nothing to receive and nothing to poll" },
  "ancillary-ops": "supported",
  "ambient-engagement-seam": "supported",
  "engaged-row-promotion": "supported",
  "owned-thread-ingress": "supported",

  "addressed-leg": { supported: "the `direct` wake — a name-drop or structured mention, not a platform @mention" },
  "ambient-leg": { supported: "the ambient supervisor, not the §2.5 engagement registry" },
  "seat-catch-up": "supported",
  "seat-context-admission": { unsupported: "the hydration fills no context-line slot — the seat's room context is the catch-up read, which core already admits" },
  "approval-card": { unsupported: "a page comment carries no component plane, so there is no button to render and no route for a tap. A governed act that takes the venue walk is redirected to a card-capable room in the SAME domain, or refused when the domain holds none. The paths OUTSIDE that walk do not: the spend checkpoint (spend/checkpoint.ts `requireSessionContinuation`) fails OPEN here and records the crossing in an audit row instead" },
  "judge-lift-notice": "supported",
  "name-drop-mention": "supported",
  "message-edit-wake": { unsupported: "the webhook admits `comment.created` only — `comment.updated` answers `ignored` at step 4" },
  threads: { supported: "thread-first — every wake arrives scoped to one discussion" },
  rooms: { unsupported: "no standing container — a discussion is minted by its first comment and anchored to one block" },
  dm: { unsupported: "no DM plane — Notion carries no person-to-person message channel" },
  mpim: { unsupported: "no DM plane — Notion carries no person-to-person message channel" },

  reply: "supported",
  edit_reply: "supported",
  react: { unsupported: "vendor limit — the Notion comment API exposes no reaction write" },
  no_reply: "supported",
  read_channel: "supported",
  read_thread: "supported",
  search: "supported",
  post_message: { unsupported: "not built yet — no `channel` row in `access/resource-grant.ts` — OPE-1507" },
  dm_person: { unsupported: "no DM plane — Notion carries no person-to-person message channel (§4.7.2)" },
  set_dm_delivery: { unsupported: "no DM plane — the verb mounts only inside a 1:1 DM (§4.7.2)" },
  stop: { supported: "a comment whose entire body is `stop` — Notion pushes no reaction webhook" },
  ack_stop_glyph: { unsupported: "vendor limit — the Notion comment API exposes no reaction write, so there is no glyph to place" },
  ack_cancel_note: "supported",
  stand_down: { supported: "marks the page row; refuses when no row exists" },
  post_file: { supported: "at most 3 files per post — a Notion comment's own vendor cap" },
};
