export type ConsequenceTier = "open" | "gate:member" | "gate:admin";

export const CONNECTOR_READ_VERBS: readonly string[] = [
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

const RESERVED_TOOL_NAMESPACES: ReadonlySet<string> = new Set(["grant"]);

export function isReservedNamespaceTool(toolName: string): boolean {
  const segments = toolName.split("__");
  return segments.length >= 2 && RESERVED_TOOL_NAMESPACES.has(segments[0] ?? "");
}

export interface QualifiedToolName {
  readonly namespace?: string;
  readonly owner?: string;
  readonly connection?: string;
  readonly verb: string;
}

export function parseQualifiedToolName(toolName: string): QualifiedToolName | undefined {
  const segments = toolName.split("__");
  if (segments.length < 2) return undefined;
  const verb = segments[segments.length - 1] ?? "";
  const head = segments[0] ?? "";
  if (RESERVED_TOOL_NAMESPACES.has(head)) {
    if (segments.length !== 3) return undefined;
    return { namespace: head, owner: segments[1] ?? "", verb };
  }
  return { connection: segments.slice(0, -1).join("__"), verb };
}

export function classifyConnectorOp(toolName: string): "open" | "gate:member" {
  return classifyConnectorOpTier(toolName) === "read" ? "open" : "gate:member";
}

export type ConnectorOpTier = "read" | "write" | "destructive";

export const CONNECTOR_DESTRUCTIVE_VERBS: readonly string[] = ["delete", "remove", "destroy", "drop", "purge", "trash", "erase", "wipe"];

export const CONNECTOR_WRITE_VERBS: readonly string[] = [
  "create", "update", "add", "append", "insert", "post", "put", "patch", "set", "move", "comment", "edit",
  "write", "upload", "send", "assign", "label", "rename", "duplicate", "copy", "publish", "share", "invite",
  "mark", "complete", "close", "reopen", "merge", "approve", "submit", "reply", "star", "upsert", "modify",
  "replace", "attach", "link", "unlink", "restore", "archive", "unarchive", "unpublish", "revoke", "cancel",
];

function connectorOpVerbTokens(toolName: string): string[] {
  const sep = toolName.indexOf("__");
  if (sep < 0) return toolName.toLowerCase().split(/[_-]/);
  const parsed = parseQualifiedToolName(toolName);
  if (parsed === undefined) return [];
  let verb = parsed.verb.toLowerCase();
  if (sep > 0) {
    const conn = toolName.slice(0, sep).toLowerCase();
    if (verb.startsWith(`${conn}-`) || verb.startsWith(`${conn}_`)) verb = verb.slice(conn.length + 1);
  }
  return verb.split(/[_-]/);
}

function connectorPathTokens(toolName: string): string[] {
  const parsed = parseQualifiedToolName(toolName);
  if (parsed === undefined || parsed.connection === undefined) return [];
  const segments = parsed.connection.split("__");
  return segments.slice(1).join("__").toLowerCase().split(/[_-]/);
}

export function classifyConnectorOpTier(toolName: string): ConnectorOpTier {
  let best: ConnectorOpTier | undefined;
  for (const token of connectorOpVerbTokens(toolName)) {
    if (CONNECTOR_DESTRUCTIVE_VERBS.includes(token)) return "destructive";
    if (CONNECTOR_WRITE_VERBS.includes(token)) best = "write";
    else if (best === undefined && CONNECTOR_READ_VERBS.includes(token)) best = "read";
  }
  for (const token of connectorPathTokens(toolName)) {
    if (CONNECTOR_DESTRUCTIVE_VERBS.includes(token)) return "destructive";
    if (best === "read" && CONNECTOR_WRITE_VERBS.includes(token)) best = "write";
  }
  return best ?? "destructive";
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
  | { readonly kind: "eve-hitl" }
  | {
      readonly kind: "delegated-roles";
      readonly helper: string;
      readonly module: string;
    };

export interface ConsequenceEntry {
  readonly tier: ConsequenceTier;
  readonly via: GatingMechanism;
  readonly reason: string;
  readonly judgeDefer?: true;
  readonly taint?: "gate" | "disclose";
  readonly postTurnSurface?: PostTurnSurface;
}

type TaintTolerance = "gate" | "disclose";

export type PostTurnSurface = "arms" | "disarms" | "templated" | "none";

export function postTurnSurfaceFloors(surface: PostTurnSurface | undefined): boolean {
  return surface === "arms" || surface === "disarms";
}

const open = (reason: string): ConsequenceEntry => ({ tier: "open", via: { kind: "none" }, reason });
const delegated = (helper: string, module: string, reason: string): ConsequenceEntry => ({
  tier: "open",
  via: { kind: "delegated-roles", helper, module },
  reason,
});
const member = (action: string, taint: TaintTolerance, reason: string): ConsequenceEntry => ({ tier: "gate:member", via: { kind: "action-kind", action }, taint, reason });
const admin = (action: string, taint: TaintTolerance, reason: string): ConsequenceEntry => ({ tier: "gate:admin", via: { kind: "action-kind", action }, taint, reason });
const deferToJudge = (entry: ConsequenceEntry): ConsequenceEntry => ({ ...entry, judgeDefer: true });
const postTurn = (surface: PostTurnSurface, entry: ConsequenceEntry): ConsequenceEntry => ({ ...entry, postTurnSurface: surface });

export const TOOL_CONSEQUENCE: Readonly<Record<string, ConsequenceEntry>> = {
  bash: open("sandbox execution; reach is bounded by the egress plane (L1), not by this table"),
  aws: open(
    "runs an `aws` CLI command host-side under a bundle-granted, identity-bound IAM role (tools/aws.ts). Reach is bounded NOT by this table but by the role's IAM policy AND the grant's REQUIRED `allow` command list — the reviewed per-scope `awsRoles` grant (access/bundle.ts) chooses WHICH role, its IAM policy scopes WHAT it can do, and `allow` narrows WHICH commands host-side (compiled to an STS session policy on the domain-role mint path), all default-deny and reviewed-git. The tool is inert until an operator wires an AWS adapter AND binds an awsRoles grant, and fails closed on any scope with none; a fire cannot assume a human's SSO identity. Credentials are minted host-side, never enter the sandbox, and CANNOT BE ECHOED BY THE CLI ITSELF — the approver-chain screen (access/aws-screen.ts) refuses `configure export-credentials`/`list` and `--debug` unconditionally and screens the whole argv for request-redirect options, which is what makes 'the model never sees them' a fence property rather than a wish. Ungated (window-gate-manifest.ts) for the same reason it is open here: its control is the grant + the IAM role + the screen, not the seat. A per-call card would gate reads it shouldn't and still not bound a write the role permits — an operator who wants per-call approval scopes the role read-only",
  ),
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

  task_update: open(
    "writes a one-line status message onto the CALLING task's own row — the same shape as record_job_state next door: bookkeeping about itself, located from the running task rather than a supplied id, aimed at nobody else",
  ),
  task_cancel: open(
    "stops delegated work this session itself spawned — de-escalation only, the same posture as revoke_routine_permissions and stand_down. After it runs the agent can do strictly LESS, so a card here would put a confirmation in front of the brake pedal. It cannot reach another session's task: eve validates the ids against this session's own receipts",
  ),

  fresh_eyes_review: open(
    "declared subagent: an independent review pass over text the caller already holds. Zero tools (disableTool() sentinel set, lint-pinned), no sandbox reach, no audience — the verdict returns into the calling session only",
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
  read_notion_page: open(
    "granted read; disclosure is bounded by the room-level grant (membership is the ACL). OPE-913 added a WORK plane: a session whose DOMAIN declares a Notion work credential reads that domain's pages from any surface, on that credential. It widens which SURFACES may read, never which PAGES — the target still has to land in the caller's own domain — and a work-plane read carries no vouched workspace tier, so it taints",
  ),
  notion_search: open(
    "granted read of page/database TITLES and ids — never page content (OPE-913). Reach is the WORK credential's reach, which Notion enforces itself (an integration sees only the trees a human shared with it), and the tool mounts only where the domain declares that credential. Reading anything it finds still costs a second, domain-fenced call",
  ),
  search: open(
    "the federated cross-surface search verb (OPE-929 piece 3 / OPE-961) — the same shape as notion_search above, generalised: granted read of TITLES and ids only, never body content, across whichever connectors the caller's domain holds a work grant on. Reach on each connector is that connector's own credential reach (never a post-hoc filter); `insideDomain` narrows the QUERY as a convenience and cannot widen anything. Reading anything a hit points at still costs a second, domain-fenced call (read_notion_page, read_linear_issue, check_pr_status, ...)",
  ),
  read_notion_comments: open("granted read of page comments/inline discussions; bounded by the room-level grant (membership is the ACL)"),
  read_linear_issue: open("granted read of an issue's body + comment thread via the workspace token; bounded by what that token is shared into (membership is the ACL)"),
  add_label: open("trivially reversible (react-class — un-label is one more add_label call away); entity-gated to ticketing surfaces (Linear/GitHub), audited per call"),
  read_channel: open("the channel read: a read of a channel the domain grants, into that conversation; per-platform gated by X ∈ sources in execute"),
  read_thread: open("the thread read: same-surface thread read of a domain-granted channel; per-platform gated in execute"),
  read_work_channel: open(
    "the delegated worker's channel read (OPE-938): the SAME bytes read_channel returns from the SAME adapter and the same wake container, so it escapes nothing that verb does not. It is a narrower reach, not a wider one — it mounts only where the caller's domain declares the surface's work role (access/surface-work-grant.ts), where read_channel mounts on any window with sources",
  ),
  read_work_thread: open("the delegated worker's thread read (OPE-938) — same reach and same reasoning as read_work_channel, on the thread this turn arrived in"),
  session_cost: open("read of this session's own spend"),
  agent_version: open(
    "the running-version seam (OPE-991): a read of the deployment's OWN registered fact bag (commands/core.ts's AppInfo — the same one \"/oe status\" renders), never a repo read and never a guess. No principal in the output, nothing executed, nothing proposed — same class as explain_permission next to it",
  ),
  explain_permission: open(
    "the approver chain's PROSPECTIVE simulator (OPE-296 P6): resolves the REAL chain (access/approver-chain.ts) for a named tool in this scope and returns the verdict trace — the retrospective approval.chain audit row's twin, rendered by the same formatter. Strictly a simulation: it executes nothing, proposes nothing, posts nothing, writes nothing (not even an audit row — logging what-ifs would bury the rows that record decisions). Discloses only this scope's OWN policy — which elements/mode govern the surface the asker is already in — which is the legible-seam pitch itself ('you can see exactly what this domain can see, and who can ask it'); gating the explainer would make the policy less inspectable than the actions it governs",
  ),
  permission_fit_report: open(
    "permission homeostasis (OPE-297): a RETROSPECTIVE read of this domain's own grants against its own audit counts, returning PROPOSED config diffs. It proposes only — nothing is granted, revoked, gated or delayed by it, and the actuator is a reviewed config PR (merge is the privilege gate), so running it is never itself a consequential act. Open for `explain_permission`'s reason and one more: the whole output vocabulary is (tool, aws command label, refusal reason, connector op, integer count) with NO principal in it, so it discloses the shape of the scope's own authority — the legible-seam pitch — and not a single fact about a person. Gating a permission review behind an approval would make the review rarer than the drift it exists to catch",
  ),
  spend_report: delegated(
    "resolveReportScope",
    "packages/core/agent/spend/reporting.ts",
    "aggregate read; the org-wide scope additionally requires org-admin inside spend/reporting.ts's resolveReportScope. DECLARED as delegated-roles rather than left as an unqualified `open` (OPE-295 item 5): the gate is one import away, so the per-file scan could not see it, and a row that neither names the helper nor the module would read identically to a tool that had quietly stopped gating",
  ),
  usage_report: delegated(
    "resolveReportScope",
    "packages/core/agent/spend/reporting.ts",
    "aggregate read; the SAME shared resolveReportScope gate as spend_report for org scope — declared, so the two cannot drift apart and neither can silently lose it",
  ),
  query_analytics: delegated(
    "resolveAnalyticsScope",
    "packages/core/agent/access/analytics-scope.ts",
    "constrained analytics read (OPE-66): the model forms a structured query object (never SQL) over a fixed schema; org scope + rows mode are gated inside via access/analytics-scope.ts's resolveAnalyticsScope, and tainted/ambient turns degrade to aggregates — same in-tool-gating shape as spend_report, and declared for the same reason. Every call + refusal is audited (analytics.query / analytics.refused)",
  ),
  web_fetch: open(
    "read of the public web, executed HOST-SIDE — reach is bounded NOT by this table but by the egress plane, applied host-side by the web_fetch fence (access/web-fetch-fence.ts) against the same allow-list the sandbox firewall compiles from; eve additionally fences it to https + public destinations, and the read escapes nothing",
  ),

  no_reply: open("ends the turn silently; posts nothing"),
  react: open("an emoji in the asking room"),
  reply: open("a visible, ordinary reply in the asking room — same class as the terminal text it replaces; audited"),
  edit_reply: open(
    "rewrites the text of a message THIS agent already posted in the asking room, in place (OPE-793). It reaches nothing outside that conversation, adds no message and notifies nobody, and every surface that has the verb renders an edited marker, so the room sees the change. WHICH message it may touch is not a consequence question and is not decided here: the locus is host-resolved from the binding or the frozen wake origin, and the id must be in the own-post ledger (channels/own-post-ledger.ts) — a miss is refused and audited. Same class as `reply` above it; audited as `reply.edit`",
  ),
  update_status: open("ephemeral status line in the asking room"),
  connector: open(
    "posts connect OPTIONS (a Block Kit card on Slack, links on other surfaces) for a provider — same class as a reply. It stores no secret and grants nothing itself; the CONSEQUENTIAL acts (minting an org-level OAuth URL, opening the api-key intake) happen host-side at the CLICK, where standing is re-verified (connections/connector-card.ts) — the model is never in that loop, and org-level/personal options a requester can't use are OMITTED from the card, not shown-and-refused. resolveRole is read only to omit, never to refuse, so no in-tool gate",
  ),
  browser_tools: open(
    "the resolver FILE that mounts the flag-gated agent-browser tool family (access/browser-toolkit.ts, OPE-43); mounts nothing under its own name. The injected browser_* tools are a runtime-injected family (the connector-op precedent): each is open on the bash rationale — in-sandbox execution whose reach is bounded by the OPERATOR's browser.domains allowlist enforced twice (agent-browser containment + the egress firewall), never by this table",
  ),
  post_file: {
    tier: "open",
    via: { kind: "eve-hitl" },
    reason:
      "posts a file into the asking room (same class as reply). The input-aware eve confirmation on the " +
      "HTML-artifact publish path is a session-private UX confirm, not an authorization gate — blessed as " +
      "the eve-HITL residue by design §7.2 (the artifact URL is org-opt-in and unlisted). Its " +
      "`approval.response` policy (OPE-575) binds the Approve click to the session initiator; that " +
      "hardens the confirm, it does not make it a gate — no DENY, and no check on a cancel click.",
  },

  cancel_routine: postTurn("disarms", member("routine.cancel", "gate",
    "behaviour-persisting removal: silently cancelling a watch/schedule removes a guardrail the surface relies on; reversible by re-creation, but a human confirms. `disarms` (OPE-419), so a tainted turn is floored at that human decision: 'cancel the routine that watches for X' is the cheapest sentence a hostile page can plant, and it is the same act remove_routine_rule has been floored for since OPE-438",
  )),
  edit_routine: postTurn("arms", member("routine.edit", "gate",
    "self-modification at instruction granularity (OPE-147): rewrites the TRUSTED text a standing routine hands to unattended future fires — the create_routine rubric applied to the moment that text changes, which is the moment a human must read it. The card renders before AND after, which cancel+create could not. Confirming also bumps the routine's authority generation, revoking every standing grant keyed on the old text, so an edit can never launder approvals onto an instruction nobody read. `arms` (OPE-419): this row's own sentence — trusted text on an unwitnessed future run — IS the vector-1 predicate, so the taint floor that add_routine_rule carried for a CLAUSE now covers the whole prompt too",
  )),
  enable_routine: postTurn("arms", member("routine.enable", "gate",
    "re-arming standing autonomy (OPE-147): after the click the routine fires again with no human present, indefinitely — the same property routine.create is gated on, and having been armed once before does not make the second arming unattended-safe (whatever it was failing on may be exactly why it should stay off). The card names the disable reason, so the clicker confirms a diagnosis rather than pressing a button. `arms` (OPE-419): re-arming an unattended future run off fetched bytes is the act the floor exists for",
  )),
  delete_skill: postTurn("disarms", member("skill.delete", "gate",
    "behaviour-persisting removal: silently deleting a shared domain skill/runbook removes a guardrail; reversible by re-creation, but a human confirms. `disarms` (OPE-419) for cancel_routine's reason — a runbook that says 'never do Y' is exactly what a hostile page wants gone, and deleting it changes every future turn that would have loaded it",
  )),
  add_routine_rule: postTurn("arms", member("routine.policy.add", "gate",
    "self-modification at RULE granularity (OPE-141): arms a standing instruction that is rendered as TRUSTED text into every future unattended fire of one routine, indefinitely — the create_routine/edit_routine rubric axis, scoped to a clause instead of the whole prompt, and with a longer reach than either because it is never re-read by anyone once armed. Deliberately NOT a lighter gate than edit_routine despite touching less text: what makes an instruction consequential here is that an unwatched run obeys it, which is equally true of one sentence. This tool HARD-REFUSES inside a routine fire (the host-set ROUTINE_MARKER stamp), so no run can amend its own doctrine, and it is absent from JOB_WAKE_TOOLS. On a TAINTED turn it declares `taint: \"gate\"` (as every row whose `postTurnSurface` arms or disarms does; everywhere else a tainted turn merely DISCLOSES its provenance and the verdict is unchanged — OPE-307): the verdict is floored at a human decision, so no lowering can auto-approve it off fetched content and an unattended tainted run denies (OPE-438). The fire refusal plus that floor are what buy the right to render the block trusted at all. OPE-419 turned the four-name enumeration behind that floor into the DECLARED `postTurnSurface` column this row now carries, so a new tool that arms a future run joins the floor or fails the build",
  )),
  remove_routine_rule: postTurn("disarms", member("routine.policy.remove", "gate",
    "behaviour-persisting removal (OPE-141): dropping a standing rule silently takes away a guardrail a human armed after an incident, and every later fire stops following it with no notice — the cancel_routine/delete_skill shape, reversible by re-adding, but a human confirms against the rule's stated reason. It carries add_routine_rule's routine-fire refusal and its tainted-turn floor for a sharper reason than symmetry: stripping the rule written to stop an attack is an easier act than authoring a malicious one. There is deliberately no edit verb — an edit is remove + add, two cards, so each wording is read on its own and no rule's provenance is mutated under a rewrite",
  )),

  declare_webhook: postTurn("arms", member("webhook.declare", "gate",
    "proposes an inbound webhook in either shape: FUSED (an ingress bound to a standing instruction and a named channel, which runs unattended with that channel's full existing access on anyone's POST, indefinitely) or EMIT-ONLY (an ingress and nothing else, whose consequences are decided later by separately-approved `event` routines). Which is exactly why this tool arms nothing: approving OPENS A PULL REQUEST, and the privilege gate is the MERGE, behind branch protection + CODEOWNERS on the config repo. An unmerged PR declares nothing, and even a merged one authenticates nobody until the signing secret exists — no secret is minted, seen, or transported by this flow, so there is no disclosure axis and no private-delivery precondition (arming a `broker: \"db\"` hook's value is rotate_webhook's separate, card-gated act). Same tier and same two-step as request_access, whose flow it reuses. Declares `taint: \"gate\"`: a durable external wake path aimed at a named channel may never be auto-approved off fetched content, so a tainted turn is floored at a human decision and an unattended tainted run denies (OPE-438)",
  )),
  rotate_webhook: postTurn("arms", member("webhook.rotate", "gate",
    "mints and DISCLOSES a signing secret for an ingress a merged PR ALREADY declared — it widens nothing (no new endpoint, no new authority, no new audience), and the DISCLOSURE is the whole reason for the bar. It is also the only way a `broker: \"db\"` hook ever gets a value at all, which is what lets a declared hook go live without a redeploy; refused by name for any other broker, whose value is set outside this deployment. This is likewise the ONLY recovery path, deliberately: there is no re-reveal anywhere in the design, because a re-reveal is indistinguishable in the audit log from exfiltration of a live secret. Whether the superseded key keeps working is the DECLARATION's own choice — a second `secretRef` entry is the overlap, ended by a PR rather than a timer — so the model cannot choose that window either. Declares `taint: \"gate\"`: minting a live signing secret may never be auto-approved off fetched content, so a tainted turn is floored at a human decision and an unattended tainted run denies (OPE-438). `arms` (OPE-419): the mint is what makes a DECLARED ingress actually able to wake this deployment, so it creates post-turn execution surface even though it declares no new endpoint",
  )),
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

  record_watch_state: postTurn("none", open("writes watch bookkeeping onto the calling routine's OWN row, located via the dispatcher-stamped marker")),
  report_run_failed: postTurn("none", open(
    "a fire declaring that ITS OWN run did not do its work (OPE-177) — writes `lastOutcome: failed` plus a capped one-line reason onto the calling routine's OWN row (marker-located, never a supplied id), which the three-strike fold then honours. It is the only routine verb whose entire reach is to make the routine do LESS: it cannot post, cannot widen anything, and its worst case is a routine that stops early and announces that it did. Gating it would put a confirmation in front of the honesty mechanism, on a path with no human present to click it. The declared text is model-authored and quarantined to the audit rows, never to the host-composed disable notice",
  )),
  record_job_state: postTurn("none", open("writes a durable-job's progress ledger onto the calling job's OWN row (OPE-55), located via the dispatcher-stamped marker; cap-bounded, aims at nobody else")),
  complete_job: postTurn("none", open(
    "a durable job declaring ITSELF done and retiring (OPE-55) — flips its OWN row (marker-located, never a supplied id) to the terminal `done` status; reaching a job's intended done-state from inside its own run, not a guardrail removal (cancel_routine is that). Reversible by re-creating the job; audited (routine.complete)",
  )),
  subscribe_pr: postTurn("templated", open(
    "arms a self-serve check-back whose routine prompt is CODE-templated (subscribePrPrompt) from grant-validated inputs — the model authors no routine text, incl. the re-arm, which loops through this SAME tool, never create_routine; posts stay in the arming surface; READ-scoped credential only; the chain is hard-capped (MAX_CHECKS_PER_SUBSCRIPTION, budget carried on the routine ROW so a prompt rewrite can't reset it) and self-retires on merge/close; cancellable with cancel_routine, which stays the ONLY manual off switch (a `stop` param here would be a second, ungated removal path). `templated` rather than `arms`: the surface it creates executes after the turn, but its INSTRUCTION is `subscribePrPrompt` in scm/pr-watch's caller — a code literal a tainted turn cannot reach — and its only inputs are a repo the grant already allows and a PR number. Flooring it would card the common flow on every turn that had read a PR body, which is most of them, to protect text the model never writes. That trade is the reason for the value, and it is the row to revisit first if the prompt ever stops being code-templated",
  )),
  run_routine_now: postTurn("none", open(
    "brings a routine's ALREADY-ARMED run forward (OPE-147): sets nextRunAt to now so the ordinary dispatcher tick fires it — no new fire path, no new audience, no new authority, and every consequential thing the fired turn attempts re-gates on its own. The prompt is the one a human already read on the routine.create card, and the schedule is unchanged. Host-rate-limited to one manual run per routine per dispatcher tick, audited (routine.run_now with the real requester; the resulting fire's routine.fire row carries manual:true), and it REFUSES without a verified principal — so a fire, which has none, can never re-trigger itself or another routine. `none` (OPE-419) despite naming a routine by id: it writes only `nextRunAt`, arming no new authority, no new audience and not one word of instruction — the prompt it brings forward is the one a human already read on the routine.create card",
  )),
  revoke_routine_permissions: open(
    "de-escalation only (OPE-152): withdraws a routine's STANDING permissions so it goes back to drawing an approval card for every gated action, leaving the routine itself running. There is no configuration in which it widens anything — after it runs the routine can do strictly less unattended — so gating it would put a confirmation in front of the brake pedal. It still REFUSES without a verified principal, for attribution (the routine.grants_revoked audit row names who withdrew them), and the grants it deletes were each minted by a human's click in the first place",
  ),
  extend_workspace_time: open("extends this session's own sandbox window; capped (sandbox.extendMaxMinutes) and audited"),
  spawn_thread_session: open(
    "presence (§B1, Stage T2): mints a persistent CONVERSATIONAL thread seat (narrow hands) and dispatches to it, non-blocking. Widens PRESENCE, not consequence — the seat has no wide hands and re-gates every L2 consequence itself; delegation/presence IS the standing seat's job. Open, fully audited (thread_seat.spawned); taint forwarded onto the child, not gated here",
  ),
  complete_thread: open(
    "a thread seat releasing its own thread's ownership — the next message then wakes the standing seat instead. Reversible (the seat re-opens), touches no memory/spend/audience beyond the ownership index; a conversational verb, audited (thread_seat.completed)",
  ),
  set_dm_delivery: open(
    "the RECIPIENT of the agent's direct messages turning them off, or back on, from their own DM (OPE-1064 tier P2). The stop REMOVES the agent's reach — one durable row that outranks every grant — and the resume restores only what that same person just gave up, in a room that holds nobody else. It touches no memory, no spend, no credential and no audience beyond the person setting it. Nothing here for an approver to weigh: a card in front of \"please stop messaging me\" would be the product asking permission to stop bothering somebody. Audited (dm.audience.stopped / dm.audience.resumed)",
  ),
  stand_down: open(
    "the agent stopping following a conversation it was asked to leave (OPE-418 Part B). It REMOVES the agent's own reach — one durable `stopped` flag on this surface's engagement row, cleared by the next @mention — and touches no memory, no spend, no credential and no audience. Nothing here for an approver to weigh: putting a card in front of \"please be quiet\" would be the product asking permission to stop annoying someone. Audited (engagement.stood_down)",
  ),
  agent: open(
    "delegation: eve's BUILT-IN `agent` hands a self-contained job to a full-hands worker in the parent's own sandbox, bound to the parent's identity. It re-gates every L2 consequence INSIDE the child, forwards taint onto the child's opening auth, and widens HANDS, never CONSEQUENCE. The call returns a task receipt at once and eve delivers the settled child as a new message. Escapes nothing this table doesn't re-gate in the worker; audited via delegation.task_started / delegation.task_settled",
  ),
  grant_tools: open(
    "the resolver FILE that projects a chat's live CREDENTIAL GRANTS into per-grant `grant__<owner>__<verb>` tools (OPE-1060, the sandbox_tools shape). It mounts nothing under its own name and grants nothing: it reads grant rows an OWNER already approved in their own DM and returns one tool per row. Its own tier is open because resolving is a read of rows that already exist. Each MOUNTED name is classified on the RESERVED-NAMESPACE path instead of by a static row here — a runtime-minted name cannot have one — and its authoritative tier is the one pinned on the GRANT ROW at mint, from the reviewed verb definition, never re-derived from the mounted name (the false-open arm S0 closed)",
  ),
  request_credential_grant: open(
    "ASKS one named person to let this conversation spend their own connector credential (OPE-1060 S3). It grants nothing, sends nothing model-authored but a QUOTED purpose line, and writes one pending row. The rubric's consequential test — does the effect escape the conversation — is met by the DM, and the row is still `open`, for the same reason link_identity is: what escapes is a DECISION REQUEST addressed to the one person entitled to answer it, and the answer is the gate. A card here would ask a MEMBER-tier audience in the requesting room whether to ask the owner, which puts a person's consent to spend their own credential in front of their colleagues one step removed — the exact pressure the owner-DM venue exists to remove, and a weaker check than the owner's own card, not a stronger one. What bounds it instead: the domain must declare the grant role (no fallback), the turn must name exactly ONE verified requester, the verb must be REGISTERED and the resource explicitly addressed, at most one ask per (requester, owner, verb, resource) may be pending so a re-planning model cannot page anybody twice, the owner's card copy is host-authored throughout, and the ask dies on its own short TTL. A TAINTED turn is refused outright inside the tool — an `open` row has no card for this registry's taint column to floor, and content the turn fetched must never author the sentence an owner reads to decide",
  ),

  link_identity: open(
    "issues a short-TTL, single-use proof-of-control CODE in the initiator's own DM and writes one challenge row. It links nothing, reaches nobody outside that DM, and changes no behaviour — the code's entire power is to earn its holder a QUESTION in the initiator's DM naming them. Gating it would put a card in front of asking a question. The consequential step is confirm_link, and that step is already a specific identified human answering in their own DM, which no card can improve on",
  ),
  confirm_link: open(
    "the RATIFICATION itself — the human act an approval card would otherwise be standing in for. It commits the link, and it is `open` precisely BECAUSE it is the gate: it refuses unless the caller is the challenge's own initiator (matching platform AND acting principal id), in the originating DM, on a claim that is still `claimed` and unexpired. A card here would ask a member-tier audience to confirm a decision only ONE person is allowed to make — a weaker check, not a stronger one. Denying writes nothing at all",
  ),
  unlink_identity: open(
    "de-escalation only: removes an account from the CALLER'S OWN link-set, and there is no configuration in which it widens anything — afterwards that account is attributed to strictly fewer things. Gating the off switch for your own identity would mean needing someone else's permission to stop being associated with an account, which is the one direction this must never require. Refuses without an ACTING principal (so a fire cannot detach its creator's accounts) and audited (identity.link.unlinked)",
  ),

  create_skill: postTurn("arms", member("skill.create", "gate",
    "self-modification: a skill is a procedure the agent will load and FOLLOW by name (persistent RCE-of-behaviour). `arms` (OPE-419), and the taint floor came with the declaration: the row's own words are the vector-1 predicate, and it sat outside the four-name enumeration only because the enumeration was hand-picked. A skill's text is read on a LATER turn, by a run that has no memory of the page this one fetched, which is the exact deferred-instruction shape the floor exists to stop being auto-approvable",
  )),
  create_routine: postTurn("arms", deferToJudge(member("routine.create", "gate",
    "self-modification: a standing scheduled behaviour that outlives the turn. `arms` (OPE-419) — the strongest case in the table: the model AUTHORS the prompt, and the dispatcher renders it as trusted text to an unattended run, on a schedule, indefinitely. Everything add_routine_rule is floored for is true here of the whole instruction rather than one clause",
  ))),
  purge_memory: deferToJudge(member("memory.purge", "disclose", "hard-to-reverse: ERASES memory across every writable silo (and the frozen args carry only the bullets' hashes — GDPR redaction)")),
  open_pull_request: deferToJudge(member("pr.open", "disclose",
    "audience-expanding: a PR reaches repo watchers, CI and reviewers beyond the asking room; commits stage on a hidden ref and publish only on the click",
  )),
  request_access: deferToJudge(member("access.request", "disclose", "audience-expanding: sends a grant request (a bot PR + admin-channel note) beyond the asking room; the merge stays the privilege gate")),
  create_agent: postTurn("arms", member("agent.create", "gate",
    "self-modification + audience: provisions a new channel-resident agent — a domain + memory silo + capability bundle — as one config PR; the card is the injection gate and the merge the privilege gate. `arms` (OPE-419): a resident agent instructs every future turn in its channel, which is post-turn instruction surface of the widest grain in the table. The merge gate does NOT make the floor redundant — declare_webhook opens a PR too and has carried the floor since OPE-438, because what a reviewer reads is a diff the model wrote off fetched bytes",
  )),
  set_state: member("ticket.set_state", "disclose", "audience-expanding: a ticket's state change (e.g. close/reopen) is visible to every watcher of the entity (repo/team members, CI, other assignees), not just the asking room"),
  assign: member("ticket.assign", "disclose", "audience-expanding: assignment makes the entity someone's explicit responsibility, visible to the whole team/repo, not just the asking room"),
  create_ticket: member("ticket.create", "disclose",
    "audience-expanding: a filed work item reaches every watcher of the repo/team, its triage automation and its subscribers — none of them in the asking room — and the model authors the title + body, so the card (which renders both in full) is the injection gate before that text is published",
  ),
  post_message: member("chat.post", "disclose",
    "audience-expanding: a message posted into a container the turn did NOT arrive in interrupts named humans who never asked, is attributed to the deployment, and cannot be un-seen after an edit — and the model authors the body, so the card (which renders the destination and the full text) is the injection gate before those bytes reach a room that never asked for them",
  ),
  dm_person: member("chat.dm", "disclose",
    "audience-expanding: a direct message interrupts one named human who never asked, is attributed to the deployment, and cannot be un-seen after an edit — so the FIRST message to a person takes the card, which renders the recipient, the full text and the host footer, and is the injection gate before the agent starts a correspondence nobody invited. 🔴 THE CARD DOES NOT REPEAT: later messages to that same person FLOW (OPE-893 — \"ask for forgiveness, not permission ... give the user a way to make it stop\"), so from the second message on the model's bytes reach a person with no reviewer between. What remains is the operator's grant, an audit row per delivery, and the recipient's own stop (set_dm_delivery), which outranks every grant",
  ),

  set_spend_limit: deferToJudge(admin("spend.set", "disclose", "self-modification + money: changes what the org will spend")),
  clear_spend_limit: admin("spend.clear", "disclose", "reverts a spend control — same bar as setting one"),
  revoke_connector: admin("connector.revoke", "disclose", "kills a live capability for a scope — an org-level control change"),
  clear_connector_override: admin("connector.clear", "disclose", "re-arms a revoked capability — same bar as the revoke"),
  memory_admin_list: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    taint: "disclose",
    reason: "audience-expanding read: enumerates silos beyond this room's own memory — role-scoped disclosure (access/roles.ts adminControlRoles)",
  },
  memory_admin_read: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    taint: "disclose",
    reason: "audience-expanding read: pulls another room's silo contents into this one — role-scoped disclosure",
  },
};

export function judgeDeferredTool(tool: string): boolean {
  if (isConnectorOpTool(tool)) return false;
  return TOOL_CONSEQUENCE[tool]?.judgeDefer === true;
}

export interface ActionKindEntry {
  readonly tier: Exclude<ConsequenceTier, "open">;
  readonly reason: string;
}

export const NON_TOOL_ACTION_KINDS: Readonly<Record<string, ActionKindEntry>> = {
  "session.checkpoint": {
    tier: "gate:member",
    reason:
      "the SOFT session cost checkpoint (OPE-62): past a configured per-session spend threshold, consequential work pauses on a card until a human confirms continuing. Raised by the spend path, not by a verb — which is precisely why it needs pinning here: the tier is a real decision (a member may unblock their own session's spend, an admin bar would make an ordinary long task need an admin) and nothing else in the tree records that it was made",
  },
};

export function checkActionKindRegistry(
  registeredKinds: readonly string[],
  policyOf: (action: string) => "admin" | "member" | undefined,
  toolRegistry: Readonly<Record<string, ConsequenceEntry>> = TOOL_CONSEQUENCE,
  nonToolRegistry: Readonly<Record<string, ActionKindEntry>> = NON_TOOL_ACTION_KINDS,
): string[] {
  const problems: string[] = [];
  const boundToTool = new Map<string, string>();
  for (const [tool, entry] of Object.entries(toolRegistry)) {
    if (entry.via.kind === "action-kind") boundToTool.set(entry.via.action, tool);
  }

  for (const kind of registeredKinds) {
    const tool = boundToTool.get(kind);
    const pinned = nonToolRegistry[kind];
    if (tool !== undefined && pinned !== undefined) {
      problems.push(
        `ActionKind "${kind}" is declared TWICE — by tool "${tool}" in TOOL_CONSEQUENCE and again in NON_TOOL_ACTION_KINDS. One kind, one declaration: remove the non-tool row, whose cross-check would otherwise be free to disagree with the tool's`,
      );
      continue;
    }
    if (tool !== undefined) continue;
    if (pinned === undefined) {
      problems.push(
        `ActionKind "${kind}" is registered but no tool proposes it and it has no row in NON_TOOL_ACTION_KINDS (access/consequence.ts) — a live approval bar that nothing records a decision about. Add a row (fail-closed: there is deliberately no default)`,
      );
      continue;
    }
    const policy = policyOf(kind);
    const expected = pinned.tier === "gate:admin" ? "admin" : "member";
    if (policy !== expected) {
      problems.push(
        `ActionKind "${kind}" is pinned ${pinned.tier} in NON_TOOL_ACTION_KINDS but registers ApproverPolicy "${policy ?? "(none)"}" — the declaration and the runtime bar disagree`,
      );
    }
  }

  for (const kind of Object.keys(nonToolRegistry)) {
    if (!registeredKinds.includes(kind)) {
      problems.push(
        `NON_TOOL_ACTION_KINDS pins "${kind}" but no such kind is registered — remove the row or fix the name (a stale pin reads as coverage and is the opposite)`,
      );
    }
  }
  return problems;
}

export interface ActionKindRegistration {
  readonly file: string;
  readonly line: number;
  readonly ident: string;
  readonly kind?: string;
}

const REGISTER_CALL = /^\s*registerActionKind\(([A-Za-z_$][\w$]*)\)/;
const KIND_DECL = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*ActionKind</;
const KIND_PROPERTY = /^\s*kind:\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*,/;
const STRING_CONST = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"\s*;/;

export function findActionKindRegistrations(file: string, source: string): ActionKindRegistration[] {
  const lines = source.split("\n");
  const strings = new Map<string, string>();
  for (const line of lines) {
    const c = STRING_CONST.exec(line);
    if (c) strings.set(c[1]!, c[2]!);
  }
  const declared = new Map<string, string>();
  lines.forEach((line, i) => {
    const decl = KIND_DECL.exec(line);
    if (!decl) return;
    for (let j = i + 1; j < lines.length; j++) {
      const text = lines[j] ?? "";
      const prop = KIND_PROPERTY.exec(text);
      if (prop) {
        const value = prop[1] ?? strings.get(prop[2]!);
        if (value !== undefined) declared.set(decl[1]!, value);
        return;
      }
      if (/^\};?\s*$/.test(text)) return;
    }
  });
  const found: ActionKindRegistration[] = [];
  lines.forEach((line, i) => {
    const call = REGISTER_CALL.exec(line);
    if (!call) return;
    const ident = call[1]!;
    const kind = declared.get(ident);
    found.push({ file, line: i + 1, ident, ...(kind !== undefined ? { kind } : {}) });
  });
  return found;
}

