# The control plane

Open Everywhere is configured **as code, through git** — bundles, bindings, caps, routines, and instructions live in your repo and reach production by PR → CI → deploy. The control plane is the small runtime surface that does what git *can't*: read live state, and act faster than a deploy in an incident. It is an **MCP server, not a web dashboard**.

## The lens

> In a git-driven system, the control plane holds only what git can't: runtime **state**, and break-glass **narrowing** that's faster than a deploy. Anything that **widens** access, or is a **deliberate permanent change**, belongs in a PR.

Every endpoint is judged against that lens. The rule the code implements is **no unaudited, unattributed widening** — not "nothing widens at runtime". Widening takes one of three paths, and each one names an actor: a **config PR**; an authenticated **control-MCP write**, which acts at once on the caller's verified role (`set_spend_limit` raises a cap, `decide_pending_action` approves a pending one); or **propose → code-rendered card → verified click**, with the arguments frozen at propose time. Every path writes an audit row carrying the acting principal — best-effort by contract, as [Audit & provenance](./audit-and-provenance.md) sets out. Access is stricter still: the propose verbs that widen it — `request_access`, `create_agent`, `declare_webhook` — open a bot-PR instead of executing, and an unmerged PR grants nothing.

Narrowing gets a runtime lane wherever the code provides one — connectors, spend, session grants, routines, skills, link-sets, the approval judge — and there it never waits for a deploy. That lane is not universal. A repo grant, an AWS role grant and an egress host are deploy-grained in both directions; [Revocation latency](./revocation-latency.md) explains why.

