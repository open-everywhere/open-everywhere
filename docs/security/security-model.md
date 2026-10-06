# Security model

Open Everywhere runs an autonomous agent with access to your chat tools, repositories, and connectors. Security is the central design constraint, not a layer bolted on afterwards. This page is the one to read before you decide to trust it: it states what the agent can and cannot reach, where each guarantee is enforced, and what you control.

## The threat model in one breath

The agent is **semi-trusted**. It acts on your behalf, but it is driven partly by untrusted input — chat messages, fetched web pages, connector results — and it runs tool calls a model generated. So Open Everywhere makes a deliberately pessimistic assumption: **the agent can be induced to *try* anything**, and the job of the system is to constrain what it can actually *reach*.

That assumption produces five properties, each enforced in a specific, tested place:

| The agent must not… | …because of |
|---|---|
| Exfiltrate data or read your secrets | the egress firewall + credential injection |
| Act outside what you granted | bundles + the resolver + the per-surface connector gate |
| Let one team's data reach another's | org partitioning + RLS + fail-closed visibility |
| Take a consequential action unsupervised | approval gates |
| Do anything unrecorded | append-only audit |

The posture on prompt injection is deliberate: Open Everywhere does **not** try to stop the model from being *talked into* attempting something by text in a message, page, or connector result. It assumes injection can happen and instead constrains what the agent can actually *reach and do* — egress, scoping, and approval gates hold regardless of what any text says. As defense in depth, a body that is untrusted **by source** is also structurally fenced as data before it reaches the model — every tool result and every unvouched or bot-authored message, on every surface, never a per-surface opt-in. The fence is **nonce-closed**: each render stamps a fresh random nonce on both tags, minted after the content is in hand, so injected text cannot close the envelope early and promote its remainder to trusted framing. A chat message from a vouched member is the deliberate exception, stated in full below. The one class no in-tree seam can fence is provider-executed `web_search` results, which are consumed server-side within the model call — covered by a standing instruction plus the reach-bounding layers above. See [Trusted dispatch vs untrusted surface data](../how-it-works/agent-and-loop.md#trusted-dispatch-vs-untrusted-surface-data).

Everything below is **fail-closed**: when a check can't positively confirm that something is allowed, the answer is *no*. Absence of a grant is never silently read as permission.

## 1. The egress firewall — your secrets never enter the sandbox

This is the strongest control, and the one most products get wrong. The agent's code runs in a sandbox whose network egress is **default-deny**. A [bundle](../how-it-works/access-and-scoping.md) declares the exact hosts and paths a session may reach; everything else is denied implicitly.

The part that matters for trust: **credentials are injected at the firewall, not handed to the agent.** When the agent `curl`s an API, it sends an *unauthenticated* request to a plain URL. The firewall stamps the auth header onto the request *as it leaves the sandbox*. The secret is never present in the sandbox's environment, memory, or process — so even a fully compromised agent cannot read it. It can only *use* the already-scoped, already-authenticated channel the policy permits.

The credential-and-transport story has its own page: see [Credentials & the two planes](./credentials-and-planes.md).

> **Enforcement note.** Firewall-level egress with per-request header injection is native on the **Vercel Sandbox** backend. Off Vercel, Open Everywhere's own `docker()` backend (the default — see [`OE_SANDBOX_BACKEND`](../deploy/platforms/self-host-egress.md#sandbox-backend-containment-oe_sandbox_backend)) reaches the same full parity through a **local egress-proxy sidecar** — see [Self-host with enforced egress](../deploy/platforms/self-host-egress.md) — without needing hardware virtualization. That parity is the deployment's to arm: the push path runs only when `OE_EGRESS_PROXY_URL` names the proxy. With no proxy URL, `docker()` applies the coarse allow-all/deny-all strings alone, so a session that resolves any host allow-list aborts at start unless `egress.allowUnenforced: true` is set. Eve's own `microsandbox` backend is a KVM-dependent alternative, but it does not give full parity: it enforces host-grain allow/deny natively, while credential injection silently does not happen and `match` narrowing is dropped (measured, OPE-917); it is also not a selectable Open Everywhere backend today. `just-bash` rejects network policies entirely and is dev-only.

Egress enforcement is **on by default**. Set `egress.enforce: false` to opt out to dry-run — the policy is still compiled and logged, just not applied — while your bundles don't yet cover every host the agent legitimately needs. One thing dry-run does **not** relax: a `deny-all` produced by a **compile error** is applied anyway. Dry-run loosens the policy you intended, never a failure to compute one at all. On a backend that can't apply fine-grained policy, the session **aborts** rather than running unenforced (fail closed — the platform's session default is allow-all, so an unenforced session is an unfirewalled one). `egress.allowUnenforced: true` restores warn-and-continue for a knowingly-unenforced dev backend.

## 2. Access scoping — an app-layer allowlist, not membership

Capability grants are **config-as-code**: they live in your git repo and change only by reviewed PR. A bundle separates *what a capability is* from *where it binds* — one bundle binds to many surfaces through a `domain` scope.

The resolver that turns grants into effective access is **deterministic, narrowest-wins, and has no fallback**. A capability you didn't grant is simply absent; it is never silently broadened. A grant bound too broadly (org- or workspace-wide) is **linted at preview time** so you see the blast radius before you ship.

For connectors there's a second, harder gate: a scoped connection **self-scopes**. Its credential resolver reads the inbound surface identity and **refuses an ungranted surface before any credential is resolved**. An ungranted or unidentifiable surface never reaches a token. The full mechanism — bundles, domains, the two universes, narrowest-wins — is on the [Access & scoping](../how-it-works/access-and-scoping.md) keystone page.

**The fence is Open Everywhere's own code, over workspace-wide credentials.** The deployment holds one token per vendor install — a Slack bot token, a Linear OAuth token, a Notion key on the shipped default. The vendor scopes none of those per user or per domain. What narrows them is this repository, at three enforcement points. A domain's declared `reach` names what it serves — exact surface keys, a whole tenant, or a same-level glob — and the resolver admits nothing outside those entries. On a **tenant-scoped** platform (Slack today) the **tenant fence** derives its admitted tenant set from those same `reach` prefixes and drops a delivery from a tenant the config never declared; it is inert on the other surfaces, when no tenant is declared, and under `OE_ALLOW_MULTI_TENANT_PRINCIPALS=1` (`agent/access/tenant-admission.ts`). A scoped connection **refuses an ungranted surface inside `getToken`, before any credential exists**, and each connector op is classified read or write for the approval gate and the audit row (`agent/access/connector-scope.ts`, `agent/access/consequence.ts`).

**What this is not: membership, and not a per-user vendor ACL.** A platform's own membership check (a Slack bot must be invited to a channel; a Discord bot needs a role overwrite) is a real, vendor-enforced boundary on several surfaces, and it decides whether the agent can reach a room **at all**. It does not separate two of your domains that live inside one workspace the agent already belongs to. Route auth is not that separation either: it says who the caller is, never which sessions or tenants that caller may reach. [§3](#3-tenant-isolation--one-team-never-reads-another) states which of the two boundaries actually holds, surface by surface.

## 3. Tenant isolation — one team never reads another

Memory and operational state are partitioned by **org**, the outermost tenant key, carried on every surface binding. Isolation holds at two levels:

- **At rest:** every durable store filters by `org_id`. On Postgres (Neon) that column filter is backed by **Row-Level Security** as defense-in-depth, validated in tests against real RLS enforcement. Spend counters and routines carry an org-keyed policy of that kind. 🔴 **Read that second layer for what it is.** Those policies permit when `app.current_org` is unset, and nothing in the shipped runtime sets it, so they bite only under a non-owner role with per-request GUC wiring. On the default single-role Neon deploy the app connects as the table owner and bypasses them. The `org_id` filter on every query is the load-bearing isolation in every posture — see [Database](../extending/database.md). **The audit trail is different from both, in two ways.** 🔴 **Its org filter is REQUIRED** (OPE-1812): `readAudit` refuses a read that names no org instead of widening to every tenant, in both adapters and in the type. That refusal is the load-bearing tenancy control for the log — not caller discipline, which is what it was when an org-less read returned every org's rows. Second, `audit_entry` carries the same GUC-keyed policy the mutable tables do, on a `FORCE`d table, so it binds the owner too; but nothing in the shipped runtime sets `app.current_org`, so that policy permits today and narrows only for a deployment that wires the GUC per request. The table's append-only guarantee is separate and unconditional: with no `UPDATE` or `DELETE` policy under `FORCE ROW LEVEL SECURITY`, those verbs are denied to every non-superuser role, the owner included.
- **At runtime:** memory sharing is gated by **trust** (verified in-org membership), not by a channel's public/private visibility — a private channel with confirmed internal membership shares its domain's brain exactly like a public one does. An **external** surface — externally-shared/guest-bearing, or any surface whose membership can't be positively confirmed — gets read-only `public` memory at most; it never reaches an internal domain or the org brain, and never writes into shared memory. The "is this internal?" decision is the security-critical bit, lives in one tested place per surface, and **fails closed to external**.

See [Memory](../capabilities/memory.md) for the domain/silo model and [Audit & provenance](./audit-and-provenance.md) for what's recorded.

### Cross-domain isolation within one org

The isolation above is org-grain: it keeps one tenant's data from another tenant's. A different question sits inside one org: when two of your **domains** — say a general team's channel and an HR channel — live in the same vendor workspace and the agent has a presence in both, what stops a session woken in one domain from reading the other's rooms or pages?

The honest answer is **per surface, not one blanket sentence**, because each vendor's own credential and membership model differs. Audited 2026-08-12 against each vendor's own documentation, not assumed:

| Surface | Vendor-enforced boundary | What OE adds | Multi-credential per tenant |
|---|---|---|---|
| Slack | 🟢 real — a bot token cannot read a channel it has not been added to (`not_in_channel`); OE requests no self-join scope | a domain's exact `reach` entries, on top of that membership | only via a second bot install (a second @-handle) |
| Discord | 🟢 strongest — per-channel permission overwrites on the bot's own role, set from Discord's UI, no OE involvement | a domain's exact `reach` entries, on top of that membership | only via a second bot application |
| Teams | 🟢 on the shipped default (RSC, granted per team at install) · 🔴 none on a tenant-wide Graph permission — **[check which one you are on](../deploy/surfaces/teams.md#which-boundary-governs-your-reads)** | a domain's exact `reach` entries | not needed on RSC — the grant already scopes per team |
| Notion | 🟡 depends on your config — 🔴 none on the default single deployment-wide key (identical for every domain) · 🟢 real once a domain binds **its own** internal integration, which Notion scopes to that integration's share list | the full domain fence: roster **and** workspace claim, both sides | ✅ yes — per-domain integrations ship ([bind one](../deploy/surfaces/notion.md#step-4--one-integration-per-domain-optional)); the fence is only as tight as your share lists |
| Linear | 🟡 partial — only private-team visibility; the deployment's OAuth token otherwise reaches whatever the authorizing install can see | the full domain fence: roster and workspace claim, both sides | partly — likely possible with per-domain service users, unverified |
| GitHub | 🟢 credential-layer — a mint scoped to the session's granted repos, injected at the firewall, the token never enters the sandbox | already the boundary; no separate roster needed | ✅ yes, already shipped |

Two things follow from this table, stated plainly:

- **Slack, Discord and Teams-on-RSC need no rearchitecture.** The vendor's own membership model is the real first boundary, and Open Everywhere's domain roster is a second, narrower one on top of it. The agent cannot admit itself to a room it is not already in.
- **Notion is the one surface where you choose the boundary.** Leave it on the deployment-wide key and the domain fence is application code, not a vendor guarantee — one key reads everything the integration can see. Bind a domain to **its own internal integration** and that domain's calls run under a credential Notion itself scopes to the integration's share list. Bind the two roles independently: `channel-key` covers replies, the webhook two-step and the read tools; `memory` covers the read-only page-subtree projection a domain uses as its brain. A delivery-woken session's `read_notion_page` / `read_notion_comments` calls run under the **credential that verified that delivery**, never a fresh lookup off the page's domain binding — so a page double-shared with the deployment-wide key as well as your domain's own integration only opens what the VERIFYING key can see on Notion's side **through those two tools**. One declared exception: on the work plane a domain that holds a Notion work grant reads through `read_notion_page` under the credential that grant names, because such a turn was woken by no Notion delivery at all. `read_notion_comments` holds the delivery rule absolutely. The domain's **memory** silo is a separate path and is not narrowed by this: it still resolves its credential from the domain binding, so a surfaced domain that anchors a Notion memory silo pulls that silo under the domain's own `memory` credential regardless of which integration verified the delivery. The caveat that remains is exact and it is yours to close: binding still cannot un-share a page, so a page left shared with the default integration is still readable under that weaker key. Unshare it. See [One integration per domain](../deploy/surfaces/notion.md#step-4--one-integration-per-domain-optional).
- **Linear is where a workspace-wide credential is still the whole story.** The deployment's OAuth token reaches whatever the authorizing install can see, bounded only by private-team visibility; the domain fence above is application code, not a vendor guarantee.
- **Teams is the one row with two answers, so Open Everywhere reports which one you have.** The same Graph token is authorised either by the per-team RSC grant or by a tenant-wide application permission, and only the first is a Microsoft-enforced boundary. The deployment reads the answer out of its own token and reports it in two places: the ops `preflight` names the boundary in force, and a `teams.read_boundary` audit row records it whenever it changes. A conditional claim you cannot check is not a claim — see [Which boundary governs your reads](../deploy/surfaces/teams.md#which-boundary-governs-your-reads).

Every refused cross-domain read, on every one of the six surfaces, writes a `read.refused` audit row (ids and a verdict, never content) — see [Audit & provenance](./audit-and-provenance.md). On Teams that row also carries a `boundary` field, so the trail shows which boundary governed the reads the deployment does let through.

There is also a documented asymmetry in how the domain fence itself treats a workspace-wide container: see [Access & scoping § Reach](../how-it-works/access-and-scoping.md#reach-exact-keys-and-containers).

### A cross-surface window reads only the surface that woke the turn

A domain on `mode: "unified"` fans several surfaces into one context window, so one long-lived
session carries turns from Slack, Discord, GitHub, Linear, Notion and Teams in turn. The read tools
are armed once, when the session opens, from whichever surface happened to open it. A **per-turn
origin fence** therefore runs again inside every read: the turn may read only the surface the
message that woke it came from. A Slack-origin turn cannot read a Discord channel, a GitHub-origin
turn cannot read a Slack channel, and a delegated worker inherits its parent turn's origin rather
than widening it. What travels across surfaces in a window is the **shared context**
the agent already holds, never a live read on another surface.

**The work plane is the one declared way past the origin fence**, and it is a config declaration
rather than a hole. `read_notion_page` and `read_linear_issue` admit an off-origin turn when the
caller's own domain holds that vendor's work grant — so a Slack-origin turn *can* read a Notion page
where a reviewed grant says that domain works in Notion. The grant names the credential the read
runs under, and the target is still fenced to the caller's own domain underneath. With no grant the
refusal is unchanged, down to the audit row. `read_notion_comments`, `read_channel`, `read_thread`
and `read_work_channel` hold the fence absolutely.

The fence refuses a turn whose origin the deployment cannot name. That is deliberate: "I could not
work out which surface woke this" is not evidence that a read is on-origin.

This is the second of three gates each read runs, and each one is narrower than the last: the target
platform must be one of the window's own sources, it must be the turn's origin, and the channel must
be on the domain's roster (the same roster §3 describes). All three gates now audit their own
refusal (OPE-732). The roster gate writes a `read.refused` row. The sources gate writes
`<platform>.sources_refused`, and the origin fence writes `<platform>.origin_refused` — `<platform>`
is the target the read was refused, not the turn's own surface. See [Audit &
provenance](./audit-and-provenance.md) for the row shapes.

## 4. Approval gates are governance, not a crutch

Consequential or outward actions — opening a PR, sending outside the originating surface, creating a routine or a skill — pause for a human. This is the right posture for *any* autonomous agent regardless of how strong the underlying model is: the gate exists because the **action class** warrants a human, not to compensate for a weak model.

**The stance is not to prevent the agent from acting. It is to require a human to approve anything consequential.** Three surfaces hold that line, and none is agent-writable. (1) **Approval-card resolution**: an agent tool can *propose* a gated action (`requestApproval`), but the *decide* core (`resolveApprovalClick`, its approver-standing check `clickerMayDecide`, and the Slack click route `handleApprovalPayload`) answers only to a human's button click or to an authenticated operator on the RBAC-gated control plane. No agent tool can reach it. (2) **The trust registry** that declares which rooms count as internal (§3 above) has one runtime write path, `registerSurfaces`, called once at boot from the deployer's config-as-code. No agent tool can call it. (3) The **pre-approval rules store** ([How it works § Pre-approval rules](../how-it-works/pre-approval-rules.md)) needs no entry in the scan for a structural reason: rules are config-as-code with **no runtime write path at all**, and the machine-written grants overlay refuses a `preApprovalRules` field outright (a strict allowlist in `grants-codemod.ts`, pinned by test). A rules store the agent could edit would let it author its own exceptions to (1) and (2) — so any change that adds a write path for rules must add that writer to the scan's manifest before it lands. The manifest holds **three** entries today, and the third is one this list does not name: the **judge-contradiction ledger** (`agent/approvals/judge-contradiction.ts`), whose `contradictJudgeAllow`, `disarmApprovalJudge` and `rearmApprovalJudge` are the record of a human overruling the approval judge. A rules writer would therefore be a fourth entry, not a third. `npm run lint:human-only-invariants` scans the whole agent-tool roster. It runs in the `npm test` chain, not in `npm run build`. It fails if any tool, today's or a later one, imports a protected export from any manifest entry — by name, by namespace (`import * as x`), or through a dynamic import expression. The checker's own header lists exactly which import forms it covers.

**The egress plane is the carve-out, and it is deliberate.** The stance above governs the TOOL plane — the actions an agent takes by calling a tool. A request the agent makes from inside its own sandbox (a `bash` `curl`, a script's HTTP call) reaches no tool and shows no card, ever. What bounds it is the compiled firewall policy, not a per-request check: a host the bundle does not open is denied, and a host it opens to `POST` is open to `POST` for as long as that policy stands. So on that plane the review happens in the bundle diff, not at the moment of the write. One caveat belongs with that sentence: the policy is recompiled every turn of a session and re-applied whenever the recompiled policy differs from the one in force, and again mid-turn by `checkout_repo` and `open_pull_request`, which widen the two git hosts to every verb under a brokered token no bundle diff shows. [Credentials & the two planes](./credentials-and-planes.md) sets out why, and names the one row that records what a policy left open.

**Which verbs pause is decided in a PR diff, never at runtime.** Every agent tool carries an explicit consequence tier in one central, greppable table — `packages/core/agent/access/consequence.ts` — with three tiers:

| Tier | Meaning | Examples |
|---|---|---|
| `open` | stays inside the asking conversation; still audited | reply, react, reads, subscribe to a PR's status |
| `gate:member` | a verified human confirms with a click on a code-rendered card | open a PR, create a routine/skill, purge memory |
| `gate:admin` | requires admin standing (config-as-code roles) | set a spend limit, revoke a connector, read another room's memory |

The tier is assigned by a **three-axis rubric** applied by the PR author and reviewer — an action is consequential iff its effect *escapes the conversation* on any axis:

1. **Audience** — output reaches beyond the room that asked (a PR, a publish, anything cross-surface to a lower-privacy target).
2. **Reversibility** — it can't be cheaply undone (forget, merge, spend).
3. **Self-modification** — it durably changes the agent's own future behaviour (a standing memory rule, a skill, a routine, a grant, a cap).

Everything else is `open`: a reply in the asking channel fails all three axes. **The annotation is the law; the runtime never classifies.** A gated tool routes through the approvals plane (frozen args, a code-rendered card, a verified clicker) or a config-as-code roles check — there is no model-facing judgement about whether a given action "seems safe." The seat instructions (`agent/instructions.md` § Approvals) bind the model to the same rule: the card is the runtime's to raise, never the model's to infer. So the model does not invent a gate for an action that no tool gates, such as a write to a REST host the domain declares or a routine's declared tool. That write is pre-authorised by the bundle.

**Whose standing a `gate:admin` check reads.** It reads **the person who asked**, never whoever else the session was serving. That distinction is load-bearing on a standing seat, because one seat holds several conversations: the framework folds queued messages into one turn and keeps one of their identities, and a delegated worker inherits that one identity faithfully. So a gate that read "this turn's identity" would answer for the wrong person in both directions — it would serve a non-admin under an admin's standing, and refuse an admin under a stranger's. The asker comes from the host-written wake envelope, which names the author of the message that woke the turn; the model never writes it and one person cannot forge an element around another's words. **When the turn cannot name exactly one asker — several people woke it at once, a relay message woke it, or a worker was dispatched from a turn that named nobody — the admin action is refused**, and the refusal says the caller could not be verified rather than claiming they lack standing. Ask again on its own and the gate answers normally. On a cross-surface window seat, which is the seat many people wake, a delivery carrying no envelope is refused for the same reason rather than answered with the turn's acting principal: the seat serves several askers, so "nobody named" there is a refusal, not an absence of evidence. The presence rule is unchanged and still runs first: an autonomous fire has nobody acting, so it holds no admin standing whatever its envelope names.

**A delegated run is TOLD who asked; it never reads its own brief.** Every delegated run — a framework subagent, and equally a worker or seat the agent dispatches as a separate session — is handed the asker on the same host-set channel that carries its other stamps, and the stamp wins over anything in the text. That order is the control, not a convenience: a worker's opening message is a brief its *parent model* wrote, and a brief that spelled out a wake envelope naming an administrator would otherwise mint one. Every dispatch writes the stamp unconditionally, including when it cannot name anybody, because a missing stamp is exactly what would let the run fall back to reading its own text. A triggered fire stamps "nobody asked" for the same reason: its delivery can carry a webhook payload from outside the org.

One residual is stated rather than papered over. A session that no room shares — a single-surface session, the control plane, a script, a local run — still answers with the turn's acting principal when its delivery carries no envelope. No such session is woken by more than one person's delivery, so there is no borrowed identity to take, and refusing there would break every headless caller for no gain. If a many-asker seat is ever built outside the cross-surface window, it has to classify as a shared room, not as one of these.

**The one exception to that refusal, and why it gives nothing away.** A turn several people woke is served when **every** candidate asker holds **org-admin** standing. The gate's answer is then identical whichever of them asked, so no candidate gains anything by being served under another's id — there is no borrowed standing to borrow. The rule is deliberately narrow. Every candidate must be on the org roster by exact id; one candidate who is not, or one the roster cannot name, refuses the whole turn. The candidate set must be known and whole — an unverifiable turn that names no candidates refuses exactly as before. And it is org admin only, never a matching set of domain admins, because two people who administer the same domain still differ elsewhere. The cost is stated: the audit row names one of the candidates, chosen deterministically, so attribution inside that set of org admins is approximate. That is a bounded loss taken knowingly, so that admin verbs stay usable in a busy admin room; authorisation itself loses nothing.

**Standing is personal; where an answer may be *spoken* is not.** An admin gate says a person may see a thing somewhere. It says nothing about the room the answer renders into, and the room has its own audience. So org-grain reads carry a **second fence on the venue**, layered on the role check — both must pass. Org-wide admin memory reads (the silo map, and any cross-domain file content) answer **only** in an armed governance channel or in a DM with the asker. In any other channel the same ask is **narrowed to that channel's own domain**, and the answer says so; where there is no domain to narrow to, or the asker does not administer this one, the read is redirected before any content is computed, and the redirect is audited. Two properties of this fence matter. It can only ever **remove** reach — the narrowed answer never exceeds what the room's own domain already covers, and the role check still holds it to what the person may see anywhere. And **membership is not authorisation**: being in the governance channel, or in the governance domain, confers nothing at all. The exact-id roster stays the only source of admin standing; the venue only decides whether standing may be *spent here*. A governance channel with a non-admin in it stops being a governance venue until that person leaves — the demote is automatic, and so is the re-arm.

**What a `gate:member` click does and doesn't prove.** The member tier is an *injection gate*: its job is that a session which read hostile text can only ever *offer* a button, never press one. It deliberately does **not** require admin standing, and it does **not** require a second person — self-approval by the requester is allowed on purpose, because the ceremony exists to gate the model's proposal, not to police the member. The member-tier actions are ones the person could already take by hand, and the ones that reach further stop at another gate anyway: approving `open_pull_request` publishes a branch and opens a PR that a human still reviews and merges, and approving an access request *grants nothing* — it opens a PR against the grants overlay, where the merge, behind branch protection and CODEOWNERS, is the actual privilege gate.

**Before any of that, the card has to be allowed into the room at all.** An approval card spells out exactly what would execute — the figures, the domain, the target — because that is the whole point of it, so posting one into an externally-shared channel discloses the action in full to another company, and the decision that follows is *perfectly authorised*, which is why no authorisation check catches it. So a proposal into a channel the platform **positively reports as externally shared** is refused before the card is posted: nothing is minted, nothing is rendered, and the refusal is audited and explained in a message that deliberately names no figure, kind or domain of its own. This gate is **tier-blind** — it applies to every gated action, not just admin ones, because posting happens before any tier is consulted and the most disclosive card in the system (confirming *which* memory to forget) is a member-tier one. Where membership can't be read it stays inert, so every non-Slack surface behaves exactly as before. The cost is honest: an admin whose only room is externally shared has to ask from an internal channel instead.

Three further constraints bind the clicker, and all are Slack-scoped today. First, a click must come from the room the card was posted into — the check runs on the room the interactive payload reports, so a surface that supplies no such context (Discord, and the headless control plane) leaves it inert; this check runs before the rest and does not depend on the kind's tier. Second, where channel membership can be read, a member-tier click from a channel the platform **positively reports as externally shared** is refused — the card stays pending so someone inside the org can decide it, and the refusal is audited. Where membership can't be read the gate stays inert rather than refusing, because "we couldn't ask" must not silently disable approvals. This room-level check alone is **necessary but not sufficient**: it catches externally-shared channels, not a guest sitting in an ordinary internal private channel. Third, a person-level check closes that gap, for member-tier clicks only: on Slack, a click from a person the platform **could not confirm as a member of the workspace** is refused, in any room, internal or externally shared — decided before the room-level check, though after the click's-own-room check above. "Could not be confirmed as a member" is broader than "is a guest": it also covers a Slack Connect stranger, a deleted account, and a person from a workspace this deployment has not declared. A **bot** account is not in that set — an app is judged by its workspace like a person, so the workspace's own app is a member and a foreign app is not. Nor is a **sibling Enterprise Grid workspace**, once the operator declares the Grid: that declaration is what admits a Grid colleague whose home `team_id` differs from the workspace they clicked in. Where the platform cannot classify the clicker at all — no token, an API error, or a Slack-level refusal such as `missing_scope` — this leg stays inert too, the same anti-outage polarity as every other leg here. Approving a webhook ROTATE is held to the stricter bar — the click mints a live signing secret and destroys the one in use, so it additionally requires a channel whose membership actually resolved. (The secret itself is revealed to the person who asked for the rotation, not to the clicker; the stricter bar is about who may decide a mint that destructive, and the room is what bounds who could have clicked.) (Rotate is the only kind on that bar. A webhook is created by a merged PR, never by a click.)

**The same floor governs who may answer the agent's own questions.** An approval card is not the only widget the agent puts in a room. When the model calls `ask_question`, or the framework asks whether to continue a long session, the framework parks the turn and renders a widget with buttons; whoever presses one resumes the turn — a spend commitment, since the resumed turn runs the model again. That is a separate seam from the approval card, and the framework's own default accepts the person who pressed the button and compares them to nothing, with no budget check either. Open Everywhere therefore authorises that answer in its own code, on Slack and on Teams: first the same ingress spend gate every ordinary mention runs (see [Spend & cost controls](./spend-and-cost.md)), then the same room floor the approval click runs: an answer submitted in a channel the platform **positively reports as externally shared** is refused, the answerer is told why, and the refusal is audited as `input_response.denied`. Both platforms go one step further with a per-person verdict — Teams reads the conversation's membership list, Slack reads the same per-user lookup the approval click now reads — and an answerer either platform **could not confirm as a member of the workspace** is refused even in an ordinary internal channel. (On Slack that unconfirmed set is broader than "a guest": it also covers a Connect stranger, a deleted account, and a person from an undeclared workspace. It does not cover a bot account, nor a sibling Enterprise Grid workspace under a declared Grid — the same rung walk the approval click runs, described above.) Where neither can be read the gate stays inert, the same anti-outage polarity as the click. **A question can also be answered by an ordinary message**, not only by pressing a button: when a delegated worker asks something, the agent posts the question into the conversation that delegated the work, and the next message **in that same conversation** is delivered back to that worker as its answer. The conversation is part of the check, not an assumption. One cross-surface window covers every room and every surface in a domain, so the agent records which room a question was posted into and compares it against the room each message arrives from. A message from anywhere else is an **ordinary message**: it wakes the agent normally, and the question stays open for the room that can see it. That comparison fails **soft in one direction only** — where either room cannot be identified, the message is treated as ordinary rather than as an answer. The cost is a question that waits longer; the alternative would be a message silently swallowed by a question its sender never saw. A message that does come from the asking room then runs the **same room floor** the button does — a refused answerer's message is not taken as an answer, it is audited as `input_response.denied`, and the question stays open. The per-person check is **inert on this one path**, because a message carries the conversation's trust verdict rather than a per-person one, and reading one as the other would refuse whole conversations. So the message path is the one place a person the platform could not confirm as a member may still answer, provided the room itself passes the floor. **The message path is not limited to the cross-surface window.** A surface the agent watches on its own — a Notion page's comment threads, for example — records the same question-to-room binding, with the discussion thread as the room. 🔴 On such a surface the room floor **runs and is inert**: the per-person check is not passed (there is no membership probe), and the room check cannot refuse because no roster can be resolved for it — the same anti-outage polarity described above, reached structurally rather than by a platform blip. So on a self-watched surface the discussion-to-question binding and the ingress spend gate are what carry this path, not the floor. Before that, such a surface showed a delegated worker's question and could not carry any answer back to it: the person answered in the thread and believed they had answered, while the worker stayed parked. Two limits are honest rather than implied. The answer is bound to the **room**, not to the person who triggered the session: `ask_question` exists so the room can answer, and binding it to one principal would break the channel case it was built for. **An answer by message does not change who the turn runs as.** A turn runs as its room, not as a person: its reach is fixed from the seat when the turn starts. So an answer that arrives as an ordinary message reaches the waiting question with no identity of its own, and the turn keeps the identity it started with, whoever answered. **A button answer does not change the turn's identity either.** On Slack and Teams the framework requires an identity on the button road. On the framework version this deployment pins, every question the agent asks is held by the asking tool itself, and the framework hands a button answer to that tool with the clicker's identity as a **responder** label only. The turn's own identity is not replaced. A real-host test pins this on Slack, so a framework change that starts replacing it there fails that test. Teams follows the same framework path, but no real-host test drives it. The clicker's own standing is still checked first (the spend gate and the room floor above). An approval decision is different on purpose: it is judged on the clicker's own tier. **A non-member's answer carries the non-member mark.** A worker on a work-session domain asks with a question card, and the room's answer reaches the seat as an ordinary message, so it carries the mark itself. Where the agent instead delivers a message to a waiting question as its answer, and the person who wrote it could not be confirmed as a member, the agent records the mark beside the question before it delivers the answer. If the mark cannot be recorded, the answer is not delivered as an answer: the message wakes the agent as an ordinary message, which carries the mark itself. The turn that reads the answer then marks itself tainted, the same mark a plain message from that person would give a new turn. So the taint controls apply to it: the sinks that declare `taint: "gate"` floor their verdict at a human's approval, and the mark travels with any work the turn hands on. 🔴 One limit stays open: the mark reaches the turn's taint record, not its identity. A reader that takes the non-member fact from the identity or from a worker's dispatch record does not see it. That reader is the own-account connector member plane, which this deployment ships disarmed. Three decisions stay with a person, and each one reads that person's own act, never the latest message in the turn: an own-account connector (it reaches a shared seat only through a grant), an admin action (the standing of the person who asked), and an approval decision (the tier of the person who clicked). When a later delivery inside a turn names a different person than the delivery that opened it, the admin gate refuses, a worker that turn starts on a native surface gets no surface authority, and no thread seat opens under the mixed identity. This backstop covers every turn whose opening identity the agent recorded when the turn started. A turn that started before the record existed keeps the earlier behaviour. And the seam is **one-sided** — a refusal leaves the question open, because the framework offers no way to cancel a pending request, so a refused answerer can retry and a question nobody may answer stays open until the session ends. That is denial of service, not escalation.

The table is guarded by `npm run lint:consequence` on the `test` chain, which makes it **total and honest**: a tool absent from it fails the build (no default tier — a new tool cannot mount un-tiered), a declared tier whose source code stops matching its actual gating mechanism fails, and gating can therefore move *only* through a visible diff to this one file. Even eve's own framework tools are enumerated and pinned, so a future framework tool can't slip in ungated.

### The unified approver chain

Every permission scheme above is one mechanism: a chain of **approvers**, each answering
`allow`, `deny`, `ask`, or deferring (`access/approver-chain.ts`). The operator mental model
is two sentences:

> Any deny wins. Otherwise the first opinion in the fixed order wins; modes and
> unattendedness only move `ask`. A registry row flipped to `defer` consults the LLM approval
> judge when the deployment arms it — and every judge failure is `ask`, the card the row always
> produced.

The order is pinned in code — **custom → surface → classifier → registry** — and config can
fill slots but never reorder levels, so a config element can never slide in front of a surface
control and silently void it. The registry above is the terminal element: it never defers, so
every resolution lands on a verdict. A `deny` from any element is **absolute** — no mode,
transform, or later element can lift it; the only way is a reviewed config diff to the element
that denies. Element errors resolve `ask`, fail-closed, never silently allow.

**Operator approvers** are TypeScript declared on a bundle (`approvers`) — and they may
*lower* a built-in verdict (auto-allowing a gated verb for one domain), because a bundle
author already holds a strictly bigger power: they grant the credentials this plane governs.
Config-as-code is the review; what deliberately does not exist is any *runtime* lowering
toggle. Connector- or remote-supplied approvers are clamped **raise-only** unless the operator
grants `mayAllow` explicitly.

**Modes** (`Domain.approvalMode`) are post-resolution *transforms*, not chain elements:
`DANGEROUSLY_BYPASS` turns `ask → allow` — it kills approval **cards** and nothing else (an
operator's own written prohibition, egress, credentials, IAM, spend caps and audit all still
hold); `APPROVE_ALL` floors `allow → ask` except names on its explicit allowlist, which keep
the registry default; `DENY_ALL` tightens everything to a fast, audited refusal. A **fourth arrow
runs at the same stage and is not a mode at all**: the break-glass halt denies `allow` and `ask`
alike, under `reason: "halt"`, whenever a halt row covers the call. `resume` is exempt from the halt
arrow — otherwise a halt would deny its own lift — and exempt from `DANGEROUSLY_BYPASS` too, so a
model turn inside one bypassed domain can never lift an org-wide stop without an admin click. Three
more
transforms run after modes, in this order: **taint** (`allow → ask`), which runs *after* modes
precisely so a bypass can never lift the taint floor; then the **beneficiary-clicker floor**
(`allow → ask`) — a kind whose click *mints live material* (a signing secret, on `webhook.rotate`)
cannot be safely auto-approved, because a chain-lowered `decidedBy` is `chain:<element>`, never a
person, and minting and destroying a live key is not a decision an element may make; so no element,
mode or bypass may leave one of these kinds auto-approved. (The reveal itself goes to the person who
ASKED for the rotation, never to the approver. The floor is about who may *decide* the mint, not who
receives it.) And **last of all, unattended** (`ask → deny`) — a
routine/webhook fire that hits an undeclared gate, or either floor above, fails fast instead of
posting a card into an empty room (declare the permission on the routine's creation card
instead).

**The position of `unattended` is itself a control.** It runs last so that it sees every `ask` the
pipeline can produce, including the two floors' own. Run earlier, a floor could raise a verdict to
`ask` *after* the arrow whose whole job is to stop cards landing where nobody can click them — and
the run would sit holding a card forever.

**The LLM approval judge** (`approvals.judgeMode`) is a deliberate **deviation from this
model's "no runtime model judgment" rule**, bounded on every side. It ships armed (`enforce`), and
`off` turns it off for the whole deployment. It decides only the
*fully-deferred residue*: a `TOOL_CONSEQUENCE` row an operator has explicitly flipped
`ask → defer` (`judgeDefer` — a reviewed registry edit that must cite measured shadow-mode
evidence, never faith), in `enforce` mode, consulted only by
the propose plane (the permission simulator and every headless caller stay judge-free by
construction). **An enforced allow must cite an authored
[pre-approval rule](../how-it-works/pre-approval-rules.md)** that the scope really carries. The rules
are prose in the app's own config repository, so every act that runs without a card traces to a
sentence an admin wrote and a reviewer read. An allow that cites no rule, or cites a rule that does
not exist, is an `ask`. A scope with no authored rule is not consulted at all. Its verdict is final like any element's — `allow` executes without a card
(audited, `decidedBy: chain:judge`, the row naming the rule), `deny` refuses absolutely — and *everything else* is `ask`:
judge off, transport error, an unreachable judge model, unparseable output, the 30-second timeout,
and an operator's standing per-domain disarm all land on the exact
card the row produced before its flip, so the degraded mode *is* the unarmed chain. The judge
runs before the clamps — which is what lets a routine fire's eligible action auto-lift instead
of dying on a card in an empty room, while modes, taint and the floor still tighten whatever it
allows. It is reasoning-blind (request facts, standing policy, the requester's own visible
messages — never the agent's reasoning, never tool outputs, and never a delegated worker's
brief, which the parent *model* wrote and which is fenced out by session provenance at the
capture hook), pass-2-only under enforcement (the
cheap scrutiny screen may escalate but never terminate with allow), and every consult writes an
`approval.judge.verdict` audit row — the live track record the flip review queries. **A first
live `deny` deserves individual review** before the class is trusted. **Three classes are outside the
judge's reach**, whatever a rule says. Every admin act (a `gate:admin` row, such as
`set_spend_limit`) needs a person's click. Erasing remembered facts (`purge_memory`) needs one too,
because an erasure cannot be undone. A `routine.create` that declares a standing write is
armed by a person's click only. A standing write is a declared `pr.open` or a declared connector
tool that is not a read. The chain does not consult the judge for any of the three, and the verdict row
records `source: "human-only"`. **A cached allow answers for one act:** the per-session cache is keyed
on the act's whole arguments, the requester and `unattended`, so it never lifts a different act. **A connector write reaches the judge only on the domain's
credential** (the `op.connector` kind, OPE-2368). Code keeps every other connector call on its card
before the judge: a destructive op, an op on a person's own account, an unattended run, a turn that
read external content, a room that does not belong to exactly one domain, and an input the card cannot
show in full. The consult reads the room's domain, so a per-domain judge disarm or halt covers it. A judge allow runs that one call
only. It writes no approval for a later call, and only the judge can lift the card.

🔴 **The judge never disarms itself.** An operator is the only thing that turns it off, and the
only thing that turns it back on. There is no automatic circuit breaker: no count of human
overrules, no window, no statistical trigger. That is the ratified auto-approval doctrine held
straight — the model adjudicates and code does not second-guess its verdicts. If bad verdicts
become a real observed problem, the answer is better judge calibration or an operator disarm, not
an automatic one.

**Three human doors write the judge's ledger** — the same `approval.judge.contradicted` audit rows,
told apart by `humanAction`. Nothing else writes one, so a row always means a person acted:

- **The click overrule** (`humanAction: overrule`). A judge `allow` posts no approval card, so the
  room would otherwise see nothing at all. It instead gets a **judge-lift notice**: a code-rendered
  message naming the act that ran and carrying one button, *This should not have run*. The click
  needs the same admin standing as deciding that kind, and one lifted action is recorded once
  however many times it is pressed. It is **audit signal only**: it records the overrule for a
  reviewer, it never undoes the act (which has already happened), and no number of overrules
  changes what the judge does. **The notice reaches every surface; the button does not.** Slack and
  Discord render it with the button. Teams, GitHub, Linear and Notion have no route for a tap, so
  the notice arrives there as plain text naming the act, the outcome and the action id it is
  recorded under — the trace is the same, and the overrule on those surfaces is a person reading
  the trail, not a click. See the judge-lift-notice row of the [surface-parity
  tables](../extending/chat-surface-contract.md#71-registration-seams).
- **The admin disarm** (`disarm_approval_judge`, [control plane](./control-plane.md);
  `humanAction: admin-disarm`). An operator turns the judge off for one address. Every defer-flipped
  verb there falls back to its approval card — the pre-judge behaviour, so the degrade never widens
  access. It **lasts until an operator re-arms**; no clock lifts it.
- **The admin re-arm** (`rearm_approval_judge`; `humanAction: admin-rearm`). The symmetric partner,
  and the only thing that cancels a disarm. An address's state is the **latest** operator row, so a
  later disarm turns the judge off again. The ledger is append-only: a re-arm erases nothing — the
  disarm it cancels and every human overrule stay readable in the trail forever.

🔴 **Every reader that asks for these rows asks per org.** The org is part of the judge's disarm
address, so the consult that derives the state, the click overrule's duplicate check, and the
control plane's `audit_query` all answer from one org's rows only. On a store shared by several orgs
an unscoped read would let one org's acts govern another's: the sharp case is the re-arm, the
permissive direction, which would cancel a break-glass disarm nobody in that org had lifted. See
[the control plane](./control-plane.md) for the two verbs' own refusal of a foreign `org`, and for
the one whole-store scan that still reads across orgs without deriving anything from these rows.

**Both verbs take one of two addresses, and the two are a strict partition.** `domain: <name>`
governs that domain. `orgWide: true` governs the **domain-less consults** — every defer-flipped
propose that carries no domain. Exactly one address per call; the server refuses both and refuses
neither, and there is no sentinel domain name.

🔴 **Know what `orgWide` covers before you use it.** It is wider than the two always-org-level
verbs: `pr.open` and `routine.create` carry no domain always, `spend.set` carries none on every
user-level cap and on any scope no domain claims, and `memory.purge` and `access.request` carry
none from any surface with no domain — a DM, for instance. A disarm only ever narrows, so a wide
population is safe in that direction. A **re-arm is permissive**, and it restores card-free
auto-approval across all of them at once.

🔴 **`orgWide` is not a kill switch.** It reaches the domain-less consults **only** — never a
domained one — and a domain disarm never reaches it. There is deliberately no "disarm the judge
everywhere at once" verb: that would be a larger control than break-glass, and it would need its
own ruling. The strict partition is what keeps this verb narrow.

A domain address needs a role covering the domain; `orgWide` names no scope, so it needs the
org-wide `admin` role. Both verbs write ids and registered names only — no free-text reason. A
disarm's *why* lives in the operator's own ticket or chat.

The notice renders on Slack and Discord. Slack's is the built-in render, the same one that draws its
approval card; every other surface must register a notice renderer of its own. A surface that
registers none gets no notice — a lift there leaves its audit rows and no room-visible trace, because
the button has no envelope to ride on a surface that ships no render for it.

The judge's context can carry **[pre-approval rules](../how-it-works/pre-approval-rules.md)**:
admin-authored prose, declared in the config repo and resolved per scope, that tells it which
actions the org treats as routine. They are an input to the consult above, so every bound listed
in that paragraph still holds — a rule can pre-approve an action, and it can never remove an ask
that policy code forces. The agent cannot author one (the machine-written grants overlay refuses
the field), and rules are never read from a repository the agent checks out to work on. When a
rule justifies an allow, the judge cites its id and the verdict row records it, so every
rule-driven auto-allow is traceable to authored prose. An allow citing an id that does not exist
is degraded to `ask`.

### What counts as external content

**Most of it is decided by one reviewed table, not by each read tool.**
Every ingestion site declares *what* it is reading — a chat message, a Notion page, a GitHub
PR, a connector result, a fetched web page, an uploaded file — and a single source-tier table
answers whether that marks the turn. The rule is **source-instance-binary**: a bound instance
is either internal (org membership gates who can type into it) or public (anyone can), never
per-item authorship, because "who wrote this particular comment?" is not a question Open
Everywhere can answer reliably at read time. So a **private** repository's reviews and diffs,
a Notion or Linear workspace you have *vouched* as internal, a connector granted
`contentOrigin: "internal"`, and ordinary chat on a member-authored surface are all read without
marking the turn — while a **public** repo, an unvouched workspace, an undeclared connector,
the open web, webhook payloads, uploaded files, image descriptions and `aws` output all mark
it. Where the deciding fact cannot be read, the table **falls closed** and marks.

Three properties are worth stating plainly. *Fencing and marking are decided separately* — every
one of those bodies is still wrapped as data before the model sees it, and the table decides only
the mark. The one place a body is *not* wrapped is a chat message from a vouched member, which is
a decision about the SOURCE and not about the table (see the chat paragraph below). *An undeclared
site is ungoverned, not trusted* — it marks unconditionally, so
adding a source declaration stays a deliberate act. And *the table can only ever relax*: it
may drop a mark a read tool would have set, never introduce one where the tool set none —
which is why turning it on could not tighten anything. `taint.tierMode: "dryrun"` reverts to
per-tool behaviour without a rebuild, and every divergence writes a `taint.verdict` audit row
naming the source kind, the verdict, and the table's own reasoning.

**Stated plainly for chat, since it is the most-asked-about source:** in a **wake envelope** the
author's standing decides both whether a message body is fenced and whether it marks the turn. A
message from a `principal` or `peer` author — a verified teammate who addressed the agent, or one
who did not — reaches the model as plain escaped text: no `<untrusted_external_data>` wrapper, no
do-not-follow notice. Those two grades differ only in addressing, so the split between them never
moves a body across the fence. The
`<message trust=…>` attribute the model already sees is what states the author's standing, and the
standing instructions teach what each grade means. Every other author keeps the fence: an unvouched
(`unauth`) human, a bot or a relayed session output (`relay`), an author the surface positively
refuted as a non-member, and any author whose grade could not be resolved. That last case is the
fail direction and it fences. (One older path sits outside this rule in both directions: a **raw
direct** DM or @mention delivered straight to a seat carries no envelope at all — no `<message>`
tag, no grade, and no fence — so it was never fenced and is not fenced now.)

Two things this does not say. It is not "content that looks safe is unfenced" — the rule reads the
SOURCE, so a teammate quoting a hostile message they received is still a teammate typing, and their
message stays unfenced while the reach-bounding layers above do the holding. And it reaches nothing
a *tool* brings back: every connector, MCP, web and read-tool result is fenced by provenance
whoever asked for it, which is the seam an injected page or issue actually arrives through.

**Chat marks on the AUTHOR as well as on the room.** The table's general rule is
source-instance-*binary* — it asks whether the bound instance is internal, never who typed. That is
the right grain for a repository or a workspace, and the wrong one for a chat surface, where a
stranger can sit inside an internal room. So chat adds an author question, and asks it at both seams
a stranger's bytes can arrive through:

```
a chat WAKE marks  ⟸  the room is DECLARED PUBLIC in the trust registry
                   ∨  an ingested message's author was POSITIVELY REFUTED by their platform
                   ∨  an ingested message's author was POSITIVELY REFUTED by the author-trust register
                   ∨  the room is UNDECLARED and taint.undeclaredSurface = "mark"   (off by default)

a chat READ marks  ⟸  any DISTINCT author of the fetched page was POSITIVELY REFUTED,
                      by their platform or by the author-trust register
```

The two seams differ in one way worth knowing. The **wake** leg runs in the ingress process, outside
any turn, so it travels to the reading turn as a host-set auth attribute and never consults the
table. The **read** leg (`read_channel`, `read_thread`) runs *inside* the turn, so it goes through
the table like every other ingestion: it declares `authoredByNonMember` and the `chat-message` row
branches on it.

**The wake leg runs on all six surfaces** — Slack, Discord, Teams, Notion, GitHub and Linear. Each
resolves its own per-author evidence, then asks the one shared join
(`stampNonMemberChatAuth`), which is what keeps "non-member" meaning the same thing everywhere.

🔴 **Both legs refute; neither infers.** A probe that could not answer, a tenant nobody armed, a bot
author and a message with no readable author id all mark **nothing**. Marking on silence would set
the bit on every read-heavy turn in an ordinary members-only workspace, and a bit that is always set
is one nobody can act on.

Read coverage follows what each platform can answer (the table below). Slack refutes through its own
`users.info` probe, cached per author and asked once per *person* in the page rather than once per
message. Discord and Teams have only the author-trust register on a read, so a tenant nobody has
armed never marks — under-marking, which is the direction this whole plane fails in.

**Marking is one answer, not the only one.** A deployment can instead decide that an excluded
author's text must never *enter* — `externalPolicy.authorGrain: "withhold"` — or that the agent must
not engage in an external room at all — `externalPolicy.roomGrain: "silent"`, which suppresses
wakes on Slack, Discord, Teams, GitHub and Linear (see
[Identity § where each grain is wired](../how-it-works/identity.md)).
Both ship OFF (`taint` / `engage`), so this section describes what every deployment does today.
`withhold` binds the READ verbs as well as the wakes: `read_channel` and `read_thread` replace an
excluded author's text with the arrived-marker, so a body a wake suppressed cannot be fetched back by
reading the channel. A withheld body never keys taint, because it never ingested. See
[The external-participant policy](../how-it-works/identity.md#the-external-participant-policy--what-follows-from-the-classification).

**The room leg** reads the operator's own declaration (`agent/identity/surfaces.ts`). A community
Slack workspace, an open Discord guild and a published Notion page are all rooms the world can type
into, and no per-author probe can help there — so the operator says so once, and every human-authored
turn on that room marks.

**The author leg** covers the other case: a **non-member sitting inside an internal room**. A Slack
multi-channel or single-channel guest and a Slack-Connect stranger are the sharp examples — Slack
reports each of them positively, through `users.info`. The other platforms are weaker and the
difference matters:

| Surface | Can it positively refute an author? |
|---|---|
| Slack | **Yes** — `is_restricted`, `is_ultra_restricted`, `is_stranger`, a foreign `team_id`. |
| Linear | **Yes** — `User.guest`. |
| GitHub | **Yes** — `author_association` outside `OWNER`/`MEMBER`/`COLLABORATOR`. Each of those three holds a deliberate access grant. The refutation matches a written-out **excluded** set — `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN` — rather than negating the internal one, so an absent association, or a value GitHub adds later, answers *not refuted*. That is fail-open on purpose: negating the internal set would read every unknown value as external and take the agent off the air on a payload change. Repo privacy is a different question and is not read here. |
| Teams | **Partly** — Entra `userType: "guest"`, when a roster lookup answered. |
| Discord | **No.** Discord has no organisation concept, so there is nothing to refute against. `member.pending` is a *screening* verdict, not a membership one. |
| Notion | **No.** The API's user object distinguishes only `person` from `bot`. |

🔴 **That table is about the WAKE.** On a **read**, only Slack refutes for itself. Teams' Entra
probe is keyed by conversation and needs the Bot Connector handle off an inbound activity, so a read
tool cannot reach it — and a read may target a different channel from the turn's own conversation
anyway. Reaching it would mean a new tenant-wide Graph permission (`User.Read.All`) for one taint
bit, which is deliberately not spent. So a Teams or Discord read marks only where the author-trust
register is armed.

**On the two surfaces that cannot refute anyone, you declare the authors yourself.** The
author-trust register (`agent/identity/authors.ts`) is the second source of refutation: the operator
names who is internal in a guild or workspace, and the register then refutes everyone else there.
See [Identity → the author-trust register](../how-it-works/identity.md#the-author-trust-register--declaring-whose-requests-are-trusted).

🔴 **The two registries are additive and neither replaces the other.** The room declaration gates
**audience** — what the agent may disclose into a room, given who can read it. The author register
gates **authority** — whose requests carry an org member's standing. A trusted author does not make a
public room safe to print into, so a register hit never cancels the room leg.

🔴 **An unarmed tenant refutes nobody.** The register is armed per tenant, explicitly. A guild with no
entry behaves exactly as it did before the register existed. Silence is not a declaration: reading it
as "everyone here is an outsider" would set the bit on every human message in every undeclared guild,
which is the always-on-bit failure the ingestion rule exists to avoid.

Four properties bound the whole leg. It keys on **ingestion, not presence** — a guest in the room
changes nothing until a message they wrote enters the wake or its backscroll, and a first wake that
hydrates a guest's earlier message marks just as their own message would. It covers **people, not
machines**: a bot or webhook poster is `relay`, and marking every app post would set the bit on most
conversational turns. It **fails open**: an unresolvable probe is not a refutation, because failing
closed would set the bit on every chat wake in a workspace whose token lacks `users:read`. And it is
**per turn**: the signal rides the one wake that carried those bytes, so the next message in the same
thread starts clean.

🔴 **A surface the operator has never declared marks nothing, by default, and the residual is real.**
Between install and the first declaration a genuinely public chat room reads clean. Three things
bound it. The ACL plane already fences an undeclared room to the read-only `public` pseudo-domain.
The approval plane is the defence against a consequential act. And `preflight` reports an
undeclared surface **with traffic** as a red, naming the surface and the line to add — the complaint
moved from every turn, where it was unreadable, to config time, where it is actionable. A deployment
that prefers per-turn pressure sets `taint.undeclaredSurface: "mark"`, which is far narrower than the
old behaviour because a *declared* room never reaches it.

🔴 **"We could not ask" must never read as "we asked and it was fine."** Silence in the trust
registry is not a `public` declaration, and the two produce different audit rows: a declaration
produces `declared`, silence keeps producing `assumed`.

**Taint is marking, not gating**, and the transform is the exception that proves it. A turn
that has ingested external content is *disclosed*: the approval card it proposes says so and
names what was read, and the `approval.chain` audit row carries the same. **Memory is where the
disclosure stops.** A bullet the turn writes carries no mark of its own: since the memory verbs
were retired, a write is a freehand file edit captured at session end, and the capture seam sees
file diffs rather than the turn that made them — so there is nothing to attribute, and
re-deriving a mark would mean marking a whole SESSION, which this model deliberately refuses to
do. What is durable there is the `memory.write` audit row, not the bullet; naming a fact's origin
in the bullet's own prose is the agent's job (see
[Memory](../capabilities/memory.md#the-shape-memory-keeps)). None of that changes a
verdict. What does is the registry's per-sink `taint` column, and only its `gate` value. Every other
sink declares `disclose`, which moves nothing.

**Which tools carry `gate` is derived, not listed.** Each tool answers one question on its registry
row — *does this arm, alter or remove surface that executes or instructs after the turn ends?* — and
an `arms`/`disarms` answer requires the floor. Today that is eleven verbs: the routine lifecycle
(`create_routine`, `edit_routine`, `enable_routine`, `cancel_routine`), its rules
(`add_routine_rule`, `remove_routine_rule`), skills (`create_skill`, `delete_skill`), resident agents
(`create_agent`) and webhook ingress (`declare_webhook`, `rotate_webhook`). The number is not the
control. `lint:consequence` scans the tree for the durable writes that land such surface — adding a
routine, writing a skill, applying an agent spec, declaring a hook, minting an ingress secret — and
fails the build on any tool that reaches one while declaring nothing. A hand-kept list of dangerous
verbs rots in one direction only: the new tool is simply absent from it, and every gate stays green.
This one cannot.

**What `gate` does is floor the verdict at `ask` — it does not refuse.** A tainted turn may still
propose one of those acts; what it may not do is have the act *auto-approved*. No lowering
reaches below the floor: not a custom approver, not a config allow, not the judge, not a
`DANGEROUSLY_BYPASS` domain. Attended, a human reads a card that names what the turn ingested and
decides. Unattended, the `unattended` transform reads that `ask` and denies it, which is exactly
the old behaviour in the case that actually carries risk.

The reasoning for that shape, since it replaced a hard refusal: a wall a tainted turn cannot climb
makes the turn useless, and useless security gets routed around — done by hand, or switched off.
A card a human reads is a control that survives contact, and it carries strictly more information
than a blank refusal ever did. The relaxation is paid for only where a human is present to be
asked; where nobody is, the answer is unchanged. **The residual is stated rather than hidden:** an
approval card converts a deterministic barrier into a human judgement at the moment injected text is
trying to shape that judgement. The card's mechanical provenance line is the counterweight, and it is
rendered by code — never by a summary of the tainted content itself.

**And the whole model is opt-out-able, in one reviewed line.** A governed seam nobody can decline
is a tax, not a feature — so `taint.mode: "off"` in `agent/settings/settings.ts` retires the marking model
outright: no marks, no verdict floor and no disclosure. (Taint never withdraws the delegation verb:
the forward leg marks the child instead, and `off` takes that leg with it.) It ships **on**, and there is deliberately **no environment variable
that reaches `off`**. No other behaviour setting can be pushed from the environment either — that
list closed with OPE-411, and its one surviving name (`OE_MODEL_STACK`) is a harness seam, not a
switch this security model shares. Every behaviour change, taint included, costs a diff — reviewed,
in the history, the same bar this file holds `taint.mode` to. Two things `off` does *not* touch: the **fence** is
unmoved in both modes (it keys on the source, it is what stops fetched prose reading as
instructions, and it refuses nothing), and the **approval system** is entirely independent of it. And it cannot hide: a session
running with the model off writes a `taint.mode` audit row, and every `approval.chain` row it
produces carries `taintMode: "off"` beside its `tainted: false`, so an opted-out deployment can
never read like one that ran the model and found nothing. See
[the configuration reference](../deploy/configuration-reference.md#turning-the-tainted-turn-model-off)
for what it costs you, stated plainly.

The reasoning for the narrower shape, since it is a deliberate loosening: the guard that
actually holds is the *turn-independent* one — a standing memory rule pauses for a human on
every turn, clean or not. A gate keyed on ingestion only stops an attacker who acts in the
same turn they planted the instruction; one who waits a turn gets the identical verdict. What
a broad taint gate reliably produced instead was a card for every ordinary "I read the docs,
now remember this" — an always-on signal, which is a signal nobody reads.

Every resolution writes an `approval.chain` audit row carrying every element's verdict, the
registry baseline, which element resolved it, and the transforms applied — so *"why was there
no card?"* and *"config lowered this"* are queryable facts. The `explain_permission` tool (and
the repo-side `npm run explain:permission` script) runs the same chain prospectively and
prints the same trace: the audit row's retrospective twin, rendered by one shared formatter.
Its `unattended` and `tainted` inputs are hypotheticals. When the caller supplies `tainted`, the
trace marks that value as supplied and prints this turn's own signal beside it — so a simulated
`tainted` never reads as a measurement of the turn. `unattended` has no such marker: the chain
requires a value, so the call site always resolves one, and the trace cannot tell a supplied
`unattended` from a measured one. Do not read the trace's `unattended:` as evidence about the turn.

Those rows are also what makes a grant's *fit* measurable rather than assumed: `permission_fit_report`
reads them over a window and proposes both widenings (a grant too narrow for the work that keeps
arriving unattended) and tightenings (a grant nothing exercised). Proposal-only — the actuator is a
reviewed config PR. See [Permission homeostasis](./permission-homeostasis.md).

## 5. Everything consequential is recorded

The audit log captures who, what, where, and when for memory writes, egress and connector grants, and consequential tool actions. It is **append-only by design** — on Postgres this is enforced at the database layer with insert-and-select-only policies under `FORCE ROW LEVEL SECURITY`, so update and delete are denied even to the table owner the app connects as (only a superuser / `BYPASSRLS` role could still mutate it, which the default Neon role is not). On SQLite the same property holds by contract (no delete method) rather than by DB enforcement, on a single-tenant-trusted backing. Either way the log can record an erasure without being erasable itself. See [Audit & provenance](./audit-and-provenance.md).

## 6. Spend is bounded

Per-surface and per-workspace token budgets are enforced from a DB-backed, org-partitioned ledger; an over-budget scope declines new work cleanly rather than degrading silently. Budgets are set in config and can be bridged **up** or tightened **down** at runtime through an audited override — spend is the one plane where a widening bridge is allowed, because a budget is not a security boundary. The override replaces each cap component it names and leaves the components it does not name at the config value. See [Spend & cost controls](./spend-and-cost.md).

## The supply-chain invariant

One property is worth calling out for anyone forking or contributing: **this repository runs no GitHub Actions workflow at all.** `.github/` holds a CODEOWNERS file, the issue templates and the PR template, and nothing else. Gates run on the contributor's own machine or in a cloud sandbox, and a run's evidence is posted back as a commit status. So the classic open-source RCE — `pull_request_target` plus a PR-head checkout plus secrets in the environment — has no lane to take: there is no workflow for a fork's pull request to reach, and no Actions secret to reach for. A fork that adds its own deploy job takes that lane on: keep any such job on `push` to the base branch, never on `pull_request`, and see the template in the repository, at `docs/how-it-works/deploy-on-merge.yml.example`. This invariant is not to be weakened without a security review.

Recommended hardening for a fork that runs its own workflows: branch protection on `main`, required status and DCO checks, private vulnerability reporting, Dependabot, CodeQL, and pinning third-party Actions to commit SHAs.

## What this does not protect you from

Every section above states a control and where it is enforced. This one states where those controls stop. It is short on purpose: the curated, anchored list of open gaps is the [honesty ledger](./honesty-ledger.md), and this section is the map into it.

- **An instruction is not a gate, and this system ships both.** A gate is code that refuses — the consequence table, the approver chain, the compiled egress policy. An instruction is text in the model's prompt, and the model can lose track of it or be talked out of it. Read any sentence about agent behaviour and ask which of the two carries it. Two places rely on an instruction by design and say so: provider-executed `web_search` results are consumed inside the model call, so no in-tree wrapper can fence them; and the untrusted-content envelope tells the model how to treat what it wraps, while what actually bounds an induced attempt is egress scoping and the approval gates.
- **An approval gate proves a human pressed the button. It does not prove the action was wise.** The tier is an annotation a PR author and reviewer assign in `packages/core/agent/access/consequence.ts`; **the runtime never classifies**. So a tool tiered `open` by mistake is not gated, and no runtime check notices — `npm run lint:consequence` proves the table is total and that a declared tier still matches its mechanism, never that the tier is the right one. The `gate:member` tier allows self-approval on purpose: it gates the model's proposal, not the member. And the **egress plane shows no card at all** — a `curl` from inside the sandbox reaches no tool, so the review for that plane happens in the bundle diff rather than at the moment of the write.
- **Taint marks only what a platform lets it see, and it only ever loosens.** The external-content floor (`allow → ask`) needs an author positively refuted, or a room the operator declared external. Discord and Notion cannot refute an author at all, Teams only when a roster lookup answers, and on a **read** only Slack refutes for itself — so the plane fails by **under**-marking. Enforcement is relaxation-only: the reviewed table can drop a mark a call site would have set, never add one, so the call sites that still do not mark stay a counted gap rather than a closed one, counted by a `taint.verdict` audit row whose `detail.divergence` reads `under-taint` — one row per source kind per turn, never one per call site. The stricter answers ship OFF: keeping an excluded author's text out entirely (`externalPolicy.authorGrain: "withhold"`) and not engaging in an external room at all (`roomGrain: "silent"`) are both opt-in.
- **Self-hosting isolates the sandbox, not the operator.** The sandbox tiers are not interchangeable. Vercel Sandbox gives a hardware-virtualised microVM. Off Vercel, Open Everywhere selects `docker` (the default) or the dev-only `justbash`, and nothing else — `OE_SANDBOX_BACKEND` naming any other value, `microsandbox` included, refuses to boot. Plain Docker gives container isolation only, and Docker's own network policy is allow-all or deny-all unless it is paired with Open Everywhere's egress-proxy sidecar. (Eve's own `microsandbox` enforces default-deny egress but **not** at-boundary credential injection, measured at OPE-917, which is why a read credential would be written into the sandbox there — a finding held open by the boot refusal above, not a posture this deployment can select.) And self-hosting moves trust to you rather than removing it: the audit chain proves tampering to the operator, never to an outside party, because nothing anchors the chain to a witness the operator does not control.
- **Nothing here defends the store or the host.** Org partitioning and RLS bound what a *session* reads. A person with database credentials, a platform admin, or anyone who can change tracked config and get it merged is outside every control on this page — which is why grants, domains and the trust registry are config-as-code behind branch protection and CODEOWNERS, and why that merge is the real privilege gate.

## Quick reference

| Guarantee | Enforced in | Your switch |
|---|---|---|
| Default-deny egress + credential injection | the egress firewall | on by default (`egress.enforce: false` to opt out); Vercel Sandbox natively, `docker()` off-Vercel via the [egress proxy](../deploy/platforms/self-host-egress.md), which the deployment arms with `OE_EGRESS_PROXY_URL`; no other backend is selectable |
| Capability scoping | bundles + resolver | config-as-code bundles |
| Per-surface connector gate | the connector self-scope | grant by name in a bundle |
| Cross-tenant isolation (at rest) | SQLite/Postgres providers, `org_id` + RLS | `deploymentIdentity.org` (tracked config), `OE_MEMORY_PROVIDER=postgres` |
| Fail-closed memory visibility | per-surface identity binding | automatic per surface type |
| Control-plane auth (fail-closed) | the admin resource server | `OE_ADMIN_*` issuer config |
| Repo access (short-lived tokens) | the GitHub App identity | `OE_GITHUB_APP_*` |
| Approval gates (consequence tiers) | the consequence registry + ActionKind approvals plane | `consequence.ts` (pinned by `npm run lint:consequence`) |
| Append-only audit | the audit store | `npm run audit` |
| Fork-safe supply chain | no workflow ships, so a fork PR reaches no Actions secret | invariant — do not weaken |

To report a vulnerability, see the repository's `SECURITY.md`.