export function checkActionKindCoverage(
  registrations: readonly ActionKindRegistration[],
  registeredKinds: readonly string[],
): string[] {
  if (registrations.length === 0) {
    return [
      "no `registerActionKind(...)` statement was found anywhere in the scanned tree — the scan is broken or its roots are wrong, and an empty enumeration would make this check pass by looking at nothing",
    ];
  }
  const problems: string[] = [];
  const live = new Set(registeredKinds);
  for (const r of registrations) {
    if (r.kind === undefined) {
      problems.push(
        `${r.file}:${r.line} registers ActionKind \`${r.ident}\`, but no \`const ${r.ident}: ActionKind<...>\` opening with a literal \`kind:\` was found in that file — so this check cannot confirm the kind reaches the registry. Declare it in the same file as the registration, or every check keyed off the live registry quietly stops covering it`,
      );
      continue;
    }
    if (!live.has(r.kind)) {
      problems.push(
        `${r.file}:${r.line} registers ActionKind "${r.kind}", but it is ABSENT from the live registry enumerated here — registration is a module side effect, so that module was never loaded. checkActionKindRegistry is total only over what it can see, so this kind's approval bar is currently cross-checked by nothing. Add a side-effect import for "${r.file}" to scripts/consequence-lint.ts`,
      );
    }
  }
  return problems;
}

