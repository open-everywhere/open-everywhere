export interface AuditActionDeclaration {
  readonly action: string;
  readonly fields: readonly string[];
  readonly proves: string;
  readonly notExercised?: string;
}

export interface TemplatedAuditActionDeclaration {
  readonly template: string;
  readonly platforms: readonly string[];
  readonly fields: readonly string[];
  readonly proves: string;
  readonly consequential: boolean;
  readonly notExercised?: string;
}

export interface DynamicActionSite {
  readonly file: string;
  readonly expression: string;
  readonly emits: readonly string[];
}

export const CONSEQUENTIAL_AUDIT_ACTIONS: readonly AuditActionDeclaration[] = [
  {
    action: "admin.identity.suspend_link_set",
    fields: ["linkSetId"],
    proves: "an operator suspended a link set, so its members stop resolving to one principal",
    notExercised:
      "no e2e leg drives the control-plane identity writes: they need a second REAL native account per surface plus an operator control token, and the pack provisions neither. Driving them needs an `E2E_CONTROL_WRITE_TOKEN` fixture and a disposable link set.",
  },
  {
    action: "admin.identity.reactivate_link_set",
    fields: ["linkSetId"],
    proves: "a suspended link set was put back into service, and by whom",
    notExercised: "pairs with admin.identity.suspend_link_set — same missing control-write fixture.",
  },
  {
    action: "admin.identity.revoke_link_set",
    fields: ["linkSetId", "note"],
    proves: "a link set was revoked for good, with the operator's stated reason",
    notExercised: "pairs with admin.identity.suspend_link_set — same missing control-write fixture.",
  },
  {
    action: "admin.identity.purge_link_set_credentials",
    fields: ["linkSetId", "credentialsPurged"],
    proves: "how many stored credentials a revocation actually destroyed — the count an incident review needs",
    notExercised: "pairs with admin.identity.suspend_link_set — same missing control-write fixture.",
  },
  {
    action: "admin.identity.directory_sync_now",
    fields: ["provider", "policy", "planned", "applied", "warnings"],
    proves: "an operator forced a directory sync, and what it changed versus what it planned",
    notExercised: "needs a wired directory provider on the e2e deployment; the pack has none.",
  },
  {
    action: "admin.identity.directory_groups_plan",
    fields: ["provider", "people", "planned", "warnings"],
    proves: "a group-mapping plan was computed, over how many people, without applying it",
    notExercised: "needs a wired directory provider on the e2e deployment; the pack has none.",
  },
  {
    action: "admin.identity.directory_groups_pr",
    fields: ["provider", "people", "planned", "warnings", "outcome"],
    proves: "a group-mapping change left the deployment as a pull request rather than a silent write",
    notExercised: "needs a wired directory provider on the e2e deployment; the pack has none.",
  },
  {
    action: "identity.directory.sync",
    fields: ["provider"],
    proves: "a scheduled directory sync ran, so a stale membership set can be told from a dead sync",
    notExercised: "needs a wired directory provider on the e2e deployment; the pack has none.",
  },

  {
    action: "identity.link.challenge_issued",
    fields: ["challengeId"],
    proves: "a link challenge was issued, so a claim can be tied to the ask that invited it",
  },
  {
    action: "identity.link.challenge_claimed",
    fields: ["challengeId"],
    proves: "the second account claimed the challenge — the first half of proving one person holds both",
  },
  {
    action: "identity.link.consent_click",
    fields: ["challengeId", "verdict", "outcome", "clicker"],
    proves: "the SECOND account consented to a link, and which native id clicked — the row that makes a link non-repudiable",    notExercised:
      "RED-until-leg: S-LINK-SLACK — it drives mint → claim → confirmed and stops before the SECOND account's consent tap, which is the row that makes a link non-repudiable. Extend that leg's ratify arm to read this row back.",
   },
  { action: "identity.link.consented", fields: ["challengeId"], proves: "consent was recorded against the challenge", notExercised: "RED-until-leg: S-LINK-SLACK — the consent half of the ratify arm, beside identity.link.consent_click." },
  { action: "identity.link.confirmed", fields: [], proves: "the link took effect, and the two accounts now resolve to one principal" },
  { action: "identity.link.denied", fields: [], proves: "a link was refused — the row a later linked reach must not exist beside", notExercised: "RED-until-leg: S-LINK-SLACK — the leg drives only the ACCEPT path; a refused link needs the second account to decline, which the same two-account fixture can drive." },
  { action: "identity.link.set_created", fields: [], proves: "a new link set exists, naming the principal it creates", notExercised: "RED-until-leg: S-LINK-SLACK — the leg asserts identity.link.confirmed and never reads the set the confirmation creates." },
  { action: "identity.link.unlinked", fields: [], proves: "an account left a link set, narrowing what the principal reaches", notExercised: "RED-until-leg: lane A run 2 — an identity-link TEARDOWN cell. No leg removes an account from a set, so nothing exercises the narrowing half of the plane." },
  { action: "identity.link.revoked", fields: [], proves: "a link was revoked rather than lapsing", notExercised: "RED-until-leg: lane A run 2 — the identity-link teardown cell, beside identity.link.unlinked." },
  {
    action: "identity.link.credentials_purged",
    fields: [],
    proves: "the credentials a revoked link had reached with were destroyed — the row that closes the exposure",    notExercised:
      "RED-until-leg: lane A run 2 — the identity-link teardown cell. This is the row that closes the exposure a revoked link leaves, so the teardown cell is not optional.",
   },
  {
    action: "identity.link.suggested",
    fields: [],
    proves: "the agent proposed a link nobody had asked for, so an unsolicited suggestion is visible",
    notExercised: "the agent proposes a link on its own initiative; no leg can provoke that deterministically.",
  },
  {
    action: "identity.link.claim_unaddressed",
    fields: [],
    proves: "a claim arrived with nowhere to land — a linking attempt that failed silently would otherwise leave no trace",
    notExercised: "a failure path — a claim arriving with nowhere to land, which the pack cannot stage.",
  },
  {
    action: "identity.link.code_back_undeliverable",
    fields: [],
    proves: "the link code could not be returned to the claimant, so a stalled link has a cause",
    notExercised: "a failure path — the link code cannot be returned. The pack cannot make a delivery fail on demand.",
  },
  {
    action: "identity.link.notice_undeliverable",
    fields: [],
    proves: "the link notice never reached its member — a person whose identity changed without being told",
    notExercised: "a failure path — the pack cannot make a notice delivery fail on demand.",
  },

  {
    action: "routine.grant",
    fields: ["id", "grantedBy", "kinds", "generation", "declared"],
    proves: "which approval kinds a routine may now take without asking again, on whose click, at which generation",    notExercised:
      "RED-until-leg: lane A run 2 — a routine-PERMISSION cell. The offline tier pins the arming (test:routine-permission-card); no e2e leg arms a standing grant on a real routine.",
   },
  {
    action: "routine.grants_revoked",
    fields: ["id", "revokedBy", "count", "rows", "permissions"],
    proves: "a routine's standing permissions were withdrawn, and how many rows that actually removed",    notExercised:
      "RED-until-leg: lane A run 2 — the routine-permission cell's revoke arm.",
   },
  {
    action: "routine.permission_granted",
    fields: ["id"],
    proves: "a single routine permission was armed by a human decision",    notExercised:
      "RED-until-leg: lane A run 2 — the routine-permission cell's per-permission grant row.",
   },
  {
    action: "routine.permission_declined",
    fields: ["id"],
    proves: "a human refused a routine permission — the negative half of the record",    notExercised:
      "RED-until-leg: lane A run 2 — the routine-permission cell's refusal row, the negative half nothing drives.",
   },
  {
    action: "routine.permission_declined_stale",
    fields: ["id"],
    proves: "a permission card was answered after its generation moved on, so the answer armed nothing",    notExercised:
      "RED-until-leg: lane A run 2 — the routine-permission cell's stale-generation arm; it needs a card answered after its generation moved on.",
   },
  {
    action: "routine.permission_never_lifts",
    fields: ["id", "declaration", "generation", "reason"],
    proves: "a declared permission this deployment's bundle puts out of reach was named rather than dropped in silence",
    notExercised: "needs a routine declaring a permission THIS deployment's bundle puts out of reach; no e2e fixture declares one.",
  },

  {
    action: "thread_seat.spawned",
    fields: ["seatId", "windowId", "channelKey", "threadKey", "wakeId", "parentWakeId", "parentSessionId"],
    proves: "a seat was opened in a named conversation, joined to the wake and parent session that opened it",
  },
  {
    action: "thread_seat.messaged",
    fields: ["channelKey", "threadKey", "seatId", "delivered", "chars", "wakeId", "sessionId"],
    proves: "the seat spoke into its conversation, and whether the delivery landed",    notExercised:
      "RED-until-leg: J-SUP — the pack spawns seats (thread_seat.spawned is read by window-gate.ts) and asserts nothing about what they SAY. Extend the supervisor journey to read the seat's own message row.",
   },
  {
    action: "thread_seat.completed",
    fields: ["channelKey", "threadKey", "cleared", "reportDelivered", "wakeId", "sessionId"],
    proves: "the seat closed, and whether its report reached the parent — a seat that ends without one is a lost errand",    notExercised:
      "RED-until-leg: J-SUP — beside thread_seat.messaged. A seat that ends without a delivered report is a lost errand, and no leg would notice.",
   },

  {
    action: "discord.external_policy_suppressed",
    fields: ["verdict"],
    proves: "Discord withheld a reply on the external-policy verdict rather than answering an outsider",
    notExercised: "needs a message from OUTSIDE the org on that surface; the pack drives only its own vouched fixtures.",
  },
  {
    action: "github.external_policy_suppressed",
    fields: ["verdict"],
    proves: "GitHub withheld a reply on the external-policy verdict rather than answering an outsider",
    notExercised: "needs a message from OUTSIDE the org on that surface; the pack drives only its own vouched fixtures.",
  },
  {
    action: "linear.external_policy_suppressed",
    fields: ["verdict"],
    proves: "Linear withheld a reply on the external-policy verdict rather than answering an outsider",
    notExercised: "needs a message from OUTSIDE the org on that surface; the pack drives only its own vouched fixtures.",
  },
  {
    action: "teams.external_policy_suppressed",
    fields: ["verdict"],
    proves: "Teams withheld a reply on the external-policy verdict rather than answering an outsider",
    notExercised: "needs a message from OUTSIDE the org on that surface; the pack drives only its own vouched fixtures.",
  },
  {
    action: "slack.external_policy_suppressed",
    fields: ["verdict", "route", "channelId"],
    proves: "Slack withheld a reply on the external-policy verdict, naming the route that decided it",
    notExercised: "needs a message from OUTSIDE the org on that surface; the pack drives only its own vouched fixtures.",
  },

  {
    action: "grant.card_click",
    fields: ["askId", "clicker", "answer", "outcome"],
    proves: "a human answered a credential-grant card, and what the click actually settled",    notExercised:
      "RED-until-leg: S-DISCORD-GRANT phase 2 — the human tap the harness cannot forge. The leg already records what the tap would unlock; this is the row it would assert.",
   },
  { action: "grant.asked", fields: ["askId"], proves: "the agent asked for a credential grant rather than assuming one" },
  { action: "grant.granted", fields: ["askId"], proves: "a grant was given, so later reaches are attributable to that consent" },
  { action: "grant.declined", fields: ["askId"], proves: "a grant was refused — the row a later reach must not exist beside", notExercised: "RED-until-leg: S-DISCORD-GRANT — the leg drives the ask and the grant; a DECLINED card needs the same human tap answering no." },
  { action: "grant.expired", fields: ["askId"], proves: "a grant lapsed rather than being revoked, which is a different fact", notExercised: "a grant must LAPSE rather than be revoked, which costs its full lifetime in wall clock." },
  { action: "grant.revoked", fields: ["askId"], proves: "a grant was withdrawn by a person", notExercised: "needs an operator revocation through the control plane; the pack holds a read token only." },
  { action: "grant.refused", fields: [], proves: "the plane refused to use a grant it holds, and why" },
  { action: "grant.used", fields: [], proves: "a held grant was actually spent on a reach" },
  {
    action: "grant.undisclosed",
    fields: [],
    proves: "the agent reached with a grant it had not disclosed — the row that makes an undisclosed reach visible",    notExercised:
      "RED-until-leg: S-DISCORD-GRANT — the undisclosed-reach row. It fires only when the agent reaches with a grant it has not disclosed, which no leg stages.",
   },
  { action: "grant.notified", fields: [], proves: "the grant's owner was told their credential was used" },

  {
    action: "connector.own_account_ask",
    fields: ["askRecognised", "connector", "outcome", "requiredIdentity", "stamped"],
    proves: "a member asked the agent to act with their OWN account, recorded where the ask was recognised — so a turn that honestly refuses without reading still leaves a row",
  },
  {
    action: "connector.acting_identity",
    fields: ["askRecognised", "connector", "identity", "reason", "refused", "requiredIdentity", "tool"],
    proves: "which credential identity one gated connector read acted under, and — on `refused: true` — that an own-account ask was not silently answered on the team integration",
  },
  {
    action: "connector.credential_bound",
    fields: ["connector", "rebound", "subject"],
    proves: "a consent completion BOUND a credential — which connector, for the app row or one person's, and whether it replaced an existing row (the silent-rebind case)",
    notExercised:
      "no e2e leg completes a real provider consent: the callback needs a vendor-issued `code` against a live pending row, which no deterministic pack can mint. Driving it would take a stub authorization server the pack owns.",
  },

  { action: "docs.read", fields: ["path"], proves: "which document the agent actually read", notExercised: "RED-until-leg: lane A run 2 — a read_docs cell. No leg asks the agent to read the deployment's own manual, so none of the three docs.* rows is exercised." },
  { action: "docs.index", fields: ["count"], proves: "the agent listed the doc index, and how large it was", notExercised: "RED-until-leg: lane A run 2 — the read_docs cell's index arm." },
  { action: "docs.refused", fields: ["requested"], proves: "a doc read was refused, naming what was asked for", notExercised: "RED-until-leg: lane A run 2 — the read_docs cell's refusal arm." },

  {
    action: "wake.turn_start",
    fields: ["wakeId", "turnStartTs"],
    proves: "a wake's turn began, so the queue wait can be told apart from the turn itself",    notExercised:
      "RED-until-leg: J1 — every wake-driven turn writes this row and no leg reads one. J1 is the cheapest owner: it already drives a wake and a reply, so the row is one audit read away.",
   },
  { action: "wake.ingress", fields: ["wakeId"], proves: "a wake entered the deployment, before anything decided what to do with it" },
  {
    action: "surface.name_drop_woke",
    fields: ["reason", "container", "ts", "road", "via"],
    proves:
      "the name-drop road ADMITTED a message — the built-in name match, or a wake arm filling its abstention — and which session it handed the wake to; the positive observable that tells a judged NO_REPLY apart from a dead `nameDropWake`",
  },
  {
    action: "surface.name_drop_silent",
    fields: ["reason", "container", "ts"],
    proves: "somebody NAMED the agent and the name-drop road refused to wake, and which gate refused",
    notExercised:
      "the pack's name-drop legs drive the ADMIT side; refusing a real candidate needs a fixture room with `nameDropWake` off (or an unconfirmable channel), which no scenario provisions today.",
  },
  {
    action: "turn.unaccounted_wakes",
    fields: ["turnId", "turnWake", "unaccounted", "count", "addressedCount", "ambientCount", "capped"],
    proves:
      "a turn ended leaving pending wakes it never answered, and how many of those were addressed to the agent. NOT that the turn was COALESCED: `settleWakeAccounting` writes the row whenever a pending, in-TTL wake registered at or before the turn's own wake goes unaccounted, which a turn that merged nothing produces too",
    notExercised:
      "No leg GATES on it. F-SEC produces it incidentally — on a live run its un-mentioned follow-up entered as an ambient wake the seat left unanswered — and `classifyUnansweredWake` (scripts/e2e/gate-joins.ts) only READS the row to say which silence a red was. The leg that meant to drive it, S-APPROVAL-COALESCED, was retired at OPE-2041 because the merge it drove is unreachable: eve 0.52.5+ batches adjacent queued deliveries only when their full auth contexts are structurally equal, and OE's per-delivery `oe_wake_id` / `oe_delivery_id` stamps make that impossible on a unified window (pinned offline by `packages/core/scripts/coalesced-delivery-merge-assumption-test.ts`). A leg that GATES on this row needs no merge at all: it needs to leave one pending in-TTL wake unanswered at a turn's end and assert the row, not to reproduce a coalesced turn.",
  },
  {
    action: "window.routing_degraded",
    fields: ["domainKey", "surfaceKey", "grain", "recall", "wakeId"],
    proves: "a wake ran on a degraded route, so a wrong-room reply has a cause rather than a mystery",    notExercised:
      "RED-until-leg: lane A run 2 — a degraded-route cell. The row fires only when a wake runs on a degraded route, which needs a fixture that degrades one on purpose.",
   },

  {
    action: "approval.requested",
    fields: ["id", "kind", "scopeKey"],
    proves: "an act was held for a human, under a scope key that names WHERE the answer must come from",
  },
  { action: "approval.approved", fields: ["id"], proves: "a human approved the held act" },
  { action: "approval.denied", fields: ["id"], proves: "a human denied the held act", notExercised: "RED-until-leg: J3 — the approval journeys drive the APPROVE path only. The deny arm needs the same card answered no, which the same fixture can drive." },
  { action: "approval.rejected", fields: ["id"], proves: "the plane itself rejected the proposal before any human saw it", notExercised: "the plane rejects a proposal before any human sees it; no e2e fixture produces a proposal it refuses." },
  { action: "approval.expired", fields: ["id"], proves: "a held act lapsed unanswered rather than being decided", notExercised: "an approval must LAPSE unanswered, which costs the full expiry window of wall clock; no leg waits one out." },
  {
    action: "approval.chain",
    fields: ["id"],
    proves: "the hash-chained link for a decided approval — the row that makes the decision tamper-evident",
  },
  { action: "approval.session_granted", fields: [], proves: "a session-scoped standing grant was issued" },
  { action: "approval.session_grant_released", fields: [], proves: "a session-scoped standing grant ended", notExercised: "RED-until-leg: S-PR-SESSION — that leg drives the approve-for-session grant and asserts the grant, never its RELEASE." },
  {
    action: "approval.autoapproved",
    fields: [],
    proves: "an act skipped its card on a standing grant — the row that makes an unasked approval auditable",
  },
  { action: "approval.decision_wake", fields: [], proves: "a decision woke the turn that was waiting on it", notExercised: "RED-until-leg: J3 — the wake a decision causes. The leg observes the reply that follows a decision and never the row that says the decision woke the turn." },
  {
    action: "approval.eve_candidate",
    fields: [],
    proves: "the framework terminally rejected, failed, timed out or marked stale a native approval candidate",
    notExercised:
      "RED-until-fixture: S-EVE-CARD and S-EVE-BRIDGE exercise request-only connector approvals; the only shipped response-policy site is post_file HTML publishing, which this deployment disables, so the pack has no live candidate it can legitimately reject.",
  },
  {
    action: "approval.eve_settled",
    fields: [],
    proves: "a bridged native approval was settled, which is what lets a SUSPENDED turn resume",
  },

  { action: "delegation.task_started", fields: ["task"], proves: "a background worker was dispatched, under which task id" },
  {
    action: "delegation.task_settled",
    fields: ["task", "status", "agent"],
    proves: "a worker finished and its verdict was carried back — the row a delegated reply must sit beside",
  },
  { action: "delegation.task_failed", fields: ["task"], proves: "a worker failed rather than quietly producing nothing", notExercised: "needs a worker that FAILS rather than settles; the pack has no fixture that makes one fail on demand." },
  {
    action: "delegation.provenance_carried",
    fields: [],
    proves: "the worker's provenance reached the reply, so a delegated answer is not passed off as the seat's own",    notExercised:
      "RED-until-leg: S-DELEGATED-slack — the new delegated-turn legs assert the settlement and the reply that follows it; the provenance the worker carries back is the next row for them to read.",
   },

  { action: "reply.post", fields: ["id", "platform", "chars", "route"], proves: "the agent posted, where, and by which route" },
  { action: "reply.provenance", fields: [], proves: "the reply carried its provenance footer, naming who the answer came from" },
  { action: "reply.refused", fields: ["reason"], proves: "the post choke point refused to speak, and why" },
  { action: "reply.forced", fields: ["reason"], proves: "a reply was posted past a guard that would have withheld it", notExercised: "a reply posted PAST a guard that would have withheld it; no e2e fixture arms that path." },
  {
    action: "engagement.stood_down",
    fields: ["surfaceKey", "anchor", "marked", "refused", "reason", "roomAnchor", "roomStop"],
    proves:
      "the agent was asked to stop following a conversation, and either MARKED the engagement row (`marked` — the retroactive proof the thread was enrolled) or REFUSED to (`refused`, naming which path); `roomAnchor`/`roomStop` say whether the mark landed on the room grain instead",
  },

  {
    action: "admin.spend.set_limit",
    fields: ["scopeKey", "level"],
    proves: "an operator changed what this scope may spend, and at which level",
    notExercised: "no e2e leg drives the control-plane spend writes: they need an operator control-WRITE token, and the pack holds a read token only (E2E_CONTROL_READ_TOKEN).",
  },
  {
    action: "admin.spend.clear_limit",
    fields: ["scopeKey", "level", "cleared"],
    proves: "a spend limit was removed, and what it had been",
    notExercised: "pairs with admin.spend.set_limit — same missing control-write credential.",
  },
  {
    action: "spend.cap_bypassed",
    fields: ["standing"],
    proves: "an act ran PAST a spend cap — the row that makes an over-budget turn attributable rather than invisible",
    notExercised: "the pack has no fixture that trips a real spend cap and then bypasses it; E2E_SPEND_CAP_FIXTURE arms the trip, not the bypass.",
  },
  {
    action: "admin.approval.decide",
    fields: ["id", "kind", "decision"],
    proves: "an operator decided a held approval from the CONTROL plane rather than from a card — the same consequence through a different door",
    notExercised: "needs an operator control-WRITE token; the pack holds a read token only.",
  },
  {
    action: "admin.connector.revoke",
    fields: ["connector"],
    proves: "an operator withdrew a connector, narrowing what the agent may reach",
    notExercised: "needs an operator control-WRITE token; the pack holds a read token only.",
  },
  {
    action: "admin.session_grants.revoke",
    fields: ["surfaceKey", "sessionId", "revoked"],
    proves: "standing session grants were withdrawn, and how many — the count an incident review needs",
    notExercised: "needs an operator control-WRITE token; the pack holds a read token only.",
  },
  {
    action: "memory.purge",
    fields: [],
    proves: "stored memory was destroyed on a human decision — irreversible, so the row is the only record it happened",
  },
  {
    action: "memory.delete",
    fields: ["silo", "relPath"],
    proves: "one stored memory file was deleted, naming the silo and the path",
    notExercised: "reached through the control-plane memory writes, which need a control-WRITE token the pack does not hold.",
  },
  {
    action: "webhook.secret_revealed",
    fields: [],
    proves: "a webhook signing secret was shown to somebody — the one row that says a credential left the system",
    notExercised: "the reveal page is an operator flow behind a one-time link; the pack has no fixture that opens one.",
  },

  {
    action: "admin.halt.set",
    fields: ["door"],
    proves: "the agent was halted, through which door, and whether the halt was announced",
    notExercised: "S-HALT is declared RED-until-fixture: the halt is cleared only through the control plane, so a pack holding a read token could never lift one it set.",
  },
  { action: "admin.halt.cleared", fields: ["door", "cleared"], proves: "a halt was lifted, and what it had been holding", notExercised: "pairs with admin.halt.set — no leg may set a halt it cannot clear." },
  {
    action: "aws.sso.link_refused",
    fields: ["reason", "signerSubject"],
    proves:
      "an AWS Identity Center sign-in was refused a personal link, naming the requester whose link was spent and the Identity Center account that completed the sign-in",
    notExercised:
      "no e2e leg completes an Identity Center link: it needs a real AWS Identity Center instance, a registered public PKCE client and a browser that can sign in as two different directory users. Driving it needs an Identity Center fixture with two seeded users and a confirmed `aws` linked-id row for one of them.",
  },
];