That is why there is no **web dashboard**. A dashboard takes whatever its field accepts, acts on a session cookie, and keeps no record of who asked or what they read. The [human door in chat](#in-slack-approvals) is the deliberate exception, and it is stricter than a dashboard on each of those counts: code renders the card from the frozen arguments, the click carries a platform-verified identity checked against the approver policy for that action kind, and the request, the decision and the outcome are each audited. Management stays in three places — git for config, chat for the human door, MCP for live state and the out-of-band plane.

## Three access paths, one capability layer

Everything above lives in **one** capability layer — bundles, bindings, caps, routines,
instructions — but there are three doors into it, matched to who's reaching in and how fast
they need to:

- **Git PR** — permanent config. The whole layer reaches production this way by default; see
  [Config-as-code](../how-it-works/config-as-code.md).
- **In-Slack** — the admin surface for humans already in the workspace. Reads and self-scoped
  actions execute directly; mutations that widen or destroy go **propose → code-rendered card
  → verified admin click → code executes the frozen args**. Model proposes, code and a human
  dispose. See [In-Slack approvals](#in-slack-approvals) below.
- **Control MCP** — the out-of-band plane: scripts and CI, operators who aren't in the
  workspace, and incidents where Slack — or the agent itself — is the problem. This is the
  plane the rest of this page is about.

Within the control MCP door there's a further split by *who's reaching in*:

- **Local ops / deploy plane** — the CLI you run from a checkout to provision, configure, and deploy. This is the operator at their terminal.
- **Remote runtime-admin plane** — the MCP server an authenticated admin reaches at runtime to read state and apply break-glass overrides. This is the plane most of this page is about.

## What the MCP exposes

**Reads** — state git doesn't hold:

| Tool | Returns |
|---|---|
| `spend_report` | per-surface / per-workspace token **and $** spend for a month vs *effective* caps (config + active override — see [Spend & cost controls](./spend-and-cost.md#caps-in-the-reports-agree-with-the-gate)), plus the org's per-person allowances. Always **this deployment's own org** — it takes no `org` argument, so no caller can read another tenant's rows. Org-wide with no domain-narrowing argument, so it needs the org-wide `admin` role |
| `audit_query` | the append-only audit trail (who / what / when), always **this deployment's own org** — it takes no `org` argument, so no caller can read another tenant's rows. Scope-gated: pass the full `platform` + `workspace` + `surface` triple to narrow the read to one container, which a covering `domain:<name>` role can do; any wider ask needs the org-wide `admin` role |
| `routines_list` | every routine **in one org**, optionally only those due. Rows carry the routine's full prompt, so an org-wide listing needs the org-wide `admin` role; pass `surfaceKey` to scope it to a single channel, which a covering `domain:<name>` role can do |
| `access_preview` | effective access for a scope — hosts, connectors, repos, plugins, instructions, and secret **names** only. **Config only** — it resolves the config-as-code baseline and reads no live override; use `overrides_list` for those. Scope-gated on the `platform`/`workspace`/`channel` triple: an org-wide `admin` previews any scope, a `domain:<name>` role only a triple that resolves to its own domain. A `mode: "dm"` preview answers about the **person** `principalId` names, not about the triple, so it needs the org-wide `admin` role |
| `overrides_list` | the reconcile worklist: every live override, with reason/setBy/expiry and whether it diverges from config |
| `usage_summary` | tokens + an estimated $ figure, grouped by surface/user/kind/model, plus per-surface routine cost predictions (`routinePredictions`) |
| `usage_window` | everything spent since a timestamp across a set of workspaces, grouped by surface × model, priced **exactly** at each row's own stamped model rate (unpriced/unstamped rows show tokens only — no assumed-model fallback). The read a CI/e2e harness uses to price a live run, typically over a [service token](#service-tokens-read-only) — also served by the deployment itself as [`GET /control/v1/usage`](#the-deployment-mounted-read-route) |
| `tool_usage` | calls, errors, rejected calls, approval cards raised and the **attributed** $ estimate per connector and per tool over a window (`sinceIso`, optional `untilIso`; `by: "connector"` folds the ops of one connector). The $ is each call's even share of the model call that chose it, so it is an attribution, never a measurement — the [`tools` analytics dataset](../capabilities/analytics.md#per-connector-and-per-tool-usage-the-tools-dataset) explains the rule, and `query_analytics` answers the same question in chat. Pass `domain` to narrow it (a covering `domain:<name>` role is enough); an org-wide call needs the org-wide `admin` role. Also served as [`GET /control/v1/tool-usage`](#the-deployment-mounted-read-route) |
| `skills_list` | a domain's runtime-authored skills |
| `skill_revisions` | one domain skill's approved-body history, newest first — every content the store recorded on a `putDomainSkill` write, plus who authored/armed it and the approval card's id (see [Skill revision history](#skill-revision-history) below) |
| `memory_list` | every memory silo the caller's roles cover — provider/backing, read-only flag, files with sizes (see "Memory-admin" below) |
| `memory_read` | one file's content out of one memory silo |
| `unified_domain_audit` | one cross-surface supervisor domain's whole picture (research preview): the surfaces that make up that one mind, the union of what the agent may reach across them — flagging any container that widens the set — the read-across exposure map of which mapped humans read which surfaces, the domain's admins, and the audited reply/silence record. It is the domain-grain answer no per-container `access_preview` can give. Pure read: it restricts nothing. `sinceDays` defaults to 30. Scope-gated on the domain — an org-wide `admin` sees any domain, a `domain:<name>` role only its own |
| `unpaired_stops` | accepted `turn.cancel_requested` rows with no `turn.cancelled` and no `turn.stop_ignored` beside them after a grace. It reads the cancel evidence pair from the reader's side, so it reaches the one class no seam inside a turn can — a stop whose request row lands after its turn already ended. A **candidate list, not a rate**: both partner rows are written from a terminal arm and no turn duration is capped, so at the default grace most rows are stops of turns still running; pass a `graceMs` longer than your longest turn to narrow it. Always **this deployment's own org**, and org-wide, so it needs the `admin` role. Read `scanTruncated` before you read an empty list as an answer |
| `session_transcript` | one session's durable event stream, **rendered** as readable lines — the wake, the reasoning, each tool call with its arguments, each result, the final message. Org-wide with nothing for a domain role to cover (a session id names a run, not a domain), so it needs the org-wide `admin` role. It reads by dialling the deployment's own [`GET /control/v1/session/<id>/transcript`](#the-deployment-mounted-read-route) — see [Reading a transcript from the control MCP](#reading-a-transcript-from-the-control-mcp) |

🔴 **`access_preview` answers from CONFIG ONLY. Its identity is "the resolver's own answer, served live."** It calls `accessView` (`agent/control/views.ts`), which hands `resolveAccess` four pieces of **config** — the bundles, the bindings, the plugin registry and the connector credential catalogue — and nothing else. `resolveAccess` is **synchronous** and reads no operational store, so no live override — a break-glass `revoke_connector`, a `set_spend_limit`, a session grant — can reach this answer. Read the live overlay from **`overrides_list`**, which is the reconcile worklist and says for each override whether it diverges from config. An incident response that needs "is this connector revoked right now?" asks `overrides_list`, never `access_preview`. What `access_preview` earns over the CI-runnable config script is reach: it resolves ANY scope on demand, from the deployment, without a checkout.

**Writes** — overlays on the config-as-code baseline (they do **not** edit code or git), plus the memory-admin writes (direct, not an overlay — see below):

| Tool | Effect | Verdict |
|---|---|---|
| `revoke_connector` | break-glass: revoke a connector from a surface — takes effect at the next token resolve (see [Revocation latency](./revocation-latency.md)) | canonical narrow |
| `clear_connector_override` | revert a revoke to the config grant | reconcile |
| `revoke_session_grants` | break-glass: withdraw a routine's standing grants ("Approve for this routine (up to N h)" and its declared permissions), or every unspent one-call connector-op approval in a room | narrow (discretion, not access) |
| `cancel_routine` | stop a misfiring routine now | break-glass narrow |
| `delete_skill` | break-glass: kill a poisoned runtime domain skill | canonical narrow |
| `disarm_approval_judge` | break-glass: turn the LLM approval judge off for one domain, so every defer-flipped verb falls back to its approval card | canonical narrow |
| `rearm_approval_judge` | turn the approval judge back on for one domain — the only thing that cancels a disarm | reconcile |
| `set_spend_limit` | overlay a monthly token cap (raise or lower) | bridge — see drift |
| `clear_spend_limit` | drop a spend override, revert to config caps | reconcile |
| `memory_write_file` | full-file replace inside one memory silo | direct edit, admin-only (v1) |
| `memory_delete_file` | delete one file from one memory silo | direct edit, admin-only (v1) |
| `set_domain_model` | pick a domain's runtime model id / reasoning effort, within the model-policy envelope | domain self-serve — see below |
| `clear_domain_model` | drop a domain's model pick, revert to the git-config route | reconcile |
| `link_sets_list` | every cross-surface identity link-set, with each account's status and the evidence behind it | org-admin read — see below |
| `suspend_link_set` | put a person's link-set on hold (it stops resolving) | reversible narrow |
| `reactivate_link_set` | lift a suspend | reconcile |
| `revoke_link_set` | offboarding: close a link-set and tombstone every account on it, purge the credentials stored against it, revoke the credential grants its confirmed accounts lend, and forget their personal browsers | **terminal** narrow |
| `purge_link_set_credentials` | destroy a link-set's stored OAuth credentials (revoked at the provider, then deleted from the vault) without revoking the set | narrow only |
| `directory_sync_now` | run the identity-directory (Okta) sync for an org now, and return the plan it applied | proposal + eager narrow — see below |
| `directory_sync_status` | the last sync's result: provider, policy, counts, and any ambiguity it refused to act on | org-admin read — see below |
| `directory_groups_plan` | diff the IdP's group memberships against the person-group overlay and return the next overlay file, or (with `deliver: true`) open a bot-PR that writes it | **review mode either way — nothing applies until a human commits/merges**, see below |
| `reopen_slack_setup` | reopen the `/setup` page after a Slack install has locked it, so setup can be run again | org-admin only — see below |

The identity and directory verbs are **org-admin only, including the reads**: a link-set enumerates one
human's accounts across every surface, which is exactly the read-across a `domain:<name>` role is
scoped *not* to have (`memory_admin_list` takes the same line for the same reason). A link-set
belongs to no surface and no domain, so there is no scope for a domain role to cover.

`reopen_slack_setup` is the one key to the `/setup` lock, and the lock is what makes that page safe
to serve. `/setup` (the agent-led Slack install, OPE-2231) closes for good at the first successful
install. Without a key, a deployment could never be re-pointed at another workspace, nor re-run after
an install that captured the wrong thing — recoverable only by someone with direct database access.

**It is not the runtime *grant* the plane forbids**, and the difference is worth stating because the
verb looks like one. Reopening grants nothing on its own: the reopened page still demands a one-time
setup code that the deployment mints and logs *after* the reopen, and this verb cannot read it. So
calling it converts no authority into Slack access by itself — it hands the next step to whoever can
read the deployment's logs, which is a **platform** permission (`vercel logs`, `docker logs`) and
emphatically not the same thing as the OE `admin` role this verb requires. The two sets may overlap at
a small operator and may not overlap at all at a larger one; nothing here assumes either.

What it risks is a second `/setup` run replacing a working install's credentials, which is why it is
**org-admin only** and audited (`slack.setup_reopened`). It leaves every stored Slack credential in
place, so the deployment keeps serving the workspace while an admin walks the page; only a completed
second run replaces them. What the install before it destroyed is its own **claim** credentials — the
one-time setup code and the cookie key — so no *claim* credential from the first run survives into the
second, while the client secret, the bot token and the live signing secret all do, which is what the
paragraph above means by leaving them in place.

`revoke_link_set` is the offboarding lever and does not come back: it tombstones the accounts so a
later proof-of-control challenge cannot re-link them to anyone, and it **purges the credentials
stored against the set** — revoked at the provider (RFC 7009, where the provider publishes a
revocation endpoint) and then deleted from the encrypted vault, so offboarding is credential death
rather than only lost reach. That purge is best-effort *on top of* the revoke, never a gate on it: a
vault outage cannot block an offboarding, and the audit row records `credentialsPurged` or
`purgeFailed` so a purge that did not happen is visible. The lever also ends the holdings that live
outside the vault (OPE-2504): every credential grant a confirmed account on the set lends is revoked,
and each confirmed account's personal browser is forgotten, saved profile included. A `suggested`
account keeps both. The row counts them
(`grantsRevoked`, `browsersForgotten`) and names any that failed (`holdingFailures`). `purge_link_set_credentials` finishes such
a case, and is also the verb for a set revoked before purging existed, or for killing a suspected
compromised token without spending the terminal revoke.

`suspend_link_set` is the reversible hold to reach for when you might want it back (a suspected
compromise, an observed directory deprovision). A revoked set is repaired by building a fresh one
through the ordinary challenge flow — "this person no longer has standing" must not be quietly
reversible. See [Identity](../how-it-works/identity.md) for the linking flow these govern.

The two **directory** verbs are org-admin only for the same reason, including the status read: a
sync summary is a statement about the whole org's people plane. Both sit on the *write* plane, so a
read-only service token cannot enumerate the deployment's IdP posture either. `directory_sync_now`
looks like a widen but is not one: everything it can create is a `suggested` link, which resolves
to nothing until the person confirms it in their own DM, and the only thing it applies eagerly is
the *narrowing* one — a deprovisioned person's link-set goes on hold. It cannot revoke, and it
cannot unlink an account the directory has merely stopped mentioning. Running it repeatedly is
safe: a second pass over an unchanged directory is all no-ops. With no directory adapter wired both
verbs simply say so.

`directory_groups_plan` is the odd one out on this whole plane: **it stays in review mode, always.**
[Person-groups](../how-it-works/access-and-scoping.md#person-groups-grouping-people-not-rooms) grant
capability in each member's DM, so a membership is config-as-code and moves only through a reviewed
diff. The verb reads the directory and diffs its group memberships against the machine-owned overlay;
what it then does depends on one flag, and neither branch is a silent apply. By default it **returns
the next overlay file** plus a readable list of additions and removals, for a human to commit to
`agent/identity/groups.generated.ts`. With **`deliver: true`** it opens (or updates) a **bot-PR** that
writes that overlay to the config repo — the same branch/commit/PR machinery, and the same *an
unmerged PR grants nothing* doctrine, that the [access-request](../how-it-works/access-requests.md)
grants overlay uses; the GitHub **merge is the approval**, and the memberships take effect only on the
next deploy of the merged config. This is review mode *automated*, not replaced. There is
deliberately no auto-apply-to-a-running-instance mode — silently granting credentials to whoever an
IdP group happens to contain is the thing the reviewed-diff rule exists to prevent, and `deliver:true`
refuses politely unless the config repo is configured (`OE_ACCESS_CONFIG_REPO`), exactly as
`request_access` does. Which IdP groups sync at all is narrowable with the setting `directory.groupAllowlist`
(a string array of verbatim IdP group names; empty syncs every group) — a deployer who grants
the agent 3 of their 50 Okta groups need not carry 50 in the overlay. Narrowing never waits for the
diff: a deprovisioned person's link-set is suspended eagerly by `directory_sync_now`, and a suspended
set contributes no group membership, so their access stops immediately and the overlay removal is
bookkeeping that follows.

`delete_skill` here is the control plane's own break-glass version. Any domain member can
already delete their own domain's skill in-thread (the agent tool of the same name — see
[Runtime domain skills](../capabilities/skills-and-plugins.md#runtime-domain-skills)); this is
the admin-callable twin for when a skill needs killing from outside the conversation — a
poisoned skill and no trusted member around to remove it.

`disarm_approval_judge` and `rearm_approval_judge` are the operator's two switches over the
[approval judge](./security-model.md), and the **only** things that move its state — the judge
never disarms itself, whatever humans overrule (see the security model).

`disarm_approval_judge` **only ever narrows**: a disarmed judge lifts nothing, so every
defer-flipped verb at that address lands back on the approval card it produced before its flip. One
call writes one `approval.judge.contradicted` row marked `admin-disarm`. It **lasts until an
operator re-arms** — no clock lifts it.

Both verbs take **exactly one address**, and the schema enforces that — both fields or neither is
refused before the handler runs:

| Address | Governs | Role needed |
| --- | --- | --- |
| `domain: <name>` | that one domain's judge consults | `domain:<name>` or `admin` |
| `orgWide: true` | the **domain-less** consults — every defer-flipped propose that carries no domain | `admin` (an unscoped ask) |

🔴 **Know what `orgWide` covers.** It is wider than the two always-org-level verbs. Today's
defer-flipped set is five, and these carry no domain: `pr.open` and `routine.create` always;
`spend.set` on every **user-level** cap and on any scope no domain claims; `memory.purge` and
`access.request` from any surface with no domain, such as a DM. A disarm only narrows, so the width
is safe there. A **re-arm is permissive** and restores card-free auto-approval across all of them in
one call.

🔴 **`orgWide` is not a wildcard, and there is no org-wide kill switch.** It governs the domain-less
consults and nothing else: an org-wide disarm never silences a domained consult, and a domain
disarm never silences a domain-less one. The reader (`agent/access/approval-judge.ts`) partitions
the two populations of operator rows strictly. An operator who wants the judge off in three domains
makes three calls. A real "disarm everywhere at once" need would be a **new** control with its own
ruling, not a widening of this one.

**The org is part of both addresses.** The operator-row lookup is scoped to the calling org, so on a
store shared by several orgs one org's rows can never answer another org's consult. That matters
most in the permissive direction: without the scope, org B's `rearm_approval_judge` would be the
newest row in the store and would cancel org A's break-glass disarm, resuming card-free
auto-approval in org A with nobody there having re-armed. A consult that cannot name its org reads
as **disarmed** — the card path stands — rather than reading every org's rows.

**Every reader that queries this ledger by action carries the same filter, not just the consult.**
The consult above derives the disarm state. The **click overrule** de-duplicates per wedge row, so a
foreign org's row on the same id cannot answer "already recorded" for an overrule nobody here has
made — that would drop a person's act silently. And `audit_query`, the control read over the trail,
answers from **this deployment's org**: it takes no `org` argument at all, exactly like its HTTP twin
[`GET /control/v1/audit`](#the-deployment-mounted-read-route). Readers of one ledger must not
disagree about its population.

The claim is about readers that ask for this action. A whole-store scan that happens to include
these rows is a different thing, and the surface-trust preflight probe
(`agent/identity/trust-preflight.ts`) is one: it pages the audit log across all actions. It carries
the deployment's org too. Without that filter both stores return every tenant's rows — each adds
`org_id = ?` only when the filter names an org — so the probe folded another org's channels into its
traffic map and reported them to this operator as undeclared surfaces: rooms they cannot see, and a
fix line asking them to declare rooms that are not theirs.

🔴 **Which is why both verbs refuse an `org` that is not this deployment's.** `disarm_approval_judge`
and `rearm_approval_judge` take `org` from the caller, and the consult reads the org the propose
plane carries. A row written under any other string is a row no consult will ever find — so the call
is **refused, by name**, rather than answering `{"ok": true, "disarmed": true}` while the judge keeps
lifting through the incident the operator believed they had just stopped. A break-glass control must
not fail silently or permissively. The deployment is single-org today, so this refuses nothing a real
operator sends; a deployment that grows a second org revisits these two verbs and the role scoping
together.

**One limit worth knowing before you rely on this control.** The reader scans a **bounded page** of
the ledger's newest rows: once the `approval.judge.contradicted` ledger passes that bound, an
address with no operator row on the page fails **closed** — the judge stops lifting there and every
affected verb cards until an operator writes a fresh row. That is the intended posture, not a fault,
and it applies to the domain-less plane as well.

`rearm_approval_judge` is its symmetric partner: one row marked `admin-rearm`, and the address is
judged again exactly as before the disarm. An address's state is the **latest** operator row, so a
later disarm turns the judge off again. The ledger is **append-only** — a re-arm cancels the
operator's disarm and erases nothing, so every human overrule and every earlier operator act stays
readable in the trail. There is nothing for a re-arm to suppress: overrules drive no automatic
behaviour.

Both verbs are write-plane only, and neither carries a free-text reason — the audit contract is ids
and registered names. An org-wide row carries the marker `orgWide: true` instead of a `domain`, and
its audit envelope is `{platform: "org", workspace: <org>}` — never a made-up scope key.

There is **deliberately no runtime connector *grant*.** Access widens only through a reviewed PR; the overlay is narrow-only at the point of effect, so a runtime override can never open access. `clear_connector_override` — whether called here or approved via the in-Slack path below — only ever reverts a revoke back to the **config-granted** state; it cannot grant a connector the config baseline never gave.

`revoke_session_grants` is the same narrow lane one layer in. A click in a conversation approves one
act and keeps nothing (OPE-2363), so a conversation never holds a standing grant. The memos left for
this verb are a routine's standing grant — **Approve for this routine (up to N h)** on a routine's
card, plus the routine's declared permissions — and a connector-op approval a click gave that the
agent has not spent yet. Pass `sessionId` set to the routine's grant key to withdraw the first; pass
only `surfaceKey` to withdraw every unspent one in the room. Two things to hold straight about it:

- **It narrows discretion, not access.** A session grant only ever skipped the *human card*; every
  capability gate still ran underneath it. So this verb cannot cut a capability — `revoke_connector`
  is the lever for that. Reach for this one when a routine was granted too widely, or when you want a
  room's unspent approvals gone without cancelling the work.
- **It is not folded into `revoke_connector`.** A revoked connector already fails closed at the
  credential wall on the next call, so an approval left behind skips no card that matters. Sweeping
  memos from a connector revoke would take out every other connector's approvals as a side effect of
  a single-connector revoke. An admin who wants that says so explicitly, here.

The room is the `surfaceKey` you pass. A Discord thread or a Teams reply chain is reached through its
parent channel's surface key. A `sessionId` must be a key of that room. A conversation key names its
room in the key. A routine's grant key does not, so the verb loads the routine and refuses the key
unless the routine is stored under that `surfaceKey`. A routine of another room, or one that no longer
exists, is refused too. So the verb never deletes another room's approval.

## Skill revision history

A domain skill is an **approval-gated instruction package**: a member proposes one, a card
carries the body, an admin (or self, for a member-tier skill) clicks approve, and only then
does the body reach `domain_skill`. That table is an upsert, so the next approved edit
overwrites it — leaving an audit trail that can say **who** approved a change and **when**,
but not **what they agreed to**. `domain_skill_revisions` is the append-only fix (written by
the store itself, inside every `putDomainSkill`, so no write path can skip it); `skill_revisions`
is how you read it without a database connection.

- **Same content, same gate as `skills_list`.** A live skill's full body is already returned
  by `skills_list` to any `domain:<name>` role covering it (no admin-only carve-out there) —
  a history of that same skill's *past* bodies doesn't introduce a new disclosure, so it earns
  no tighter tier of its own. `skill_revisions` uses the identical `scopeDenial` check.
- **One skill at a time, by design.** `name` is required. The log has no prune path and bodies
  run up to 32KB each, so the control-plane surface only ever answers "this skill's history",
  never "dump every skill's history in the domain" — narrow by construction, not just by the
  `limit` param (default 20, max 100; a truncated result comes back with `capped: true`).
- **`approvalId` is the useful column, not just the text.** It joins back to `pending_actions`
  (the frozen args the card rendered) and to the `approval.approved` audit row — the two other
  places that together make a revision an *audit* answer rather than a backup copy. A reader
  that shows the body and drops the join throws away that half.
- **Survives `delete_skill`.** Deleting the live skill leaves its revisions standing — the case
  where "the skill an approver armed, then someone deleted" is exactly the one where the body
  is otherwise gone.

See [`domain_skill_revisions`](../extending/database.md#what-a-domain-skills-history-is-doing-in-here)
in the database reference for the table's own append-only posture.

## Memory-admin: inspecting and editing org memory without SQL

`memory_list` / `memory_read` / `memory_write_file` / `memory_delete_file` let an admin
browse and fix the DB-backed shared memory (silos referenced by domains — see
[Memory](../capabilities/memory.md)) without a database console.

- **Tiers are enumerated from config, not a store scan.** There's no provider API to
  "list every silo that exists"; the domains + silos registry is the source of truth
  for what *should* exist, so `memory_list` walks that instead.
- **Row-level scope gating, not all-or-nothing.** A `domain:<name>` role sees only the
  silos an *explicit* domain of that name references; `admin` sees every silo. The
  conventional org-wide memory (silo `org-brain`, referenced by the `org` pseudo-domain)
  — and any silo referenced only by the `org`/`public`/`dm` pseudo-domains, or by no
  domain at all — stays **admin-only**, even for a caller holding a matching
  `domain:org`-style role: a pseudo-domain never counts as a covering domain.
- **DM/personal and workspace-tier memory are excluded entirely.** Personal memory is
  never an admin browsing surface (fail-closed privacy — revisit only with an explicit
  erasure/GDPR flow); the workspace tier is retired from resolution with no registry of
  "which workspaces exist" to enumerate. Neither is ever in the silo set these tools
  can reach.
- **Writes are a DIRECT edit, admin-only, not a proposal (v1).** The dream cycle's
  propose-then-review gate exists because the *agent* is untrusted-autonomous; the
  caller here is an authenticated human org admin — they already *are* the approver.
  Domain-role holders get `memory_list`/`memory_read` only in v1. Fragile point: if
  domain-scoped write access is ever granted, a domain admin editing a *shared* org
  silo probably ought to go through the propose gate instead of a direct write —
  revisit then, not now.
- **Caps**: `.md`/`.txt` only, 64KB/file, and a `_`-prefixed name (a host-internal
  operational marker, e.g. onboarding's `_onboarded`) is refused outright.
- **Provenance**: every write/delete is audited (`memory.write` / `memory.delete`,
  principal = the resolved OIDC subject) and lands a `control-plane edit by <subject>`
  commit through the same provider the agent's own memory writes use. `memory_write_file`
  additionally stamps an IN-FILE marker (`edited_by`/`edited_at`, `agent/memory/
  provenance.ts`) — the audit row alone isn't enough, because the dream cycle's tidy
  pass (below) never reads the audit log, only the materialized files, and needs its own
  signal that a file was a human's direct edit rather than agent-authored drift.
- **Deletion is a real per-file removal, not a `writeTier` trick.** Every memory
  provider's `writeTier` is upsert-only by design (it never removes a file just
  because a call omits it — the safety floor against a caller that read a partial
  subset accidentally wiping the rest), so `memory_delete_file` rides a dedicated
  `deleteFile` provider primitive instead. A backend that hasn't implemented it fails the
  call loudly rather than reporting `deleted: true` while silently leaving the file in
  place — every backend implements it today (the `github` memory backing shipped its
  `deleteFile` in OPE-64, widening `GitHubContents.deleteFile`'s return contract to a
  commit sha to match). A deletion attempt that reaches the backend and THEN fails there
  (a permission/network error from the transport) isn't silent either: it surfaces as a
  structured error to the caller AND lands its own `memory.delete` audit row
  (`deleted: false`, an `error` field) — the one write-tool failure mode here that gets
  audited, because unlike a bad org/silo/backend-unsupported refusal (never reaches a
  real store), this one genuinely attempted a mutation against a real backend and it
  didn't happen.

### Memory-admin, from inside Slack

The four tools above need the out-of-band MCP control transport (an OIDC hop, a
DB-adjacent process) — most admins never have that open. `memory_admin_list` /
`memory_admin_read` (agent tools, `agent/tools/`) are a **read-only bridge** into the
exact same `memory_list`/`memory_read` machinery, callable as ordinary Slack messages:

- **The ROLE fence is the CALLER's standing, not the channel they're in.** Every other
  memory tool (`purge_memory`, the base instruction's own memory index) is scoped to
  whatever silo the CURRENT channel resolves to — an admin standing in channel A has no
  way to inspect channel B's silo, or a DM-only-reachable one, without this bridge. So
  `memory_admin_list`/`memory_admin_read` resolve admin standing by scanning **every**
  configured domain for the caller's principal id (`access/roles.ts`'s
  `adminControlRoles`), not just the domain the current channel belongs to. An admin's
  standing travels with them.
- **The VENUE fence is the room the answer lands in** (`access/admin-read-venue.ts`).
  The listing is a map of the org's memory, and `memory_admin_read` pulls cross-domain
  file content — the role gate says nothing about the audience of the room it renders
  into. So the **org-wide** view answers only in an armed governance channel
  (`governanceChannelFor`) or in a DM with the asker. Any other channel gets the answer
  **narrowed to that channel's own domain**, with a note saying so; a channel with no
  domain to narrow to, or one the asker does not administer, gets a redirect and no
  content at all. The fence can only ever narrow: it never grants a silo the role gate
  would have withheld, and **membership of the governance channel or domain confers
  nothing** — the exact-id roster stays the only source of standing. Both outcomes are
  audited, under two distinct actions because they are two different events: a redirect
  renders nothing and stamps `governance.redirected`; a narrowed answer renders real
  content at a smaller grain and stamps `governance.narrowed`, carrying the narrowed
  role rather than the caller's wider one.
- **Reused, not reimplemented.** Both tools call the same `memoryListView`/
  `memoryReadView`/`siloScopeDenial` functions the MCP tools above use — the same
  config-driven enumeration, the same row-level scope filter, and the same
  DM/personal + workspace-tier exclusion (those tiers are never `MemorySilo` config
  entries, so they can never appear here for anyone, admin included).
- **Extra for the in-Slack surface, on top of what the MCP tools do:** a 64KB read cap
  (point at the out-of-band `memory_read` for anything bigger — not a security rule,
  just avoiding a huge file landing whole in a Slack thread), and every **read** is
  audited (`memory.admin_read`) — deliberately more than the out-of-band `memory_read`,
  which isn't audited today, because an in-Slack read is more exposed (any admin's live
  session, no separate OIDC hop, and the content renders into a channel/DM transcript).
  Listing (silo/file metadata, no content) is not audited, mirroring the MCP `memory_list`.

## Domain model self-serve

`set_domain_model` / `clear_domain_model` are the **runtime CHOICE layer** underneath the
git-config **envelope** (`agent/model/policy.ts` — see
[Configuration reference](../deploy/configuration-reference.md#model-policy-the-modelreasoning-envelope)):
the envelope is what a deployment may ever call (allow-list, provider deny, reasoning
ceiling), reviewed by PR; this is a domain admin picking, at runtime, which allowed model
and reasoning effort *their* domain actually uses today.

- **Domain-admin authority, not org-admin-only.** Unlike `memory_write_file`, this is the
  same `domain:<name>` tier `set_spend_limit`/`revoke_connector`/`delete_skill` already
  honour (`scopeDenial(roles, { org, domain })`) — a domain admin acts on their own
  domain; an org admin acts on any.
- **Envelope-clamped at SET time, and again at CALL time.** The tool refuses a `modelId`
  that isn't `isModelUsable` under the org's model policy, and a `reasoning` above the
  domain's *effective* ceiling (`reasoningCeilingForDomain` — the same per-domain layering
  `reasoningCeilingFor` resolves at call time, just resolved from the domain's *name*
  instead of a live channel). `packages/core/agent/model/routing.ts`'s resolver re-runs the pick through
  the exact same envelope clamp (`applyModelPolicyToRoute`) on every model call — defence
  in depth: a policy that narrows *after* the pick was set can never let a stale pick
  through.
- **An unpriced pick lands, flagged.** The envelope answers "may this deployment call this
  model", not "does this deployment know what it costs". A pick on a model with no committed
  rate (`agent/spend/model-pricing.ts`, or core's built-in table) succeeds — an unpriced model
  is not an error — and returns `unpriced: true` with a `warning`; the audit row carries the same
  `unpriced: true` flag. It matters because calls on that model add **$0** to the spend ledger,
  so this domain's turn spend stops counting against any **USD** cap over it until the rate is
  committed. The cap is not dead — it still sums every other priced row in the scope, sandbox
  runtime included — but it no longer sees the traffic the pick moved. Token caps are unaffected.
  `npm run lint:model-ids` cannot catch this one: it reads the repo, and a pick is runtime state.
- **No `expiresAt`.** Unlike a spend override, a domain's model pick isn't a temporary
  incident bridge — a domain legitimately wants its pick to stick until it deliberately
  changes it (same posture as a runtime domain skill: the domain *owns* the setting).
- **Cached on the hot path.** `packages/core/agent/model/routing.ts`'s resolver runs on *every* model
  call (not once per turn, like the spend/connector overlays), so the pick read is
  memoized for ~15s — an admin's change lands within roughly a turn's latency without
  making the operational store a per-token-generation dependency.
- **Fail-soft throughout.** No pick set, a store read failure, or no policy configured at
  all all reproduce today's git-route-only behaviour — a broken pick lookup never blocks
  a model call, it just means the git route stands.

## How an override actually works — it does not edit the live agent

An override is **a DB overlay on the immutable git baseline, merged at read time.** Two separate stores:

1. **Config baseline** — caps, bundles, and the rest, in **git**, baked into the deployed build. Immutable at runtime; only a PR → CI → deploy changes it.
2. **Override overlay** — rows in the operational store (SQLite local / Neon Postgres hosted). Mutable. Not git, not code.

A write tool writes **only layer 2**. No file is edited, no deploy happens, the running process's code is untouched. The merge happens on every check — the code that *consumes* config is written to also consult the override store and layer it on top, override wins:

```
config = resolveCaps(workspace, surface)     // layer 1: the git baseline
limits = store.spendLimits(org)              // layer 2: the DB overrides
return applyCapOverrides(config, limits, …)  // overlay 2 on top of 1 (override wins)
// store read throws → return config  (fail-safe: fall back to git baseline, never open)
```

It's like `git config` system-vs-local, or a feature-flag overlay: the override doesn't change config; the consumer consults a second store and layers it on.

## The override doctrine — overrides are bridges, never destinations

**Every override implies a pending reconciliation.** An override with no path back is a bug. An override lives only until one of two things happens:

- **(a) the change is made properly in config** — a PR lands that makes it the real baseline, or
- **(b) the incident is resolved** — the runaway or leak is over and the override is cleared.

Which maps onto two flavours:

- **Incident override (b)** — *narrow now, clear when resolved.* Revoking a connector, lowering spend. Always allowed; narrowing is never privilege escalation.
- **Bridge override (a)** — *temporarily widen while the PR that makes it real is in flight.* Spend-**up** only. Access can't be bridged (connector overrides are narrow-only), so only *budget* gets a widen-bridge — budget isn't a security boundary.

### Drift, and the two surfaces that make "temporary" true

Because the overlay (DB) and the baseline (git) are separate stores, they can disagree. Raise a cap from 2M to 10M via MCP and the running agent uses 10M while the repo still says 2M, with nothing pulling it back. Six months on, the repo — the supposed source of truth — is wrong about what's live. That gap is **drift**, and a git-driven system mustn't let it fester. Two surfaces keep overrides honest:

1. **TTL / auto-expiry.** An override carries `reason`, `setBy`, and — on a spend override only — an optional `expiresAt`. An expired override stops being read, so the consult falls back to the git baseline: the same fail-safe path as a store error, triggered by a clock. **Set a TTL and drift can't outlive the bridge.** The TTL is a choice, not a default: the control MCP takes it as `ttlSeconds`, and the card path sets none at all, so a cap raised from a card is sticky until somebody clears it. That is why the drift view below is the backstop, not a convenience.
2. **Drift view.** A read listing every live override with its `reason` / `setBy` / `expiresAt`, whether it's expired, and (for spend) whether it diverges from config. This is the reconcile worklist.

### The critical TTL asymmetry — auto-expiry is only safe when expiry *narrows*

- A **spend-up bridge** expiring reverts to the *tighter* config cap → **safe** (narrows). TTL is the safety mechanism.
- A **connector revoke** expiring would revert to the *granted* config → **re-opens access**, possibly while a leaked token is still live → **unsafe** (fails open).

So `expiresAt` applies to **spend overrides only.** Connector revokes carry `reason` and `setBy` for the drift view but are **sticky until deliberately cleared** — auto-clearing a revoke would widen access, which the whole model forbids. The drift view surfaces them as "still active, reconcile me." This same narrowing principle drives break-glass on spend — see [Spend & cost controls](./spend-and-cost.md).

## The break-glass halt — `halt` and `resume`

A halt stops **the consequential acts the seven arrows below reach** at one address, at once — the honest bound is at the end of this section, and it is not a footnote. It is the only control here that is total, temporary and instant: a connector override is partial, a routine's `status` is durable, a domain's `approvalMode` needs a config PR and a deploy. It does **not** take the agent off the air — conversational verbs never route through the approver chain, so a halted deployment still reads and replies, and it says that it is halted.

**One address per row, and the address is a union.** A halt names either the whole org (`orgWide: true` — a marker field, never a sentinel scope key) or a `(level, scopeKey)` pair over the same four levels the spend overlay uses: `surface`, `workspace`, `domain`, `user`. Those four are independent axes, not a nesting ladder — a domain spans tenants and a person is not a place — so a call is halted if **any** covering row is active. There is no expiry: a break-glass control that lapses on a clock is one nobody can rely on. There is no free-text reason either; the rows carry ids and names only.

**Seven enforcement arrows.** Approvals (one `mode:HALT` row in `agent/access/approver-chain.ts` — 23 of the 24 gated verbs; `resume` is the one exempt name, and `aws` resolves the halt into its own chain request because it consults the chain directly rather than through `requestApproval`) · the `open_pull_request` session-memo bypass, closed so it falls through to the chain · both routine legs, clock and event fan-out, through one shared predicate that audits `routine.skip` with reason `halted` · the credential-grant broker · egress, both planes (`deny-all` for the sandbox, and a refusal at `assertEgressReach` — which is `web_fetch`'s fence and `oeFetch`, **not** every outbound call OE makes) · the connector credential wall · **the approval CLICK** (`resolveApprovalClick`, `agent/approvals/flow.ts`), which is what stops a card minted *before* the halt from executing during one.

**The click arrow refuses; it withdraws nothing.** A halted click edits no row at all — no decide, no lazy expiry, no execute — so the card stays `pending` and the same person can click it again once an admin runs `resume`. The refusal is `outcome: "halted"` on the shared decide resolution, rendered per surface from one sentence (`haltRefusalMessage`), and audited as `approval.denied` with `reason: "halted"` and the halt's address. It asks about the **row's frozen address**, which is the same address the propose arrow asked about, so a halt that would have stopped the proposal stops its click.

**Two exemptions and two limits, stated.** The exemptions: `resume`'s own card, so a halt can never deny its own lift — `resume` is `gate:admin` and therefore *mints a card*, the chain already exempts it at propose, and without the same exemption at the click an admin pressing Approve during a halt would be refused (and an *unreadable* halt store would refuse it with no halt row anywhere, the exact outage the fail-open-on-the-lift half exists to prevent). The arrow reads that kind from `TOOL_CONSEQUENCE`'s own row for the verb, never from a literal. Second, `contradict`, because it runs no `execute`, consumes no row, and only records that a human judged the machine wrong about an act that already happened — a halt stops consequential acts, not the honest record. The limits: the person axis names the **requester**, so a `level: "user"` halt on the clicker alone does not reach here; and **the TTL sweep is not halt-gated** — `schedules/tidy.ts` keeps expiring pendings throughout a halt and `approvals.ttlHours` ships 24, so a halt longer than that loses the outstanding cards to the sweep anyway and their proposals have to be re-asked after `resume`. The arrow refuses a click; it does not preserve a card.

**Every arrow honours every level.** An arrow is only as wide as the address it can name, so each of the seven derives its address through `haltScopeFor` (or `haltScopeForCtx`, which delegates to it) rather than assembling one by hand — and that one function resolves the domain from the surface key for all of them. A private copy of that resolver is exactly how the axis went missing once: only the routine legs and the approvals plane named a domain, so a `level: "domain"` halt reached two arrows out of six while this page promised all of them.

**Sharing the resolver is only half of it — what you feed it decides the address.** Every arrow feeds it the ROOM the turn is running in: a `platform/workspace/surface` key, from which the tenant and the domain follow. The credential-grant broker shows why that rule is written down. It held the shared resolver and still lost three axes, because it fed it the grant's own `scopeKey` — and a grant's scope key is an eve SESSION ID, not a surface key. Being slash-free, it parsed as a bare domain NAME, so the broker's address carried `domain = <session id>` and named no surface and no tenant: `domain`, `surface` and `workspace` halts all missed there, and only `orgWide` and `user` reached it. A borrowed Notion grant inside a halted `payments` domain kept spending its owner's credential. The broker now derives from the room it audits (`grantCallHaltScope`, `agent/access/credential-grant-broker.ts`), like every other arrow.

**And it fails closed on a room it cannot read.** A ctx that names its org but no surface leaves a tenant address, and no `domain` or `surface` row can match it. The broker asks the halt question without an address there, so **any** active halt row in the org refuses the call, at any level, and the refusal says the room could not be read so the halt was applied to be safe (`grantCallRoomUnresolved` and `resolveHaltUnaddressed`). The mount's throw path never reaches that question: a throwing `resolvePartition` also leaves `org = "unknown"`, and the grant-row lookup runs ahead of the halt check — both store readers filter on `org_id`, so no row is found and the call refuses as `revoked`. The unaddressed rule is therefore defence in depth against a caller that names an org but not a room. A kill switch fails closed on an address it cannot read, exactly as it does on a store it cannot read. Only an arrow that has established its address is a placeholder may ask that question: for an arrow that names its room, halting on any row in the org would make an addressed halt total.

`packages/core/scripts/halt-test.ts` §2b asserts the matrix — every arrow, every level, each with the unrelated-scope negative control. It drives the **broker** through the broker's own derivation, on the same inputs production passes; it mirrors the other call sites' inputs by hand, and pins each of those to its file with a structural check that the file derives its address through this module. That distinction is load-bearing: the earlier §2b handed the broker a surface-shaped scope key it never sees in production, and the four axes all passed over the hole. §2c pins the broken shape directly — a session-id address names no surface, no tenant, and no real domain.

**The honest limit of "every level", stated rather than implied:** an arrow names the axes its own inputs carry, and an axis it cannot name is one no halt row reaches there. A context that resolves no person carries no `user` axis (§2b measures exactly that); a scope key that is a bare domain name carries no person axis, because a `user:` key needs a platform. In each case the axis is ABSENT, never guessed. The broker is the exception, and it is not a limit: a ctx there with no surface is refused by any active row rather than addressed at all (above).

### The two doors, and why they are asymmetric

| | `halt` | `resume` |
|---|---|---|
| chat tier | `open`, **no card** | `gate:admin`, **carded** |
| control MCP | `halt` | `resume` |
| direction | narrows | widens |

**A card in front of a brake pedal is a brake that works only when you do not need it.** A card needs an approver who is present and clicking, which during an incident is exactly what is not guaranteed. The tree already ruled that way three times at smaller blast radius — `task_cancel`, `set_dm_delivery`, `stand_down` — and this is the same rule at deployment scale. Resuming *widens*, so it is carded: WIDEN-SLOW / NARROW-FAST, the same doctrine that makes `revoke_connector` instant and `clear_connector_override` an admin decision.

**The stated cost.** An `open` verb is one a poisoned turn can call, so a halt is a denial of service the model can trigger. That is accepted, not overlooked: the failure is loud (every seat says it is halted), visible (one `admin.halt.set` row) and reversible by an admin. The opposite trade fails silently, because nothing stopped. Neither chat verb takes an address from the model — `scope` is a two-value enum and the key is derived host-side from the seat's own binding.

**The seat is told HOW WIDE the halt is.** `haltSeatParagraph` names the halt's **level** in words — "in this conversation", "across this workspace", "everywhere in this deployment" — and never its scope key or a principal id. Without that clause a seat under a room-level halt describes the pause as deployment-wide, which is the same state bleed at the text level that OPE-1759 tracks in the session. An **unreadable** halt names no width, because none is known.

**The HOST announces the halt, not the turn.** The chat `halt` posts the host-authored confirmation into the room itself, through the reply path, and the `admin.halt.set` row carries `announced` either way. It used to hand that sentence back as the tool's *result* and trust the turn to repeat it: in the soak run of 2026-09-12 the turn did not, the room heard only that one task was cancelled, and the halt stood 50 minutes. "Loud" is the argument for an uncarded brake, so it cannot be left to the model — and when the post fails, `announced: false` is what makes the silence findable.

**A stop that names one thing is not this verb.** The chat `halt` reaches the whole deployment by default (`scope: "org"`); `scope: "surface"` brakes this room alone. A member asking to stop one piece of work — "stop that changelog one" — is asking for `cancel_work` on that job, and a member asking the seat to go quiet is asking for `stand_down`; both leave the brake alone. The seat persona (`agent/instructions/seat-prompt.ts`) and the tool description say so in the same three branches, because the same soak run shows the escalation going the other way: the widest answer is the cheapest one to justify, and it is the one the room cannot undo.

### The safety argument: fail-closed at the arrows, fail-open on the lift

This is the one place in the plane where two fail directions are deliberately opposed, and the asymmetry is the whole argument.

- **Every enforcement arrow fails CLOSED.** An unreadable halt store answers "halted". A control whose reader fails open is a control an incident can switch off by breaking the database.
- **The lift fails OPEN.** `resume` is exempt inside the halt arrow's own `fires` predicate — one greppable cell in the transform table, and exactly one name. The control-MCP `halt`/`resume` verbs consult the halt reader not at all: they write and read the row directly, and never touch the approver chain.
- **Fail-open is not auto-approve, and `mode:DANGEROUSLY_BYPASS` exempts `resume` too.** The bypass arrow turns every `ask` into an `allow` for the domain that set it. Without a second exemption the two compose into a hole: the halt arrow lets `resume` past, the bypass arrow auto-approves it, and a model turn inside one bypass domain clears the deployment's halt with no admin click. A domain's `approvalMode` is a per-domain convenience; a halt is an org-wide operator stop, and the one never lifts the other. `resume` is carded in **every** mode.
- **Both exemptions name ONE constant, and it is the verb's own registry key.** `RESUME_TOOL` (`agent/access/consequence.ts`) spells the tool's row in `TOOL_CONSEQUENCE` and both `fires` cells. As two bare literals they could drift: renaming the tool would leave both cells exempting a name no tool carries — the halt would deny its own lift and the bypass would auto-approve the renamed verb — while the tests, spelling the same dead literal, stayed green. `halt-test.ts` §5c joins the constant to the tool's MOUNTED registration in `agent/contributions.ts` — a file that imports nothing, so its spelling of the name cannot move when the constant does.

Without the second half, an ACTIVE halt row would deny its own lift: `resume` is `gate:admin`, so it routes through the chain — the very place the halt denies — and the deployment would stay halted until somebody edited config and redeployed. The control MCP is the second door for the cases the chat door cannot serve: no admin in the room, no venue that can host a card, or a chat platform that is itself the incident.

🔴 **WHAT THE SECOND DOOR DOES NOT COVER, and it is the sharp case.** Both doors end in the same `clearHalt` call on the same operational store — so the failure the fail-closed reader is *most* worth naming, an unreadable halt store, is an outage **neither** door lifts. Every arrow answers "halted", every seat says the deployment is paused, and both `resume` paths fail on the same read. The asymmetry defends against an active halt row, not against a broken store. Two consequences, both operational:

- **The `halt` table is a schema migration.** On the SQLite floor and on a single-role Postgres it is created at init. On a **two-role Postgres** deployment `initOperationalSchema` issues no DDL under the runtime role, and the runtime-role `GRANT` for a new table is emitted only in owner mode — so upgrading to this commit without re-running the owner schema step leaves `halt` absent, every read throwing, and the deployment halted with no lift. Run the owner schema step on the upgrade, before the runtime role serves a turn.
- **The lift of last resort is SQL.** With the store unreachable by the app, the remedy is at the database: `UPDATE halt SET active = false WHERE org_id = '<org>'` under the owner role, or the owner schema step if the table is simply missing. Say so here rather than leaving an operator to discover it during the incident.

### The honest bound on "all egress is denied"

It is true for the sandbox firewall and for every host-side fetch OE itself dispatches, `web_fetch`'s fence included. It is **not** true for two paths, and no arrow can reach either:

- a **subagent's own framework `web_fetch`**, which falls back to eve's built-in — unwrapped, with no hooks behind it;
- **`web_search`**, which is provider-executed: the results reach the model server-side, inside the same model call, before any byte passes through this process.

While halted, both names are **subtracted** from the toolset at `projectToolSet` — absence, not refusal, which is the only control that reaches them. Absence lands on the *next* model call, so a call already in flight is not reached.

### The other two bounds, stated because a doc that overclaims is worse than one that admits

- **Work already dispatched finishes its step.** A halt skips a routine **fire**; a turn a fire already started keeps running until its next consequential act meets an arrow. It cannot abort a delegated worker either — OE owns no abort signal — though a worker's toolset is recomputed per model call, so absence lands there on its next call — including a later turn a `taskId` continuation opens. **Do not describe a halt as instantaneous.**
- **OE's own first-party transports are not egress arrows.** Posting a Slack or Discord card, a GitHub App call, a Linear call: these are host-side fetches OE dispatches that `assertEgressReach` never sees. That is what lets the control plane keep working under its own halt — and it is also why "a halt cuts all outbound HTTP" is false.
- 🔴 **A HALT PAUSES ACTS, NOT READING — and telling a seat otherwise stops work nobody stopped.** The authorization doctrine defines a consequential act as one whose effect **escapes the conversation** (`agent/access/consequence.ts`), and almost no arrow above touches a read. So under a halt the seat still reads, still replies, still delegates a read to a worker, still puts a file into the asking room (`post_file` is `open` — "same class as reply"), and the host still persists that room's memory. None of those escapes the conversation the halt still admits.

  **Two arrows do reach a read, and the halt texts name both rather than claim a clean rule.** The **connector credential wall** refuses every op through a connected integration, a read verb included — `assertConnectorGranted` asks the halt before the grant question (`agent/access/connector-scope.ts`), so `notion__search` is refused under a halt even though it is `open` and reads nothing out of the room. And **`assertEgressReach`** refuses `describe_image`'s URL arm, which is `open` and a read too (`agent/tools/describe_image.ts` → `oeFetch` → `agent/access/host-egress.ts`). Every other read is untouched.

  This is a **text** defect the soak run of 2026-09-12 measured end to end, not an enforcement gap. `haltSeatParagraph` told the seat "no connector calls, no fetching from the internet… do not look for another way round it, and do not retry". At T a worker the seat delegated to ran `get_pr_feedback` under that halt with `refused:false` — the correct outcome. At T+34 min 33 s the seat refused the same class of read-only question and quoted that paragraph, having lost no capability in between: its own read tools were withheld by the **lean-seat roster** (`turn.tool_gated reason=lean-seat`, 89 names), never by the halt, and delegation was the route it declined. A halt paragraph that overstates its reach is therefore not a cosmetic problem — it is a refusal generator. The seat paragraph, the in-chat confirmation, the chat tool's description and the control-MCP `halt`/`resume` descriptions now say exactly what the arrows above enforce, and say plainly that reading, replying and delegating a read are not ways round the pause.

  What a halt does stop, it stops through the seven arrows above.

### The in-chat `halt` and `resume` verbs take two scopes, not four

The control plane addresses a halt over four levels. The **in-chat** verbs
(`packages/core/agent/tools/halt.ts`) deliberately offer fewer: `scope` is a two-value enum, `org` or
`surface`, and nothing else. `chatHaltAddress` then builds the row — `{ orgWide: true }` for `org`, and
`{ orgWide: false, level: "surface", scopeKey: <surface key> }` for `surface`.

**The model never names the address.** The surface key comes from the seat's own binding, host-side.
So a person asking the agent in a room to halt that room gets a halt on that room, and the model
cannot widen it to a workspace, a domain or another person's scope. The wider address space stays with
the control plane, where the caller is an authenticated admin rather than a model.

## The local stdio entry — `npm run control`

`npm run control -w @open-everywhere/core` starts the same server on stdio, for the operator at
their own terminal. Point an MCP client at it (`{"command": "npx", "args": ["tsx",
"scripts/control-mcp.ts"]}`) or run it directly. It carries the write tools: a local stdio server is
a local process talking to a local client, so it is trusted by the OS, and it needs no bearer token.

**It opens the deployment's own operational store first, and refuses to start if it cannot.** This
matters because the write tools resolve the store lazily, per call. A process that registers none
does not fail — it falls through to a local sqlite stand-in, so `set_spend_limit` answers `ok` while
the override lands in a file the deployment never reads. The entry therefore calls
`connectOperatorStoreForCli()` before it builds the server — the wrapper that declares the `--org`
flag's org **before** it opens the store, which is what the org section below rests on. That helper
resolves the store by the
**runtime's own rule**, never a second guess: whatever store the deployed app would select from this
env is the store the entry opens.

Three consequences an operator sees:

- **The ready line names the store** — `store: hosted Postgres (DATABASE_URL)`, or the embedded
  Postgres floor, or the sqlite file. It is a label, never a connection string. It distinguishes the
  **provider**, not the data dir: the embedded-Postgres branch prints a constant label whatever
  `OE_PGLITE_DIR` holds, so the line catches "I am on sqlite, not the floor" and not "I am on the
  wrong floor directory".
- **A store it cannot open is a non-zero exit with the reason**, not a running server. Selecting
  `postgres` with no `DATABASE_URL` stops here.
- **The root-of-trust env is lifted from `./.env.local`** — only the allowlisted keys
  (`DATABASE_URL`, `OE_CREDENTIAL_ENCRYPTION_KEY`, `OE_OPERATIONAL_PROVIDER`,
  `OE_PGLITE_DIR`, `OE_SQLITE_PATH`), and only where the shell has not already set them. An MCP
  client starts this process with neither your shell nor that file, which is why the entry lifts
  them in itself. The path is relative to the **working directory**, and `npm run` puts you in
  `packages/core` — so name the file you mean: `npm run control -w @open-everywhere/core --
  --root-env ../../.env.local`. This is the same `--root-env` flag, with the same default, that
  `oe secret` takes.

On the embedded Postgres floor the store is a local data dir that **one process at a time** may
open, and the lock is taken on the first query rather than at boot. Both directions follow from
that:

- A `npm run dev` that has already queried the store owns the dir, and the entry then refuses to
  start rather than open a second copy. A dev server that has booted but not yet touched the store
  holds no lock, and the entry starts.
- A control **write** opens the dir too, and this process then holds the lock until it exits — for a
  client-launched server, until you close the client. `npm run dev` refuses to boot while it does.

Stop whichever process you do not need, or point both at hosted Postgres — see
[Database & operational store](../extending/database.md).

## Auth and roles

The remote plane is an OAuth 2.1 **resource** server, and it is **fail-closed**: with no issuer configured, it returns 401 to every request. It cannot deploy publicly-open by accident. Since OPE-72 the deployment also runs a **small authorization server of its own** for the MCP write transport — see [Control-plane MCP over HTTPS](#control-plane-mcp-over-https-oauth-21) below. That server issues tokens for this one resource and nothing else; it is not a general identity provider.

- **Identity is `(issuer, subject)`, never email.** Email- or domain-based role rules require a verified email and accept only trusted issuers, so the same human can map in through multiple providers *without* the classic email-linking account-takeover footgun.
- **Claim → role gives RBAC.** Roles resolve from token claims (the setting `control.adminRoleRules`); the pluggable OIDC issuer is a swappable seam — see [Scheduler & control-plane identity](../extending/scheduler-and-identity.md).

Two role tiers, both config-as-code (no roles table): `admin` — org-wide, covers every scope — and `domain:<name>`, scoped to one memory domain (`Domain.name`, `agent/memory/config/domains/<name>.ts`). A `domain:<name>` identity can call the write tools (`set_spend_limit`, `revoke_connector`, `cancel_routine`, `set_domain_model`, …) for scopes that resolve to its own domain — its own `scopeKey`/`surfaceKey`, or a channel that maps to that domain — but not org-wide reads/writes. `overrides_list` is **not** among them: its only input is the org, so it is an unscoped org-wide listing and takes the `admin` role.

🔴 **Every read on this surface enforces that tier — by refusing the ask, or by filtering the rows — and `audit_query` and `access_preview` are no longer the exception.** Both call `scopeDenial` before their view, on the same request-scope check every write tool already runs. `audit_query` is scoped by its full `platform` + `workspace` + `surface` triple, because a row belongs to a domain only through the container key `domainForChannel` resolves. A covering `domain:<name>` role therefore reads that one container's rows; a missing segment, or no container filter at all, is an org-wide ask and needs `admin`. `access_preview` is scoped by the `platform`/`workspace`/`channel` triple, and an omitted segment takes the view's own default (`local`/`dev`/`default`) for the gate as well as for the answer — the gate and the answer name one surface. 🔴 A `mode: "dm"` preview is the exception, and it takes the org-wide `admin` role: in DM mode the resolver applies only the `principal` and `group` bindings of the caller-supplied `principalId` and stamps the answer `dm:<principalId>`, so the triple describes nothing about that answer and cannot gate it. Nothing maps a person to a memory domain, which is why the fail-closed tier for a person is `admin`. A refused call returns the standard `forbidden: no role covers …` message, and the mount has already written its `control.service_call` audit row by then. The org stays pinned to the deployment's on `audit_query`. Read the history as an operator warning: until OPE-1802 these two ran no role check, so a `domain:<name>` token issued before that commit read the whole org's audit trail and resolved **any** scope's reachable hosts, connection ids, `secretRef` names, repos, plugins and instruction stack. This is the delegated-runtime-admin case the org-wide-only design once deferred ("demand-driven, only meaningful once a second team shares an org"). **Anyone-in-the-domain** (plain Slack channel membership, no admin listing needed) is a *separate*, coarser tier that governs agent-side operations like domain skill authoring and routine create/list/cancel; it isn't expressible over this OIDC-authenticated MCP surface, since an email/subject claim isn't Slack membership — that tier lives entirely on the Slack-native tools. Domain admins (`Domain.admins`, `agent/memory/config/domains/<name>.ts`) are the config-as-code roster this maps onto; an org admin is a domain admin everywhere.

### Control-plane MCP over HTTPS (OAuth 2.1)

The control MCP's **write** transport is mounted at `POST /control/v1/mcp`, behind an OAuth 2.1
resource server. It is the everyday remote path: an MCP client reaches `decide_pending_action`,
`set_spend_limit`, `resume` and every other control tool over HTTPS, with no stdio session and no
copy of the deployment's `DATABASE_URL` on an operator's laptop. The local stdio entry
(`npm run control`) stays as the break-glass for when the app is down.

**Two things decide whether the plane EXISTS, and a third decides whether anyone can use it.**

Either of these missing ⇒ **every** route of this plane answers 404, and an unarmed deployment does
not disclose that the seam exists:

- `OE_CONTROL_OAUTH_SIGNING_SECRET` — the HS256 key. At least 32 characters; a shorter value is
  ignored with a warning and the plane stays off, never half-armed.
- `CONTROL_OAUTH_ISSUER` in `packages/core/agent/control/oauth-clients.ts` — this deployment's
  public origin, `https://<host>`, with no path. A tracked literal, and it ships **empty**.

The third is the **client registry** in that same tracked file, which also ships **empty**. It is a
separate condition, on issuing a token rather than on the routes existing: with the secret and the
issuer set and no client registered, the two discovery documents are published and the MCP mount
answers **401**, but no credential can obtain a token from either grant. Register a machine client
by committing the sha256 **digest** of its secret, never the secret; register a person's client with
its exact redirect URIs.

🔴 **The issuer is declared, never read from the request's `Host` header.** An earlier revision
derived it from the request origin. That let the caller name the audience its own token was bound
to, which empties RFC 8707 audience binding of meaning — and audience is also the only thing
separating an authorization code from an access token at the verifier, because eve's `jwtHmac`
checks `aud` and never reads the JWT `typ` header. Declaring the issuer pins both sides to one
value nobody outside a pull request can move.

**One string names the resource.** The RFC 9728 document's `resource`, the RFC 8707 `resource`
parameter a client may pass at the token endpoint, and the `aud` the minted token carries are all
`<CONTROL_OAUTH_ISSUER>/control/v1/mcp`. A deployment fronted by a second hostname adds that alias
to `CONTROL_OAUTH_EXTRA_AUDIENCES` in the same tracked file; the list ships empty. An entry naming
the **authorization-code audience** (`<issuer>#authorization-code`) is **dropped with a warning** —
it would make a raw authorization code validate as a bearer token, skipping PKCE and the single-use
claim. The bare issuer and `issuer/` are dropped too, as defence in depth against an operator
pasting their own origin.

**Why the registry is in Git and not in env.** A client id, a redirect URI, an allowed audience and
a secret digest are declarations of who this deployment trusts. `AGENTS.md` rules that a trust
declaration is a tracked literal and env carries infrastructure only. The signing key is
infrastructure by that same rule — it is a key, not a list.

**The two grants.**

| Grant | Who | How |
| --- | --- | --- |
| `client_credentials` | one agent, one machine | The operator mints a random secret, commits its digest, hands the secret to that agent. |
| `authorization_code` + PKCE (S256 only) | a person | The client generates a verifier, calls `/control/v1/oauth/authorize`, exchanges the code at `/control/v1/oauth/token`. |

🔴 **The person leg is not a browser login, and this is the honest bound.** `/control/v1/oauth/authorize`
does not show a consent page and sets no cookie. It requires the caller to present a credential the
deployment's **existing** admin door already accepts (`OE_ADMIN_OIDC_ISSUER`, a GitHub user token when the setting
`control.githubAdmin` is on, or `OE_ADMIN_STATIC_TOKEN`) and mints a code for that identity. So the flow is a correct
authorization-code round trip for a CLI or any client that can set an `Authorization` header, and a
browser that opens the URL with no bearer gets a 401. Federating a human identity through a chat
provider is the separate leg of OPE-72 and is **not built**.

🔴 **A service token cannot walk that flow, and the endpoint enforces it rather than assuming it.**
That existing admin door composes the `OE_CONTROL_READ_TOKENS` authenticator, which authenticates a
read service token as an `admin` principal. Left alone, a read credential could have exchanged
itself for a control-plane access token — the exact fallback the disjoint-families rule forbids. The
authorize endpoint refuses any identity from the service-token issuer with `403 access_denied` and
audits the refusal. A machine that should reach this plane gets its own registered
`client_credentials` client, never a borrowed read token.

**Scopes are the roles you already have.** There is no second permission model.

| Scope | What it means |
| --- | --- |
| `control:admin` | the existing `admin` role — covers every scope in the deployment |
| `control:domain:<name>` | the existing `domain:<name>` role |
| `control:write` | register the mutating tools. **Absent ⇒ the token is read-only.** |

A token's scopes become the same `roles` array `scopeDenial(roles, { org })` has always taken, and
the same `readOnly` flag that strips every write tool at `control/server.ts`'s one choke point. A
token carrying **no** role scope is refused at the door with `403 insufficient_scope` rather than
admitted with an empty role set. A person's token can never out-reach the credential that
authorized it: the authorize endpoint narrows the scopes to what that identity's own role rules
grant, and withholds `control:write` from a read-only principal.

**Discovery and refusals are real.** `GET /.well-known/oauth-protected-resource/control/v1/mcp`
(RFC 9728) and `GET /.well-known/oauth-authorization-server` (RFC 8414) describe the plane. Every
refusal **from the MCP mount** carries a `WWW-Authenticate: Bearer` challenge with a
`resource_metadata` pointer, so a compliant MCP client can discover where to get a token. The
authorization-server endpoints answer in their own vocabulary instead — RFC 6749 §5.2 error bodies,
a `Basic` challenge on the token endpoint's `invalid_client`, and a bare `Bearer` challenge on an
unauthenticated `/authorize`. The authorization response carries `iss` (RFC 9207), so a client
registered against two servers behind one redirect URI can tell which answered. Dynamic client
registration is deliberately **not** advertised — an unauthenticated caller must not be able to
create a client.

**What is eve's and what is ours.** The whole resource-server arm is eve's (re-read at the 0.71.0 pin): `jwtHmac`
verifies the signature, `exp`, `aud` and `iss`; `oauthResource` carries the RFC 9728 metadata;
`routeAuth` walks the strategies and produces the 401. eve ships **no** authorization server at
all — no token endpoint, no PKCE, no client registry — so that half is ours, and a parity test pins
both halves so an eve upgrade that changes either reds a gate.

🔴 **There is no per-token revocation, and no doc should say there is.** An access token lives 10
minutes and there is no refresh token, so the revocation window is the token's own lifetime.
Rotating `OE_CONTROL_OAUTH_SIGNING_SECRET` invalidates every outstanding token at once — that is
the break-glass. A revocation list would mean a store read on every control call, and the store is
what an operator reaches this plane to inspect when it is unhealthy.

**Audited, naming the principal.** Every token issue (`control.oauth_token_issued`), every
authenticated MCP call (`control.service_call`) and every refusal of a **registered** principal
(`control.oauth_refused`) writes an audit row naming that principal — `oauth-client:<id>` for a
machine, `<issuer>#<subject>` for a person. No token or secret value is ever logged.

A request naming a client id this deployment has never registered is refused **without** an audit
row, and that is deliberate. The id on such a request is unauthenticated caller-supplied text of
unbounded length, and the audit log is hash-chained behind a per-org lock — auditing it would let
anyone write attacker-named rows into that chain in a loop. Every other control door refuses before
it audits, for the same reason.

### Service tokens (read-only)

A machine credential for **read views only** — the shape a CI/e2e harness needs to price a run
(`usage_window`) without an OIDC dance and without any possibility of mutating anything.
Optional: with the env unset, the mode doesn't exist and behaviour is unchanged.

> **"Read-only" is literal, and there is a second family that isn't.** A service token in
> `OE_CONTROL_READ_TOKENS` opens read views and nothing else. The one seam that can inject
> agent activity — the test-wake route — authenticates against a **separate**
> `OE_CONTROL_INJECT_TOKENS` family instead (see
> [Injection tokens](#injection-tokens-the-test-wake-seam) below). The two families are
> disjoint and neither falls back to the other: a read token is refused (401) by the
> injection route, and an injection token opens no read view. Mint them separately, and
> never paste an entry into the other variable.

**Minting one** — the repo ships a print-only helper (it never writes the token anywhere):

```bash
npm run mint:control-token -w @open-everywhere/core -- e2e-harness
# prints the token VALUE (→ your CI secret store) and the "e2e-harness:<sha256hex>" env
# entry (→ the deployment's OE_CONTROL_READ_TOKENS; comma-separate for more)
```

or by hand:

```bash
TOKEN=$(openssl rand -hex 32)                      # the credential — store it in your CI secret store
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)
# on the deployment:
OE_CONTROL_READ_TOKENS="e2e-harness:$HASH"          # comma-separate for more: "name:sha256hex,name2:…"
```

The deployed env holds only the **sha256 hash**, never the token — leaking the env doesn't leak
a usable credential. Names are lowercase `[a-z0-9_-]` (they become the audit principal
`svc:<name>`); a malformed entry is dropped fail-closed with a warning that deliberately never
echoes the entry content. Verification is a constant-time digest compare (`timingSafeEqual`);
token values are never logged anywhere.

🔴 **A service token names a caller, never an actor.** The two **route** doors — the read routes
(`agent/control/read-route.ts`) and the test-wake injection route (`agent/control/test-route.ts`) —
build their auth bag with `serviceTokenFireAttributes` (`agent/routines/fire-auth.ts`), the same
module the routine and webhook fires use, so the bag carries the **unattended-origin marker**.
`svc:<name>` stays on the audit row, and the *acting* principal derived from that bag is empty — so
a gate that asks "is a human here, acting" refuses this caller. Without the marker a non-empty
`svc:<name>` would answer that question as if a person were present: the defect measured one fire
family over, on the webhook fire (OPE-278).

**Two honest limits.** First, neither route hands its snapshot to an agent session today — each
reads `principalId` for its audit row and nothing else — so the marker is a standing property of
the door rather than a refusal any path exercises. It is stamped so a future route that does carry
the snapshot inherits it, and the principal-gate lint (`npm run lint:principal-gate`, rule 4)
refuses any service-principal auth built inline instead. Second, the **MCP mount is a third door
and is not covered**: a service token there resolves to an `AdminIdentity` (`readOnly: true`), which
carries no attribute bag at all. Its read-only guarantee is the structural one below, not this
marker.

**The read-only guarantee is structural, not a per-call check.** A request authenticated by a
service token resolves to a `readOnly` principal, and the per-request MCP server is then built
with the mutating tools **unregistered** — every write tool lives behind a single registration
choke point (`registerControlWriteTools`, gated on `includeWrites && !readOnly` in
`buildControlServer`), so for a service principal there is no write tool to call at all: a
`tools/call` for one is an unknown-tool error, even on a mount that registers writes for admins.
Reads are scoped like an org admin's (the token is a deployment-level credential), so org-wide
views (`usage_window`, `usage_summary` unscoped, `overrides_list`, `routines_list`,
`session_transcript`) work — for the deployment's **own** org, and for no other.

🔴 **The org is checked before the role, on every call that names one.** Every gate on this surface
runs `foreignOrgDenial` (`agent/control/auth.ts`) **first**, and only then asks whether the caller's
roles cover the scope: the two scope gates `scopeDenial` and `siloScopeDenial`, the three role-only
gates in `agent/control/writes.ts` (`requireAdmin` for the memory writes, `requireOrgAdminForLinks`
for the link-set and directory verbs, and `decide_pending_action`'s org-admin-only arm for a
domain-level or per-user spend cap), and the two row-filtering readers that call no gate at all
(`memory_list`, `pending_actions_list`) each check it. `decide_pending_action` checks it BEFORE it
reads the row, because its `org` argument is the partition key `getPendingAction` reads under: its
spend-cap arm answers the role question alone, so an admin-scoped caller naming another tenant would
otherwise have had that tenant's frozen action EXECUTED. The order is the control. It used to run the
other way: `admin` returned "covered" before `org` was read at all, so a caller holding that role —
an org admin, or any read-only service token, which is minted with roles `["admin"]` — could name
another tenant. Reads answered from that tenant's rows, routine PROMPTS included; `memory_write_file`
went further and overwrote that tenant's silo. The role model scopes by DOMAIN and cannot express
"this org and no other", so the org is not a role question: it is a property of the deployment, read
the same way `audit_query` and the HTTP read route read it. A tool that takes an `org` argument
therefore accepts exactly one value, and says so by name when given another. `audit_query` goes
further and takes no `org` at all AND pins `deploymentOrg()` on the way to the store, so it can name
no other. `spend_report` has the same shape (OPE-1446): it advertises no `org`, and `spendView`
passes `deploymentOrg()` to `listSpendLedger`, so a foreign tenant's ledger rows never enter the
process. The pin covers the per-person allowances the same read returns. Every control read that
queries org-partitioned STORE state is now org-scoped, by a named argument the gate refuses or by a
pin no argument can move. `access_preview` is outside that sentence because it reads no store rows
at all: `accessView` resolves deployment CONFIG (bundles, bindings, the plugin registry) through the
synchronous `resolveAccess`, so it has no partition key to scope. Give it a store read and it needs
a pin like the rest. A multi-org store is not a supported posture on this surface.

The org a deployment answers for has ONE spelling — `deploymentOrg()`
(`agent/identity/deployment-identity.ts`, a leaf module re-exported by `agent/identity/binding.ts`),
which normalises the declared org through `seg()`. The org is TRACKED CONFIG, declared in
`agent/identity/surfaces.ts` and registered at boot; it is not an environment variable. Every
partition key derives from it, webhook fires and the
operational store's boot-time `audit.integrity` record included; nothing re-derives it. 🔴 That is
the guarantee inside the deployment, which loads the declaration. An OPERATOR-TIER process does
not. Five entrypoints declare the org from `--org` BEFORE they open the store: `oe secret`, and the
four core-workspace scripts `npm run audit`, `npm run spend`, `npm run routines` and `npm run
control` (the local control MCP server, `scripts/control-mcp.ts`). Each is a core script and cannot
import the app's config, so each reads `default` unless the operator passes the flag, and on a
non-default tenant an undeclared one would answer about the wrong partition and file its
`audit.integrity` row where the agent never queries. 🔴 **An npm script needs the `--` separator, or
npm eats the flag**: `npm run audit --workspace @open-everywhere/core -- --org <your org>`. Written
without it, `npm run audit --org <your org>` forwards only the bare value, `--org` never reaches the
script, and the process runs as `default` with no error. `scripts/deploy/census.ts` takes `--org`
too, but only to scope the rows it READS: it parses the flag AFTER `connectOperatorStore()`, so it
declares nothing, and any `audit.integrity` row that connect writes is filed under `default`
whatever the flag says (OPE-1576). The
leaf module exists so the boot path can share that one spelling: `operational/postgres.ts` records
its integrity row before any store singleton exists and cannot import the identity layer's graph.
Two spellings of one deployment's org would put its sessions
and its webhook fires in partitions no single reader queries, which is how a scoped reader loses rows
it should see.

**Audit trail:** unlike an interactive admin (whose reads aren't logged), **every** HTTP call
bearing a service token is audited — `action: control.service_call`, principal `svc:<name>`,
with the JSON-RPC method and tool name — so a machine credential's entire usage is
reconstructable from `audit_query`.

### The deployment-mounted read route

Service tokens also open the one part of the control plane the **deployment itself**
serves — a read-only HTTPS route mounted alongside the public Slack/webhook routes, so a
harness needs no out-of-band process (and, per the doctrine, no database URL — the
deployment exposes a tool, never a DB):

```
GET /control/v1/usage?since=<ISO-8601>&workspaces=<csv of platform/workspace keys>
Authorization: Bearer <service token value>
```

It returns the same `usage_window` view as the MCP tool of that name — rows grouped by
surface × model since the timestamp, each priced **on the deployment** at its own stamped
model's rate (unpriced/unstamped rows carry tokens only). This is what the e2e driver
pack's per-run cost report reads (`E2E_TARGET_URL` + `E2E_CONTROL_READ_TOKEN` +
`E2E_USAGE_WORKSPACES` on the harness side).

Same guarantees as the MCP mount, enforced the same ways:

- **Fail-closed:** with `OE_CONTROL_READ_TOKENS` unset or empty the route answers **404**
  to everything — the mode is off and the endpoint effectively does not exist. Configured,
  a missing or non-matching bearer is a **401** (same constant-time hash compare).
- **Read-only structurally:** the route's module imports only the read views — the write
  tools aren't gated behind a check here, they are simply **not present** in this mount,
  and the channel registers a single `GET`.
- **Audited:** every authenticated call writes the same `control.service_call` audit row
  (principal `svc:<name>`, with the view and filters) as a service-token MCP call.

Seven sibling routes share this exact contract (fail-closed 404, constant-time bearer,
read-only, self-audited): `GET /control/v1/tool-usage?since=<ISO-8601>[&until&domain&by=connector|tool]`
(the `tool_usage` view — calls, errors, cards and the attributed $ per connector and per tool,
OPE-2435), `GET /control/v1/audit` (the
dispatched/replied/no_reply/dropped-prose/rejected audit window — the uniform assertion channel for
audited *silence*), `GET
/control/v1/unified-audit` (the cross-surface domain audit), `GET /control/v1/runtime-signal`
(no query — reports `{ hasDeploymentId: boolean; credentialBrokerArmed: boolean }`: whether this
process's env carries a non-empty `VERCEL_DEPLOYMENT_ID`, the fact eve's dynamic-tool-roster
refresh keys off (`deploy:census`'s OPE-658 signal check), and whether this process's
`OE_CREDENTIAL_ENCRYPTION_KEY` decodes to a valid AES-256 key, the fact the db credential broker's
registration keys off (`deploy:census`'s OPE-641 signal check); presence only, neither the
deployment id nor any key material ever leaves the route), and:

**Reading `/control/v1/audit` as evidence — one thing to check first.** `?actions=` takes a CSV.
Every named action is scanned in the store on its **own** page of 1000 rows, and the pages are
merged newest-first. A common action therefore cannot hide a rare one **from the scan**, and neither
can this route's own `control.service_call` self-audit row, which a polling caller writes on every
call — a long poll's own rows used to compete for that page and could push a wanted row off it,
which is a *candidate* cause of the OPE-1933 reds rather than a reproduced one (~900 calls in six
minutes sits below the 1000-row page on its own). Two limits remain, and they report differently:

- An action with **more than 1000 rows of its own** in the window has a tail behind its page. The
  response carries `scanTruncated: true` and `scanned`, plus `capped: true`.
- The merged answer is still cut to **your one `limit`** across every named action, so a common
  action's newer rows can push a rare action's rows out of the **answer** even though both scans
  found them. That case reports `capped: true` and **no** `scanTruncated`.

So read **both** flags before you conclude that an action never happened, and the route always names
the ceiling it applied as `maxLimit`. On `capped: true`, raise `limit`, narrow the window, or ask
for the rare action on its own. An empty answer with either flag means "I did not look far enough",
never "there are no such rows". A repeated action is scanned once. A CSV naming more than **25**
distinct actions is refused with 400, because each name costs its own scan — ask for fewer, or drop
the filter and match the rows yourself.

🔴 **Every row carries a `seq`, and it is the only monotonic locator here.** `since` and `until`
are wall-clock bounds over a wall-clock column: the agent stamps a row's `ts` at append time, so on
a host whose clock steps backward a row written later can carry an earlier `ts` than one written
before it. A `ts >= since` window then drops that row silently and forever. When you mean
"everything written after this point", read the window once to learn the newest `seq`, keep the time
bounds only as a coarse page bound, and select the rows whose `seq` is greater. `seq` is the store's
own insert order and never moves backwards. It is a locator, not a hash input — the chain's
integrity still lives in `prevSha`, which this route does not serve.

🔴 **Bound a CLOSED window with `until`, or you cannot read it back.** Rows come out newest-first
and the cap applies after that sort, so `since` alone asks for *the newest N rows since then* — not
*the rows in that window*. Once later rows exist, an old window's own rows sit behind the page and
the read answers empty. A live run hit exactly this: six legs ran over 35 min, the run wrote well
over a thousand further rows, and no `wake.ingress` or `<surface>.dispatched` row for any of those
legs could be produced afterwards. `until` (inclusive, like `since`) closes the window at the top,
so the window itself is the page:

```
GET /control/v1/audit?since=<iso>&until=<iso>&actions=wake.ingress,reply.post
```

An inverted window is refused with a **400** rather than answered with an empty list, because an
empty list there reads as "nothing happened". To **page** a window that is still too big for one
response, re-read it with `until` set to the oldest row you received; both bounds are inclusive, so
that page repeats the rows stamped exactly at that instant and you de-duplicate them.

Both bounds are **normalised to canonical UTC** before the query runs, so an offset form
(`2026-01-10T05:30:00+01:00`) and a second-precision form (`2026-01-10T04:00:00Z`) bound the window
by the instant they name. The route echoes the normalised pair in its `filter`, and the
`control.service_call` row it writes records the same pair.

```
GET /control/v1/session/<sessionId>/transcript[?startIndex&limit&idleMs]
Authorization: Bearer <service token value>
```

**Session transcript** replays one session's durable event stream — inbound messages, model
reasoning, tool calls with their arguments, tool results with status, per-step
tokens/cost/generation id, and turn/session boundaries — each with its write-time `meta.at`
timestamp, in order. It reads eve's own public per-session replay (`attachSession(id)
.getEventStream({ startIndex })`); nothing is captured or stored a second time, so no new
at-rest copy is created. `startIndex` + `limit` (default 2000, capped) is the pager
(`nextIndex` = the cursor to resume from); a **parked** session — one that has replayed all
recorded events and is waiting for its next turn — is drained to what is durably recorded
and returned with `complete:false` (`idleMs` is the parked stop signal; a hard wall-clock
cap bounds the request regardless), never held open. The join key is `detail.sessionId`,
stamped onto the reply/no_reply/dropped-prose audit rows: poll `/control/v1/audit` for the
row, take its `sessionId`, then fetch its transcript.

**`<sessionId>` is eve's durable session id** — a `wrun_…` workflow run id, exactly the value
audit rows carry as `detail.sessionId`. It is **not** a channel continuation/window token
(`oe-dom:<domain>:…:oe-sup:g<n>`, or eve's namespaced `unified:<raw>` form): those address a
*channel*, not a run, and a window's owning session rotates. Ask for one and you get a
**404** with `found:false` and a hint naming the right lookup. A 200 always carries
`found:true` and means the id resolved — `count:0` on such a response is a genuine "this
session has recorded nothing yet", never a miss. (Before this distinction existed an unknown
id answered `200 {count:0}`, because eve's replay of a run that does not exist neither yields
nor errors — it just idles out. "Unknown" and "expired" still give the identical 404, so
nothing is enumerable.)

> A transcript is exactly as sensitive as the conversation itself — it carries untrusted
> thread content and tool I/O (and possibly secrets in tool output). It is served **only** to
> the admin service token, the same trust level as the audit log, and is in scope for the same
> GDPR/forget/at-rest story. There is no redaction pass. **This route** is a human/harness read
> surface: no agent tool reaches it, and a service token is the only thing that opens the route
> itself. One other door reaches the same CONTENT — the control MCP's `session_transcript` tool,
> which is this route's client. That door is gated on the org-wide `admin` role, and on an HTTP
> mount the token it presents is the **process's**, not the caller's: an OIDC org admin reads a
> transcript there without ever holding a control-read token. See
> [Reading a transcript from the control MCP](#reading-a-transcript-from-the-control-mcp). The agent
> has exactly one, much narrower way to read a transcript — `read_routine_transcript`, which replays
> a *routine run from the asking channel only*, through the untrusted-content envelope, and needs its
> own separate secret; see
> [Proactivity and routines](../capabilities/proactivity-and-routines.md#and-what-did-it-actually-do).
> The `type`/`data` of each event is eve's own event shape at the deployment's eve
> version (pre-1.0, wire-versioned) — treat it as "eve's events", not an OE-stable schema; the
> `index`/`at` envelope is stable.

#### Reading a transcript from the control MCP

`session_transcript` is the operator's version of that read. The route answers raw JSON events,
which is right for a harness and unreadable for a person: a few hundred events are mostly streaming
deltas and per-step token accounting. The tool returns the **render** instead
(`agent/control/transcript-render.ts` — the same projection `read_routine_transcript` uses), so the
answer is the lines that say what the run did.

**It is a client of the route, not a second way in.** A session's durable stream is reachable only
through eve's `attachSession(id).getEventStream()`, which eve hands to route handlers only. Neither
mount of the control server is a route handler — the local stdio entry is a plain CLI process, and
the streamable-HTTP transport is not an Eve route — so the tool dials the deployment's own
`GET /control/v1/session/<id>/transcript` with a control-plane read token, exactly as `deploy:smoke`
and `deploy:census` call their sibling routes. No new route, no new credential family, no new
capability inside the deployment, and the route's fail-closed 404 and per-call audit row are
unchanged.

Two gates, and both must pass:

- the **org-wide `admin` role** on the MCP call. A session id names a *run*, not a domain, so there
  is nothing for a `domain:<name>` role to cover — the same posture `usage_window` and
  `spend_report` carry. The role is checked **before** the tool looks at whether it is configured,
  so a refused caller learns nothing about the mount;
- the **service token** the route itself demands. The tool presents one; it does not bypass it.

🔴 **WHO HOLDS THAT TOKEN DECIDES WHO THE SECOND GATE ACTUALLY STOPS, and the two mounts differ.**
On `npm run control` the token is the operator's own, out of their own deploy-plane environment, so
both gates are theirs and the reader set is unchanged. On an **HTTP mount** the token belongs to the
**process**: it lives in the reader the mounting route was built with, while the caller presents an
OIDC identity whose roles come from the setting `control.adminRoleRules`. So wiring `AdminHttpOptions.readTranscript`
widens the set of principals who can read a transcript from *token-holders* to *org admins* — an
identity matched by an `admin` role rule reads any `wrun_…` without ever being issued a value listed
in `OE_CONTROL_READ_TOKENS`. That is a deliberate choice (a transcript is served at the audit log's
trust tier, and an **unscoped** `audit_query` is already an org-admin MCP read), but it is a choice the mounting
route makes, not one this repo makes for it: **no mount in this repository supplies a reader**, so
the widening is latent until a self-host route wires one.

Because the read goes through the route, **every call leaves the route's own
`control.service_call` audit row** on the deployment — with the session id, so a transcript read is
join-able back to the audit log. Read that row for what it is: it names the **token**
(`svc:<name>`), not the human or agent who drove the MCP call, exactly as it does for any other
service-token read. An interactive admin's control-plane reads are not otherwise logged.

For `npm run control`, the token and the deployment come from the deploy plane's existing env —
`OE_DEPLOY_CONTROL_TOKEN` (or `E2E_CONTROL_READ_TOKEN`) and `E2E_TARGET_URL` (or
`OE_DEPLOY_BASE_URL` / `OE_DEPLOY_ALIAS`), the same names [Rollback and
verification](../deploy/rollback.md#environment) documents. With neither set the tool stays
registered and answers with the names to set; the server's ready line says which deployment it
reads from, so an answer about the wrong instance is visible at startup.

🔴 **What comes back is untrusted content, and this plane has no funnel to wrap it in.** The render
quotes thread text and tool output an outsider may have authored. `read_routine_transcript` passes
its copy through `access/untrusted.ts` because it is composing an OE agent's own context; an MCP
client outside this process has no such seam, so the tool states the hazard in its description and
prints it as the first line of every answer. Read a transcript as evidence, never as instructions.

```
GET /control/v1/session/<sessionId>/model-calls[?turnId&limit&body]
Authorization: Bearer <service token value>
```

**Captured model calls** serve the soak tests' prefix-replay harvest. When a deployment arms
`soak.capture` (a code-only setting, shipped **off**), every model round-trip records the
**composed request body as sent** — gzipped and base64'd, with the resolved model id, the session,
the turn and step index, a `sha256` of the uncompressed body, and a schema-version stamp. This
route reads those rows back, oldest first. `body=0` returns the metadata only — enough to count the
captures, to run the capture-vs-step cross-check, and to choose a replay cut point — and moves no
prompt bytes; `body=1` (the default) serves the bytes and is capped hard, because one body can be
hundreds of kilobytes. An unknown session answers `200 {count: 0}`, not a 404: the store cannot
tell "no such session" from "capture was never armed for that run", and both are honestly "nothing
recorded here".

> 🔴 **A capture body is more sensitive than a transcript, not less.** It is the conversation as the
> model saw it — the system prompt, every rendered member message, every tool result — verbatim,
> with no redaction pass, plus the harness's own prompt edits. Four properties bound it, and all
> four are structural:
>
> - **Nothing is written unless a deployment arms it.** `soak.capture` has no environment path, so
>   arming costs a reviewed diff and a deploy. A deployment that never arms it has an empty table
>   and this route returns `count: 0` forever.
> - **An armed run should still be scoped to its own surfaces.** `soak.captureSurfacePrefix` records
>   only calls whose surface key starts with that prefix, so a soak run captures its fixture channel
>   rather than every conversation the deployment is holding. The shipped value is empty (every
>   surface) because a default cannot know your soak surface — set it whenever you arm capture.
> - **The store never leaves the deployment.** Rows live in the deployment's own database, beside
>   the audit log and the session history — the same trust domain, the same operator, no third
>   party and no new host.
> - **Only an admin service token opens it.** No agent tool reaches this route, and none may be
>   given one. With `OE_CONTROL_READ_TOKENS` unset the route answers 404 like every sibling.
> - **Bodies are never logged.** The recorder logs that a write failed and where; it never logs a
>   byte of the body, and an audit row carries counts and ids only.
>
> **Retention is an act, not a clock.** The harvest step deletes a run's captures by session id
> once the replay library has taken what it needs. There is deliberately no TTL: a soak run's whole
> value is the frozen prefixes it produces, so expiry must be something a person does after
> harvesting, never a timer that destroys the evidence. Disarm `soak.capture` when the run ends —
> leaving it armed turns a per-run snapshot into a standing transcript store, which is exactly what
> the design forbids.

```
GET /control/v1/model-calls/sessions
Authorization: Bearer <service token value>
```

**Which sessions hold captures** is the retention operator's discovery read, and the sixth sibling.
The route above needs a session id up front; an operator who armed `soak.capture`, ran a soak and
does not remember which sessions it produced has no other supported way to enumerate them. Each row
carries the `sessionId`, its first and last capture timestamp, the row count and the total
uncompressed bytes — **no body byte is ever in this response**. Same contract as every sibling:
fail-closed 404, constant-time bearer, one `control.service_call` row per authenticated call. It
deletes nothing: this mount is read-only by construction, and purge is a separate operator script
over a direct store connection (`scripts/soak/soak-capture-purge.ts`).

### Injection tokens (the test-wake seam)

A **second, disjoint** service-token family, for the one control-plane route that is not a
read: `POST /control/v1/test/wake`, the spoofed-ingest seam an e2e pack or the ambient/memory
eval harness uses to feed a synthesised wake into a standing window without driving Slack,
Notion or Linear. Same wire format as the read family (`name:sha256hex`, hashes only), same
constant-time compare, same `control.service_call` self-audit — but a different variable,
because it is a different power:

```bash
npm run mint:control-token -w @open-everywhere/core -- e2e-injector --inject
# prints the token VALUE (→ your harness env, as E2E_CONTROL_INJECT_TOKEN) and the
# "e2e-injector:<sha256hex>" entry (→ the deployment's OE_CONTROL_INJECT_TOKENS)
```

**Why it is not a read token.** Injection transitively **writes** (the receive registers a
wake→origin map row and the model then acts, posting real replies to the real origin the
body names). The caller also supplies `authAttributes` that override the host-derived
identity, and the `taskThread` selector mints a **task-grain** seat — full tool kit, no
narrowing row. None of that is a read power, so it does not ride the credential this page
calls read-only. The families never fall back to each other in either direction: a read
token presented here is a **401**, and an injection token authenticates no read view and no
MCP mount.

**Still triple-gated, fail-closed.** The credential moved to its own family, and gate 1 moved from the `OE_TEST_WAKE` env var to a setting (OPE-2411):

1. The `wake.testWakeRoute` setting must be on. **Default off ⇒ the route 404s.** A test bed
   arms it in its own tracked settings file, so arming it is a reviewed commit. It was the
   `OE_TEST_WAKE` env var until OPE-2411. 🔴 This repository's own `agent/settings/settings.ts`
   turns it on for the maintainers' test bed, so a deployment made from a clone of this
   repository must delete that entry, or gate 2 alone guards the route.
2. `OE_CONTROL_INJECT_TOKENS` must be configured **and** the bearer must match an entry in
   it. Unset ⇒ 404 (the route does not exist); configured but non-matching ⇒ 401.
3. A standing window (`mode: "solo"` or `"unified"`) must be enabled for the named
   `surfaceKey`, the claimed `domain` must be the one that surface actually resolves to, and
   the `origin` must be structurally valid ⇒ else 400.

**The body must also be COHERENT about addressing.** `mention`, `reason` and `addressing` are
three separate fields, so a body could once state `mention: true` (or `reason: "mention"`)
while `addressing` fell to its `channel-watch` default. That rendered a `mention="true"`
envelope beside `addressing="channel-watch"` — one attribute saying the message addressed the
agent, the other being the value the standing prompt holds to its highest silence bar. Such a
wake contradicts itself, and no real surface can produce it (every adapter derives all three
from one direct-mention fact). The route now reads an addressed attribute as the addressing:
`mention: true`, `reason: "mention"` or `reason: "dm"` with **no** stated `addressing` selects
`direct-mention`, and any of them paired **explicitly** with a watch addressing
(`channel-watch` / `thread-follow` / `name-drop`) is a **400**. An unknown `addressing` value
is a 400 as well. A body that states no addressed attribute is unchanged — it still defaults
to `channel-watch`.

Leave `wake.testWakeRoute` off on any deployment that isn't being driven by a harness. On one
that is, treat the injection token as the more sensitive of the two: it can make the agent
act, whereas the read token can only observe.

## In-Slack approvals

The second door from the doctrine at the top of this page: for a human already in the Slack
workspace, some of the writes above don't need the control MCP or an OIDC token at all — they
run through Slack itself, gated by a human click instead. (These also work on **Discord**: the
card posts as a message with Approve/Reject buttons, the click comes back through Discord's
signed interactions endpoint, and a guild **Administrator** may approve that guild's own scopes
without any config seed, alongside the same config-as-code rosters. Which surfaces can host a
card is a **capability** — a bundle that registers a renderer, a poster and a click route gets
one — not a fixed list, though today that list is Slack, Discord and Teams. A Teams card lives in a
channel only; see [Teams § Approval cards](../deploy/surfaces/teams.md#approval-cards).)

**Asking from a surface that can't host a card.** You still can, for **every propose tool but
one**. `purge_memory`, `request_access`, `revoke_connector`, `clear_connector_override`,
`set_spend_limit`, `clear_spend_limit`, the six routine-authoring verbs (`create_routine`,
`cancel_routine`, `edit_routine`, `enable_routine`, `add_routine_rule`, `remove_routine_rule`),
`open_pull_request`, `create_skill`, `delete_skill`, the three ticket verbs
(`set_state`, `assign`, `create_ticket`), `post_message`, `dm_person`, `resume`,
`create_agent` and `declare_webhook` are all
available in a Teams personal or group chat or a Linear conversation, and the card is **posted into a card-capable channel
in the same domain** — the
same venue rule [routines](../capabilities/proactivity-and-routines.md#where-you-can-create-one-and-where-it-reports)
use, including the skip of any candidate the platform positively reports as externally shared.
The agent tells you where the card went and that someone there has to act on it, because from
where you're standing it is invisible. If the domain has no card-capable channel — or the room
you asked in is in no explicit domain — the request is refused, naming the config to change.
Only the **card** moves: the scope being changed, and everything frozen onto the card, still
belong to the room you asked in. For the ticket verbs that is the sharpest form of the rule —
*which* issue is acted on, and *which* tracker a new one is filed into, are resolved from the
asking window's own sources, so a shared approval channel never redirects the write itself. For
`create_agent` and `declare_webhook` it is the requester's own follow-up note that stays put —
telling you where the PR landed always arrives back on the platform and channel you asked from,
never the venue's.

`create_agent` carries one further wrinkle worth knowing. It also refuses a room that **already
belongs to a domain** — its whole job is turning a domain-less channel into one, so a channel
already claimed by a domain can't also become an agent. That is exactly the precondition a
redirect needs (a room the venue walk can route *through* is, by construction, a room already in
a domain), so in practice a card-less ask either finds no domain to route through at all, or
finds one and immediately hits that other refusal a step later. Either way nothing is provisioned
from a card-less room that's already spoken for; what changed is that the refusal you read now
names the real reason instead of a blanket "no approval-card path" one.

The one propose tool still refused outright on a card-less surface is `rotate_webhook`: it hands
back a freshly minted signing secret that only means anything to whoever is wiring the sender up,
so moving its card would move the secret with it.

The `/oe budget raise` and `/oe budget clear` **slash commands** are the one exception, and
deliberately so: they have no model turn in which to tell you the card went elsewhere, and the
ephemeral acknowledgement they return says "card posted in this channel". They still refuse on a
surface with no card path — ask the agent in conversation instead and you get the redirect.

**Propose.** An in-conversation agent tool — any of the propose verbs the
[Who can click](#who-can-click) table below names, `set_spend_limit` and `purge_memory` (see
[Purging](../capabilities/memory.md#purging-the-one-memory-verb)) among them — validates the request and
**freezes the arguments**. No propose tool declares an eve approval of its own — an absent
`approval` is `never()` on the live path and on a replay — so it cannot act by itself, only propose.
It writes a pending action, posts a card, and audits `approval.requested`. Its reply to the model
says the card is posted, and, when the card was redirected to another room, names that room and
tells the model to relay it. The reply does **not** name who may decide: the frozen kind does, and
the table below is that answer.

One exception, and the tools say so rather than pretending otherwise: if the
[approver chain](./security-model.md#4-approval-gates-are-governance-not-a-crutch) **lowers**
that verb — an operator's config element answering `allow`, or a domain running
`DANGEROUSLY_BYPASS` — no card is posted at all. The frozen args execute immediately, a pending
row is minted for the audit wedge (status `approved`, decided by `chain:<element>`, never a
human's id), and the tool's reply switches to *"done — … the approver chain auto-approved this
(&lt;element&gt;), so no card was posted and it has ALREADY run — &lt;outcome&gt;"*, carrying the
same outcome line the updated card would have shown. Nothing is configured this way by default,
so out of the box every gated propose takes the card path above.

The wedge row is **one row per authorisation per turn**, not one per call. Its id is derived from
the session and the turn, plus what was decided, where, by whom and for whom — so a step body eve
redelivers after a crash writes one row rather than two. Both halves of that pair are needed: eve's
turn id restarts at zero in every session, and a routine fire gets its own session, so two nightly
fires would otherwise present the same turn and collapse. The `approval.autoapproved` audit row is
still written for **every** execution — it carries `wedgeRowReused` when the row it points at
already existed — so no act is ever missing from the trail. Two identical authorisations inside one
turn of one session share a row; anything in a different turn, or a different session, does not.

**Card.** The card is rendered by **code**, from the frozen args — never by the model.

**A card is a headline, at most one line of consequence, and the buttons (OPE-2434, OPE-2481).** A
person reads, in this order:

1. **The headline** — what will happen, to what, in plain words, with things named by their friendly
   names: "Set the monthly spend limit for #general to $50/mo.", "Post a message in #general.",
   "Send the notetaker to the Google Meet meeting and post a recap here." Each action kind writes it
   from its frozen args (`ActionKind.plainSummary`, `packages/core/agent/approvals/types.ts`).
2. **At most one consequence line**, only when a person needs it to decide (`ActionKind.consequence`):
   the figures that change, in plain words ("From $50/mo to $100/mo"), the message or task text that will be sent,
   the instruction a routine will follow, or who else is affected ("It records everyone for up to 90
   min. The host admits it. OE keeps the transcript 30 days."). A kind that quotes content
   (`consequenceQuotes`: a message, a task, a routine's instruction or rule, a skill body, a connector
   input, an issue or pull request body, an MCP server's host and description) gets up to 1,400 characters, because the card is the injection gate for that content and
   Discord caps a whole message at 2,000. A longer quote is never cut silently: the line ends with
   "(N more characters not shown)", so the approver knows the card does not show all of what the click
   approves.
3. **A one-line warning** when the proposing turn read outside content: "⚠ Asked for after reading
   outside content. Check that someone here wants it."
4. **A footer**: "Asked by @name · expires 13 October, 14:00 UTC". A `routine.permission` card has no
   clock, so its footer reads "open until the routine changes": the card ends when the routine's
   instruction is edited or the routine is deleted. Teams prints the expiry alone, because a Teams
   card cannot name the requester without a display name the row does not hold.
5. **The options**, as one ordered list.

**No visible line carries a kind label, a model or route name, a backend, a ledger, a figure label
(`$:`, `tokens:`), talk about pricing coverage, a raw platform id, an internal row id or restated
policy prose.** Those are machine keys. The kind and the full code-rendered detail
(`ActionKind.summarize`, with the taint disclosure) move to the card's **metadata** (`CardMeta`,
`card-layout.ts`). A spend card's pricing coverage caveat is part of that detail, so the approver
does not see it on the visible lines ([spend and cost](./spend-and-cost.md)). On Slack that is the message `metadata`
(`event_type: "oe_approval_card"`, with the kind, the row id and every detail line) and the first
block's id (`oe_approval_card:<kind>:<row id>`). On every surface it is the pending row and the audit
trail. The e2e runner reads the kind and the detail from there. The docs disclose each kind's full
behaviour (for a meeting bot, see [meetings](../capabilities/meetings.md)). The detail is a reading aid,
not the gate: what the click approves that a person must read is on the card itself, in the headline
and the consequence line. `npm run test:card-budget` renders every registered kind on
Slack, Teams and Discord. It fails when a card has more than four visible lines, more than its
character budget, or any of the banned shapes.

Two fences keep a frozen value from forging card structure. Every value a headline or a consequence
line interpolates goes through `plainValue` (`packages/core/agent/approvals/plain-text.ts`). It
removes the characters that open a markup link (`<url|label>`, `[label](url)`), a mention, emphasis
or a code span, removes every `@` in front of a bare `@everyone` or `@here`, and collapses newlines.
Quoted content goes through `plainQuote`, which removes the link and mention characters and the
broadcast `@` but keeps identifiers such as `page_id` readable. So the only mentions a card renders
are the ones the kind's code wrote (`<#C…>`, `<@U…>`, from `channels/friendly-ids.ts`). Slack renders
the headline as bold `mrkdwn`, so those mentions show as names, not ids. The cleaner does not remove
a bare URL: the address stays visible as text, and a surface can still link it. A kind whose headline
cannot render (an unknown kind, broken args) opens with a generic sentence. It names no kind and tells
the person to ask the agent what it will do, because a card that fails to render posts no card. The
notification text is the same visible lines.

**A decided card is one line**: "✅ Approved by @name: message posted in #general", "❌ Rejected by
@name: Post a message in #general", "⏰ Expired: Post a message in #general" (`decidedCardLine`).
The card updates in place to that line. A failed act reads "⚠️ Approved by @name, but it failed", and
a decline that a kind could not record reads "❌ Rejected by @name: … · I could not save the
decline". No card shows the error text. The error, scrubbed and capped at 300 characters, goes to
an `approval.failed` audit row (with `phase: "decline"` for a decline) and to the control-plane
result. A failed act's decision wake carries it too; a reject's wake carries no execution line
(OPE-2549). **A second post repeats the card only where
something cannot see the card.** The notice exists for a session whose history does not see a card
edit (OPE-2473). So it states the outcome, as the decided line, only when the card did not change
(a Discord or Teams sweep or session-grant release, or a rewrite Slack refused), when no standing seat
took the decision wake, or when a thread seat or worker owns the thread. A Slack sweep or release
redraws the card in place. Otherwise the card is the room's record (OPE-2490): when the asker decided
their own request, nothing else posts, and when somebody else decided it, or it expired, one short line
tells the asker ("@asker, @admin approved your request."). A card on a surface that cannot spell a
mention (Teams, Google Chat), or whose asker is on another platform, gets no such short line, because it
would show a raw id. A notice that states the outcome names a person only where the surface can spell a
mention (Slack, Discord), so on Teams or Google Chat it names nobody. A refused click (not an admin, an outside channel, a halt) shows its note to the
clicker only. On Slack that is an ephemeral message in the card's thread. Code-written card text
carries no em-dash: `withoutDashes` (`plain-text.ts`) turns each one into a comma, and quoted content
keeps its own characters. Slack, Teams and Discord render the same
layout (`packages/core/agent/approvals/card-layout.ts`), and the **options are one ordered list** —
Approve first, Reject last, and a routine's grant option between them. "Approve, and allow things
like this" (OPE-2456) is one more entry in that list, offered only where a rule could lift the act.
It carries the proposed rule as a confirmation, and Slack shows it before the click is sent. Teams
and Discord send a tap with no confirmation, so they leave that option out. Plain Approve stays
one-off and never writes a rule. See [pre-approval rules § 7](../how-it-works/pre-approval-rules.md#7-approve-and-allow-things-like-this).

**Several asks from one job arrive as one card, on Slack.** A pending row freezes its proposing
session (`group_key`). When a second ask comes from the same session, into the same room and the
same thread, while that session's card is still open, it joins that card instead of posting a new
one: the card is rewritten as one grouped message that opens with a plain count ("2 approvals for
one job, 2 still open"), and each item keeps its own headline, consequence line and buttons. A
decided item becomes its one decided line.
A click still decides exactly one row, through the same click core, and the redraw keeps the other
items live. A card holds at most five items, and a sixth ask posts its own card. A rewrite that
fails leaves the ask on a card of its own, so a failed join never hides an ask. Teams and Discord
post one card per ask today: grouping there needs each surface's own update path, and is a
follow-up.

**One queue: "what is waiting on me".** A person can ask their DM seat what waits on them.
The `waiting_on_me` read (`packages/core/agent/status/waiting-on-me.ts`) lists every open card they
can decide — a member-tier card their own work raised, or an admin-tier card their org or domain
admin roster entry admits — and every card their own work raised that waits on an admin, plus every
job or thread that reported itself blocked on them or needing them
([attention states](../how-it-works/agent-and-loop.md#attention-states-and-the-one-blocked-ping)).
Each item is the card's plain sentence (never its detail lines) and a link to the card. The read is
DM-only and reads only the asking person's own queue: it takes no person argument, so the acting
principal is the query key, and an unattended fire reads nothing. A card is matched on the platform
it was posted to. A link is not a permission: the click core still refuses a click from outside the
card's own room. The person's one list of what the agent does for them, `doing_for_me` and the Home
tab's "What I do for you" (OPE-2522), carries this queue as its last part. See
[Everything I do for you](../capabilities/proactivity-and-routines.md#everything-i-do-for-you-one-list-per-person).
Pending actions lapse after 24 hours by default (`approvals.ttlHours`) and can no longer be
approved or rejected once expired.

🔴 **The expiry NOTICE covers only the orgs in `schedules.sweepOrgs`.** A click on a lapsed card is
refused in every org, because the click path reads the clock off the row. That late click also
writes the `approval.expired` row. But the daily sweep is what rewrites an UNCLICKED card and writes
its row, and the sweep walks only the orgs that the setting `schedules.sweepOrgs` names (shipped: the single
org `default`; it was `OE_TIDY_ORGS` until OPE-2411). In any other org, a lapsed card keeps its buttons until someone clicks it, and no
`approval.expired` row is written until that click. A multi-tenant deployment must
list every org in `schedules.sweepOrgs` — see the
[configuration reference](../deploy/configuration-reference.md#approvals).

**Click.** The approve/reject click lands on Slack's own interactivity endpoint — the same
signature-verified public route events already use (see the
[Slack surface guide](../deploy/surfaces/slack.md)). The handler resolves the clicker's identity
from **Slack's signed payload**, checks that the click came from the room the card was posted
into, checks it against the frozen scope and the approver policy for that action kind, and only
then executes — through the exact same store functions the writes above call (`setSpendLimit`,
`setConnectorOverride`, …). One mutation path, two front doors. Every step is audited
(`approval.requested` / `approval.approved` / `approval.rejected`, and `approval.denied` when a
click is refused), and the card is rewritten in place to a plain, code-rendered outcome. A
refused click never consumes the card: it stays pending for whoever *can* decide it. See
[what a `gate:member` click proves](./security-model.md#4-approval-gates-are-governance-not-a-crutch)
for the limits of the member tier specifically.

Two properties are what make it safe to hand the model a proposal tool in the first place:

1. **The card is rendered by code from frozen args, never by the model.** By the time a human
   reads it, there is no live model output between the request and the screen — reading the
   card is reading exactly what will execute.
2. **The click is verified by code against Slack-signed identity, not model output.** The model
   is never in the effect path. Injected text can talk it into *proposing* something plausible,
   but it cannot approve its own proposal, forge a click, or change what a posted card says.

### Who can click

Not every action kind needs the same tier. The split is a **rule**, not a list of examples:

- **Admin kinds are the org config, spend and break-glass mutations** — the spend caps, the connector
  overrides, and lifting a break-glass `halt`. They need an **admin**: an org admin, or a domain admin whose domain
  covers the frozen scope. This is the same `Domain.admins` roster the `domain:<name>` claim
  above maps onto (see [Access & scoping](../how-it-works/access-and-scoping.md#roles-whos-an-admin))
  — just checked from Slack's signed identity instead of an OIDC token. One roster, a third way
  of asking it "is this person an admin here?"
  - **Two carve-outs need an ORG admin specifically**, and the domain-admin fallback never
    applies to either: a spend cap at `level: "domain"` (a domain's leads must not set their own
    domain's budget) and one at `level: "user"` (the person whose allowance moves is not in the
    room the card lands in, cannot see it, and is the only party with a stake and no seat). Both
    are enforced identically on the in-chat click and on the control plane's headless
    `decide_pending_action`, from one shared predicate.
- **Every other kind is a member kind.** It needs only **any member of the channel**, the same
  anyone-in-the-domain tier that already governs routine create/list/cancel and domain-skill
  authoring: being able to click is already being in the channel, which is the same trust tier
  whose delegated worker can already edit that silo's files. The card exists to defeat injection
  here, not to gate privilege.
  - One member kind is a card that replaced an eve-native confirm (OPE-2340): `op.connector` (one
    connector op call that needs a person: every click approves one call with the input stored on
    the card, and the agent runs it by replaying the card by its id, OPE-2363 and OPE-2388). It is
    not in the `connector.` admin family, which is the connector **overrides**, an org config
    mutation. The native connector confirm had no response half and bound its click to nobody, so a
    member bar on `op.connector` is a narrowing. The card posts and returns, so no turn waits on it.

The admin kinds are the **carve-out**; the member kinds are everything the rule leaves. The table
below is generated from each kind's registered `ApproverPolicy`
(`packages/core/agent/approvals/`) by `scripts/approver-policy-docs.ts`, and
`npm run lint:approver-policy` fails on three drifts: a table that disagrees with the registry, an
admin kind outside the config/spend family the rule names, and this section no longer stating that
rule.

<!-- BEGIN GENERATED: approver-policy (scripts/approver-policy-docs.ts) -->

| Action kind | Propose tool | Who can click |
|---|---|---|
| `a2a.delegate` | `delegate_to_agent` | member |
| `access.request` | `request_access` | member |
| `agent.create` | `create_agent` | member |
| `browser.personal.act` | `my_browser` | member |
| `browser.personal.handback` | `my_browser_handoff` | member |
| `browser.personal.propose` | — *(no propose tool)* | member |
| `canvas.write` | `write_canvas` | member |
| `chat.dm` | `dm_person` | member |
| `chat.post` | `post_message` | member |
| `connector.clear` | `clear_connector_override` | admin |
| `connector.revoke` | `revoke_connector` | admin |
| `email.sender` | `propose_email_sender` | member |
| `halt.resume` | `resume` | admin |
| `list.write` | `update_list` | member |
| `mcp-server.propose` | `propose_mcp_server` | member |
| `meeting.join` | `meeting_join` | member |
| `meeting.recap` | `meeting_recap` | member |
| `memory.purge` | `purge_memory` | member |
| `op.connector` | — *(no propose tool)* | member |
| `pr.open` | `open_pull_request` | member |
| `routine.attention` | — *(no propose tool)* | member |
| `routine.cancel` | `cancel_routine` | member |
| `routine.create` | `create_routine` | member |
| `routine.edit` | `edit_routine` | member |
| `routine.enable` | `enable_routine` | member |
| `routine.permission` | — *(no propose tool)* | member |
| `routine.policy.add` | `add_routine_rule` | member |
| `routine.policy.remove` | `remove_routine_rule` | member |
| `routine.suggest` | — *(no propose tool)* | member |
| `session.checkpoint` | — *(no propose tool)* | member |
| `skill.create` | `create_skill` | member |
| `skill.delete` | `delete_skill` | member |
| `spend.clear` | `clear_spend_limit` | admin |
| `spend.set` | `set_spend_limit` | admin |
| `ticket.assign` | `assign` | member |
| `ticket.create` | `create_ticket` | member |
| `ticket.set_state` | `set_state` | member |
| `webhook.declare` | `declare_webhook` | member |
| `webhook.rotate` | `rotate_webhook` | member |

<!-- END GENERATED: approver-policy -->

### The doctrine nuance: bridge mutations, now reachable in-Slack

The override doctrine above still holds exactly as written: narrowing is always allowed, and
only spend gets a widen-bridge. What's new is *where* a bridge mutation can be requested from.
Because a human admin approves each one individually — reading a frozen card, not trusting the
model — the in-Slack path can now carry the same bridge-shaped mutations the control plane
always could: raising a spend cap, or clearing a connector revoke back to config.
**`clear_connector_override` still only reverts to the config-granted state, in-Slack or via the
control MCP — it can never grant beyond what a PR already approved.** The "no runtime connector
*grant*" invariant is unchanged either way. What changed is that the control plane is no longer
the only door that can pull a bridge back toward config — it remains the plane for what
in-Slack can't cover: scripts, CI, an operator outside the workspace, or an incident where
Slack itself, or the agent posting into it, is the thing under suspicion.

## The approvals plane's own seams

**An action kind is looked up by its kind string at both propose and decide time.**
`registerActionKind` (`packages/core/agent/approvals/actions.ts`) keeps one registry, and both the card
and the execution resolve through it — so the card a person reads and the act that runs cannot drift
apart. The summary lines a pending row renders are derived **only** from its kind and its frozen
arguments, never from the raw blob, and both the card path and the control-plane list view share that
one renderer. An unregistered kind and unparseable arguments both render a plain marker rather than
throwing.

**A second ask for the identical session, tool and input is denied inside a window.**
`withDuplicateApprovalGuard` (`packages/core/agent/access/approval-dedupe.ts`) guards only a genuine
prompt: any other decision passes through untouched. When an identical ask is already open it answers a
denial telling the person to answer the earlier card. The window is **five minutes**
(`DUPLICATE_APPROVAL_WINDOW_MS`), and the guard **fails open** — a store error reads as "nothing open",
so a blip costs a duplicate card rather than a lost ask.

**The card-or-not preview is per tool, never per call.** `approvalPreviewFor`
(`packages/core/agent/access/approval-preview.ts`) derives it from the consequence registry and the
window-gate manifest, split into what a member may run, what needs admin standing, what is confirmed
natively by eve, and what is mounted elsewhere. A lean seat narrows the set further. Because it is
derived, the preview cannot promise a card the chain would not raise.

**Operator-written approval scenarios run against the real chain, judge-free.**
`runApprovalScenarios` (`packages/core/agent/access/approval-scenarios.ts`) resolves each scenario
through the actual approver chain and compares the verdict, the resolver, the applied transforms and
the registry verdict, collecting every mismatch as a failure line. Running judge-free is what makes a
`defer` row resolve to its last-resort ask rather than to a model's opinion.

**The turn's requester-visible messages reach the judge as quoted data.**
`requesterMessagesThisTurn` (`packages/core/agent/access/requester-messages.ts`) holds the current
turn's received message text, rendered quoted and under review. Four deliveries are **deliberately
never captured**: one inside a native delegation child, one inside the work session (its every
delivery wraps the seat model's brief), one whose auth carries a taint-seed stamp, and one of
unattended origin. A turn that captures nothing leaves the previous turn's messages standing as
backscroll, and the reader answers empty outside a session context.

**A person's ask reaches the judge of the work-session child that proposes the act.** Under the three
tiers the person asks on the seat, and the act is proposed in a child of the work session, which
captures nothing. So the ask crosses the forward on host rows only:

- The capture hook also reduces each delivered envelope to ONE person's own ask: the body of its one
  `trigger="true"` message, its author and its wake (`requesterAskOf`,
  `packages/core/agent/hooks/requester-messages.ts`). No backscroll sibling rides, and a fenced body
  comes back unfenced, as the own-account gate reads it.
- The `work` forward copies the asks for its OWN wake, its OWN verified requester and its OWN turn into
  the work request row (`requesterAsks`). It never copies the brief. An unverified requester, a wake
  the host proved came from a non-member, and an earlier turn carry none. A routine fire writes no
  asks.
- At the child's `turn.started`, `adoptForwardedRequesterAsks`
  (`packages/core/agent/access/forwarded-asks.ts`) finds the child's own request. On the opening
  turn it reads the call row the work session wrote for the child's own `agent` call. On a later turn
  it reads the continuing wake the provenance fence admitted for a continuation by `taskId`
  (`readContinuationWake`, `packages/core/agent/channels/task-provenance.ts`). The work session's
  `task.started` advances the child's authority row to a new task wake, but it never writes either of
  these two rows, and both exist before the child's turn runs. A later turn on a request the child
  already adopted adopts nothing, so that ask reads as earlier context. Adoption is idempotent per
  turn.
- A later turn adopts a continuation only in that continuation's own turn. The fence records the
  task's settlement generation on the continuation row, and the call it admits after settlement N is
  served by the child's turn N. Every other turn refuses the row. So a turn that starts while a
  continuation is still pending never weighs the pending ask, and that act gets a card. Two other
  facts already keep a pending continuation away from a parked child: the fence refuses a
  continuation while the child's call is unsettled, and an approval resume continues the parked turn
  without a new `turn.started`. The generation check holds when the fence's best-effort claim write is
  lost. Its cost is in the closed direction: a redelivered settlement or an extra child turn moves the
  two counts apart, and every later continuation of that task gets a card.
- The child records the row's asks as its own turn's messages only when the row is not a fire, names
  a verified requester equal to the child's own dispatch requester, and belongs to the child's own
  work session. The judge then reads them as this turn's requester messages, as on the seat.
- One residual stays open. With one job open, every `agent` call in the work session's turn joins
  that job (`packages/core/agent/access/work-request-turn.ts`). So a second child that the work
  session starts in that turn also carries the person's ask. It stays inside the same conversation
  and the same requester.

The `work.forwarded` audit row counts the asks it carried (`askCount`) and never holds their text.

**The deciding card crosses an approval click on `AsyncLocalStorage`.** `armingApproval`
(`packages/core/agent/approvals/arming-context.ts`) reads it, because a click executes outside any eve
session and the executing code still needs to know which card armed it. **It is never an authorisation
input**: the click's own authorisation is decided before the arming context exists.

**A foreign responder is refused on both legs, Approve and Cancel.** `decideResponder`
(`packages/core/agent/approvals/eve-response-policy.ts`) binds a response to the REQUESTER: eve's
`request.principal`, the caller whose turn made the tool call. It falls back to the session initiator
only when eve records no requester, and it allows when neither exists. Every other responder is
rejected, and the request stays pending. eve 0.69.0 runs the policy for Cancel as well as Approve, and
OE applies the same rule to both (OPE-2255): a bystander can no longer cancel another person's pending
action. eve's Slack channel posts the refusal privately to the refused responder.
🔴 Authoring that response policy is also the **switch** that routes the request onto eve's candidate
path: a call site that forgets it silently keeps the older "any authenticated clicker may approve"
behaviour.

**An eve-native `approval:` written outside the scanned tool directory is listed with a reason.**
`NON_TOOL_APPROVAL_SITES` (`packages/core/agent/access/consequence.ts`) carries three entries, and a
new one reds the lint. The scan is line-based, so it cannot tell a real policy from a property inside a
template literal — and the entries say which each one is rather than narrowing the regex, because
narrowing it is how a scan stops seeing the true positives too:

| Site | What it actually is |
| --- | --- |
| `packages/core/agent/connections/notion.ts` | **Real and deliberate** — a connector approval policy on an eve connection, not a tool. It is defence in depth over the hard credential gates, never the gate itself. The value must stay a bare request policy: eve's connection resolver keeps `approval` only when it is a function, so an approval *configuration* object is dropped at boot. There is therefore **no responder check** on a connector-op card. |
| `packages/core/agent/plugins/extract.ts` | **Not a live policy** — the match is inside a template literal, the line the plugin extractor generates into a scaffolded connection file. It is reviewed where it lands. |
| `packages/core/agent/access/window-gated.ts` | **Not a policy** — eve's deterministic replay step names for a dynamic tool entry, each value a string identifier. |

**Three exports are human-only, and no agent tool file may import them.**
`PROTECTED_HUMAN_ONLY_EXPORTS` (`packages/core/agent/access/human-only-invariants-manifest.ts`) names
`contradictJudgeAllow`, `disarmApprovalJudge` and `rearmApprovalJudge`
(`agent/approvals/judge-contradiction.ts`). They write the ledger that carries every human act over the
approval judge, and the judge's own disarm state is derived from it. **Every row asserts that a person
acted**, so a tool-written one would be the machine forging a human judgement in the honest record. The
manifest holds both directions on purpose: an overrule and a disarm are restrictive, but a **re-arm is
permissive** — a tool-written one would cancel an operator's break-glass disarm and restore card-free
auto-approval for the domain.

### Principal gates that are exempt, and why

Every refusal gate over a principal identity carries a marker saying which question it asks.
`checkPrincipalGates` (`packages/core/agent/access/principal-gate-manifest.ts`) reds an **unmarked**
gate and reds a marker outside the vocabulary, naming the two legitimate intents: **accountability**
(somebody nameable must exist, which an attested routine creator satisfies) and **presence** (a human
must be here and acting, which a fire must not satisfy). The lint also requires the gate to read an
accessor that can actually deliver the question it claims to ask.

Some sites are exempt, and each says why in its own comment:

- **A pass-through guard.** The duplicate-approval guard authors no verdict of its own: it forwards the
  wrapped policy's answer and, on a prompt it has already seen, denies the duplicate. It can only
  narrow, never park a run the wrapped policy did not already park, so the attendedness question
  belongs to the policy it wraps.
- **A non-tool action kind.** A session checkpoint is not a tool, so no chain request is ever built for
  it. An attendedness signal there would be inert and misleading, which is why an unattended fire's
  checkpoint still cards into an empty room.
- **Service-principal dispatch sites.** The two control-plane token doors, the webhook fire and the
  event fan-out each stamp `principalType: "service"` and a service principal id. They authenticate a
  **fire** rather than gating on a human, so the presence question does not apply to them.

## What's recorded

Every override mutation is audited with the acting principal. The provenance counterpart — *what config changed, who, when, and when it went live* — comes from git history plus deploy history; see [Audit & provenance](./audit-and-provenance.md).

### The admin action vocabulary

These are the `admin.*` rows an operator mutation writes. Every one names the acting principal.
🔴 **Most of these actions have two write sites, and the row says which door was used**: the
control MCP (`control/writes.ts`) and the in-chat approval action (`approvals/actions.ts`) write the
same action name. A mutation that also changes a store the store itself audits leaves a second,
mechanism-side row beside the `admin.*` one — [identity linking](../how-it-works/identity.md#what-identity-linking-writes-to-the-audit-log)
is the worked example. Count the doors on the `admin.*` row, and the mutations on the mechanism's
own row.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `admin.approval.decide` | An admin decides one approval through the control plane. | The approval id, its kind, the decision the row settled on, and the outcome line. |
| `admin.approval.judge_disarm` | The approval judge is disarmed. | The scope address it was disarmed for. The judge's own ledger row records the mechanism. This row names the door. |
| `admin.approval.judge_rearm` | The approval judge is re-armed. | The same scope address, from the same door. |
| `admin.connector.revoke` | A connector's grant is revoked for a scope. | The connector name, and the reason when the caller gave one. |
| `admin.connector.clear_override` | A connector override is cleared, reverting that scope to config. | The connector name, and `cleared` — whether an override was actually in force. |
| `admin.halt.cleared` | The break-glass halt is lifted. | The halt address and `cleared`, so "nothing was halted" is a stated fact rather than an absence. The control-MCP door additionally stamps `door: "control-mcp"`. An org-wide halt is about the org, so its row is stamped on the org. |
| `admin.model.set_domain` | A domain's model is set at runtime. | The domain, the model id and the reasoning setting the caller picked, and a flag when the chosen model carries no price — so a later cost question has an answer. |
| `admin.model.clear_domain` | A domain's model override is cleared. | The domain and `cleared`. |
| `admin.routine.cancel` | A routine is cancelled through the control plane. | The routine id and `cancelled`. |
| `admin.session_grants.revoke` | A session's grants are revoked. | The surface key, the session id, the revoked count, and the reason when one is given. The count is reported **even when it is zero**, so "nothing to revoke" is stated rather than inferred. |
| `admin.spend.clear_limit` | A spend override is cleared. | The scope key, the level, and `cleared` — whether anything was actually in force. |
| `admin.identity.suspend_link_set` | A link set is suspended. | The link-set id. |
| `admin.identity.reactivate_link_set` | A suspended link set is reactivated. | The link-set id. |
| `admin.identity.revoke_link_set` | A link set is revoked. | The link-set id. |
| `admin.identity.purge_link_set_credentials` | Every credential a link set holds is purged. | The link-set id and the purged count. |
| `admin.identity.directory_sync_now` | An on-demand directory sync runs. | The provider, the policy, the planned counts, what was applied, and how many warnings the plan raised. |
| `admin.identity.directory_groups_plan` | A directory-group plan is requested. | The provider, the people count, the planned counts, the warning count, and the allowlist size when groups are allowlisted. Plan mode returns the content and applies nothing. |
| `admin.identity.directory_groups_pr` | A directory-group plan is turned into a config pull request. | The same plan fields, plus the delivery outcome (`no-op`, `dry-run`, `opened` or `updated`) — so a plan that produced no pull request reads differently from one that did. `dry-run` means `accessRequests.dryRun` held the write. |

### One more row on this plane

**`control.oauth_code_issued`** — the control plane's OAuth route writes this when it issues an
authorization code. The row names the client id and the granted scope, as a space-joined list. It
never carries the code.

### The update siblings: `pr.update` and `skill.update`

Two approved actions write a **different action name when they update rather than create**, so the
trail reads continuously across a follow-up.

**`pr.update`** — the pull-request gate opens a pull request from the frozen title, body and head
sha. When the create resolves as an update — a follow-up push to an already-open branch — the same
gate writes `pr.update` instead of `pr.open`. The row carries the repository, the head, the base,
the frozen sha, the pull request number and URL, who requested it, and whether the turn was tainted.

**`skill.update`** — an approved skill edit writes `skill.update` where a first authoring writes
`skill.create`. The row carries the domain, the skill name, the body's author, the approver who
armed it, and the taint flag. The frozen body itself is kept in the skill revision log above, not in
the audit row.