export const NON_TOOL_APPROVAL_SITES: Readonly<Record<string, string>> = {
  "packages/core/agent/connections/notion.ts":
    "REAL, and deliberate: `connectorApprovalPolicy()` on an eve CONNECTION, not a tool. The connector-op plane is explicitly NOT rows in TOOL_CONSEQUENCE (see the scope note at the top of this file) — an op's name is injected at runtime and cannot be enumerated statically — and the eve-native `approval:` callback is the ONLY pre-execution seam eve exposes for an injected connection tool. It is defence in depth over the hard credential gates (grant + DM-only wall), never the gate itself. Since OPE-575 the value is an approval CONFIGURATION: its `response` half binds the Approve click to the session initiator (approvals/eve-response-policy.ts), which is still not approver standing — it cannot deny the request and a cancel click bypasses it",
  "packages/core/agent/plugins/extract.ts":
    "NOT a live policy: the match is inside a TEMPLATE LITERAL — the `approval: once()` line that the plugin extractor GENERATES into a scaffolded `agent/connections/<slug>.ts`. It is reviewed where it lands, by whoever reads the generated file, and the header of that generated file says so",
  "packages/core/agent/access/window-gated.ts":
    "NOT a policy: `replayStepNames` returns `{ execute, approval, approvalResponse }` — eve's deterministic replay STEP NAMES for a dynamic tool entry. Each value is a string identifier, and the properties are named after what eve calls the steps",
};

