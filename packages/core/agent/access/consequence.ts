export type ConsequenceTier = "open" | "gate:member" | "gate:admin";

const CONNECTOR_READ_VERBS: readonly string[] = [
  "search", "list", "get", "read", "fetch", "query", "find", "describe",
  "view", "retrieve", "show", "lookup", "count", "check", "browse", "download",
];

export function connectorOpName(toolName: string): string {
  const i = toolName.indexOf("__");
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

export function isConnectorOpTool(toolName: string): boolean {
  return toolName.includes("__");
}

export function classifyConnectorOp(toolName: string): "open" | "gate:member" {
  return classifyConnectorOpTier(toolName) === "read" ? "open" : "gate:member";
}

export type ConnectorOpTier = "read" | "write" | "destructive";

const CONNECTOR_DESTRUCTIVE_VERBS: readonly string[] = ["delete", "remove", "destroy", "drop", "purge", "trash", "erase", "wipe"];

const CONNECTOR_WRITE_VERBS: readonly string[] = [
  "create", "update", "add", "append", "insert", "post", "put", "patch", "set", "move", "comment", "edit",
  "write", "upload", "send", "assign", "label", "rename", "duplicate", "copy", "publish", "share", "invite",
  "mark", "complete", "close", "reopen", "merge", "approve", "submit", "reply", "star", "upsert", "modify",
  "replace", "attach", "link", "unlink", "restore", "archive", "unarchive", "unpublish", "revoke", "cancel",
];

function connectorOpVerb(toolName: string): string {
  let op = connectorOpName(toolName).toLowerCase();
  const sep = toolName.indexOf("__");
  if (sep > 0) {
    const conn = toolName.slice(0, sep).toLowerCase();
    if (op.startsWith(`${conn}-`) || op.startsWith(`${conn}_`)) op = op.slice(conn.length + 1);
  }
  return op.split(/[_-]/, 1)[0] ?? op;
}

export function classifyConnectorOpTier(toolName: string): ConnectorOpTier {
  const verb = connectorOpVerb(toolName);
  if (CONNECTOR_READ_VERBS.includes(verb)) return "read";
  if (CONNECTOR_DESTRUCTIVE_VERBS.includes(verb)) return "destructive";
  if (CONNECTOR_WRITE_VERBS.includes(verb)) return "write";
  return "destructive";
}

export function restMethodTier(method: string): ConnectorOpTier {
  switch (method.trim().toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";
    case "POST":
    case "PUT":
    case "PATCH":
      return "write";
    case "DELETE":
      return "destructive";
    default:
      return "destructive";
  }
}

export type GatingMechanism =
  | { readonly kind: "none" }
  | { readonly kind: "action-kind"; readonly action: string }
  | { readonly kind: "admin-roles" }
  | { readonly kind: "eve-hitl" };

export interface ConsequenceEntry {
  readonly tier: ConsequenceTier;
  readonly via: GatingMechanism;
  readonly reason: string;
}

const open = (reason: string): ConsequenceEntry => ({ tier: "open", via: { kind: "none" }, reason });
const member = (action: string, reason: string): ConsequenceEntry => ({ tier: "gate:member", via: { kind: "action-kind", action }, reason });
const admin = (action: string, reason: string): ConsequenceEntry => ({ tier: "gate:admin", via: { kind: "action-kind", action }, reason });

export const TOOL_CONSEQUENCE: Readonly<Record<string, ConsequenceEntry>> = {
  bash: open("sandbox execution; reach is bounded by the egress plane (L1), not by this table"),
  glob: open("sandbox-local file listing"),
  grep: open("sandbox-local file search"),
  read_file: open("sandbox-local read"),
  write_file: open("sandbox-local write — durable effects leave only via gated verbs"),
  sandbox_tools: open(
    "the resolver FILE that re-provides the six disabled framework sandbox tools per session grain (access/window-gated.ts windowGatedKit); mounts nothing beyond the six names above, each at its own open tier",
  ),

  web_search: open("read of the public web via eve's provider; a read, escapes nothing"),
  ask_question: open("asks the ROOM a clarifying question — stays in the asking conversation"),
  todo: open("in-context scratchpad for the model's own turn planning; nothing durable, nothing leaves"),
  load_skill: open("loads a skill's instructions INTO CONTEXT — reading a procedure, not executing an effect; arming a skill stays gated at create_skill"),
  connection_search: open("read of WHICH connectors exist for this session; a connector's own OPERATIONS are the separate design-deferred plane (§3 grain 2)"),

  fresh_eyes_review: open(
    "declared subagent: an independent review pass over text the caller already holds. Zero tools (disableTool() sentinel set, lint-pinned), no sandbox reach, no audience — the verdict returns into the calling session only",
  ),
  recall_verification: open(
    "declared subagent: entailment check of a claim against evidence the caller quotes. Zero tools (lint-pinned) — it reads no memory itself, so it discloses nothing the caller did not already have",
  ),

  check_pr_status: open("read of a PR's state"),
  get_pr_feedback: open("read of a PR's reviews/comments/check runs via the read-scoped credential; disclosure is bounded by the channel's repo grant (membership is the ACL), and the digest is size-capped"),
  walk_pr: open(
    "read-only GATHER for a PR walkthrough (OPE-257): the PR's state, its unified diff, and the resolved-config facts CI computed, fetched from the config-diff workflow's own ARTIFACT. Same class and same bound as get_pr_feedback next to it — one read-scoped credential, disclosure bounded by the channel's repo grant (membership is the ACL), every body size-capped and reported when clipped, and the diff shipped inside the untrusted fence. Two properties beyond that are worth stating because they are the reason this tool is safe to leave open: its input schema is EXACTLY {repo, number}, so a session cannot add its own framing to the brief the independent reviewer reads; and it fetches facts from a workflow artifact rather than a PR comment, because anyone who can comment on a PR could forge one. It escapes nothing, arms nothing, and cannot merge",
  ),
  post_pr_walkthrough: open(
    "renders the PR walkthrough HOST-SIDE and delivers it to the ONE config-declared governance admin channel the access-request and webhook-declare flows already notify (OPE-257). Audience does leave the asking room, so the tier is a real decision rather than a reflex: what makes it open is that the model chooses neither the venue (there is no channel input) nor the facts (they are re-fetched here from CI's artifact and are not an input at all) — it supplies only the fresh_eyes_review verdict, every string of which is collapsed to one line by approvals/review-surface.ts and rendered inside a block labelled as a model opinion. Nothing is armed, granted, stored as policy or merged: the tool posts a document, and there is no approve/merge/submit-review call anywhere in it. A member card asking permission to put a governance note into the channel whose job is receiving governance notes would buy nothing, and friction that buys nothing is how a control gets routed around. The residual — that a session can cause one message per PR into a channel of admins — is a noise property bounded by the fixed venue plus the room's existing audience floor, not a privilege one",
  ),
  checkout_repo: open("read into the sandbox with a read-only credential; the write path is open_pull_request"),
  describe_image: open("read/vision over an attachment already in the room"),
  list_repos: open("read of this channel's own grant"),
  list_routines: open("read of this surface's own routines"),
  read_routine_transcript: open(
    "read of a routine run that happened IN THIS CHANNEL (OPE-153). Tiered against read_channel, deliberately, because it is the same shape: a read of content this room could already see, into the room that could already see it — membership is the ACL, and the reach is narrower than read_channel's (that one reads any channel the DOMAIN grants; this one is pinned to the caller's own partition by the scope of the fire lookup, routines/fire-audit.ts listRoutineFires). It escapes nothing, changes nothing, and reaches no external host. It is NOT open on a 'reads are always open' reflex: the transcript is a SUPERSET of what the room saw (it carries what the fire INGESTED), so the control that matters is not a tier but the untrusted fence re-applied on the way out, plus the OPE-73 projection that makes the fence reach the model — both in tools/read_routine_transcript.ts, both tested. A tier would have gated WHO may read; neither the tier nor the approver would have neutralised the ingested bytes",
  ),
  list_skills: open("read of the domain's own skills"),
  read_docs: open(
    "read of OE's OWN shipped manual, compiled into the bundle (OPE-138). First-party prose about the product, identical for every member of every deployment that carries the same bundles — it discloses nothing about this org, reaches no external host, and changes nothing, so it fails all three rubric axes harder than any other read here. The provider scoping it applies is a RELEVANCE + non-disclosure boundary (a deployment without the Notion bundle is never handed Notion's runbook), not an access tier",
  ),
  read_file_upload: open("read/decode of a text upload already in the room; bot-token fetch is host-pinned to Slack, type-allowlisted, size-capped, content ingested untrusted"),
  read_notion_page: open("granted read; disclosure is bounded by the room-level grant (membership is the ACL)"),
  read_notion_comments: open("granted read of page comments/inline discussions; bounded by the room-level grant (membership is the ACL)"),
  read_linear_issue: open("granted read of an issue's body + comment thread via the workspace token; bounded by what that token is shared into (membership is the ACL)"),
  add_label: open("trivially reversible (react-class — un-label is one more add_label call away); entity-gated to ticketing surfaces (Linear/GitHub), audited per call"),
  read_channel: open("generic channel read (Stage 2): a read of a channel the domain grants, into that conversation; per-platform gated by X ∈ sources in execute"),
  read_thread: open("generic thread read (Stage 2): same-surface thread read of a domain-granted channel; per-platform gated in execute"),
  read_slack_channel: open("read of a channel the bot is already in, into that conversation"),
  read_slack_thread: open("same-surface thread read"),
  session_cost: open("read of this session's own spend"),
  spend_report: open("aggregate read; the org-wide scope additionally requires org-admin inside spend/reporting.ts's resolveReportScope"),
  usage_report: open("aggregate read; same shared resolveReportScope gate as spend_report for org scope"),
  query_analytics: open(
    "constrained analytics read (OPE-66): the model forms a structured query object (never SQL) over a fixed schema; org scope + rows mode are gated inside via access/analytics-scope.ts's resolveAnalyticsScope, and tainted/ambient turns degrade to aggregates — same in-tool-gating shape as spend_report. Every call + refusal is audited (analytics.query / analytics.refused)",
  ),
  web_fetch: open("read via the egress allowlist; default-deny hosts bound what it can reach"),

  no_reply: open("ends the turn silently; posts nothing"),
  react: open("an emoji in the asking room"),
  reply: open("a visible, ordinary reply in the asking room — same class as the terminal text it replaces; audited"),
  update_status: open("ephemeral status line in the asking room"),
  connector: open(
    "posts connect OPTIONS (a Block Kit card on Slack, links on other surfaces) for a provider — same class as a reply. It stores no secret and grants nothing itself; the CONSEQUENTIAL acts (minting an org-level OAuth URL, opening the api-key intake) happen host-side at the CLICK, where standing is re-verified (connections/connector-card.ts) — the model is never in that loop, and org-level/personal options a requester can't use are OMITTED from the card, not shown-and-refused. resolveRole is read only to omit, never to refuse, so no in-tool gate",
  ),
  browser_tools: open(
    "the resolver FILE that mounts the flag-gated agent-browser tool family (access/browser-toolkit.ts, OPE-43); mounts nothing under its own name. The injected browser_* tools are a runtime-injected family (the connector-op precedent): each is open on the bash rationale — in-sandbox execution whose reach is bounded by the OPERATOR's OE_AGENT_BROWSER_DOMAINS allowlist enforced twice (agent-browser containment + the egress firewall), never by this table",
  ),
  post_file: {
    tier: "open",
    via: { kind: "eve-hitl" },
    reason:
      "posts a file into the asking room (same class as reply). The input-aware eve confirmation on the " +
      "HTML-artifact publish path is a session-private UX confirm, not an authorization gate — blessed as " +
      "the eve-HITL residue by design §7.2 (the artifact URL is org-opt-in and unlisted).",
  },

  cancel_routine: member("routine.cancel", "behaviour-persisting removal: silently cancelling a watch/schedule removes a guardrail the surface relies on; reversible by re-creation, but a human confirms"),
  edit_routine: member(
    "routine.edit",
    "self-modification at instruction granularity (OPE-147): rewrites the TRUSTED text a standing routine hands to unattended future fires — the create_routine rubric applied to the moment that text changes, which is the moment a human must read it. The card renders before AND after, which cancel+create could not. Confirming also bumps the routine's authority generation, revoking every standing grant keyed on the old text, so an edit can never launder approvals onto an instruction nobody read",
  ),
  enable_routine: member(
    "routine.enable",
    "re-arming standing autonomy (OPE-147): after the click the routine fires again with no human present, indefinitely — the same property routine.create is gated on, and having been armed once before does not make the second arming unattended-safe (whatever it was failing on may be exactly why it should stay off). The card names the disable reason, so the clicker confirms a diagnosis rather than pressing a button",
  ),
  delete_skill: member("skill.delete", "behaviour-persisting removal: silently deleting a shared domain skill/runbook removes a guardrail; reversible by re-creation, but a human confirms"),
  add_routine_rule: member(
    "routine.policy.add",
    "self-modification at RULE granularity (OPE-141): arms a standing instruction that is rendered as TRUSTED text into every future unattended fire of one routine, indefinitely — the create_routine/edit_routine rubric axis, scoped to a clause instead of the whole prompt, and with a longer reach than either because it is never re-read by anyone once armed. Deliberately NOT a lighter gate than edit_routine despite touching less text: what makes an instruction consequential here is that an unwatched run obeys it, which is equally true of one sentence. The card is not the load-bearing control — this tool HARD-REFUSES on a tainted turn (unlike remember/create_routine/edit_routine, which warn and card) and HARD-REFUSES inside a routine fire (the host-set ROUTINE_MARKER stamp), so no run can amend its own doctrine and no fetched content can reach a card; it is also absent from JOB_WAKE_TOOLS. Those refusals are what buy the right to render the block trusted at all",
  ),
  remove_routine_rule: member(
    "routine.policy.remove",
    "behaviour-persisting removal (OPE-141): dropping a standing rule silently takes away a guardrail a human armed after an incident, and every later fire stops following it with no notice — the cancel_routine/delete_skill shape, reversible by re-adding, but a human confirms against the rule's stated reason. It carries add_routine_rule's tainted-turn and routine-fire refusals for a sharper reason than symmetry: stripping the rule written to stop an attack is an easier act than authoring a malicious one. There is deliberately no edit verb — an edit is remove + add, two cards, so each wording is read on its own and no rule's provenance is mutated under a rewrite",
  ),

  declare_webhook: member(
    "webhook.declare",
    "proposes an inbound webhook in either shape: FUSED (an ingress bound to a standing instruction and a named channel, which runs unattended with that channel's full existing access on anyone's POST, indefinitely) or EMIT-ONLY (an ingress and nothing else, whose consequences are decided later by separately-approved `event` routines). Which is exactly why this tool arms nothing: approving OPENS A PULL REQUEST, and the privilege gate is the MERGE, behind branch protection + CODEOWNERS on the config repo. An unmerged PR declares nothing, and even a merged one authenticates nobody until the signing secret exists — no secret is minted, seen, or transported by this flow, so there is no disclosure axis and no private-delivery precondition (arming a `broker: \"db\"` hook's value is rotate_webhook's separate, card-gated act). Same tier and same two-step as request_access, whose flow it reuses. HARD-REFUSES on a tainted turn: a durable external wake path aimed at a named channel is the act no card text can honestly anchor once the request originated in fetched content",
  ),
  rotate_webhook: member(
    "webhook.rotate",
    "mints and DISCLOSES a signing secret for an ingress a merged PR ALREADY declared — it widens nothing (no new endpoint, no new authority, no new audience), and the DISCLOSURE is the whole reason for the bar. It is also the only way a `broker: \"db\"` hook ever gets a value at all, which is what lets a declared hook go live without a redeploy; refused by name for any other broker, whose value is set outside this deployment. This is likewise the ONLY recovery path, deliberately: there is no re-reveal anywhere in the design, because a re-reveal is indistinguishable in the audit log from exfiltration of a live secret. Whether the superseded key keeps working is the DECLARATION's own choice — a second `secretRef` entry is the overlap, ended by a PR rather than a timer — so the model cannot choose that window either. Hard-refuses on taint: no card text can honestly anchor a request to mint a live signing secret when the request originated in fetched content",
  ),
  list_webhooks: open(
    "read of this deployment's OWN declared inbound-webhook inventory: id, scheme, shape (fused vs emit-only), target, posture, read grant. NEVER a secret ref — a pointer straight at the vault row — and tools/list_webhooks.ts projects field-by-field so a new field on the hook type cannot silently join the disclosure. The hook id IS returned and that is not a relaxation: a declared id is a short human-chosen token merged in a reviewed diff and printed in the repo, unlike the deleted chat-created class's ids which were 128 random bits and WERE the endpoint URL. Same tier and same reasoning as list_routines: membership IS the read tier for a surface's own standing behaviour",
  ),
  read_webhook_history: open(
    "read of ONE hook's delivery metadata over the last 7 days (OPE-212) — timestamps, byte counts, verification grade, delivery ids, fan-out counts, and the closed skip reasons its subscribed routines recorded. It escapes nothing, changes nothing and reaches no external host, and it is strictly narrower than list_webhooks next to it: that one enumerates the whole inventory to any member, this one answers about a SINGLE hook and only when the hook's own `readableBy` grants this surface — the SAME check (`resolveAccessForPartition` + `scopeGrantsRead`) that decides whether a routine here could have been FIRED by it. So the tier is not the control here and would be the wrong one: `readableBy` is a per-hook confidentiality decision an admin already made, and a member/admin gate on top would either shadow it or contradict it. THIS tool discloses no payload body — it stores none and reads none; the separate, explicitly-armed capture window (list_recent_events) is the only thing in the tree that retains payload-derived values, and it is a different table, a different tool and a different arming act. The two off-host strings this one can echo — a vendor rejection text, jq's evaluator message — are length-capped and the whole page ships through the untrusted fence",
  ),
  list_recent_events: open(
    "read of ONE hook's CAPTURED DELIVERIES (OPE-211) — the numbered jq filter documents retained while a capture window was armed, optionally scored against a candidate filter (OPE-184 Half 2). This is the ONE read in the tree that returns payload-derived values, so the honest statement of its reach is: it shows `{event, action, scope, fields}` exactly as a filter would see them, for deliveries INCLUDING ones that matched no routine and that therefore nobody has previously read. It is nonetheless `open` for the same reason read_webhook_history above is, and the reason is not tier laziness: the control is the hook's own `readableBy`, checked with the SAME `resolveAccessForPartition` + `scopeGrantsRead` pair that decides whether a routine here could have been FIRED by this hook. A room holding that grant is already authorized to read this hook's events; showing it the ones that matched nothing widens WHICH events it sees, not WHOSE — it stays strictly inside a per-hook confidentiality decision an admin already took, and a member/admin gate on top would shadow or contradict that decision rather than tighten it. What is NOT reachable here bounds the rest: never the raw body, never the headers (so never a signature or a bearer token), never the rendered `summary`, because none of them are in the stored document at all. Nothing escapes, nothing changes, no external host is reached, and the whole rendering ships through the untrusted fence — which on this tool is load-bearing rather than ceremonial, since attacker-authored bytes ARE the content it exists to show",
  ),
  capture_events: open(
    "ARMS a bounded capture window on ONE hook (OPE-211), after which its deliveries' filter documents are retained until the window closes. It reaches no external host, emits nothing, mints and discloses no secret, and DISCLOSES NOTHING AT THE MOMENT IT RUNS — it changes what a later, separately-gated read can show. Gated by the hook's own `readableBy`, the SAME check applied to the read, deliberately: arming is what creates the thing reading discloses, so a weaker gate on the write than on the read would let a room cause retention it cannot itself inspect. `open` rather than gated for the same reason as its two neighbours — `readableBy` is the per-hook confidentiality decision and a tier on top would shadow it — and the retention it starts is bounded IN CODE three independent ways (a row cap, a wall-clock ceiling the caller cannot exceed, and an absolute sweep that runs regardless of both), self-expiring with no operator action. REFUSED BY NAME for `trigger-only` hooks, whose whole posture is that payloads are never retained; that refusal is the reason this tool cannot be used to route around a posture. Re-arming CLEARS the previous window, so it is also the forget action",
  ),

  record_watch_state: open("writes watch bookkeeping onto the calling routine's OWN row, located via the dispatcher-stamped marker"),
  report_run_failed: open(
    "a fire declaring that ITS OWN run did not do its work (OPE-177) — writes `lastOutcome: failed` plus a capped one-line reason onto the calling routine's OWN row (marker-located, never a supplied id), which the three-strike fold then honours. It is the only routine verb whose entire reach is to make the routine do LESS: it cannot post, cannot widen anything, and its worst case is a routine that stops early and announces that it did. Gating it would put a confirmation in front of the honesty mechanism, on a path with no human present to click it. The declared text is model-authored and quarantined to the audit rows, never to the host-composed disable notice",
  ),
  record_job_state: open("writes a durable-job's progress ledger onto the calling job's OWN row (OPE-55), located via the dispatcher-stamped marker; cap-bounded, aims at nobody else"),
  complete_job: open(
    "a durable job declaring ITSELF done and retiring (OPE-55) — flips its OWN row (marker-located, never a supplied id) to the terminal `done` status; reaching a job's intended done-state from inside its own run, not a guardrail removal (cancel_routine is that). Reversible by re-creating the job; audited (routine.complete)",
  ),
  subscribe_pr: open(
    "arms a self-serve check-back whose routine prompt is CODE-templated (subscribePrPrompt) from grant-validated inputs — the model authors no routine text, incl. the re-arm, which loops through this SAME tool, never create_routine; posts stay in the arming surface; READ-scoped credential only; the chain is hard-capped (MAX_CHECKS_PER_SUBSCRIPTION, budget carried on the routine ROW so a prompt rewrite can't reset it) and self-retires on merge/close; cancellable with cancel_routine, which stays the ONLY manual off switch (a `stop` param here would be a second, ungated removal path)",
  ),
  run_routine_now: open(
    "brings a routine's ALREADY-ARMED run forward (OPE-147): sets nextRunAt to now so the ordinary dispatcher tick fires it — no new fire path, no new audience, no new authority, and every consequential thing the fired turn attempts re-gates on its own. The prompt is the one a human already read on the routine.create card, and the schedule is unchanged. Host-rate-limited to one manual run per routine per dispatcher tick, audited (routine.run_now with the real requester; the resulting fire's routine.fire row carries manual:true), and it REFUSES without a verified principal — so a fire, which has none, can never re-trigger itself or another routine",
  ),
  revoke_routine_permissions: open(
    "de-escalation only (OPE-152): withdraws a routine's STANDING permissions so it goes back to drawing an approval card for every gated action, leaving the routine itself running. There is no configuration in which it widens anything — after it runs the routine can do strictly less unattended — so gating it would put a confirmation in front of the brake pedal. It still REFUSES without a verified principal, for attribution (the routine.grants_revoked audit row names who withdrew them), and the grants it deletes were each minted by a human's click in the first place",
  ),
  extend_workspace_time: open("extends this session's own sandbox window; capped (OE_SANDBOX_EXTEND_MAX_MIN) and audited"),
  spawn_task: open(
    "delegation: mints an async thread-grain worker and dispatches to it, non-blocking. Escapes nothing this table doesn't re-gate INSIDE the child (egress + every L2 consequence gate fire again there); widens hands, not consequence, and delegation IS the standing seat's job — so open, fully audited (task.spawned). Taint is forwarded onto the child, not gated here",
  ),
  complete_task: open(
    "a task worker releasing its own thread's ownership — the next message then wakes the standing seat instead. Reversible (the seat re-spawns), touches no memory/spend/audience beyond the ownership index; a conversational verb, audited (task.completed)",
  ),
  spawn_thread_session: open(
    "presence (§B1, Stage T2): mints a persistent CONVERSATIONAL thread seat (narrow hands) and dispatches to it, non-blocking. Widens PRESENCE, not consequence — the seat has no wide hands and re-gates every L2 consequence itself; delegation/presence IS the standing seat's job. Open, fully audited (thread_seat.spawned); taint forwarded onto the child, not gated here",
  ),
  complete_thread: open(
    "a thread seat releasing its own thread's ownership — the next message then wakes the standing seat instead. Reversible (the seat re-opens), touches no memory/spend/audience beyond the ownership index; a conversational verb, audited (thread_seat.completed)",
  ),
  return_result: open(
    "a one-shot task worker reporting its result back to the seat that delegated it (delegation reshape, Phase 1): writes the durable result row + wakes the CALLER's OWN seat with the caller's OWN forwarded identity — no new audience. The summary rides untrusted-wrapped, so a consequential action the caller takes off it re-gates via the normal ingest-taint path. Widens nothing; audited (task.returned)",
  ),
  agent: open(
    "delegation (reshape): both modes spawn a full-hands ONE-SHOT worker on a credential-correct new session (same rationale as spawn_task — re-gates every L2 consequence INSIDE the child, forwards taint, widens hands not consequence). async returns at once and the worker wakes the caller with its result; sync HOLDS FOCUS and block-polls the durable result row, returning it inline (degrading to async on MAX_WAIT). Escapes nothing this table doesn't re-gate in the worker; audited via task.spawned",
  ),
  delegation_tools: open(
    "the resolver FILE that re-provides the disabled framework-named `agent` per session grain (access/window-gated.ts windowGatedKit — the sandbox_tools shape); mounts nothing beyond the `agent` name above, at its own open tier",
  ),

  create_skill: member("skill.create", "self-modification: a skill is a procedure the agent will load and FOLLOW by name (persistent RCE-of-behaviour)"),
  create_routine: member("routine.create", "self-modification: a standing scheduled behaviour that outlives the turn"),
  remember: member(
    "memory.remember",
    "self-modification, CONDITIONAL: a plain fact writes directly (not consequential); a standing RULE or any fact from a tainted turn freezes onto a card",
  ),
  forget: member("memory.forget", "hard-to-reverse: destroys memory (and the frozen args carry only the bullet's hash — GDPR redaction)"),
  open_pull_request: member(
    "pr.open",
    "audience-expanding: a PR reaches repo watchers, CI and reviewers beyond the asking room; commits stage on a hidden ref and publish only on the click",
  ),
  request_access: member("access.request", "audience-expanding: sends a grant request (a bot PR + admin-channel note) beyond the asking room; the merge stays the privilege gate"),
  set_state: member("ticket.set_state", "audience-expanding: a ticket's state change (e.g. close/reopen) is visible to every watcher of the entity (repo/team members, CI, other assignees), not just the asking room"),
  assign: member("ticket.assign", "audience-expanding: assignment makes the entity someone's explicit responsibility, visible to the whole team/repo, not just the asking room"),
  create_ticket: member(
    "ticket.create",
    "audience-expanding: a filed work item reaches every watcher of the repo/team, its triage automation and its subscribers — none of them in the asking room — and the model authors the title + body, so the card (which renders both in full) is the injection gate before that text is published",
  ),

  set_spend_limit: admin("spend.set", "self-modification + money: changes what the org will spend"),
  clear_spend_limit: admin("spend.clear", "reverts a spend control — same bar as setting one"),
  revoke_connector: admin("connector.revoke", "kills a live capability for a scope — an org-level control change"),
  clear_connector_override: admin("connector.clear", "re-arms a revoked capability — same bar as the revoke"),
  memory_admin_list: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    reason: "audience-expanding read: enumerates silos beyond this room's own memory — role-scoped disclosure (access/roles.ts adminControlRoles)",
  },
  memory_admin_read: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    reason: "audience-expanding read: pulls another room's silo contents into this one — role-scoped disclosure",
  },
};

