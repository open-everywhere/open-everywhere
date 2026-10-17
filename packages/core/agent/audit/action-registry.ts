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
    action: "identity.offboard.applied",
    fields: ["account", "source", "outcome"],
    proves: "a surface reported a person's account deactivated, every gate confirmed it, and the offboarding lever ran without an admin (OPE-2423)",
    notExercised:
      "RED-until-leg: no e2e leg deactivates a Slack member — the fixture workspace would lose an account it cannot get back. identity/offboarding.ts's unit suite (test:surface-offboarding) drives every outcome.",
  },
  {
    action: "identity.offboard.refused",
    fields: ["account", "source", "reason"],
    proves: "a deactivation report was NOT acted on, and why (another workspace, an unadmitted tenant, an unconfirmed deactivation, a set that also holds the person's account elsewhere) — the row that shows a terminal revoke was withheld",
    notExercised:
      "RED-until-leg: no e2e leg deactivates a Slack member, for the reason identity.offboard.applied states. The unit suite (test:surface-offboarding) drives every refusal.",
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
    fields: ["reason", "channelKey", "threadKey", "seatId", "recorded", "closedNow", "foreign", "cleared", "hasReport", "handedBack", "reaction", "posted", "wakeId", "sessionId"],
    proves: "the seat finished its thread: whether the completion posted in the thread, whether the done reaction landed on its root, and whether the host's hand-back reached the parent — a seat that ends without one is a lost errand",    notExercised:
      "RED-until-leg: J-SUP — beside thread_seat.messaged. A seat that ends without a delivered report is a lost errand, and no leg would notice.",
   },

  {
    action: "thread_seat.closed",
    fields: ["reason", "channelKey", "threadKey", "seatId", "recorded", "closedNow", "foreign", "cleared", "hasReport", "handedBack", "reaction"],
    proves: "the HOST closed a thread seat — it went quiet (reason expired) or its thread could no longer reach it (reason closed) — and whether the host-written hand-back reached the parent, so no delegated thread ends in silence",
    notExercised:
      "RED-until-leg: J-SUP — an idle close needs a thread quiet for three days, and a host close needs a re-homed domain; no journey waits that long or re-homes one. scripts/thread-seat-close-test.ts drives both paths offline.",
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
  { action: "approval.session_granted", fields: [], proves: "a routine's standing grant was issued (the card's middle button; a conversation keeps none, OPE-2363)" },
  { action: "approval.rule.added", fields: ["id", "ruleId", "change"], proves: "a person confirmed a rule in their own DM, and the judge reads it for their asks there from now on", notExercised: "RED-until-leg: no live leg clicks the rule option and confirms its dialog yet (OPE-2456)." },
  { action: "approval.rule.removed", fields: ["ruleId"], proves: "a person removed one of their DM rules in the Home tab", notExercised: "RED-until-leg: no live leg drives the Home tab's Remove dialog yet (OPE-2456)." },
  { action: "approval.rule.proposed", fields: ["id", "ruleId", "domain"], proves: "a person's confirmed rule opened a pull request against a domain's rules, naming who asked and from which card", notExercised: "RED-until-leg: no live leg clicks the rule option in a domain room yet (OPE-2456)." },
  { action: "approval.rule.refused", fields: ["id", "reason"], proves: "a click on the rule option approved the act but wrote no rule, and says why (a guest, a shared room, another person's DM)", notExercised: "RED-until-leg: no live leg clicks the rule option yet (OPE-2456)." },
  { action: "approval.session_grant_released", fields: [], proves: "a session-scoped standing grant ended", notExercised: "RED-until-leg: no live leg clicks a routine's standing grant. S-PR-SESSION asserts that a conversation's click writes NO grant (OPE-2363)." },
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
      "RED-until-fixture: since OPE-2340 no shipped tool carries a native approval or a response-policy site at all (OE cards only, ruling Q4), so the pack has no live candidate it can legitimately reject, request-only or otherwise. S-EVE-CARD asserts that a DM connector write raises no native approval in its window.",
  },
  {
    action: "approval.eve_settled",
    fields: [],
    proves: "a bridged native approval was settled, which is what lets a SUSPENDED turn resume",
  },

  { action: "delegation.task_started", fields: ["task"], proves: "a background worker was dispatched, under which task id" },
  {
    action: "work.forwarded",
    fields: ["requestId", "wakeId", "workToken"],
    proves: "a seat forwarded a job to its conversation's work session (OPE-2338), joined to the room wake that asked",
    notExercised:
      "RED-until-leg: the e2e board has no work-session journey yet. Its proof is the integration tier (tasks/seat-snappy-under-worker, tasks/parallel-jobs-one-conversation). Extend J-UNI-X with a forwarded job.",
  },
  {
    action: "work.cancel_relayed",
    fields: ["taskId", "request", "outcome"],
    proves: "a seat relayed a cancel for one forwarded job into its work session, or why the cancel was refused (OPE-2338, ruling D15)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no deployed domain runs the work session in slice A.",
  },
  {
    action: "work.question_posted",
    fields: ["chars", "options"],
    proves: "a work-session child posted its question into its job's room as an OE card and did not wait (OPE-2340, ruling D5) — counts only, never the question",
    notExercised:
      "RED-until-leg: no e2e domain runs the work session yet; tests/integration/tasks/seat-snappy-under-worker.test.ts arm ② reads this row on the integration tier.",
  },
  {
    action: "a2a.delegate_approved",
    fields: ["agent", "host", "requestedBy", "tainted"],
    proves: "a member's click on an a2a.delegate card, or an approver-chain lift (principalId `chain:<element>`), approved ONE delegation of one exact task to one declared A2A agent (OPE-2425) — ids only, never the task text",
    notExercised:
      "RED-until-leg: the e2e scenario S-A2A-DELEGATE drives a delegation against a public reference agent only when a deployment declares one; tests/integration/connectors/a2a-delegation.test.ts reads this row on the integration tier.",
  },
  {
    action: "a2a.refused",
    fields: ["reason", "agent", "tool"],
    proves: "an A2A tool refused a room before any card or request: not internal (shared, public or guest DM), a non-member in the wake, or a domain the agent's declaration does not allow (OPE-2425)",
    notExercised:
      "RED-until-leg: no e2e leg drives an external room into an A2A tool; packages/core/scripts/a2a-client-test.ts §9 drives the gate and tests/integration/connectors/a2a-delegation.test.ts reads this row on the integration tier.",
  },
  {
    action: "a2a.inbound_refused",
    fields: ["reason"],
    proves: "the inbound A2A route refused a call before it read the body or started anything: no credential, a token no declared caller verifies, or a verified token whose subject no caller declares (OPE-2448). Throttled to ~one row per reason per minute, with a `suppressed` count — never the credential",
    notExercised:
      "RED-until-leg: the e2e scenario S-A2A-INBOUND drives the refusal only on a deployment that turns inbound A2A on; tests/integration/ingress/a2a-inbound.test.ts reads this row on the integration tier.",
  },
  {
    action: "a2a.inbound_accepted",
    fields: ["caller", "taskId", "landed"],
    proves: "an AUTHENTICATED, declared inbound A2A caller started a task, and whether it landed as a job in its own surface of its declared domain, or why not (OPE-2448) — ids, counts and a reason, never the task text",
    notExercised:
      "RED-until-leg: beside a2a.inbound_refused — tests/integration/ingress/a2a-inbound.test.ts reads this row on the integration tier.",
  },
  {
    action: "a2a.inbound_answered",
    fields: ["caller", "taskId", "requestId", "outcome", "chars", "written", "write"],
    proves: "an inbound A2A task's job settled — or was lost or withheld, which ends it `failed` — and whether its answer was written to the caller's task, the task row was gone, or the store failed (`write`), with the outcome and the answer's length (OPE-2448) — never the answer",
    notExercised:
      "RED-until-leg: beside a2a.inbound_refused — tests/integration/ingress/a2a-inbound.test.ts reads this row on the integration tier.",
  },
  {
    action: "a2a.delegated",
    fields: ["agent", "host", "requestedBy", "approvedBy", "approvedByPolicy", "state"],
    proves: "an approved delegation SENT one task to a declared A2A agent with the asker's identity attached, and the task state it came back in (OPE-2425) — never the task text or the answer",
    notExercised:
      "RED-until-leg: beside a2a.delegate_approved — tests/integration/connectors/a2a-delegation.test.ts reads this row on the integration tier.",
  },
  {
    action: "domain_question.asked",
    fields: ["questionId", "domain", "room", "seatId", "delivered", "chars", "tainted"],
    proves: "a member's DM seat asked a domain the member belongs to, through which of the domain's internal rooms, and whether the domain seat was woken (OPE-2452) — ids and counts only, never the question",
    notExercised:
      "RED-until-leg: no e2e domain is wired for a DM question yet; packages/core/scripts/domain-question-test.ts pins the gate's pure decisions offline, and tests/integration/channels/domain-question.test.ts drives the real tool and reads this row on the integration tier.",
  },
  {
    action: "domain_question.received",
    fields: ["questionId", "domain", "room", "seatId", "delivered", "dm"],
    proves: "the domain side of a DM question: the domain's own audit shows which member's DM asked it, and which of its rooms the member belongs through (OPE-2452)",
    notExercised: "RED-until-leg: beside domain_question.asked — tests/integration/channels/domain-question.test.ts reads this row on the integration tier.",
  },
  {
    action: "domain_question.answered",
    fields: ["questionId", "domain", "asker", "declined", "route", "chars", "tainted"],
    proves: "a domain's seat answered (or declined) one DM question, and how the answer reached the asker's DM — through the DM seat, by a host post, or not at all (OPE-2452) — never the answer",
    notExercised: "RED-until-leg: beside domain_question.asked — tests/integration/channels/domain-question.test.ts reads this row on the integration tier.",
  },
  {
    action: "domain_question.answer_delivered",
    fields: ["questionId", "domain", "asker", "declined", "route"],
    proves: "the DM side of an answer: the asker's own audit shows which domain answered them and how it reached their DM (OPE-2452)",
    notExercised: "RED-until-leg: beside domain_question.answered — tests/integration/channels/domain-question.test.ts reads this row on the integration tier.",
  },
  {
    action: "domain_question.refused",
    fields: ["reason", "domain", "tool"],
    proves: "a DM question or its answer was refused before anything was sent: not a 1:1 internal DM, a non-member in the wake, no verified person, an unknown or closed domain, membership the platform could not prove, a person outside the domain, no running seat, or an answer from the wrong seat or a turn the delivery did not wake (OPE-2452)",
    notExercised: "RED-until-leg: no e2e leg drives a refused DM question; packages/core/scripts/domain-question-test.ts pins every refusal reason in the pure gate functions offline, and tests/integration/channels/domain-question.test.ts drives the real tool for the not-a-member reason and reads this row on the integration tier.",
  },
  {
    action: "bot_ask.expected",
    fields: ["askId", "bot", "channel", "thread", "windowHours", "cap"],
    proves: "a person's own DM seat opened an asked thread after the platform proved the person wrote the ask and that it names that bot (OPE-2426) — the only act that lets another bot's Slack message wake the agent outside the e2e driver settings (OPE-1023)",
    notExercised:
      "RED-until-leg: no e2e leg drives a second bot in a shared channel yet; packages/core/scripts/bot-ask-test.ts drives the real tool offline and reads this row through the audit seam.",
  },
  {
    action: "bot_ask.refused",
    fields: ["reason", "tool"],
    proves: "an asked thread was refused before anything was recorded: not a 1:1 internal DM, a non-member in the wake, no verified person, a scheduled run, a turn a relayed bot reply woke, a platform with no probe, or a message the platform did not prove as the person's ask to that bot (OPE-2426)",
    notExercised: "RED-until-leg: beside bot_ask.expected — packages/core/scripts/bot-ask-test.ts drives every refusal reason offline.",
  },
  {
    action: "bot_ask.reply_relayed",
    fields: ["askId", "bot", "channel", "slot", "route", "chars"],
    proves: "another bot's reply in an asked thread was relayed to the asker's DM (`dm-seat`, `posted` or `failed`), and which reply slot it took under the cap (OPE-2426) — never the reply's text",
    notExercised: "RED-until-leg: beside bot_ask.expected — packages/core/scripts/bot-ask-test.ts and packages/providers/slack/scripts/slack-bot-ask-test.ts drive the relay offline.",
  },
  {
    action: "connector.op_approved",
    fields: ["connection", "op", "grain", "requestedBy"],
    proves: "a member's click on an op.connector card approved one connector op for this conversation (a write, or the flag-off blanket) or for one call (a destructive op) — the OE card that replaced eve's native once() (OPE-2340, ruling Q4)",
    notExercised:
      "RED-until-leg: no e2e leg clicks a connector-op card yet; scripts/no-native-hitl-test.ts drives the seam with an injected card plane, never this row.",
  },
  {
    action: "work.cancel_redeemed",
    fields: ["taskId", "outcome"],
    proves: "the work session's fenced task_cancel redeemed the seat's cancel ticket for one job, or was refused (OPE-2338, ruling D15 under D10)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no deployed domain runs the work session in slice A.",
  },
  {
    action: "work.result_wake",
    fields: ["taskId", "status", "outcome"],
    proves: "a work-session job's result was delivered to the seat that forwarded it, or why it was not (OPE-2338)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no deployed domain runs the work session in slice A.",
  },
  {
    action: "work.request_lost",
    fields: ["requestId", "reason", "outcome"],
    proves: "a forwarded job was lost because its work session rotated, parked or failed, and the seat was told with a failed result (OPE-2341, placement §2.18 and D9)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no deployed domain runs the work session yet; the integration tier drives it (liveness/work-session-park).",
  },
  {
    action: "work.request_refused",
    fields: ["requestId", "taskId", "reason", "outcome"],
    proves: "the work session's continuation fence refused a forwarded follow-up, and the seat was told with a failed result (OPE-2379)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no journey yet drives a W-side continuation refusal; the integration tier drives it (tasks/work-refused-follow-up-reaches-room), and the unit tier pins it (packages/core/scripts/worker-continuation-test.ts §8).",
  },
  {
    action: "work.session_rotated",
    fields: ["registryKey", "from", "to", "trigger", "drainingRequests"],
    proves: "a conversation's work session rotated to a fresh generation, losing its sandbox, and why (OPE-2341, ruling Q6); on a code change (`runtime-changed`) the old session keeps the jobs it holds and drains them (OPE-2377)",
    notExercised:
      "RED-until-leg: beside work.forwarded — no deployed domain runs the work session yet; the integration tier drives it (liveness/work-session-park).",
  },
  {
    action: "work.session_failed",
    fields: ["registryKey", "token", "retired"],
    proves: "a work session failed (on eve 0.69+ an empty compaction summary is fatal) and its generation was retired (OPE-2341, design point D9)",
    notExercised:
      "RED-until-leg: no journey and no integration spec yet drives a work session to a fatal failure; the unit tier pins the remedy (packages/core/scripts/work-generation-test.ts ⑥).",
  },
  {
    action: "delegation.task_settled",
    fields: ["task", "status", "agent"],
    proves: "a worker finished and its verdict was carried back — the row a delegated reply must sit beside",
  },
  {
    action: "delegation.continuation_admitted",
    fields: ["task", "session", "openingCall"],
    proves: "a seat continued an idle worker by taskId from the room that opened the task (OPE-2251), and the worker's authority row was re-pointed at the continuing wake",
  },
  {
    action: "delegation.continuation_refused",
    fields: ["task", "session", "reason"],
    proves: "a taskId continuation was refused by the provenance fence (OPE-2251) — `reason: cross-room` is a task opened in another room of the same seat, `task-working` a task that has not reported back yet",
  },
  { action: "delegation.task_failed", fields: ["task"], proves: "a worker failed rather than quietly producing nothing", notExercised: "needs a worker that FAILS rather than settles; the pack has no fixture that makes one fail on demand." },
  {
    action: "delegation.task_unreadable",
    fields: ["edge", "marker", "adopted", "status", "task"],
    proves: "eve sent an event on a task edge that OE's reader REFUSED, so it reached no edge and adopted no taint — the fail-OPEN arm, made countable instead of silent",
    notExercised:
      "needs eve to send a task event OE's reader refuses, which on a real host means an eve release that moved a shape. `scripts/background-task-taint-test.ts` T4 drives it at the unit tier with a hand-built unreadable payload.",
  },
  {
    action: "delegation.dispatch_unauthorized",
    fields: ["edge", "reason", "marker", "adopted", "call"],
    proves: "a delegated dispatch got NO exact dispatch authority, so no task wake is minted and its settlement installs no reply address — the reply fence refuses it under `task-wake-unread`. The state the old throw claimed to prevent, now counted instead of silently passed",
    notExercised:
      "needs a unified seat delegating on a turn that reaches no exact wake. `scripts/background-task-taint-test.ts` PART 4D covers THREE of the five reasons through the real handlers: it asserts the row for `unified-turn-no-wake` and `settlement-turn-ambiguous-authority` on `actions.requested` (with a non-delegating action as the negative control), and drives `authority-row-absent-at-task-started` on `task.started`, asserting both its row and the absent task wake. NOT covered: `settlement-turn-no-authority`, which needs no fault and is simply not driven; and `dispatch-wake-not-durable`, which needs `rememberDelegatedTaskWake` to throw and so needs a store fault this tier cannot provoke.",
  },
  {
    action: "delegation.provenance_carried",
    fields: [],
    proves: "the worker's provenance reached the reply, so a delegated answer is not passed off as the seat's own",    notExercised:
      "RED-until-leg: S-DELEGATED-slack — the new delegated-turn legs assert the settlement and the reply that follows it; the provenance the worker carries back is the next row for them to read.",
   },

  { action: "reply.post", fields: ["id", "platform", "chars", "route"], proves: "the agent posted, where, and by which route" },
  { action: "reply.provenance", fields: [], proves: "the reply drew on connector reads, and which sources the room may be told (detail.sources; no footer since OPE-2487)" },
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
    action: "exit.export",
    fields: ["tables", "rows", "memoryFiles", "transcriptStore", "transcriptRuns", "auditChainVerified", "sha256"],
    proves: "an operator exported the org's data with `oe export`, how much left, and a digest of exactly what was written",
  },
  {
    action: "exit.person_erased",
    fields: ["personSha256", "rows", "dmRooms", "memoryTiers", "transcriptStore", "transcriptsDeleted", "transcriptsShared", "authorityEnded", "linkSet", "accountsRevoked", "credentialsPurged", "grantsRevoked", "browsersForgotten", "authorityFailures"],
    proves:
      "an operator erased one person with `oe erase` — what was destroyed, by count, with the person named only by hash, and what of the person's links, credentials and holdings ended first (OPE-2560)",
  },
  {
    action: "exit.transcript_deleted",
    fields: ["sessionId", "outcome", "files", "captures"],
    proves: "one session transcript was deleted, and whether the store that holds it could be reached",
  },
  {
    action: "exit.retention_swept",
    fields: ["storedStateDays", "sessionTranscriptDays", "rows", "transcriptsDeleted", "transcriptStore"],
    proves: "the daily retention sweep ran under the org's retention settings, and what it aged out",
  },
  {
    action: "memory.export",
    fields: ["via", "silo", "items", "chars", "sha256"],
    proves:
      "a person's own memory left the store as a document handed to them, through which door, and a digest of exactly what was handed over — never its lines (OPE-2451). S-APP-HOME drives it with a forged Export click.",
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
  {
    action: "connector.xaa.link_refused",
    fields: ["reason", "connection", "signerSubject", "stage"],
    proves:
      "an Okta Cross App Access grant was refused for a requester and a connection — at stage sign-in (the link was spent; signerSubject is the Okta account that signed in, or null when the id token did not verify) or at stage mint (a stored grant re-checked before a mint; signerSubject is the grant's Okta account; `reason` tells a link that is gone, where the grant was deleted, from an unreadable link plane, where the grant was kept)",
    notExercised:
      "no e2e leg completes an Okta sign-in: it needs a real Okta org with an OIDC app for OE and a browser that can sign in as two directory users. The feature ships dark (no connection declares an xaa sign-in).",
  },
  {
    action: "meeting.join",
    fields: ["meetingId", "platform", "host", "requestedBy", "backend", "box", "maxMinutes", "transcription"],
    proves: "a member approved sending OE's meeting bot to one meeting, naming the platform, the host, the box it runs in, its cap and the transcription route",
    notExercised:
      "S-MEETING-RECAP is declared NON_LAUNCH: a live leg needs a deployment with meetings enabled, a published bot image and a real meeting whose host admits the bot. The tier-2 test tests/integration/meetings/meeting-recap.test.ts drives the row on the built host with a fake box backend.",
  },
  {
    action: "meeting.ended",
    fields: ["meetingId", "reason", "box"],
    proves: "a meeting bot's box was stopped, why (the meeting ended, the room emptied, the cap), and the seconds and dollars billed for it",
    notExercised: "pairs with meeting.join — the same live-meeting fixture.",
  },
  {
    action: "meeting.recap_posted",
    fields: ["meetingId", "posted", "decisions", "actions", "summarised", "missingChunks", "labelledLines"],
    proves: "the recap of a meeting went (or failed to go) into the thread that asked, with how many decisions and actions it carried, how many chunks of audio were missing, and how many transcript lines carried a speaker name",
    notExercised: "pairs with meeting.join — the same live-meeting fixture.",
  },
  {
    action: "email.admitted",
    fields: ["inbox", "route", "trust", "via", "to", "cc", "dropped", "tainted"],
    proves: "an inbound mail passed the email gate and woke a seat — which inbox, which seat kind, the sender's trust, which list admitted the sender, and how many reply recipients were frozen or dropped",
    notExercised:
      "S-EMAIL-ROOM-REPLY and S-EMAIL-DM-FORWARD are declared NON_LAUNCH: a live leg needs an agent-mailbox account with an inbox on a domain the test org controls (DNS records the run cannot create). The unit pack test:email-front drives the row through the real front with a fake transport.",
  },
  {
    action: "email.refused",
    fields: ["reason", "inbox"],
    proves: "the email gate refused an inbound mail before any model saw it, and why (disabled, unknown inbox, shared vendor domain, a loop, an automated or flagged mail, a failed sender authentication, a sender not on the list, an unknown person, or no domain reaching the inbox)",
    notExercised: "pairs with email.admitted — S-EMAIL-STRANGER-REFUSED needs the same live mailbox fixture.",
  },
  {
    action: "email.sender.pr_opened",
    fields: ["requestId", "inbox", "sender", "repo", "branch"],
    proves: "a person approved adding an allowed sender to a room inbox, and the pull request that adds it was opened (nothing is allowed until an admin merges it)",
    notExercised: "pairs with email.admitted — the propose leg needs a config repository the e2e app can write to. The unit pack test:email-sender drives the row with fake repository edges.",
  },
  {
    action: "google-chat.admitted",
    fields: ["space", "route", "trust", "domainId", "threadReply"],
    proves: "a token-verified Google Chat message passed the surface's gate and woke a seat — which space, which seat kind, the sender's trust, and the sender's Workspace domain id (so an operator can read it off the row for `internalDomainIds`)",
    notExercised:
      "S-GCHAT-MENTION-REPLY is not on the e2e board yet: a live leg needs a Google Workspace test tenant with the Chat app published to it (a fixture the run cannot create). The unit pack test:google-chat-front drives the row through the real front with fake deps.",
  },
  {
    action: "google-chat.refused",
    fields: ["reason", "space", "domainId"],
    proves: "the Google Chat gate refused a token-verified message before any model saw it, and why (a group chat, direct messages turned off, an outside person's DM, or no domain reaching the space), with the sender's Workspace domain id",
    notExercised: "pairs with google-chat.admitted — the same live Workspace fixture.",
  },
  {
    action: "browser.personal.open",
    fields: ["box", "backend", "egressEnforced", "hosts", "maxMinutes"],
    proves: "a person's browser box started on this deployment's sandbox backend, with whether the backend's firewall holds its host list, how many hosts it may reach and its cap",
    notExercised: "S-PERSONAL-BROWSER is declared NON_LAUNCH: a live leg needs a deployment with the personal browser enabled, a published browser image and a box backend. The tier-2 test tests/integration/personal-browser/personal-browser.test.ts drives the row on the built host with a fake box backend and a fake box.",
  },
  {
    action: "browser.personal.closed",
    fields: ["box", "reason", "seconds", "usdMicros"],
    proves: "a person's browser box stopped (closed by them, idle, its cap, a halt, unreachable, a forget), and the seconds and dollars billed for it",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.action",
    fields: ["op", "host", "box", "ok"],
    proves: "the agent took one action in a person's browser, naming the kind of action and the site — never the text it typed",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.act_granted",
    fields: ["host", "minutes", "until"],
    proves: "the person, by their own click, let the agent click and type on one site in their browser, and until when",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.takeover",
    fields: ["by", "until", "box"],
    proves: "the person took the controls of their browser (on the watch page, or handed them by the agent with a reason), and until when every agent action is refused",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.handback",
    fields: ["by", "box"],
    proves: "the controls of a person's browser went back to the agent — by the person's card, on the page, or because the take-over expired",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.view_opened",
    fields: ["session", "until"],
    proves: "a single-use watch link to a person's browser was opened and started one watch session, naming a prefix of the session and its expiry",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.forget",
    fields: ["persistKey"],
    proves: "a person's browser and every login in it were deleted from the sandbox backend at their request",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "browser.personal.teach",
    fields: ["phase"],
    proves: "a person taught a task by demonstration in their own browser (OPE-2454): the recording started, was saved as a paused draft (step counts only, never a label or typed text), was rehearsed without a click, was discarded, or was lost (its box closed, or the hand-off failed)",
    notExercised: "pairs with browser.personal.open — the same browser fixture.",
  },
  {
    action: "meeting.recap_requested",
    fields: ["meetingId", "platform", "host", "roomId", "requestedBy", "when"],
    proves: "a member approved reading one meeting's transcript from the meeting platform with the organisation's credential, naming the platform, the meeting and the person who asked",
    notExercised:
      "S-MEETING-NATIVE-RECAP is declared NON_LAUNCH: a live leg needs a deployment with native recaps enabled, the org's platform credential stored, and a real meeting with the platform's transcription on. The tier-2 test tests/integration/meetings/meeting-native-recap.test.ts drives the row on the built host with a fake platform reader.",
  },
  {
    action: "meeting.recap_refused",
    fields: ["meetingId", "platform", "reason", "posted"],
    proves: "a recap from the platform's own transcript ended with no recap, and why: the platform refused (an admin switch or grant off, not transcribed, expired, not found, a bad credential), no transcript appeared before the watch ran out, native recaps were turned off, or a halt covered the ask",
    notExercised: "pairs with meeting.recap_requested — the same live-meeting fixture.",
  },
  {
    action: "personal_watch.silence",
    fields: ["reason", "kind", "dial", "dampening", "fingerprint", "summary"],
    proves: "the watch held a finding back (or could not look), and the closed reason why — one row per finding and reason",
    notExercised:
      "no e2e leg declares a watch source: the pack's fixtures have no calendar connector, so no live check runs. `test:personal-watch` drives every reason through the real tick and the real audit write.",
  },
  {
    action: "personal_watch.nudge",
    fields: ["kind", "urgency", "dial", "dampening", "calibrationAsk", "fingerprint"],
    proves: "the watch started a direct message to the person on its own, with no ask, and under which dial",
    notExercised: "the same gap as `personal_watch.silence`: no fixture calendar exists for a live check.",
  },
  {
    action: "personal_watch.dial.set",
    fields: ["dial", "previous", "via"],
    proves: "a person turned their watch to more, less or none, and through which door (`command` or `app-home`)",
    notExercised:
      "S-WATCH drives both doors (a forged `/oe watch` and a forged Home-tab click) and gates on this row, but it is NON_LAUNCH: its Home-tab leg needs the fixture app reinstalled with the Home tab on, as S-APP-HOME does.",
  },
  {
    action: "personal_watch.response",
    fields: ["response", "dampening", "via", "fingerprint"],
    proves: "a person marked a nudge useful or not useful, and the dose that answer left",
    notExercised: "S-WATCH proves only that a forged answer writes NO row; a real answer needs a nudge, which needs a calendar fixture no board carries. `test:personal-watch` drives the row offline.",
  },
  {
    action: "personal_watch.proposal",
    fields: ["fingerprint", "kind", "connector", "tool", "weekday", "hour", "weeks", "dial"],
    proves: "the watch posted a routine proposal card into the person's own DM, for which repeated connector op or repeated question (`kind`; a question names its hash, never its words) and weekday, under which dial",
    notExercised: "a live proposal needs three weeks of a person's real tool-call history, which no board carries. `test:workflow-discovery` drives the real tick and the tier-2 spec drives the compiled schedule.",
  },
  {
    action: "personal_watch.proposal.accepted",
    fields: ["fingerprint"],
    proves: "the person pressed Set it up on a routine proposal, and the routine was armed through `routine.create` (its own row sits beside this one)",
    notExercised: "the same gap as `personal_watch.proposal`. `test:workflow-discovery` presses the real card kind.",
  },
  {
    action: "personal_watch.proposal.declined",
    fields: ["fingerprint"],
    proves: "the person pressed No thanks on a routine proposal, and the watch recorded it so the idea is never offered again",
    notExercised: "the same gap as `personal_watch.proposal`. `test:workflow-discovery` presses the real card kind.",
  },
  {
    action: "room_watch.proposal",
    fields: ["fingerprint", "kind", "connector", "tool", "weekday", "hour", "weeks", "people"],
    proves: "the watch posted a routine proposal card into a shared room, for which repeated connector op or question (a question names its hash, never its words), on which weekday, from how many people",
    notExercised: "a live proposal needs three weeks of several people's real activity in one room, which no board carries. `test:workflow-discovery` drives the real tick and the tier-2 spec drives the compiled schedule.",
  },
  {
    action: "room_watch.proposal.accepted",
    fields: ["fingerprint"],
    proves: "a member pressed Set it up on a room's routine proposal (`principalId` names who), and the routine was armed in the room through `routine.create`",
    notExercised: "the same gap as `room_watch.proposal`. `test:workflow-discovery` presses the real card kind.",
  },
  {
    action: "room_watch.proposal.declined",
    fields: ["fingerprint"],
    proves: "a member pressed No thanks on a room's routine proposal, and the room's row recorded it so the idea is never offered there again",
    notExercised: "the same gap as `room_watch.proposal`. `test:workflow-discovery` presses the real card kind.",
  },
  {
    action: "room_watch.silence",
    fields: ["reason", "fingerprint", "kind", "summary"],
    proves: "room discovery held a room back, and the closed reason why (`room-stopped`, `proposal-gap`, `delivery-refused`) — one row per stop, or per idea and reason; the same hold on the next scan files nothing new",
    notExercised: "a live hold needs a room pattern, which needs three weeks of several people's activity in one room, which no board carries. `test:workflow-discovery` drives every reason through the real tick and the real audit write.",
  },
  {
    action: "room_watch.stopped",
    fields: ["changed", "via"],
    proves: "a person in a shared room stopped the agent's routine suggestions there with `/oe suggest off` (`principalId` names who)",
    notExercised: "S-ROOM-SUGGEST drives a signed `/oe suggest off` in the base channel and gates on this row, but it is NON_LAUNCH: no board has run it live yet. `test:workflow-discovery` drives the row offline.",
  },
  {
    action: "room_watch.resumed",
    fields: ["changed", "via"],
    proves: "a member lifted a room's stop on routine suggestions with `/oe suggest on` (`principalId` names who)",
    notExercised: "the same gap as `room_watch.stopped`: S-ROOM-SUGGEST is NON_LAUNCH. `test:workflow-discovery` drives the row offline.",
  },
  {
    action: "cover.set",
    fields: ["on", "until", "questions", "via"],
    proves: "a person turned their out-of-office cover on (with its end date) or off, and through which door (`command`, or `end-date` when the date passed)",
    notExercised: "S-COVER drives `/oe cover on` and `/oe cover off` and gates on this row; it is NON_LAUNCH until a board runs it live.",
  },
  {
    action: "cover.wake",
    fields: ["wakeId", "recorded", "mentioned"],
    proves: "a room wake mentioned a person with live cover, so the wake carried OE's cover note, and whether the question entered the person's recap log",
    notExercised: "S-COVER posts a mention of the covered person in a domain channel and gates on this row; NON_LAUNCH until a board runs it live.",
  },
  {
    action: "cover.answered",
    fields: ["wakeId", "chars"],
    proves: "the agent's reply on a cover wake was posted with the host's cover label, and its text became the answer in the person's recap",
    notExercised: "S-COVER gates on this row and on the label in the posted reply; NON_LAUNCH until a board runs it live.",
  },
  {
    action: "cover.recap",
    fields: ["questions", "leftOut", "sent"],
    proves: "the recap of a person's cover went to their own DM, with how many questions it showed and how many it left out because the person could not read the room",
    notExercised: "S-COVER waits for this row after `/oe cover off` (the schedule runs every 5 minutes); NON_LAUNCH until a board runs it live. `test:cover` drives the tick offline.",
  },
  {
    action: "cover.recap_refused",
    fields: ["reason", "gaveUp", "tries"],
    proves: "a recap could not be delivered (no DM, not a 1:1 DM, over budget, a failed send), and whether the tick gave up and dropped the log",
    notExercised: "no board fixture refuses a DM; `test:cover` drives the refusal and the give-up offline.",
  },
  {
    action: "person.opt_out.set",
    fields: ["via"],
    proves: "a person opted out of agent actions on their own content, and through which door (`command` or `app-home`)",
    notExercised:
      "no e2e leg drives `/oe optout` or the Home-tab button: the pack's driver posts messages and cannot invoke a slash command or press a Home-tab button as a person. Driving it needs a user-token slash-command fixture. The integration tier drives `/oe optout on` and `off` through the real signed commands route (`tests/integration/memory/person-opt-out-shared-room.test.ts`, OPE-2497).",
  },
  {
    action: "person.opt_out.cleared",
    fields: ["via"],
    proves: "a person lifted their opt-out, and through which door",
    notExercised: "the same gap as `person.opt_out.set`: no e2e leg can invoke a slash command or press a Home-tab button as a person. The integration spec `person.opt_out.set` names drives it.",
  },
  {
    action: "person.opt_out.refused",
    fields: ["act"],
    proves:
      "the host refused an agent act on an opted-out person's content — a memory write (`act: memory-write`, with `road` and `tier`) or somebody else's message shortcut on their message (`act: message-shortcut`, with `requestedBy`)",
    notExercised:
      "no e2e leg opts a person out first, for the reason `person.opt_out.set` gives; the unit packs (`test:person-opt-out`, `test:slack-side-panel`) drive both legs through the real write road and the real front route. The integration tier drives the memory-write leg on a real host, in a shared room, through the work session's persist (`tests/integration/memory/person-opt-out-shared-room.test.ts`, OPE-2497).",
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
    template: "<platform>.post_file",
    platforms: ["slack", "discord", "notion"],
    fields: ["count", "filenames", "hasComment", "attached"],
    proves: "the whole post_file batch: how many files went out as attachments",
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
  "attention.ping_failed",
  "voice.transcribed",
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
  "canvas.write",
  "list.write",
  "checkpoint.continue",
  "checkpoint.trip",
  "connector.card_posted",
  "connector.consent_detour",
  "connector.consent_resume",
  "connector.dashboard_link_issued",
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
  "mcp-server.propose.pr_opened",
  "meeting.status",
  "email.wake_failed",
  "google-chat.wake_failed",
  "session.generation_retire_skipped",
  "work.session_rotation_deferred",
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
  "home.publish",
  "hook.refused",
  "input_response.dropped",
  "input_response.nonmember_marked",
  "input_response.routed",
  "turn.question_dropped",
  "linear.dispatched",
  "linear.mention_divert_failed",
  "linear.no_reply",
  "linear.replied",
  "linear.stand_down_lifted",
  "linear.stand_down_suppressed",
  "memory.admin_read",
  "memory.canvas_refresh",
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
  "reply.feedback",
  "reply.no_reply",
  "reply.no_reply_addressed_to_other_refused",
  "reply.no_reply_after_stand_down",
  "reply.no_reply_observed",
  "reply.no_reply_redundant",
  "reply.post.failed",
  "reply.stand_down_ack",
  "review.pr_walkthrough",
  "routine.cancel",
  "routine.checkin",
  "routine.complete",
  "routine.create",
  "routine.paused",
  "routine.declared_ops_resolved",
  "routine.edit",
  "routine.enable",
  "routine.expire",
  "routine.fire_attrs_seen",
  "routine.fire_attrs_sent",
  "routine.policy.add",
  "routine.policy.remove",
  "routine.test_blocked",
  "routine.test_fired",
  "routine.test_requested",
  "routine.transcript_read",
  "session.runtime_rotation",
  "skill.create",
  "skill.delete",
  "skill.update",
  "slack.attachment.allow",
  "slack.attachment.deny",
  "slack.setup_reopened",
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
  "teams.intro_posted",
  "teams.oe_command",
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
    file: "packages/core/agent/a2a/inbound/audit.ts",
    expression: "row.action",
    emits: ["a2a.inbound_refused", "a2a.inbound_accepted"],
  },
  {
    file: "packages/providers/google-chat/agent/channels/google-chat.ts",
    expression: "row.action",
    emits: ["google-chat.admitted", "google-chat.refused"],
  },
  {
    file: "packages/providers/email/agent/channels/email.ts",
    expression: "row.action",
    emits: ["email.admitted", "email.refused"],
  },
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
    expression: "`${platform}.post_file` / `.attach`",
    emits: [
      "slack.post_file",
      "discord.post_file",
      "notion.post_file",
      "slack.post_file.attach",
      "discord.post_file.attach",
      "notion.post_file.attach",
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
    emits: ["connector.use", "connector.read", "connector.refused"],
  },
  {
    file: "packages/core/agent/access/connector-disclosure.ts",
    expression: "the shorthand `action` forwarded from the disclosure decision",
    emits: ["connector.refused", "governance.redirected"],
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