const AUDIT_ACTION_PLATFORMS: readonly string[] = ["slack", "discord", "teams", "github", "linear", "notion", "unified"];

export const TEMPLATED_AUDIT_ACTIONS: readonly TemplatedAuditActionDeclaration[] = [
  {
    template: "<platform>.post_file.attach",
    platforms: ["slack", "discord", "notion"],
    fields: ["count", "filenames"],
    proves: "a file left the sandbox as an ATTACHMENT on a named surface — names and counts, never bytes",
    consequential: true,    notExercised:
      "RED-until-leg: F-ART (slack) · J-DISC leg 3 (discord) · lane A run 2 (notion, no leg posts a file there). Each drives the attachment in the room and gates the reply, never this row.",
   },
  {
    template: "<platform>.post_file.link",
    platforms: ["slack", "discord", "notion"],
    fields: ["count", "filenames"],
    proves: "a file left the sandbox as a HOSTED LINK, which is a different exposure from an attachment",
    consequential: true,    notExercised:
      "RED-until-leg: lane A run 2 — the HOSTED-LINK arm on every platform. F-ART and J-DISC both ask for an attachment, and a hosted link is a different exposure.",
   },
  {
    template: "<platform>.post_file",
    platforms: ["slack", "discord", "notion"],
    fields: ["count", "filenames", "hasComment", "hosted"],
    proves: "the whole post_file batch: how many files went out, and how many were hosted rather than attached",
    consequential: true,    notExercised:
      "RED-until-leg: F-ART (slack) · J-DISC leg 3 (discord) · lane A run 2 (notion). The whole-batch row, which no leg reads.",
   },
  {
    template: "<platform>.react",
    platforms: AUDIT_ACTION_PLATFORMS,
    fields: [],
    proves: "the agent left a reaction rather than a reply — an act a member sees, so it is recorded",
    consequential: false,
  },
  {
    template: "<platform>.react.failed",
    platforms: AUDIT_ACTION_PLATFORMS,
    fields: [],
    proves: "a reaction the agent meant to leave did not land",
    consequential: false,
  },
  {
    template: "<platform>.ambient_skipped",
    platforms: AUDIT_ACTION_PLATFORMS,
    fields: [],
    proves: "an ambient message was seen and deliberately not answered",
    consequential: false,
  },
];