export interface ToolSource {
  readonly name: string;
  readonly source: string;
}

const REQUEST_APPROVAL = /\brequestApproval\s*\(/;
const ADMIN_ROLES = /\brequireOrgAdmin\s*\(|\brequireDomainAdminOrOrg\s*\(|\badminControlRoles\s*\(/;
const EVE_HITL = /^\s*approval:(?!\s*never\()/m;

export function checkConsequenceRegistry(
  tools: readonly ToolSource[],
  frameworkToolNames: readonly string[],
  policyOf: (action: string) => "admin" | "member" | undefined,
  registry: Readonly<Record<string, ConsequenceEntry>> = TOOL_CONSEQUENCE,
  subagentNames: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const authored = new Set(tools.map((t) => t.name));

  for (const tool of tools) {
    seen.add(tool.name);
    const entry = registry[tool.name];
    if (!entry) {
      problems.push(
        `tool "${tool.name}" has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (there is deliberately no default tier)`,
      );
      continue;
    }

    const hasPropose = REQUEST_APPROVAL.test(tool.source);
    const hasRoles = ADMIN_ROLES.test(tool.source);
    const hasHitl = EVE_HITL.test(tool.source);

    switch (entry.via.kind) {
      case "none":
        if (entry.tier !== "open") {
          problems.push(`tool "${tool.name}" declares ${entry.tier} with NO gating mechanism — an under-gated declaration; wire a gate or re-tier it`);
        }
        if (hasPropose || hasRoles || hasHitl) {
          problems.push(
            `tool "${tool.name}" is declared open/ungated but its source carries a gating construct (${[hasPropose && "requestApproval", hasRoles && "admin-roles check", hasHitl && "eve approval:"].filter(Boolean).join(", ")}) — update its TOOL_CONSEQUENCE row so the change is a visible diff`,
          );
        }
        break;
      case "action-kind": {
        if (!hasPropose) {
          problems.push(`tool "${tool.name}" declares ${entry.tier} via ActionKind "${entry.via.action}" but its source never calls requestApproval — the gate is not actually wired (under-gated)`);
        }
        if (!tool.source.includes(`"${entry.via.action}"`)) {
          problems.push(`tool "${tool.name}" declares ActionKind "${entry.via.action}" but its source never names that kind — the registry row points at a gate the tool doesn't use`);
        }
        const policy = policyOf(entry.via.action);
        if (policy === undefined) {
          problems.push(`tool "${tool.name}" declares ActionKind "${entry.via.action}" but no such kind is registered (approvals/actions.ts) — the propose would throw at runtime`);
        } else {
          const expected = entry.tier === "gate:admin" ? "admin" : entry.tier === "gate:member" ? "member" : null;
          if (expected === null) {
            problems.push(`tool "${tool.name}" declares tier "open" via an ActionKind — a gated mechanism needs a gate:* tier`);
          } else if (policy !== expected) {
            problems.push(
              `tool "${tool.name}" declares ${entry.tier} but ActionKind "${entry.via.action}" registers ApproverPolicy "${policy}" — the declaration and the runtime gate disagree`,
            );
          }
        }
        break;
      }
      case "admin-roles":
        if (entry.tier !== "gate:admin" && entry.tier !== "open") {
          problems.push(`tool "${tool.name}" declares ${entry.tier} via admin-roles — that mechanism enforces admin standing, so the tier must be gate:admin (or open for a partial, in-tool check)`);
        }
        if (!hasRoles) {
          problems.push(`tool "${tool.name}" declares an admin-roles gate but its source has no requireOrgAdmin/requireDomainAdminOrOrg/adminControlRoles call (under-gated)`);
        }
        break;
      case "eve-hitl":
        if (entry.tier !== "open") {
          problems.push(
            `tool "${tool.name}" declares ${entry.tier} via eve-hitl — eve HITL has no approver-standing check, so it cannot carry a gate:* tier (design §7.2); route it through an ActionKind`,
          );
        }
        if (!hasHitl) {
          problems.push(`tool "${tool.name}" declares eve-hitl but its source sets no non-never \`approval:\` policy — the confirmation is not actually wired`);
        }
        break;
    }
  }

  for (const name of frameworkToolNames) {
    if (authored.has(name)) continue;
    seen.add(name);
    const entry = registry[name];
    if (!entry) {
      problems.push(
        `framework tool "${name}" is mounted by eve at runtime but has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (fail-closed: a mounted tool can't be un-tiered)`,
      );
      continue;
    }
    if (!(entry.tier === "open" && entry.via.kind === "none")) {
      problems.push(
        `framework tool "${name}" is declared ${entry.tier}/${entry.via.kind} — a framework tool OE doesn't author has no source to scan and no ActionKind of its own, so it must be open/none. To gate it, ship an agent/tools/${name}.ts override (which moves it onto the scanned path).`,
      );
    }
  }

  for (const name of subagentNames) {
    if (authored.has(name)) continue;
    seen.add(name);
    const entry = registry[name];
    if (!entry) {
      problems.push(
        `declared subagent "${name}" (agent/subagents/${name}/) is mounted as a model-visible tool but has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (fail-closed: a mounted tool can't be un-tiered)`,
      );
      continue;
    }
    if (!(entry.tier === "open" && entry.via.kind === "none")) {
      problems.push(
        `declared subagent "${name}" is declared ${entry.tier}/${entry.via.kind} — a subagent has no tool source to scan and no ActionKind of its own, so it must be open/none. Gate what the SUBAGENT can do via agent/subagents/${name}/tools/ instead.`,
      );
    }
  }

  for (const name of Object.keys(registry)) {
    if (!seen.has(name)) {
      problems.push(
        `TOOL_CONSEQUENCE registers "${name}" but it is neither an authored tool file nor a mounted framework tool — remove the row or fix the name (a stale row hides a real gap)`,
      );
    }
  }

  return problems;
}