export interface ApprovalSite {
  readonly file: string;
  readonly line: number;
}

export function findEveApprovalSites(file: string, source: string): ApprovalSite[] {
  const sites: ApprovalSite[] = [];
  source.split("\n").forEach((line, i) => {
    if (EVE_HITL.test(line)) sites.push({ file, line: i + 1 });
  });
  return sites;
}

export function checkApprovalSites(
  sites: readonly ApprovalSite[],
  registry: Readonly<Record<string, string>> = NON_TOOL_APPROVAL_SITES,
): string[] {
  const problems: string[] = [];
  const found = new Set(sites.map((s) => s.file));
  for (const site of sites) {
    if (registry[site.file] === undefined) {
      problems.push(
        `${site.file}:${site.line} sets an eve-native \`approval:\` outside agent/tools/, where lint:consequence cannot reach it — an eve approval has NO approver-standing check (design §7.2), so it must be accounted for in NON_TOOL_APPROVAL_SITES (access/consequence.ts) with what it actually is, or moved onto a tool file where the registry can tier it`,
      );
    }
  }
  for (const file of Object.keys(registry)) {
    if (!found.has(file)) {
      problems.push(
        `NON_TOOL_APPROVAL_SITES accounts for "${file}" but it no longer contains an \`approval:\` site — remove the entry (a stale reason reads as coverage of something that is gone)`,
      );
    }
  }
  return problems;
}