export const OPERATIONAL_AUDIT_ACTIONS: readonly string[] = [
  "access.request.pr_opened",
  "access_request.claim_withheld",
  "admin.approval.judge_disarm",
  "admin.approval.judge_rearm",
  "admin.connector.clear_override",
  "admin.model.clear_domain",
  "admin.model.set_domain",
  "admin.routine.cancel",
  "agent.create.pr_opened",
  "analytics.query",
  "analytics.refused",
  "approval.claim_withheld",
  "approval.failed",
  "approval.judge.contradicted",
  "approval.judge.shadow",
  "approval.judge.verdict",
  "aws.exec",
  "aws.refused",
  "bash.background_unredirected",
  "bash.timeout",
  "binding.refused",
  "browser.click",
  "browser.close",
  "browser.console",
  "browser.drag",
  "browser.evaluate",
  "browser.fill",
  "browser.find",
  "browser.get",
  "browser.hover",
  "browser.navigate",
  "browser.network_requests",
  "browser.press_key",
  "browser.read",
  "browser.screenshot",
  "browser.scroll",
  "browser.select_option",
  "browser.set_checked",
  "browser.snapshot",
  "browser.tabs",
  "browser.tools",
  "browser.upload",
  "browser.wait_for",
  "chat.dm",
  "chat.post",
  "chat.post_refused",
  "checkpoint.continue",
  "checkpoint.trip",
  "connector.card_posted",
  "connector.consent_detour",
  "connector.consent_resume",
  "connector.dashboard_link_issued",
  "connector.entitlement_check",
  "connector.mint",
  "connector.oauth_url_issued",
  "connector.op",
  "connector.read",
  "connector.refused",
  "connector.use",
  "control.service_call",
  "control.oauth_code_issued",
  "control.oauth_refused",
  "control.oauth_token_issued",
  "dm.audience.resumed",
  "dm.audience.stopped",
  "github.supervisor_session_failed",
  "github.supervisor_turn_failed",
  "linear.supervisor_session_failed",
  "linear.supervisor_turn_failed",
  "session.generation_retire_skipped",
  "session.generation_retired",
  "surface.wake_admitted",
  "credential.binding_opened",
  "credential.binding_proposed",
  "credential.intake_requested",
  "credential.stored",
  "credential.unresolved",
  "delegation.settlement_report_posted",
  "delegation.settlement_report_skipped",
  "delegation.worker_turn_failed",
  "describe_image",
  "discord.dispatched",
  "discord.relay_admission_refused",
  "dm.delivery.skipped",
  "dm.refused",
  "dream.mode3_report",
  "dream.mode3_tick",
  "egress.hostside.allow",
  "egress.hostside.deny",
  "egress.own_account_refusal",
  "egress.policy",
  "eve.patch.refused",
  "eve.patch.unverifiable",
  "github.dispatched",
  "github.no_reply",
  "github.reaction_claim_unreadable",
  "github.reaction_poll_budget",
  "github.replied",
  "governance.dm_delivered",
  "governance.floor_breach",
  "governance.narrowed",
  "governance.redirected",
  "grant.mount_refused",
  "grant.mount_withheld",
  "input_response.card_refused",
  "input_response.card_settled",
  "input_response.dropped",
  "input_response.routed",
  "linear.dispatched",
  "linear.mention_divert_failed",
  "linear.no_reply",
  "linear.replied",
  "linear.stand_down_lifted",
  "linear.stand_down_suppressed",
  "memory.admin_read",
  "memory.claim_withheld",
  "memory.index_change",
  "memory.learn",
  "memory.observation",
  "memory.operational_write",
  "memory.proposal",
  "memory.provenance_marked",
  "memory.settlement_flush",
  "memory.skill_proposal_pr",
  "memory.sync_timing",
  "memory.tidy",
  "memory.tidy_tick",
  "memory.trust_gate",
  "memory.write",
  "memory.write_refused",
  "notion.dispatched",
  "notion.no_reply",
  "notion.rejected",
  "notion.replied",
  "notion.scope_refused",
  "notion.webhook_timing",
  "permission.fit_report",
  "pr.open",
  "pr.update",
  "provider.unselected_wake_refused",
  "reaction.feedback",
  "read_file_upload",
  "reply.edit",
  "reply.edit.refused",
  "reply.no_reply",
  "reply.no_reply_addressed_to_other_refused",
  "reply.no_reply_after_stand_down",
  "reply.no_reply_observed",
  "reply.no_reply_redundant",
  "reply.post.failed",
  "reply.stand_down_ack",
  "review.pr_walkthrough",
  "routine.cancel",
  "routine.complete",
  "routine.create",
  "routine.declared_ops_mounted",
  "routine.edit",
  "routine.enable",
  "routine.expire",
  "routine.fire_attrs_seen",
  "routine.fire_attrs_sent",
  "routine.policy.add",
  "routine.policy.remove",
  "routine.transcript_read",
  "session.runtime_rotation",
  "skill.create",
  "skill.delete",
  "skill.update",
  "slack.attachment.allow",
  "slack.attachment.deny",
  "soak.capture_gap",
  "stall.nudge",
  "surface.app_installed",
  "surface.app_uninstalled",
  "surface.quiet_fail",
  "surface.wake_dropped",
  "surface.wake_failed",
  "surface.wake_retry",
  "taint.forward",
  "taint.mode",
  "taint.verdict",
  "teams.dispatched",
  "teams.read_boundary",
  "thread.ingress_routed",
  "ticket.add_label",
  "ticket.assign",
  "ticket.create",
  "ticket.set_state",
  "turn.bare_stop",
  "turn.cancel_requested",
  "turn.cancelled",
  "turn.native_input_requested",
  "turn.step_boundary",
  "turn.stop_ignored",
  "turn.supervisor_prose_dropped",
  "turn.tool_gated",
  "turn.wake_accounting_skipped",
  "unified.no_reply",
  "unified.self_dispatch",
  "unified.supervisor_session_failed",
  "unified.supervisor_turn_failed",
  "unified.task_wake",
  "unified.task_wake_retarget",
  "webhook.declare.pr_opened",
  "webhook.declined",
  "webhook.fired",
  "webhook.rotated",
  "worker.toolset",
];

