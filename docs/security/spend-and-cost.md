# Spend & cost controls

The operator pays for all inference, so per-surface and per-workspace budgets are a real guardrail. The posture is **decline, don't truncate**: an over-budget scope refuses new work cleanly rather than silently degrading. Budgets come in two denominations — a monthly **token count**, a monthly **USD amount**, or both — and every configured component is enforced.

## What's counted, and where

Usage is reported per model call and bucketed by **calendar month** into ONE **DB-backed
spend ledger** in the operational store (SQLite local / Neon Postgres hosted), keyed by
`(surface, acting principal, routine, model, period)` — so a surface total, a workspace
total (the sum of its surfaces'), one person's DM spend, or one routine's month are each
a keyed sum over the same table. The ledger is **org-partitioned** — under Postgres
carrying an org-keyed Row-Level Security policy as defense-in-depth, the same second
layer memory has. Read that layer for what it is: it permits when `app.current_org` is
unset, and nothing in the shipped runtime sets it, so the `org_id` filter on every query
is what isolates tenants in every posture. The **audit trail** carries the same GUC-keyed
policy on a `FORCE`d table, so it binds the owner too — but the GUC is unset, so it permits
today, and the org the store REQUIRES on every audit read is what isolates the log (see
[Audit & provenance](./audit-and-provenance.md)). One tenant's spend is never visible to another.

**Every model call the agent pays for is counted, not just the conversation.** Most model
calls are turn steps, which the agent framework reports directly. One is not: the
**vision call** behind `describe_image` (reading a screenshot, a diagram, a photo) runs
inside a tool, so nothing upstream reports it — the transport hands back its own token
counts and the gateway's measured cost, and the tool writes the same attributed ledger
and usage rows a turn step writes. The row is stamped with **the vision model's id** and
with the calling turn's surface, principal and routine, so "what did seeing images cost"
is a grouping of the same table, a person's image reads count against their own budget,
and a USD cap can trip on vision spend. (Before this, vision inference was billed by the
provider and invisible to every one of those.)

**Both denominations read that one ledger.** Token caps sum its billable tokens; **USD
caps** sum its `usd_micros` column, which is **priced at write time**: a call with a
recorded model is priced at that model's verified/catalog rate, a call with no recorded
model falls back to the deploy's sole priced model, and **sandbox runtime** lands as its
own line — no tokens, no model, dollars from the platform rate (below) — so real compute
burn can trip a USD cap even in a month with no model spend at all. This is the same
arithmetic `spend_report` shows, so the number an admin reads in a report is the number
the gate enforces. The row keeps its token counts and model alongside the price, so a
later pricing correction can recompute the dollars for every model row. The accounting
is **evidence-only**: a call this deployment has no rate for contributes **$0** (never a
guessed rate), which would leave a USD cap enforcing over nothing. For every model the
**committed config** selects, that state is a **build failure** rather than a caveat: `npm run
lint:model-ids` refuses a config that selects a model with no committed price (below). The gate
reads the repo, and the primary pins are in the repo: the settings `models.force` and
`models.primary` join the selected set, so the lint prices a committed pin too (they were the
unpriced `OE_FORCE_MODEL` / `OE_PRIMARY_MODEL` variables until OPE-2411). The allow-list this app
declares is derived from the roles it resolved (`agent/model/models.ts`), so a pinned primary enters
that list, and `set_domain_model` may then route a domain to it. The
gate cannot see a runtime pick — the pick is an operational-store overlay, not a repo file — so that tool
prices the pick itself: an unpriced model still lands, and the result and the audit row carry
`unpriced: true`. A deployment that declares no model policy at all (core's default) has no
allow-list clamp either, and the same flag is its only signal.

**The in-chat bridge reports the same gap, from the other end.** `set_domain_model` prices the
model it is about to route to; `set_spend_limit` cannot — a cap names a scope, not a model. So a
`monthlyUsd` proposal reads that scope's traffic over the last **30 days** and returns the models
it ran on that carry no committed rate, as `unpricedModels` (the field name and shape
[`usage_window`](./control-plane.md) uses; `"(unstamped)"` stands for rows with no model id). The
test is the ledger's own: a model prices at its committed rate, a stampless row at the deploy's
sole configured model, and anything neither path prices contributed **$0** to the `usd_micros`
column the cap sums. The proposal still posts its card — an unpriced model is a deployer's pricing
gap, not a reason to refuse an admin — and the tool's reply carries a sentence the agent relays in
the asking channel. **The card renders it too, and the decision row records it.** The coverage is
measured before the card is minted and frozen into the pending row's args, so the approver reads it
on the card — which matters most on a [redirected card](./control-plane.md), where the approver is
in a different room from the reply. The card states all four answers explicitly: every model
priced, the named models with no rate, *no traffic in the window*, or *not measured*. The last two
are never rendered as silence or as the "every model priced" tick, because a scope that ran nothing
has proved nothing and a card that says so anyway is a clean bill nobody earned. The
`admin.spend.set_limit` audit row carries the same summary —
`pricingCoverage: "full" | "gap" | "no-traffic" | "not-measured" | "unknown"` (the last for a
coverage state written by a newer deploy than the one rendering it — never a clean bill it cannot
vouch for), plus `unratedModels` and `unobservedModels` on a gap — so what the approver read is
recoverable after the fact, the way
`set_domain_model`'s `unpriced` flag is. Both propose doors freeze it: the tool and
`/oe budget raise`. Freezing it puts coverage inside the frozen args, so it joins the
`spend.set` dedup identity: two otherwise identical USD proposals that measured different coverage
now mint two cards rather than one, which is the wanted answer — a deduped card would show its
asker a coverage line that the ledger has since overtaken. A token-only proposal freezes no
coverage and its card and audit row are unchanged. Every card line is written about the moment the
card was posted, never the live present: a card lives 24 hours by default and the window rolls, so
a present-tense tick would be a claim about now made from a day-old read. It is **evidence, not a
prediction**: it names models the scope has already run on, and it cannot see a model the scope has
yet to use — so a scope with no traffic in the window yields *no traffic*, which the card and the
audit row both state as its own answer rather than as a clean bill. Two gaps get two
remedies, and the card keeps them in separate lines: a named model with no rate is a pricing gap
you fix by committing the rate, while
`(unknown)` / `(unstamped)` rows are an instrumentation gap — nothing observed which model ran, so
there is no rate to commit. The audit row keeps them apart under the same two names,
`unratedModels` and `unobservedModels`. And a **criteria domain** (`dm`, `public`, `org`) reports *not
measurable* rather than "no gap": membership there is decided per turn from the session's mode and
trust, which a usage row does not record. A token cap is unaffected throughout — tokens are counted
for every call, priced or not.

## Setting a budget

Caps are **config-as-code** — the same posture as access grants: budgets live in your git repo, reviewed by PR, no dashboard. A cap does still move at runtime, but only as an audited [runtime override](#break-glass-on-spend--a-narrowing-bridge), never as an untracked edit. That override stays on the drift worklist until somebody clears it, and an expired one stops applying but is still listed. The registry is `agent/spend/budgets.ts` in the deployer app (the same seam pattern as memory domains and webhook triggers; it's validated at import time — a malformed entry, a typo'd field name, or a non-positive amount fails the build rather than silently never enforcing). You set a default cap and, optionally, per-workspace, per-domain, and per-surface entries; the **narrowest configured entry wins** for a given scope — `perSurface` → `perDomain` → `perWorkspace` → `default` — and every component that entry sets is enforced:

```ts
const budgets: SpendBudgets = defineSpendBudgets({
  default: { surfaceMonthlyUsd: 25, workspaceMonthlyUsd: 200 },
  perDomain: {
    dm: { surfaceMonthlyUsd: 5 },      // every internal DM, without listing them
    public: { surfaceMonthlyUsd: 2 },  // every externally-shared/guest surface
  },
  perSurface: {
    "slack/T123/C_FIREHOSE": { surfaceMonthlyUsd: 100, surfaceMonthlyTokens: 50_000_000 },
  },
});
```

`perDomain` is keyed by a **memory domain name** (see [memory & domains](../capabilities/memory.md)), not a platform key — it's the "a fixed cap that applies across all domains/DMs with no manually-overridden value" case: a surface resolves to exactly one domain (its explicit `reach` membership, else the `dm`/`public` **criteria domain** it classifies into — an internal DM → `dm`, an external DM or externally-shared/guest channel → `public` — else no domain at all), so one `perDomain` entry reaches every qualifying surface without enumerating them. It sits narrower than `perWorkspace`/`default` and wider than `perSurface`. A winning `perDomain` entry's fields apply exactly like any other layer's — `surfaceMonthlyTokens`/`surfaceMonthlyUsd` compare against **each qualifying surface's own** ledger individually (a repeated per-surface default, not one pool shared across the domain — a shared pool across a whole workspace is what `perWorkspace` already gives you).

Caps are **empty (uncapped) until you set them** — Open Everywhere never invents a budget for you. Fill the config in to turn enforcement on.

## How a cap is enforced

Before starting work for a scope, Open Everywhere checks the scope against its effective caps. If no cap is configured, the check returns immediately without even touching the stores (the fast path). If a cap exists, it compares the month's surface and workspace totals — tokens against token caps, estimated $ against USD caps — and returns the **narrowest breached cap first** (surface before workspace) with a human-readable reason:

> this channel reached its monthly budget (5,100,000 / 5,000,000 tokens)
>
> this channel reached its monthly budget (~$26.10 of $25.00)

An over-budget scope **declines the new request** rather than truncating context or quietly producing worse output. The check runs at every **unattended** entry point — the three places spend can originate with nobody in the room: a scheduled [routine](../capabilities/proactivity-and-routines.md) fire is declined at dispatch (recorded as `skipped`, schedule advanced, an audited `routine.skip` row rather than a post — a proactive decline has no asker to answer), an **event-triggered** routine fire is declined per matched routine before it wakes a session (same audited `over_budget` skip; the delivery itself is simply not acted on — an event has no "later"), and an inbound **webhook** fire is declined before it ever reaches dispatch. On the **attended** side the gate runs on **every** surface's inbound mention — Slack, Discord, Teams, GitHub, Linear and Notion — which is dropped with a posted reason naming the scope key an override must target.

A surface reaches the agent by two different routes, and both are gated. Its **native** leg (that surface's own mention handler) gates at its own ingress; its **cross-surface window** leg — the one that carries a mention into a domain's shared context window — gates at the *divert*, the single point every windowed wake from every surface passes through. That matters because on several surfaces the window leg deliberately *bypasses* the native handler (the native mention is suppressed so the shared-context session can answer instead), so a gate on the native leg alone would never see it. Both write a `spend.gate` audit row; the row's `door` says which one refused.

**A widget click that resumes a parked turn is gated too.** When the model calls `ask_question`, or the framework's own session-limit prompt parks a turn, a click on the resulting Slack or Teams widget resumes that turn — the same spend commitment as a fresh mention, taken through a button instead of a message. The framework hands that click to Open Everywhere's own code before it resumes anything, and that code runs the same gate first, door `answer`, ahead of the separate check for *who may answer* (see [Security model — approval gates](./security-model.md)). A decline leaves the request pending, exactly like a refused answerer — the framework offers no way to cancel it. A room-message answer to a delegated worker's question is gated earlier still: it arrives through the ordinary cross-surface divert above, so it already crossed the gate before the answer decision runs.

The gate is deliberately **pre-flight per unit of work**, not mid-turn: a turn's cost isn't knowable before it runs, and killing a session mid-turn is exactly the truncation the posture forbids. So the turn that crosses a cap completes, and the *next* mention / routine fire / webhook fire on that scope refuses — worst-case overshoot is one turn's spend.

Two fail postures, precisely distinguished: the **check fails open** — if the budget check itself errors (a store read fails), work proceeds; a broken bookkeeping query must never brick the agent. But a **definitively-computed over fails closed** — there is no "try anyway" path past a real breach *for non-admins*; the ways forward are the month rolling over, a config PR, an admin-approved override (below) — or being the admin (next paragraph).

**Admins bypass the inbound gate, visibly.** The cap is a runaway-cost guard on ambient/team usage, not a security boundary — its failure mode is "the team burned $X without noticing", never "the budget owner deliberately spent". So an over-budget **mention** from an admin over that scope — the config roster (org admins, or the covering domain's admins), or on Discord a REST-verified guild administrator/owner — proceeds with a posted `⚠️ … proceeding because you're an admin` warning and a `spend.cap_bypassed` audit entry, instead of the decline. The warning is throttled to **once per surface per hour** (an admin working through an over-budget channel isn't nagged per message); every bypass writes its audit row regardless — the throttle is UX, never accountability. Sudo semantics: visible, audited, and the admin can raise or clear the cap right there in-channel. The bypass check itself fails **closed for the grant** (any error in it means no bypass — the normal decline runs); it applies only to inbound mentions, never to routine or webhook fires (proactive work has no sender to hold accountable) — a property enforced by the dispatchers not consulting the bypass at all, and asserted in the test suite rather than left to convention. Slack's only admin evidence is the config roster; its payloads carry no workspace-admin standing.

**DMs are capped like anything else.** They used to be exempt outright — every DM turn left the gate before a single cap was read — which made a `perDomain["dm"]` entry a budget that was visible everywhere and enforced nowhere. It is enforced now. A DM's own `perSurface` cap, the `perDomain["dm"]` default, and the workspace cap its spend rolls into all decline a DM turn.

Since a DM surface is 1:1 with a person, and `perDomain` applies its surface-shaped components to **each** member surface individually rather than pooling them, `perDomain["dm"]` is the straightforward way to say *"every person gets their own monthly budget"*: two people never share it.

### Budgets on a person

`perUser` puts a budget on a **person** rather than a place — an allowance for everyone, plus a named override for individuals:

```ts
const budgets: SpendBudgets = defineSpendBudgets({
  perUser: {
    default: { surfaceMonthlyUsd: 5 },          // every user's own DM: ~$5/month each
    overrides: {
      "slack/T0AB1CD2E/U0123ABCD": { surfaceMonthlyUsd: 50 }, // …except this person
    },
  },
});
```

It is keyed by a **qualified principal key** — `platform/<id>`, plus the workspace rung on a tenant-scoped platform (`slack/<team-id>/<member-id>`), the same spelling admin rosters and credential bindings use — and enforced against that principal's own rows in the spend ledger — the `(surface, principal)` keyed sum the ledger has carried since caps stopped reading `usage_events`. Scope is their **DM**: what this person may spend talking to the agent one-to-one, not their usage everywhere. Both denominations are supported; only the surface-shaped fields (`surfaceMonthlyTokens` / `surfaceMonthlyUsd`) are accepted, and a `workspaceMonthly*` written there fails the build rather than sitting in the registry enforcing nothing.

What is actually new here is **addressability**, not per-person budgeting: `perDomain["dm"]` above already gives every person their own repeated budget, so `perUser.default` is close to a restatement of it. What was never expressible is *one named person's* allowance — that would have meant `perSurface["slack/T…/D0BF…"]`, keyed on an opaque DM channel id nobody can read off a human. `overrides` is keyed on the person.

**It is an independent constraint, not a fourth layer.** A turn is over budget if the person's budget trips **or** the surface's **or** the workspace's — all three are checked. Slotting `perUser` into the narrowest-entry-wins ladder would mean that granting someone an allowance *silently switched off* the cap on the room they were sitting in. Person and place are different axes.

A **routine's** spend counts against **its creator's** allowance, because that is who the ledger already charges — a fire is bound to its creator precisely so the ledger, the audit trail and an approval card can say whose it is. So an override raises what that person's own routines may spend. It widens nothing else: the surface and workspace caps are checked on the same turn, and a fire gets no admin bypass, so it stays bounded from two directions no per-user entry can move. And it grants no *authority* — the fire holds none of its creator's admin standing, which is a separate fence.

**A per-person allowance is also raisable at runtime**, like every other scope. `set_spend_limit` (and `clear_spend_limit`) take `level: "user"`, whose scope key is the person themselves — `user:<principal-key>`, e.g. `user:slack/T0AB1CD2E/U0123ABCD`. It defaults to whoever is asking ("my own allowance"); to propose a change for somebody else, name their key. The override overlays this registry component-wise and expires back to it, exactly like a surface or workspace bridge, and config-as-code stays the permanent home — a bridge you want to keep belongs in `perUser.overrides` via a PR, keyed on the same person (drop the `user:` marker: `user:slack/T1/U1` reconciles to `"slack/T1/U1"`, which is exactly the form `overrides` takes — no translation step).

> **A bare id is refused at load.** `overrides` used to also accept an unqualified native id (`"U0123ABCD"`), and that was a live bug rather than a legacy convenience: an id with no namespace matched *every* connected platform's id of that spelling at once, so a Discord user could collect a Slack user's allowance on any deployment running both. The registry now takes the qualified form only, and the build fails with the exact replacement string if it finds a bare one. There is deliberately no compatibility path that strips the platform back off — that is the one direction that fails open.

> **A per-user cap needs an ORG ADMIN to approve — a domain admin cannot.** This is the same bar a *domain*-level cap carries, for a sharper reason. Everywhere else, letting the room's own admins decide is safe because the room is both beneficiary and witness: a self-serving raise is visible to the people who approve it. A per-person cap breaks that pairing — the person whose allowance moves is not in the room the card lands in, cannot see the card, and is the only party with a real stake (a raise lands on the org's bill; a cut quietly degrades one named individual's service) with no seat at the decision.

**Who has an allowance is now readable**, which it was not before: `spend_report` at `scope: "org"` lists every per-person allowance — config-declared and live-override alike — with which layer each came from, and the control plane's spend view carries the same inventory. Surfaces and workspaces are places, and a person is neither, so until this existed the only way to learn a per-user cap existed was to be stopped by one. That roster is deliberately **org-scope only**: `scope: "domain"` is "anyone in the domain", and a list of named individuals with what the org has decided about each is not that audience's business.

**The escape hatch moved, it didn't disappear.** The exemption's real job was avoiding a lockout — when every channel is over cap, the DM is where an admin goes to raise it. That job now belongs to the same **admin bypass** described above: an org admin's own DM turn proceeds past the cap with the visible `⚠️` and a `spend.cap_bypassed` audit row, so the escape is *observable* rather than silent. (In a DM the roster leg reduces to **org admin** specifically, because a DM resolves no covering domain for a domain admin to be an admin *of*.) The bypass is consulted only by the inbound gates, so an admin's own **routine fire** into a DM gets no escape and is declined like any other proactive fire — an unattended spend loop is exactly what the cap is for.

A non-admin declined in their DM is told so, with the remedy that actually works from there: ask an org admin, and the message names the key that raises **the cap that actually bit** — the person's allowance key for a per-user breach, this conversation's key for a surface breach, the workspace key for a workspace breach. It offers **only** keys that would unblock them: a refusal over a channel's own cap no longer hands out the workspace key, because raising the workspace cap leaves the channel cap biting. The layer itself is named once, by the reason sentence the cap check writes; the refusal adds no second claim about whose budget stopped you, and a group DM can never breach the person axis at all (that axis applies to one-to-one DMs), so a group-DM refusal always points at the room's cap or the workspace's. `set_spend_limit`'s `level: "surface"` now also works from a DM (it targets that DM, which is a real enforced scope); `level: "domain"` still needs an explicit name, because a DM's default domain is the criteria layer spanning *everybody's* DMs.

**Every refusal names the cap that stopped it.** With three independent candidates — the person's, the surface's, the workspace's — "you're over budget" identifies nothing, and the three are three different asks with three different scope keys and (for the per-user one) a different approver. So each decline states the layer, the scope key the cap is declared on, and the spent-vs-cap pair: *"you've reached your own monthly budget — the per-user cap on `user:slack/T1/U1` (12,400 / 10,000 tokens)"*, versus *"this channel reached its monthly budget — the per-surface cap on `slack/T1/C1` (…)"*. The same distinction rides the unattended paths: a declined routine or webhook fire records the naming reason on its skip row.

**Runtime overrides come in four levels: surface, workspace, domain, and user.** `set_spend_limit`/`clear_spend_limit` (the in-chat approval-card bridge) target a `"surface"` or `"workspace"` scope key, a `"domain"` level keyed by the **domain's own name**, or a `"user"` level keyed by the **person** (`user:<platform>/<id>`). A domain-level override overlays the *surface-shaped* cap components for every surface that resolves to that domain, the same convention a config-as-code `perDomain` entry uses. When more than one PLACE level is active, the narrower always wins: workspace → domain → surface, applied widest-first.

The **user** level sits outside that ordering entirely, because the person axis is an independent constraint rather than a rung on the place ladder: a user-level override overlays only the `perUser` allowance, and can never widen — or narrow — the cap on the room somebody is sitting in. (The control-plane MCP write currently exposes `surface` and `workspace` only; `domain` and `user` are proposed through the in-chat pair, which is where their approval bar lives.)

Two deliberate asymmetries in who can approve: a **domain-level** override is **org-admin only** — a domain's own admins (its leads) cannot approve a change to their domain's spend ceiling, the same way a domain admin can't touch a workspace-level cap — and a **user-level** one is org-admin only for the sharper reason given above: the person it is about has no seat in the room deciding it.

## Session cost checkpoints (a soft control)

The monthly cap above is a **hard** ceiling on a scope's *total* spend. A **session checkpoint** is a softer, complementary control aimed at a different failure mode: a single conversation that quietly runs up a large bill — a long autonomous coding session, a runaway agent loop — without anyone deciding to let it. When a session crosses a configured per-session threshold, Open Everywhere **pauses only its consequential actions and asks a human "keep going?"** — it never blocks reads or replies, so the agent stays conversational while its effectful hands are held.

Checkpoints are **config-as-code** in `agent/spend/checkpoints.ts` (the sibling of `budgets.ts`, same import-time validator posture), and **empty by default** — nothing is checkpointed until you set a threshold, so there's no behaviour change out of the box. You declare per-session thresholds in any of three denominations, layered `perSurface` → `perDomain` → `perWorkspace` → `default` exactly like budgets (narrowest configured entry wins):

```ts
const checkpoints: SpendCheckpoints = defineSpendCheckpoints({
  default: {
    sessionTokens: 5_000_000,     // pause consequential actions after ~5M tokens in one session
    sessionModelCalls: 200,       // …or after ~200 model calls (the closest durable analogue to "turns")
  },
  perDomain: {
    public: { sessionUsd: 2 },    // a guest/externally-shared session: confirm past ~$2
  },
});
```

`sessionModelCalls` counts usage-event rows (model calls / agent steps), not user-visible turns — Open Everywhere keeps no per-turn counter, and the field is named for what it actually measures. `sessionUsd` prices the session's rows the same evidence-only way `session_cost` does, so a deploy whose models aren't priced never trips a `$` checkpoint (use tokens or model-calls there).

**What "soft-gates consequential actions only" means.** The checkpoint is enforced at the top of each **gate:member** consequential tool's execute (`open_pull_request`, `create_skill`, `create_routine`, `purge_memory`, `request_access`, `cancel_routine`, `delete_skill`) — the [consequence classification](../how-it-works/agent-and-loop.md) decides what counts. Reads, replies, reactions and status updates are never gated, so past the threshold the agent can still answer questions and read context — it just can't open a PR or erase memory until someone confirms. **gate:admin** control actions (`set_spend_limit`, `clear_spend_limit`, `revoke_connector`, `clear_connector_override`) are deliberately **not** checkpointed: those are the very actions that raise the limits or fix the controls that would unblock the session, so soft-blocking them would dead-lock the operator out of their own escape hatch.

**How the pause works.** The crossing is caught at a tool-execute boundary — the only place Open Everywhere can pause a live session and redirect the model mid-turn (an observe-only hook cannot abort the loop; the pre-flight monthly gate can't fire mid-session). The tool call returns a recoverable "paused, awaiting a keep-going confirmation" message the model reads and works around, and a **confirmation card** posts once to the channel (Slack/Discord). A member approving arms a **session-continue grant** and every subsequent consequential action in that session proceeds; declining leaves the soft-block in place (no card spam on later attempts). The grant keys off the session's window token, so it lasts until the window rotates or `approvals.checkpointTtlHours` (default 24 h) lapses, whichever comes first. The card names that clock before the click. The next fresh session re-evaluates from zero. Each step is audited: `checkpoint.trip` when the pause fires, `checkpoint.continue` when a member approves, and the approval plane's `approval.rejected` (kind `session.checkpoint`) on a decline. Where no approval-card path exists (a surface that can't post a card), the checkpoint fails **open** — a soft control must never dead-end an action it can't offer a way to unblock — and records the crossing; the hard monthly cap still binds there independently.

**Approving a job's checkpoint is a decision, not a daily reprieve.** A **durable job**'s fires all resume one session, so its cost only accumulates and its grant memo's key never rotates. Under a wall-clock TTL that made approval meaningless: the memo lapsed, the job paused again on a total that was now strictly higher, and it did that once a day forever. So a **routine fire's** continue grant carries **no expiry**, and the cost at the moment of approval becomes the **approved mark**. The next card fires only when the session spends **a fresh threshold's worth on top of that mark** — the control keeps its teeth against a runaway job, and a member who approved once is asked again only about spend they have not seen. Approving that second card sets a new mark. **The card says this before the click** — a durable session's card carries the sentence "this job keeps one running total, so approving sets a mark rather than a timer… and the approval does not lapse on its own", so nobody grants a non-expiring approval the card did not describe. A **live** session is untouched: its grant is unconditional until the window rotates or its TTL lapses, whichever comes first, exactly as before. Which rule applies is decided by the **grant**, not by who is speaking — a person replying inside a job's own thread reads the job's memo, so that turn is held to the job's rebase rather than handed an unconditional grant with no expiry. A *declined* job keeps the TTL on its "asked" marker, which is what lets it be asked again rather than being paused for good.

**When nobody is in the room: a checkpoint on an unattended fire.** Everything above assumes a human is present to answer. A [routine fire](../capabilities/proactivity-and-routines.md) has nobody, by construction — and a durable job makes that permanent rather than momentary, because all its fires share one session: its cost only accumulates, so once it crosses a threshold every later fire is paused again until someone approves. The card still posts, but a paused fire would otherwise be *invisible* — it finishes cleanly (a paused tool is a recoverable error the run works around), so nothing counted it as a failure and nothing reached `complete_job`. So each paused fire is now recorded on the routine itself: `list_routines` reports `blocked on a cost checkpoint: 2/3 runs`, a `routine.stalled` audit row names the refused tool, and after **three paused fires in a row** the job stops itself with a notice saying it was *blocked* — pointing at this card, not at a re-arm. Clear the checkpoint (approve, or raise the threshold for that scope) before re-arming, or it stalls again. A *stateless* routine needs none of this: it gets a fresh session per fire, so its crossing dies with that fire.

## Per-event usage capture

The monthly ledger above is the caps-checking aggregate — keyed monthly sums, no
timestamps and no session dimension, because that's the shape budget enforcement needs.
Alongside it, every model call also appends a row to an **append-only** `usage_events`
table: org, surface,
session id, principal id (when known), a timestamp, token counts, and a best-effort
**kind** — `channel`, `dm`, `routine`, `supervisor`, `subagent` or `unclassified` (a
routine-fired session carries the dispatcher's marker, so it's classified correctly even
though its surface binding otherwise looks like an ordinary channel turn). `unclassified`
is a turn whose conversation nothing could resolve: the tag is read as the report mask's
legacy fallback, and `channel` there means "the binding resolved a room", never "we had to
pick something". This is the row-level sibling the
ledger deliberately never kept, and it's what per-session cost, per-domain/per-org rollups,
per-user analytics, and routine cost prediction are all built on.

**Delegated work is filed under the conversation that delegated it.** When a session hands
work to a [declared subagent](../capabilities/skills-and-plugins.md#declared-subagents-the-specialist-unit),
the child's model calls are written by the same hook (subagents must author their own
`hooks/spend.ts` — hooks aren't inherited across Eve's isolation boundary) and file under
the **parent's** session id, carrying the child's own identity in the row's detail. Two
things follow. Your conversation's cost stops under-reporting by exactly what it delegated
— a child's session id is minted per run and nothing ever queries it. And a delegated run
becomes something the *host* can observe: the [PR walkthrough](../capabilities/pr-walkthrough.md#whether-an-independent-reviewer-really-ran)
reads these rows to state whether an independent review actually ran, rather than asserting
it. A subagent asking what *it* cost still gets only its own rows.

A **`sandbox`**-kind row (runtime seconds, no tokens) is appended by the stop-after-turn
sandbox hook each time it stops a **metered** VM, so a session's compute time shows up
alongside its model spend — see [Sandbox](../extending/sandbox.md) for the stop-after-turn
mechanic itself. Vercel is the metered backend: it bills provisioned memory by wall clock. A
self-hosted `docker` container has no per-second bill, so its stops write no row at all —
pricing them at Vercel's rate would invent a charge that the USD caps then enforce. The same
metered stop also writes the runtime's estimated $ into the **spend ledger**
(model-less, token-less, `usd_micros` only), which is what lets the monthly USD cap see
sandbox burn. Both rows carry the same **principal and routine attribution** as the
session's model rows — a routine fire's sandbox time bills its creator, and a person's
`perUser` budget counts their sandbox dollars, not just their tokens.

A **`meeting`**-kind row (OPE-2459) records one meeting bot's box hours, with no tokens. It is written
once per meeting, when the bot sends `ended` or the cap sweep finishes a meeting that never did, beside one spend-ledger row
(`usd_micros` only), attributed to the person who asked. On Vercel the dollars are the box's memory
GiB-hours at `spend.sandboxGiBHourUsd`; on docker the row records the hours at $0. Transcription and the
recap's model call are not in it. See [Meetings](../capabilities/meetings.md#governance).

A **`browser`**-kind row (OPE-2441) records one session of a person's browser box, with no tokens. It is
written once per box session, when the box closes (the person or the agent closed it, it idled out, it hit
its cap, a halt, or it stopped answering), beside one spend-ledger row (`usd_micros` only), attributed to
the person. On Vercel the dollars are the box's memory GiB-hours at `spend.sandboxGiBHourUsd`; on docker
the row records the hours at $0. The model calls that drive the browser are ordinary token rows. See
[Personal browser](../capabilities/personal-browser.md#governance).

🔴 **Retention: the default store deletes no usage row.** The `spend.usageEventsTtlDays` typed
setting (default 90) sets the cutoff for a prune that runs on roughly 1-in-20 writes (the same
amortized-cost idiom the event-dedupe table uses). Only the deprecated SQLite floor deletes rows
with it. The zero-wiring default is the embedded-Postgres (PGlite) floor, and a `DATABASE_URL`
selects hosted Postgres. Both use the Postgres adapter, where the prune issues no SQL and returns
0. **Under Postgres this is a documented no-op**: `usage_events` carries `SELECT` + `INSERT`-only
policies under `FORCE ROW LEVEL SECURITY`, so on hosted Postgres `DELETE` is denied even to the
non-superuser table owner the app connects as — the same append-only posture that protects the
audit log. That is deliberate: a trustworthy per-session/per-user cost trail is worth more than
the ability to prune it from the app role. ⚠️ **On the PGlite floor the database does not enforce
that denial.** The floor has one role, and PGlite's default session role is a superuser, which
bypasses even `FORCE`. There the no-op is a choice of the app's code, not a property of the
database. Real long-term retention on Postgres therefore needs a maintenance path *outside* the app role
(a migration-role-owned `SECURITY DEFINER` prune, or a superuser job) — the same escape hatch
audit-log tamper-prevention relies on. On the PGlite floor, with its one role, the operator's own
job on the database does the delete. This tree ships no such path. Retention is the operator's
own control, set on the database. The `spend_ledger` table is the same: no code path in this
tree deletes a `spend_ledger` row, on any store. On a two-role Postgres deploy the runtime role
also holds no `DELETE` on it. A new calendar month writes new rows under a new `period` key
rather than removing the old ones.

## The ledger row, dimension by dimension

`SpendLedgerKey` fixes what one ledger row is attributed to: the surface key, the acting principal,
the routine, and the model priced against. 🔴 **An absent dimension is the empty string, never
null.** A Postgres primary-key column cannot be null, and a nullable unique index would silently
break the upsert-and-add dedup — two null-keyed writes would insert two rows instead of summing into
one. So `''` means unattributed, and the model column additionally carries an explicit unknown-model
sentinel when a token-bearing model call reaches the ledger with no model named.

`SpendLedgerRow` holds what accumulates against that key: input, output, cache-read, cache-write and
reasoning tokens, the derived micros, the gateway-measured micros, and the call count. Reasoning
tokens are attribution only — they never enter the dollar figure.

`SpendLedgerWrite` is one increment. Omitted dimensions default to the empty string and omitted
amounts to zero, and every write adds one to the row's call count. 🔴 **The cost source defaults to
`derived`**, so a row never claims a measurement it did not get. An omitted or zero measured-micros
value means nothing measured it.

`SpendTotals` returns **both** sums — derived and measured — over a keyed prefix. That pair is what
every cap compares against.

Three store methods carry the runtime overrides: `setSpendLimit` upserts one at a scope and level,
replacing any previous row whole. `clearSpendLimit` removes one and reports whether a row existed.
and `spendLimits` returns an org's rows — the read both the gate and the report consult.

### The per-model-call usage events

`usage_events` is the append-only per-model-call log, carrying the session id and timestamp
dimensions the ledger deliberately does not keep.

- **`UsageEventInput`** lets a zero-token row omit its timestamps and counts. The append defaults
  them.
- **`UsageSummaryRow`** rolls the log up by surface, principal, kind, routine and model, with the
  reported call counts beside the sums.
- **The gateway generation id** is stamped under one shared detail key, named once for the writer
  and every reader. It is what joins a ledger row to the gateway's own bill.

🔴 **Pruning means two different things on the two backings.** On **Postgres** `pruneUsageEvents`
does nothing, by design: the table carries `SELECT`-and-`INSERT`-only policies exactly as
`audit_entry` does, so on hosted Postgres `DELETE` is denied even to the non-superuser owner the
app connects as. On the PGlite floor the no-op holds too, but the app connects as a superuser, so
the database does not enforce the denial there. On **SQLite** it
really deletes rows older than the given instant, because there is no row-level-security engine
there and local retention holds by contract. 🔴 **A zero from the prune on Postgres means it deleted
nothing.** It issued no SQL, so a retention job that reads that zero as success has removed no row.
Retention on Postgres, PGlite included, is the operator's own job on the database.

### Delegation depth, and what it does not claim

A delegated child's usage rows carry a stamp — the call id, the session, the root session and the
depth — written by `stampSubagentRun` and read back by `subagentRunOf`, which answers nothing for a
legacy or hand-written detail shape rather than guessing.

🔴 **Depth tops out at two, and two means "two or more".** `delegationDepthOf` answers 1 when the
parent **is** the root, and the capped value otherwise. The runtime names only the immediate parent,
so the exact number of intervening hops is not observable. An absent root degrades to 1, because the
parent is then the deepest ancestor that can be seen — which is exactly what depth 1 asserts.

`attestSubagentRuns` turns ledger rows into an attestation, and there are **two states only — there
is no "probably"**. An `absent` answer always carries its reason, because "we did not look" and "we
looked and there was nothing" are different facts a reader is entitled to tell apart.
`readSubagentAttestation` reads a session's rows for that evidence, and a store failure is reported
as absence with a reason rather than raised as an error.

### The checkpoint memos

`SessionApprovalRow` holds the two memos a [session cost
checkpoint](#session-cost-checkpoints-a-soft-control) needs — the grant and the ask — keyed on the
bare session id or the window token. `setSessionApproval` writes the memo that both the block path
and the card click consult. `getSessionApproval` reads a **live** memo at an instant, so an expired
grant stops suppressing the checkpoint rather than suppressing it forever.

## Pricing: tokens to an estimated $

A small, **evidence-only** pricing table (`spend/pricing.ts`) turns token counts into an
estimated USD figure. A model id only enters the built-in table once its rate has been
verified against an authoritative source and cited in the code — never a plausible-looking
guess. An unpriced model shows **tokens only** ("unknown rate"), never a fabricated dollar
figure. The built-in table holds exactly one entry, naming the **shipped model stack's**
primary, whose rates were **measured from real Gateway bills**: completions with prompt sizes
swept across two orders of magnitude, solved for input/output rates against the `usage.cost` the
Gateway itself returns, and then **verified against a row the solve never saw**. Re-measure with
`npm run probe:models -- --rates`.

That verification step is not ceremony. A two-point solve always "fits", and some model ids do
not have a single rate at all: `deepseek/deepseek-v4-flash-0731` measured at **three** distinct
exact rates across eight otherwise-identical calls — $0.09/$0.18, $0.13/$0.26 and $0.14/$0.28 per
1M tokens — because the Gateway load-balances that id across upstreams that charge differently.
Two calls a second apart differed by 1.56×. The held-out check is what tells you whether "one
rate" was even the right shape of answer; where it is not, the honest report is a band.

> One gotcha for anyone building on the usage rows: the Gateway applies the **prompt-cache
> discount without populating `usage.cachedInputTokens`**, which reads `0` on a cached call. Cache
> savings appear in the cost, not in the token split.

That table must hold **exactly one** entry, and it must name the deploy's default model: it
doubles as the assumed rate for usage rows that carry no model stamp, so a second entry
silently disables that fallback and a stale entry silently misprices every such row.
`npm run lint:model-ids` enforces both.

**Your own rates go in `agent/spend/model-pricing.ts`** — config-as-code, beside the budgets
file, reviewed by PR:

```ts
const pricing: ModelPricingTable = defineModelPricing({
  "alibaba/qwen3-vl-instruct": { inPerMtok: 0.2, outPerMtok: 0.88 },
  "google/gemini-3.8-flash": { inPerMtok: 0.75, outPerMtok: 3.75 },
});
```

An entry here wins over the built-in table for that model id. The table is validated at import
time — a bad id shape, a typo'd field, or a zero/negative/non-finite rate fails the build rather
than silently never pricing. `cachedInPerMtok` is optional; omitting it prices cached reads at
the full input rate, which can only overstate a cost.

**Pricing coverage is a gate on the `test` chain, and it is unconditional.** `npm run lint:model-ids` derives
every model id this config can select — all five roles of **every** shipped stack, not just the
one you run — and fails when any of them has no rate in either table. It fails whether or not
you have a USD cap configured today, because a cap is a one-line PR that somebody will add
without reading this page. The red message names the model id and the file to fix.

Researching a rate: the Gateway's public catalog (`https://ai-gateway.vercel.sh/v1/models`, no
auth) is a fine starting point, but it is **not** the number to commit. It has been wrong for
every id this project has measured — for `deepseek/deepseek-v4-flash-0731` it publishes one rate
for an id that bills at three (above). Measure with `npm run probe:models` and commit the
measured number with its provenance. Where a rate is a band, commit the **maximum**: the only
direction a cap may err is the one that cannot understate spend, and `lint:model-ids` cross-checks
each committed rate against the band in `spend/stack-pricing.ts`.

There is **no live catalog fetch and no pricing env var.** Both were removed once every
selectable model had to carry a committed rate: a fetched rate can disagree with what you are
actually billed, and a JSON blob in an env var is invisible to review. Pricing resolves
synchronously from code, so a report can never render a priced model as unpriced because an
instance is cold.

**Why the reporting tools sometimes have to *assume* a model.** Hook-written usage rows
don't carry a `model` field (`step.completed` doesn't expose one in this Eve version), so
turning a row's tokens into a dollar figure means assuming which model priced it. The
reporting tools resolve this the same way everywhere: an explicit `assumedModelId` input
always wins; otherwise the **built-in table's single entry** is assumed — but only when that
entry is also the model this deployment actually runs as its primary. Both conditions matter.
A built-in table with several entries gives no way to know which one a given row used. And a
single entry naming a model the deploy no longer runs would price every stampless row at the
wrong model's rate, permanently, since a ledger row's dollars are written once.

So a deployment that selects the other shipped stack (`models.stack`), or
pins its primary with `models.force` / `models.primary`, gets **no** assumption: those rows
show tokens only, and the tool's `note` says so plainly. Pass `assumedModelId` explicitly to
price them, or move the built-in entry to the model you run.

**Sandbox cost is priced separately, always shown — and cap-enforced.** A sandbox's $
comes from Vercel Sandbox's published Provisioned Memory rate ($/GiB-hr), verified twice
— against the published pricing page and against a real Vercel bill that matched it to
the cent (see the sandbox cost-model build notes). Unlike model pricing, this always
resolves (it's a platform constant, not a per-model unknown), and since OPE-266 it also
feeds the spend ledger's `usd_micros` at each sandbox stop, so USD caps count runtime,
not just tokens. It stays an **estimate**: it assumes every sandbox ran at the
configured/default memory size — override the assumed size or rate with
`spend.sandboxMemoryGiB` / `spend.sandboxGiBHourUsd` if a deploy pins a non-default
sandbox size.

## What refuses at config load

A budget that is silently unenforced is worse than no budget, so the shapes are validated when the
config loads rather than when a cap would have tripped.

`assertSpendBudgetsValid` walks the whole registry. A `perWorkspace` key must be
`platform/workspace`, a `perSurface` key `platform/workspace/surface`, and a `perDomain` key a
non-empty domain name. Every configured amount must be a positive finite number. **An empty registry
is valid** — empty means uncapped, and Open Everywhere never invents a budget.

🔴 **The person axis refuses two key shapes, for two different reasons.** A `perUser.overrides` key
must be a **qualified** principal key such as `slack/U0123ABCD`. A bare native id names no namespace,
so one entry would alias every platform's id of that spelling. A key carrying the runtime override's
own `user:` scope marker is a scope address rather than a config key, and accepting it would give a
deployer an entry that looks reconciled and matches nobody. Both errors compute the exact
replacement string, because the remedy is a one-line edit. `perUser` itself admits only `default`
and `overrides`: a plural typo would otherwise be an allowance nobody ever receives, and no amount
of reading `spend_report` would show that.

`assertSpendLimitAmount` guards a **runtime** override instead. It rejects an override that sets
neither a token cap nor a dollar cap, a token cap that is not a positive integer, and a dollar cap
that is not a finite number above zero. The non-positive check is load-bearing rather than tidy: the
SQLite adapter encodes "no token component" as `-1` in a legacy `NOT NULL` column, so a genuine
negative limit must never reach storage.

`assertSpendCheckpointsValid` applies the same scope-key rules to
[session cost checkpoints](#session-cost-checkpoints-a-soft-control), and `assertCheckpointShape`
runs at import: it refuses an unknown checkpoint field, an entry that sets no threshold at all, and
any threshold that is not a finite number above zero. An empty checkpoint registry stays valid.

**A missing app config is not an error.** `loadBudgets` and `loadCheckpoints` both answer an empty
registry when no app config is registered — the standalone ops tooling case. That reads as "no
config caps" and "nothing is checkpointed", never as a failure. `activeSpendLimitsForOrg` has the
same posture for the batch readers: it fetches an org's active overrides once and fails soft to an
empty list. 🔴 Read an empty override list as "every scope falls back to its config-as-code cap",
never as "no cap at all". `checkpointConfigured` answers whether any component is set, so an
unconfigured scope pays no store read.

### How the ledger read is filtered

`spendLedgerConjuncts` assembles the `WHERE` clause for **both** ledger reads — the sum and the list
— from one definition, so the two backends' filter semantics cannot drift. It covers the exact
surface key, an escaped surface-key prefix, the period range and the cost source.

🔴 **The prefix is escaped, and the escape character is declared.** `likePrefixPattern` escapes the
`LIKE` metacharacters, so a literal `_` or `%` inside a workspace key matches itself and cannot widen
the read into another workspace's rows. The `ESCAPE` clause is stated explicitly because SQLite has
no default escape character while Postgres defaults to backslash. Stating it keeps the two engines
byte-identical.

### What the pricing table refuses, and which ids the coverage gate checks

`assertModelPricingValid` fails the config import on a malformed model id, an unknown field, or a
rate that is not positive. `defineModelPricing` type-checks a deployer's rate literal at the config
site, so a mistyped field fails where it was written rather than at first use.

Four enumerations feed the build-time coverage gate, and each answers a different question:

- **`builtInModelIds`** — the ids the shipped table prices. It is the assumed-model candidate set,
  and it deliberately excludes deployer entries.
- **`deployerPricedModelIds`** — the ids a registered deployer table prices, for the coverage lint's
  message.
- **`selectedStackModelIds`** — every model id every named stack selects, so an unpriced role is a
  red build rather than a surprise in the ledger.
- **`routePinnedModelIds`** — the concrete ids the domain and role config layers pin.

`unpricedModelIds` then reports which of those this deployment has no rate for, resolved through
**the same lookup a spend write uses** — so the gate and the ledger cannot disagree.
`stackPricedModelIds` lists the ids the measured band table covers.

**Sandbox time is priced from two settings, not a table.** `sandboxMemoryGiB` reads the memory size
to price against, and `sandboxGiBHourUsd` reads the hourly rate. Both live in the behaviour schema,
so the evidence and the value it justifies move in the same diff. Unlike a model rate, there is no
unpriced case here.

### The coverage a cap proposal states before it is approved

A dollar cap can only count models the deployment can price, so a proposal says what it would miss
**before** anybody approves it.

`contributesZeroUsd` restates the ledger's zero-dollar rule as a predicate: a named model with no
rate contributes nothing, and so does a scope with no assumable model. `unpricedModelsForScope`
reports the models a dollar cap on this scope would not count, and answers **not measurable** for a
criteria domain.

🔴 **The coverage read is only taken for a dollar proposal, and a failed read never reads as a clean
bill.** `readSpendCoverage` returns nothing at all when the proposal sets no dollar cap. When the
ledger read throws, it returns the same **not measurable** channel a criteria domain uses, and both
the card and the note then say the ledger could not be read. An empty model list with no
not-measurable marker is the positive answer — every model this scope ran on is priced — so the two
must never be conflated.

**The coverage window is 30 days, deliberately not the cap's calendar month.** The cap counts a
month. The coverage question is "what has this scope actually run on lately", and a fixed 30-day
window answers it on the first of the month as well as on the last.

`frozenCoverage` freezes the answer into one of four states — **full**, **gap**, **no traffic** or
**none** — splitting models that carry no rate from models that were never observed.
`SpendCoverage` carries those four states onto the approval card **and** its audit row, so the
approver and the trail read one frozen value rather than two independent reads.
`spendCoverageLines` renders the approver-facing sentence directly under the proposed figures, and
`spendCoverageDetail` records the same frozen value on the `admin.spend.set_limit` row's detail.

`unpricedCoverageNote` composes the sentence the asking channel hears. 🔴 **It names two remedies,
never one.** A named model with no rate is a **pricing** gap, and the remedy is to commit a rate. An
unknown or unstamped row is an **instrumentation** gap, and the remedy is to fix the stamping. A
note that offered only the first would send an operator to edit a price table that was never the
problem.

`currentCapsFor` reads the card's current cap as the effective caps per level. The person level
leaves the place ladder, because a person is not a place.

## Reading spend and usage

Three in-conversation agent tools read from `usage_events` (all `approval: never()` —
read-only):

| Tool | Scope | Shows |
|---|---|---|
| `session_cost` | This conversation only — no role required | Tokens, an estimated $ (if a model can be assumed), and this session's sandbox runtime seconds + estimated $. Includes what the conversation delegated to subagents, and says so in its note. |
| `spend_report` | `scope: "domain"` (anyone in a memory domain) or `scope: "org"` (org admin only) | Tokens + $ by surface and turn-origin kind, the existing monthly ledger totals — **tokens AND $**, per surface AND per workspace — against **effective** caps (config-as-code overlaid with any active admin override), and a routine-fired cost **projection** — see below. |
| `usage_report` | Same scope tiers as `spend_report` | Conversation count (an estimate — see its note), turns, a per-user activity breakdown, and the busiest surfaces, over a time window. Counts only, never a judgment — no per-user leaderboard framing. |

`scope: "domain"` is gated by resolution, not a list: your channel resolving to a memory
domain at all **is** the gate (the same "anyone in the domain" posture domain skills and
routine create/list/cancel use — see [Access & scoping](../how-it-works/access-and-scoping.md#roles-whos-an-admin)).
`scope: "org"` requires an org admin.

### What the report reads, and what it refuses to claim

Four store reads sit under every report. `spendRoot` reports the ledger's backing location, for logs
and admin views. `spendTotals` exposes an arbitrary keyed sum over one org's ledger. `spendRollup`
returns the org, surface and period lines — and 🔴 **omitting the org reads every tenant**, so name
one unless a cross-tenant answer is what you want. `aggregateSpendBySurfacePeriod` collapses the
cost-source rung while keeping measured micros and their derived shadow separately addressable,
which is what lets the drift note below exist at all.

**The attribution note never states a dollar figure, and a zero is not a measurement.**
`tokenAttributionNote` reports the token split alone. 🔴 **A zero cache total reads as
UNATTRIBUTED, never as "caching did not happen."** The note tells the two causes apart: no call
published a cache field at all, or calls published the field and every one read zero. In the second
case it names the Vercel AI Gateway by name, where a cached call is billed at the discount while the
cached-token count reads zero — so on that backend the saving shows in the cost and never in the
split. It is stated for that backend by name rather than as a fact about every deployment, because
the model backend is swappable and an operator told the wrong thing stops looking for a real gap.

**The drift note always names its denominator.** `costDriftNote` reads the gap between what the
gateway billed and what this deployment's rate table derived. It says how many of the calls in scope
the gateway actually measured, because a divergence figure without its coverage is not
interpretable, and it states that **the caps enforce the derived figure** — so a persistent
divergence is a rate-table correction to make, not a cap that is quietly wrong.

**Domain bucketing excludes direct messages by construction.** `domainOfUsageRow` buckets a usage
row by its explicit domain, answers nothing for a row of kind `dm`, and falls back to the `org`
pseudo-domain. `filterToDomain` keeps only the rows of one domain, for a scoped report.

🔴 **A day window is answered in calendar months, and the report says which.**
`periodsCoveringDays` names the months a window of N days touches — one or two for a 30-day window,
depending on where in the month it falls. The ledger's finest window is a calendar month, so the
scan **over-covers rather than under-covers** and reports the period names it actually summed. A
caller that printed "the last 30 days" without those names would be making a claim the ledger cannot
support.

### How a report protects the people who DM the agent

The store keeps full per-DM resolution. The **reports** collapse every DM surface into one `(dms)`
bucket per workspace, so a report posted into a channel never reveals which individuals DM the agent
or how much.

**Detection is the row's own stamp, never the shape of its surface id.** Every `spend_ledger`,
`usage_events` and `audit_entry` row carries `surface_mode` — the conversation mode the turn's own
binding resolved. `spend/dm-mask.ts` is the one road every spend and usage report takes, and all
three datasets of `query_analytics` take it too: a Discord snowflake and a Teams `19:…`
conversation id mask exactly as a Slack `D…` id does. No id shape is read in the report layer.
(A platform's own identity mapper may still read one — Slack falls back to the `D` channel-id
prefix when an activity carries no `channel_type` — but that sits upstream of the stamp, in the
layer entitled to know what a Slack id looks like, never in the mask.)

The audit record was the last table without the column. It carries one now, and the column joins
the record's hash chain only on a row that carries one — so the addition left every earlier row's
link intact, and rewriting a stored mode to publish an individual's conversation id breaks the
chain exactly as rewriting the surface does.

🔴 **One limit, stated rather than papered over.**

- **The stamp is only as good as the platform's own mode.** A mapper that cannot classify a
  conversation reports no mode, and the binding gap-fills `channel` so every other reader keeps a
  usable value. A gap-filled mode is NOT written to a row: the row is stamped only when the mapper
  resolved the conversation, so an unclassifiable turn masks rather than publishing as a room.
  The row's turn-origin tag follows the same rule and has to — the mask reads that tag as its
  fallback for rows older than the stamp, and a turn tagged `channel` there is published. Such a
  turn tags `unclassified`, so both of the mask's inputs agree.
- **A surface with no registered mapper resolves nothing at all.** A platform whose provider bundle
  is not installed, and the `local` dev platform, both fall back to the built-in stand-in, which
  reports no mode unless the deployment declares `OE_MODE`. Every row from such a surface is
  unstamped, tags `unclassified`, and masks. Declaring `OE_MODE` counts as a resolution — the
  operator has answered for the surface — and is the remedy on a dev instance whose reports should
  name their rooms.
- **On the `audit` dataset, only the per-action tool writer stamps the mode today.** Every other
  audit writer leaves it absent, so those rows mask. See
  [Analytics](../capabilities/analytics.md); OPE-1940 tracks stamping the rest.

🔴 **The mask fails closed.** A row nothing stamped cannot be classified, so its key is masked too —
into a separate `(unclassified)` bucket, never into `(dms)`, because reporting a channel's spend as
DM spend would be a false statement about where the money went. Rows read that way are the ones
written before the stamp existed (nothing is backfilled — the mode was knowable only from the turn's
binding, which no stored row carries) and any row whose writer had no binding. 🔴 **They do not age
out.** A new calendar month starts new ledger rows but deletes no old one, and the default store
prunes no `usage_events` row. They stay until the operator's own retention on the database removes
them.

**A group DM is not masked**, on any platform. A group is not an individual, and the bucket exists to
protect individuals.

**The turn-origin tag cannot answer this question, which is why the stamp exists.** A routine,
supervisor or subagent turn wins `kind` before the DM test runs, so a routine fired *inside* a DM is
stamped `kind: "routine"`. The mask still reads `kind` for rows written before `surface_mode`, but
only for its two conversation-bearing values (`"dm"`, `"channel"`); every other value is
unclassified and masks.

`resolveSlackLabels` resolves display labels concurrently, leaves DMs unlabelled, and swallows every
lookup failure — a missing label degrades a report, it never fails one.

**Two of the three aggregate figures are exact, and one is not.** `aggregateByUser` reports exact
per-principal event and token counts, dropping runtime (`sandbox`, `meeting`, `browser`) and unattributed rows. `aggregateBySurface`
reports the busiest surfaces by **event count**, which is exact. Its **session count** carries the
approximation caveat. `approxConversationCount` is where that caveat comes from: it approximates
conversations by summing grouped session counts and excluding runtime (`sandbox`, `meeting`, `browser`) rows. Read it as an
approximation, because that is what its name says and what the grouping makes it.

**Cadence projection is floored by the dispatcher, not by the trigger.** A projected fire rate is
capped at the dispatcher's own tick floor, so a trigger that asks for more than the dispatcher can
deliver does not inflate a predicted cost.

### The two report doors

`renderSpendReportForDm` renders the org spend report as plain direct-message text — the headline
figures and the over-cap surfaces — for a surface with no block formatting.

`session_cost` answers for one session, and it behaves differently for a delegated child. 🔴 **A
child reads its parent's rows and keeps only the rows stamped as its own**, so a worker reports what
it spent rather than what the whole delegation tree spent. `usageForSession` is the raw read beneath
both, returning one session's rows oldest first, and `generationIdOf` reads a row's gateway
generation id back — answering nothing for a row that carries none, which is every row from a
non-gateway deployment.

### The domain spend scan behind `/oe budget raise`

`/oe budget raise <usd>` proposes a cap. Proposing one against a guess is how a room asks for a
number nobody can justify, so the ephemeral acknowledgement carries the **requester's own domain's
recent spend**, read straight from the `spend_ledger`. The read needs **no admin role and no
privileged capability**: it is gated by resolution — your channel resolving to a memory domain **is**
the gate — which is the same gate `spend_report`'s `scope: "domain"` uses.

**It is reachable more widely than that tool, though, so do not read the two as equivalent.**
`spend_report` is a worker-only tool: a conversational seat gets it only by delegating to a worker an
access binding mounted it on. `/oe budget raise` is a slash command intercepted at the front, with no
bundle and no role check, so **any member of a resolving channel** can run it and read the figure.
There is no setting that turns the line off.

The scan is narrowed three ways, and the last two are properties of the returned shape rather than
promises about a caller:

- **Your own domain, and only it.** The domain comes from the requester's own binding — the command
  takes no domain argument — and the same resolution then decides which ledger rows are summed. A
  DM, a group chat, an externally-shared or unconfirmed channel, and an unassigned channel with no
  org-wide default domain all resolve to **no** domain, and the scan does not run. The
  acknowledgement then says which of those applies. It never renders an absent figure as `$0.00`,
  because a proposal answered by a zero would read as a clean bill nobody earned.

  **"Your domain" can be the `org` pseudo-domain, and that bucket is wide.** An internal channel that
  no explicit domain claims falls through to the `org` criteria domain, which this repo ships by
  default. The scan then sums every ledger row no explicit domain claims — every other unassigned
  surface, and DM rows too, because a `spend_ledger` row carries no turn `kind` and so cannot take
  the DM exclusion the usage-row reports apply. The figure is **org-scale**: it covers every surface
  no explicit domain claims, on every workspace and every platform this deployment serves.
  `/oe budget` shows a member **less** than this — it sums one workspace's prefix. The bucket is not
  new, because `spend_report`'s `scope: "domain"` already renders it, per surface. But do not read
  the line as bounded by the room or the workspace it was typed in. Put a channel in an explicit
  domain if you want the line narrowed to that domain.
- **An aggregate, and nothing else.** The scan returns one total for tokens, $ and calls, and the
  acknowledgement shows the $ total only (OPE-2486): `/oe budget` already shows the tokens. There is
  no per-surface and no per-principal breakdown, so nothing in the answer names a person or a room.
- **The cap ledger, never the observability log.** It reads `spend_ledger` — the durable, keyed
  table the caps themselves sum — so the figure the requester reads is derived from the rows the
  gate enforces against. It does not read `usage_events`.

**The window is whole calendar months, and the acknowledgement names them.** A `spend_ledger` row is
keyed by `period` (`YYYY-MM`), so the ledger cannot answer a rolling 30-day question at all — the
finest window it holds is one calendar month. The scan therefore sums the calendar months that the
last 30 days touch, which is one month or two, and names those months in words ("September 2026 and
October 2026"). It over-covers rather
than under-covers, and it never claims an exact 30 days the ledger could not support.

**The raise itself is unchanged.** The scan adds a sentence to the requester's own ephemeral
acknowledgement. It is not frozen onto the approval card — the pricing-coverage read above is on the
card because the **approver** needs it, while this figure is for the **asker** — and it changes
nothing about who may decide. A non-admin proposes; an admin still clicks Approve. A broken ledger
read is fail-soft in the same way the coverage read is: the proposal still posts, and the
acknowledgement says the ledger could not be read.

### Caps in the reports agree with the gate

`spend_report`'s `ledger.surfaces` and `ledger.workspaces` (and the control plane's
`spendView`, below) show the **same effective caps and the same $ arithmetic** the spend
gate (`scopeOverBudget`) enforces — the report and the gate can't disagree:

- **Effective, not config-only.** Each row's `tokenCap`/`usdCap` is config-as-code
  overlaid with any *currently active* admin override (`set_spend_limit`) — the same
  `applyCapOverrides` merge `effectiveCaps` does at the gate, just read once per org
  instead of once per scope. An expired override has already reverted to the config
  baseline in the report, exactly as it has at the gate.
- **`usd` is the gate's own evidence-only estimate**, not a separate calculation: the
  same per-row pricing (a row's own recorded model, or the deploy's sole assumed model
  as a fallback; never a guessed rate) that `scopeUsdSpend` uses. For the **current**
  calendar month, a surface's `usd` figure is *exactly* what the gate is enforcing right
  now. This ledger figure always uses the gate's own default assumed-model resolution —
  independent of any `assumedModelId` you pass for the rest of the same report (which
  only affects the `bySurfaceAndKind`/`totals` sections above it).
- **A past `period`** windows `usd` to that whole calendar month (not "since month start
  through now" — that phrasing only makes sense for the current month, which is all the
  gate ever evaluates).
- Each row also carries `tokenOver`/`usdOver`/`over` (`over` is true if *either*
  denomination is breached) instead of the old single `cap`/`over` pair.
- **Workspace rows are new** — previously only surfaces had a cap row; the workspace's
  own token/$ cap and spend are now shown too.
- The `"(dms)"` bucket keeps hiding **per-DM caps** (`tokenCap`/`usdCap: null` — a shared
  bucket has no single cap) but **never** hides `over`/`tokenOver`/`usdOver`: if any
  individual DM is over its own cap, the bucket reports over — and since DMs became
  enforceable, "over" in the bucket also means those DMs' next turns are being declined.
- **Per-person allowances have their own list**, not a row among the surfaces: `userCaps`
  (org scope only) enumerates every `perUser` allowance — the blanket `default`, each named
  config entry, and each live `level: "user"` override with its expiry and who set it —
  labelled with which layer it came from, because the remedy differs (a config entry is
  changed by a PR, an override by clearing the bridge). It is deliberately a separate list:
  folding an allowance into a surface row would imply it *replaced* that surface's cap, which
  is the one thing the person axis must never do.

### Per-routine cost prediction

`spend_report`'s `routinePredictions` projects **7-day and 30-day** token (and $, if
priced) spend per surface, for surfaces with enough history: it takes this window's
observed average tokens-per-fire for `routine`-kind usage and multiplies it by that
surface's **currently active** cron/interval cadence (derived from the routine's trigger,
not guessed), **floored at the dispatcher's 10-minute tick** — a routine is dispatched at
most once per tick, so an `every 5 minutes` trigger is projected at ~144 fires/day, not 288.
A surface needs at least 3 observed fires before a projection is offered;
fewer than that, or a surface whose only routines are only-on-change/`event` (posting —
and so cost-per-post — isn't predictable), gets a `skippedReason` instead of a number. Always labelled an estimate,
never presented as a bill — see [Proactivity & routines](../capabilities/proactivity-and-routines.md#workflows-a-routine-that-runs-a-skill).

### The control plane's own read tools

The remote MCP [control plane](./control-plane.md) has its own, separately-authenticated
versions of some of this, for an operator outside any conversation:

- `spend_report` (control) — the pre-existing, org-wide-only per-surface/per-workspace
  ledger-vs-caps view (distinct from the in-conversation agent tool of the same name
  above, which also covers a single domain and is richer — kind breakdown + prediction).
  Same item-16 closeout as the agent tool: **effective** caps (config + active override)
  and **$** alongside tokens, for both surfaces and workspaces — see
  [Caps in the reports agree with the gate](#caps-in-the-reports-agree-with-the-gate)
  above. It reads this deployment's own org and nothing else (OPE-1446): the view passes
  `deploymentOrg()` to the ledger read, and the tool advertises no `org` a caller could
  move. The agent tool reaches the same one org, from the seat instead.
- `usage_summary` — the `usage_events` rollup behind the three agent tools above, callable
  for one domain/surfaceKey (a `domain:<name>` role covers its own scope) or, unscoped,
  the whole org (requires the org-wide `admin` role). It now carries the same per-surface
  `routinePredictions` the in-conversation `spend_report` does, closing the one gap between
  the two views.
- `skills_list` — the control-plane mirror of `list_skills`' domain tier (see
  [Skills & plugins](../capabilities/skills-and-plugins.md#runtime-domain-skills)),
  scoped the same way.

See [The control plane](./control-plane.md#auth-and-roles) for the `admin` / `domain:<name>`
role convention these three read tools (and the write tools) check against.

## The ingress spend gate

The gate runs before any model turn starts. It answers `proceed` — the wake is admitted, because the
scope is under cap, an admin bypassed it, or the check failed open — or `declined`, which means the
refusal has already been posted and the caller must drop the wake with no model turn at all.

🔴 **Every refusal names the door it came through**, because "the mention path refused" and "the
engagement path refused" are different facts. The five doors are `mention`, `engagement`, `join`
(the channel-join intro turn), `window` (the cross-surface single-window divert, which every
surface's single-window leg funnels through), and `answer` — a click on a human-in-the-loop widget
that resumes a parked turn. That last one is a door because resuming a parked turn is a decision to
spend more, taken through a button, on a scope nobody asked whether it could afford.

**The refusal copy is one set of sentences with a badge parameter.** Slack renders its own
shortcodes and nothing else does, so the two badge pairs are data rather than a fork of the copy:
`SLACK_SPEND_BADGES` keeps Slack's historical shortcodes so its rendered refusal stays
byte-identical, and `UNICODE_SPEND_BADGES` supplies the plain-text badges every other surface uses —
Discord, Teams, GitHub, Linear, Notion, and the cross-surface window, whose refusal can land on any
of them.

### The admin bypass fails in two directions, on purpose

`capBypassFor` decides whether the person who triggered the wake may spend past a tripped cap. It
grants on **roster** standing — an org admin always, a domain admin only over their own domain's
surfaces — or on a surface's own **native admin** signal where its provider registers one. Discord's
guild-administrator check is the reference, and Slack has no native leg.

🔴 **The grant fails CLOSED.** Any error resolving standing answers "no bypass", so the caller's
normal decline still runs. 🔴 **The warning fails OPEN.** The warning line is throttled to one per
surface per hour, and that throttle is a filtered read of the `spend.cap_bypassed` rows the bypass
already writes — durable state, no new table, and it survives a serverless recycle. A broken read
therefore resolves to *post the warning*, because the warning is the visibility half of sudo and a
silent bypass is the failure that matters. **The throttle never touches the row**: the audit row is
written on every bypass, and only the visible line is suppressed.

### What a checkpoint trip does when it cannot ask

`requireSessionContinuation` gates an action once a [session cost
checkpoint](#session-cost-checkpoints-a-soft-control) is crossed. It has three arms, and each one
leaves a `checkpoint.trip` row.

- **No way to ask a human** — no approval-card path, no verified sender, or no channel id. The
  action is **allowed**, and the row says so: `carded: false`, `allowed: true`, with a note naming
  the missing card path. A soft control must not become a hard stop on a surface that cannot show a
  card.
- **Carded** — the card posts and the row records the trip as carded, once per session. 🔴 **The
  held tool's own error says what the room actually holds**, and there are three answers, not two.
  A card that posted is pointed at. A card that FAILED to post audits `carded: false`,
  `note: "card post failed"` and a reason class, and the error says plainly that the card did not
  reach the room, names that class, tells the member to confirm directly instead of looking for a
  card, and says the card is posted again on the next consequential attempt — which is what the
  un-set ask marker really does. The sentence and the row carry the same reason class, so a reader
  joining the two gets one answer. A card that posted but whose ask marker failed to write audits
  `carded: true`, `note: "ask marker not recorded"`: the room really holds a card, so the error keeps
  pointing at it, and the only loss is the once-per-session suppression — a duplicate card on the
  next attempt, never a missing one.
- **Repeat** — an "asked" marker written the first time this session cards survives a decline, so a
  rejected checkpoint keeps the soft block without re-posting a card on every later attempt. 🔴 **An
  ask marker older than the last approval is spent.** A member answered *that* card, and a later
  block is a fresh crossing; honouring the stale marker would suppress the new card while still
  throwing the block, and the job would stop with nothing for anyone to act on.

### What `set_spend_limit` and `clear_spend_limit` refuse

Both tools propose a change rather than making one, and both refuse a proposal that would store an
override matching nothing.

**A fire may not propose one at all.** Both tools need a verified sender on the turn. A triggered
routine fire has no acting sender — only the creator it is attributed to — and a fire must not
propose a spend-limit change in that person's name.

**The scope key defaults by level**, and two defaults are refused outright from a direct message.
`defaultScopeKey` resolves a workspace-level cap to the workspace key, a surface-level cap to the
surface key, a person-level cap to the acting sender, and a domain-level cap to the covering domain —
throwing when no domain resolves. `assertScopableFromHere` then refuses:

- a **defaulted domain-level** cap proposed from a DM, because it would land on the `dm`/`public`
  criteria domain, which spans every DM in the deployment rather than this conversation. Name the
  domain explicitly, or cap this DM with `level: "surface"`;
- a **defaulted workspace-level** cap proposed from a Discord DM.

An explicit `scopeKey`, or a proposal made in a channel, passes both.

`assertScopeKeyShapeForLevel` closes the last gap: a person-level cap must carry a person-shaped
scope key, and no other level may. `planSetSpendLimit` additionally refuses a proposal that sets no
cap component and one with a blank reason. `planClearSpendLimit` runs the same sender, defaulting
and shape fences on the way out.

## Break-glass on spend — a narrowing bridge

Caps are config, so the permanent way to change one is a PR. But an incident can't wait for a deploy, so the [control plane](./control-plane.md) exposes a runtime spend override that overlays the config baseline in the operational store and is merged at read time. This ties directly into the **override doctrine** — and spend is the one override that gets a *widen*-bridge, because a budget is not a security boundary:

- **Lower a cap (narrow now).** An incident override: a scope is running away, you tighten its budget instantly, you clear it when the incident is resolved. Always allowed — narrowing is never escalation.
- **Raise a cap (bridge).** A legitimate scope needs more headroom and the PR that makes it the real baseline is in flight. You bridge the budget up temporarily. Permitted *because* budget isn't a security boundary — unlike access, which can never be bridged.

An override carries a token component and/or a USD component and overlays **per-component**: a USD-only override replaces the scope's $ cap while the config token cap stays in force (and vice versa) — a bridge never silently drops a cap it didn't name. One override row exists per scope + level; setting a new one replaces the previous one there.

### The same override, a second front door

The control MCP isn't the only way to set or clear a cap. Anyone can ask the agent in Slack to
raise or lower a budget; the agent's `set_spend_limit` / `clear_spend_limit` tools don't act
directly — they **propose**: a code-rendered card is posted showing the current cap, the
proposed one, and who asked. A click from a domain or org admin applies it — through the exact
same `setSpendLimit` / `clearSpendLimit` store calls the control plane's own writes use. (If an
operator has *lowered* that verb in the approver chain, there is no card and the cap is already
in force when the tool replies — the reply says so; see
[the control plane](./control-plane.md#in-slack-approvals).) It's
**one runtime overlay, two front doors**: the drift view (`overrides_list`) shows a spend
override the same way regardless of which door set it, with the same `reason` / `setBy` /
`expiresAt` and the same TTL asymmetry above. One difference is worth knowing: the card path
sets **no** `expiresAt`, so a cap raised from a card is sticky until somebody clears it, while
the control MCP can attach a `ttlSeconds` that reverts it on a clock. See
[The control plane: In-Slack approvals](./control-plane.md#in-slack-approvals) for the
propose → card → click mechanics and who's allowed to click.

**A proposal names only the cap components the person asked for.** `monthlyUsd` alone and
`monthlyTokens` alone are each a complete proposal, and a component the proposal leaves out stays
as it is. **A repeat proposal posts no second card:** while a card for the same level, scope and
figures is undecided and unexpired in the same venue, `set_spend_limit` returns that card's
`pendingId` and posts nothing, even when the `reason` text differs. A rejected or expired card never
blocks a new proposal.

### Why TTL auto-expiry is safe here

A spend override carries `reason`, `setBy`, and an optional `expiresAt`. When a spend-up bridge expires, the override stops being read and the consult **falls back to the tighter config cap** — expiry *narrows*, which is the safe direction. That's the asymmetry that makes spend special: auto-expiry is only ever safe when it tightens, and a spend-up bridge reverting to the config cap always does. (Contrast a connector revoke, where auto-expiry would *re-open* access and is therefore forbidden — see [The control plane](./control-plane.md).) A TTL is what keeps drift from outliving the bridge, and it is optional — so every override shows up in the drift view as a reconcile item until somebody clears it, an expired one included.

The merge itself is fail-safe — if the override store can't be read, the check falls back to the **config caps only**, never to "uncapped." Spend is pure runtime *state*; the caps it's measured against are config (git) — see [Reading spend and usage](#reading-spend-and-usage) above for the tools that report both together.

## Estimating a stack's cost before you run it

Everything above prices what your deployment *did* run. `npm run pricing:stacks` is a separate, offline **calculator** for what a [named model stack](../deploy/configuration-reference.md) (`agent/model/stacks.ts`) *would* cost under a given amount of usage — a basic estimation model, built to be improved rather than a finished product. It reads every shipped stack straight from that file (a new stack shows up automatically) and a **token profile** — per-role input/output token counts you supply, never invented by the tool — and prints each stack's per-role and total cost as a range.

```
npm run pricing:stacks                          # the shipped illustrative profile
npm run pricing:stacks -- --profile usage.json   # your own profile, e.g. from usage_summary
```

Two things the printed estimate is always honest about, because they're true of every model this tool prices:

1. **Cache savings are excluded.** The gateway applies its cache discount without ever reporting which tokens got it, so there is no honest signal to build a hit-rate assumption on — every estimate prices all input at the full rate, making it a conservative *upper bound*, never a best case.
2. **Open-weights rates are a band, not a point.** An id like `deepseek/deepseek-v4-flash-0731` gets load-balanced across upstreams that bill differently — the same id measured three distinct exact rates across eight otherwise-identical calls. So its cost is printed as a range (min-max), and a single-rate model (e.g. the closed stack's) is just a range whose ends happen to match.

The measured rates live in `packages/core/agent/spend/stack-pricing.ts`, deliberately separate from this file's own `usd_micros` pricing table above: that one is enforced to hold exactly the deploy's own live default (so a stampless usage row's `$` fallback never guesses), while the calculator needs a rate for *every* shipped stack, including ones this deployment isn't currently running.