export const POST_TURN_WRITE_PRIMITIVES: readonly string[] = [
  "addRoutine",
  "updateRoutine",
  "removeRoutine",
  "putDomainSkill",
  "deleteDomainSkill",
  "applyAgentSpec",
  "applyHookDeclaration",
  "mintSecretFor",
];

export interface PostTurnWriteSite {
  readonly file: string;
  readonly line: number;
  readonly primitive: string;
}

export const NON_TOOL_POST_TURN_WRITERS: Readonly<Record<string, string>> = {
  "packages/core/agent/operational/store.ts": "the operational-store INTERFACE that declares the routine verbs; a type signature, not a call site",
  "packages/core/agent/schedules/dispatch.ts": "the HOST dispatcher tick. It patches nextRunAt/lastOutcome on rows it is already firing, outside any session — there is no turn here to be tainted",
  "packages/core/agent/routines/outcome-fold.ts": "the host-side outcome fold (three-strike disable + stall detection). It reads what a fire DID and writes bookkeeping; it never authors instruction text",
  "packages/core/agent/control/writes.ts": "the control-plane MCP write surface — operator-authenticated over its own transport, not a tool the model can call in a turn",
  "packages/core/agent/control/server.ts": "the control-plane MCP server that mounts those writes; same plane, same reason",
};