export const DYNAMIC_ACTION_SITES: readonly DynamicActionSite[] = [
  {
    file: "packages/core/agent/tools/react.ts",
    expression: "`${binding.platform}.react` / `${binding.platform}.react.failed`",
    emits: ["slack.react", "discord.react", "teams.react", "github.react", "linear.react", "notion.react", "unified.react"],
  },
  {
    file: "packages/core/agent/channels/ambient-skip.ts",
    expression: "`${p.platform}.ambient_skipped`",
    emits: [
      "slack.ambient_skipped",
      "discord.ambient_skipped",
      "teams.ambient_skipped",
      "github.ambient_skipped",
      "linear.ambient_skipped",
      "notion.ambient_skipped",
      "unified.ambient_skipped",
    ],
  },
  {
    file: "packages/core/agent/tools/post_file.ts",
    expression: "`${platform}.post_file` / `.attach` / `.link`",
    emits: [
      "slack.post_file",
      "discord.post_file",
      "notion.post_file",
      "slack.post_file.attach",
      "discord.post_file.attach",
      "notion.post_file.attach",
      "slack.post_file.link",
      "discord.post_file.link",
      "notion.post_file.link",
    ],
  },
  {
    file: "packages/core/agent/approvals/skill-create.ts",
    expression: 'args.action === "updated" ? "skill.update" : "skill.create"',
    emits: ["skill.create", "skill.update"],
  },
  {
    file: "packages/core/agent/channels/webhooks.ts",
    expression: 'fired ? "webhook.fired" : "webhook.declined"',
    emits: ["webhook.fired", "webhook.declined"],
  },
  {
    file: "packages/core/agent/approvals/pr-open.ts",
    expression: 'pr.updated ? "pr.update" : "pr.open"',
    emits: ["pr.open", "pr.update"],
  },
  {
    file: "packages/core/agent/channels/approval-card.ts",
    expression: "outcome.kind === \"settled\" ? APPROVAL_CARD_SETTLED_AUDIT_ACTION : APPROVAL_CARD_REFUSED_AUDIT_ACTION",
    emits: ["input_response.card_settled", "input_response.card_refused"],
  },
  {
    file: "packages/core/agent/memory/write-road.ts",
    expression: 'kind === "operational" ? MEMORY_OPERATIONAL_WRITE_ACTION : MEMORY_WRITE_ACTION',
    emits: ["memory.write", "memory.operational_write"],
  },
  {
    file: "packages/core/agent/approvals/ticket-actions.ts",
    expression: "auditAction (the verb's own name, chosen per ticket action)",
    emits: ["ticket.assign", "ticket.set_state"],
  },
  {
    file: "packages/core/agent/access/browser-toolkit.ts",
    expression: "`browser.${name.slice(\"browser_\".length)}` — the dotted form of each registered browser op",
    emits: [
      "browser.click",
      "browser.close",
      "browser.console",
      "browser.drag",
      "browser.evaluate",
      "browser.fill",
      "browser.find",
      "browser.get",
      "browser.hover",
      "browser.navigate",
      "browser.network_requests",
      "browser.press_key",
      "browser.read",
      "browser.screenshot",
      "browser.scroll",
      "browser.select_option",
      "browser.set_checked",
      "browser.snapshot",
      "browser.tabs",
      "browser.tools",
      "browser.upload",
      "browser.wait_for",
    ],
  },
  {
    file: "packages/core/agent/access/host-egress.ts",
    expression: 'opts.auditAs ?? "egress.hostside.allow"',
    emits: ["egress.hostside.allow", "egress.hostside.deny"],
  },
  {
    file: "packages/core/agent/credentials/warm.ts",
    expression: "spec.auditAction (the warming spec's own row name)",
    emits: ["credential.unresolved"],
  },
  {
    file: "packages/core/agent/channels/supervisor-complete.ts",
    expression: "spec.repliedAction / spec.noReplyAction (the per-surface supervisor spec)",
    emits: ["github.replied", "github.no_reply", "linear.replied", "linear.no_reply", "notion.replied", "notion.no_reply"],
  },
  {
    file: "packages/providers/discord/agent/channels/discord-events.ts",
    expression: "row.action — a decision row replayed from the gateway's own event mapping",
    emits: ["surface.app_installed", "surface.app_uninstalled"],
  },
  {
    file: "packages/providers/github/agent/channels/github.ts",
    expression: "the `audit(action, detail, workspace)` callback the installation handler is given",
    emits: ["surface.app_installed", "surface.app_uninstalled"],
  },
  {
    file: "packages/providers/slack/agent/channels/slack-events.ts",
    expression: "appendRouteAudit's own `action` parameter, forwarded to the store",
    emits: ["slack.external_policy_suppressed"],
  },
  {
    file: "packages/core/agent/access/connector-scope.ts",
    expression: "the shorthand `action` forwarded from the connector gate's verdict",
    emits: ["connector.use", "connector.read", "connector.refused", "connector.entitlement_check"],
  },
  {
    file: "packages/core/agent/access/connector-disclosure.ts",
    expression: "the shorthand `action` forwarded from the disclosure decision",
    emits: ["grant.undisclosed", "grant.notified", "grant.used"],
  },
  {
    file: "packages/core/agent/access/credential-grant-flow.ts",
    expression: "the shorthand `action` forwarded from the grant lifecycle step",
    emits: ["grant.asked", "grant.granted", "grant.declined", "grant.expired", "grant.revoked", "grant.refused", "grant.mount_refused"],
  },
  {
    file: "packages/core/agent/control/oauth-route.ts",
    expression: "the shorthand `action` forwarded from the OAuth callback outcome",
    emits: ["connector.oauth_url_issued", "connector.mint"],
  },
  {
    file: "packages/core/agent/channels/dm-audience.ts",
    expression: "noteAudienceChange's forwarded action",
    emits: ["chat.dm", "dm.delivery.skipped"],
  },
  {
    file: "packages/core/agent/channels/unified.ts",
    expression: "a forwarded action on the unified window's own accounting rows",
    emits: ["turn.unaccounted_wakes", "turn.wake_accounting_skipped"],
  },
  {
    file: "packages/core/agent/channels/generation-retirement.ts",
    expression: "the shorthand `action` forwarded from the retirement step",
    emits: ["routine.expire"],
  },
  {
    file: "packages/core/agent/spend/ingress-gate.ts",
    expression: "the shorthand `action` forwarded from the spend verdict",
    emits: ["spend.cap_bypassed"],
  },
  {
    file: "packages/core/agent/identity/link-store.ts",
    expression: "the shorthand `action` forwarded from the link-store write",
    emits: ["identity.link.consent_click"],
  },
  {
    file: "packages/providers/discord/agent/channels/discord-gateway.ts",
    expression: "a relay decision row whose action the gateway mapping chooses",
    emits: ["discord.relay_admission_refused", "discord.dispatched"],
  },
];

export function expandTemplate(declaration: TemplatedAuditActionDeclaration): readonly string[] {
  return declaration.platforms.map((p) => declaration.template.replace("<platform>", p));
}

export function declaredAuditActions(): readonly string[] {
  const names = new Set<string>(OPERATIONAL_AUDIT_ACTIONS);
  for (const d of CONSEQUENTIAL_AUDIT_ACTIONS) names.add(d.action);
  for (const t of TEMPLATED_AUDIT_ACTIONS) for (const n of expandTemplate(t)) names.add(n);
  return [...names].sort();
}

export function consequentialAuditActions(): readonly AuditActionDeclaration[] {
  const out = [...CONSEQUENTIAL_AUDIT_ACTIONS];
  for (const t of TEMPLATED_AUDIT_ACTIONS) {
    if (!t.consequential) continue;
    for (const action of expandTemplate(t)) {
      out.push({
        action,
        fields: t.fields,
        proves: t.proves,
        ...(t.notExercised === undefined ? {} : { notExercised: t.notExercised }),
      });
    }
  }
  return out;
}