const WRITE_DECL = (primitive: string): RegExp => new RegExp(`\\b(?:function|async)\\s+${primitive}\\s*\\(`);
const WRITE_CALL = (primitive: string): RegExp => new RegExp(`(?<![\\w$.])${primitive}\\s*\\(`);

export function findPostTurnWriteSites(file: string, source: string): PostTurnWriteSite[] {
  const found: PostTurnWriteSite[] = [];
  source.split("\n").forEach((line, i) => {
    for (const primitive of POST_TURN_WRITE_PRIMITIVES) {
      if (WRITE_DECL(primitive).test(line)) continue;
      if (WRITE_CALL(primitive).test(line)) found.push({ file, line: i + 1, primitive });
    }
  });
  return found;
}

function toolSlugOf(file: string): string | undefined {
  const m = /(?:^|[\\/])agent[\\/]tools[\\/]([A-Za-z0-9_]+)\.ts$/.exec(file);
  return m?.[1];
}

export function checkPostTurnSurface(
  tools: readonly ToolSource[],
  treeWriteSites: readonly PostTurnWriteSite[],
  registrations: readonly ActionKindRegistration[],
  registry: Readonly<Record<string, ConsequenceEntry>> = TOOL_CONSEQUENCE,
  nonToolWriters: Readonly<Record<string, string>> = NON_TOOL_POST_TURN_WRITERS,
): string[] {
  const problems: string[] = [];

  const toolsByKind = new Map<string, string[]>();
  for (const [tool, entry] of Object.entries(registry)) {
    if (entry.via.kind !== "action-kind") continue;
    const list = toolsByKind.get(entry.via.action) ?? [];
    list.push(tool);
    toolsByKind.set(entry.via.action, list);
  }
  const kindsByFile = new Map<string, string[]>();
  for (const r of registrations) {
    if (r.kind === undefined) continue;
    const list = kindsByFile.get(r.file) ?? [];
    list.push(r.kind);
    kindsByFile.set(r.file, list);
  }

  const reachedBy = new Map<string, PostTurnWriteSite[]>();
  const reach = (tool: string, site: PostTurnWriteSite): void => {
    const list = reachedBy.get(tool) ?? [];
    if (!list.some((s) => s.file === site.file && s.line === site.line && s.primitive === site.primitive)) list.push(site);
    reachedBy.set(tool, list);
  };

  for (const tool of tools) {
    for (const site of findPostTurnWriteSites(`${tool.name} (tool source)`, tool.source)) reach(tool.name, site);
  }

  const attributedFiles = new Set<string>();
  for (const site of treeWriteSites) {
    const slug = toolSlugOf(site.file);
    if (slug !== undefined) {
      attributedFiles.add(site.file);
      reach(slug, site);
      if (registry[slug] === undefined) {
        problems.push(
          `${site.file}:${site.line} calls the post-turn write "${site.primitive}" from a tool file with no TOOL_CONSEQUENCE row for "${slug}" — tier it first (checkConsequenceRegistry owns that), then declare its \`postTurnSurface\``,
        );
      }
      continue;
    }
    const kinds = kindsByFile.get(site.file) ?? [];
    const owners = kinds.flatMap((k) => toolsByKind.get(k) ?? []);
    if (owners.length > 0) {
      attributedFiles.add(site.file);
      for (const owner of owners) reach(owner, site);
      continue;
    }
    if (nonToolWriters[site.file] !== undefined) {
      attributedFiles.add(site.file);
      continue;
    }
    problems.push(
      `${site.file}:${site.line} calls the post-turn write "${site.primitive}" but nothing attributes it: the file is not an agent/tools/ file, registers no ActionKind a tiered tool proposes, and has no NON_TOOL_POST_TURN_WRITERS row (access/consequence.ts). Route the write through a tiered tool's ActionKind, or account for the file there with what actually drives it — an unattributed write is post-turn surface no \`postTurnSurface\` declaration covers`,
    );
  }

  for (const [tool, sites] of [...reachedBy].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = registry[tool];
    if (entry === undefined) continue;
    const where = sites.map((s) => `${s.primitive} at ${s.file}:${s.line}`).join(", ");
    if (entry.postTurnSurface === undefined) {
      problems.push(
        `tool "${tool}" reaches a durable post-turn write (${where}) but declares no \`postTurnSurface\` — answer the vector-1 predicate on its TOOL_CONSEQUENCE row ("arms" | "disarms" | "templated" | "none"; fail-closed, there is deliberately no default, because a hand-kept list of route-creating tools rots fail-open)`,
      );
      continue;
    }
    if (postTurnSurfaceFloors(entry.postTurnSurface) && entry.taint !== "gate") {
      problems.push(
        `tool "${tool}" declares \`postTurnSurface: "${entry.postTurnSurface}"\` but \`taint: ${entry.taint === undefined ? "(none)" : `"${entry.taint}"`}\` — a tool that ${entry.postTurnSurface === "arms" ? "arms" : "removes"} post-turn instruction/execution surface must be floored at a human decision on a tainted turn; set \`taint: "gate"\``,
      );
    }
  }

  for (const [tool, entry] of Object.entries(registry)) {
    if (entry.postTurnSurface !== undefined && !reachedBy.has(tool)) {
      problems.push(
        `tool "${tool}" declares \`postTurnSurface: "${entry.postTurnSurface}"\` but reaches no durable post-turn write that this scan can see — either the write moved somewhere POST_TURN_WRITE_PRIMITIVES does not name (add it), or the row is stale and should drop the column (a claim nobody can trace to code reads as coverage)`,
      );
    }
  }
  for (const file of Object.keys(nonToolWriters)) {
    if (!attributedFiles.has(file)) {
      problems.push(
        `NON_TOOL_POST_TURN_WRITERS accounts for "${file}" but it contains no post-turn write site — remove the entry (a stale reason reads as coverage of something that is gone)`,
      );
    }
  }

  return problems;
}

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
  moduleSources: ReadonlyMap<string, string> = new Map(),
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const authored = new Set(tools.map((t) => t.name));
  const delegatedHelpers = new Map<string, string>();
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.via.kind === "delegated-roles") delegatedHelpers.set(entry.via.helper, name);
  }

  for (const tool of tools) {
    seen.add(tool.name);
    const entry = registry[tool.name];
    if (!entry) {
      problems.push(
        `tool "${tool.name}" has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (there is deliberately no default tier)`,
      );
      continue;
    }

    if (entry.tier !== "open" && entry.taint === undefined) {
      problems.push(
        `tool "${tool.name}" is gated (${entry.tier}) but declares no taint tolerance — add \`taint: "gate" | "disclose"\` to its TOOL_CONSEQUENCE row (fail-closed: an undeclared gated sink floors a tainted turn at a human decision, and that must be a decision, not an omission)`,
      );
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
        for (const [helper, declaredBy] of delegatedHelpers) {
          if (new RegExp(`\\b${helper}\\s*\\(`).test(tool.source)) {
            problems.push(
              `tool "${tool.name}" is declared open/ungated but calls "${helper}", which "${declaredBy}" declares as a cross-file admin gate (delegated-roles) — declare it the same way so the gate is visible in this table, or stop calling it`,
            );
          }
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
      case "delegated-roles": {
        if (entry.tier !== "open" && entry.tier !== "gate:admin") {
          problems.push(
            `tool "${tool.name}" declares ${entry.tier} via delegated-roles — that mechanism enforces admin standing on one branch, so the tier is either gate:admin (it gates everything) or open (a partial, per-scope check)`,
          );
        }
        if (!new RegExp(`\\b${entry.via.helper}\\s*\\(`).test(tool.source)) {
          problems.push(
            `tool "${tool.name}" declares a delegated gate through "${entry.via.helper}" but its source never calls it — the row points at a gate the tool doesn't reach (under-gated)`,
          );
        }
        const moduleSource = moduleSources.get(entry.via.module);
        if (moduleSource === undefined) {
          problems.push(
            `tool "${tool.name}" delegates its gate to "${entry.via.module}", whose source was not supplied — refusing to pass a gate nobody read (a missing module and an ungated one must not look the same)`,
          );
        } else if (!ADMIN_ROLES.test(moduleSource)) {
          problems.push(
            `tool "${tool.name}" delegates its gate to "${entry.via.module}", but that module has no requireOrgAdmin/requireDomainAdminOrOrg/adminControlRoles call — the gate it points at is gone, and this tool is now genuinely ungated`,
          );
        }
        break;
      }
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
