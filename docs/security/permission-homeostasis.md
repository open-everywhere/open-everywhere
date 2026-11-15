# Permission homeostasis

Grants drift. Open Everywhere ships two counter-regulatory loops that measure the drift and **propose** corrections — one that notices a grant is too narrow for the work arriving at it, one that notices a grant nobody is using. Both are proposal-only: the actuator is always a reviewed config pull request. Nothing here blocks, delays or gates any live action.

## Why two loops

A permission grant is a set point, and a set point with only one feedback loop drifts in one direction.

The pressure to **widen** is constant and loud: somebody is blocked, right now, and they say so. The pressure to **tighten** is silent — nobody files a ticket saying "we stopped using that AWS role in April". So access accumulates. Every long-lived system with only one loop ends up with grants that no longer describe what anything does.

That asymmetry is sharpest for **unattended work**, which is exactly where approvals are most toxic. A routine that fires at 03:00 and meets an approval card has nobody to answer it. Open Everywhere's [approver chain](./security-model.md) handles that by **denying** rather than stalling — a deny is kinder than a card in an empty room, because the fire continues and the refusal leaves a row. Those rows are the widening loop's raw material; they exist partly so this loop would have something to read.

## Loop 1 — widen from evidence

Over a window, count the refusals an unattended run actually hit, and propose the grant that would have covered them.

Four refusal families are grant-*width* questions and get a proposal:

- **An AWS allow-list refusal.** `aws.refused` with `reason: "allow-list"` says the reviewed host-side narrowing on top of an IAM role is tighter than the work. The proposal is a concrete diff to that grant's `allow` list — e.g. *"`logs:start-query` was refused 3× on this role in the last 30 days; here is the line to add"*. Widening the list can never exceed the IAM role behind it: the host-side screen only ever *further* restricts. If the role itself lacks the action, the merged diff will simply let the command fail in AWS, which is the right place for it to fail.
- **An `ask-unattended` chain deny.** The fire wanted a card nobody could answer. This one gets **no config diff, deliberately** — the actuator is not a bundle edit. A routine's declared permission is a per-routine store row armed by a human tap on the routine's own creation card, so the proposal names the tool and the counts and points at that. (If a scope should never card a verb *at all*, that is a bundle `approvers` edit — a real config diff, but one a human should author, because it changes policy for every caller in the scope rather than for one routine.)
- **An egress denial.** `egress.denied` says a host the work keeps reaching for is not in the compiled allow-list. This family is **tier-conditional**, and the report says so rather than letting a silence read as health: where the proxy is Open Everywhere's own (the [self-host egress tier](../deploy/platforms/self-host-egress.md)) each denial is recorded and read; on Vercel the sandbox host denies out of band, nothing observes the attempt, and an empty egress section means *not observed*, never *nothing was blocked*. There is **no config diff** here either, and for a reason the evidence itself explains: the reachable-host grant lives in a bundle's `domains` when the call needs no credential and in a connection's `allowedWebsites` when the firewall should inject one, and which of those is right is a question about the call — a reviewer's judgement, not a derivable edit. The row carries a **host, a policy fingerprint and a count**, plus the length of the window the count covers and, where a per-pass host cap cut the list, how many hosts it dropped. It carries **no path, no query string, no method and no client address** — so the proposal can say *that* a host was wanted and never *what for*; the worker's own report is still where that comes from.
- **A connector refusal.** The credential plane writes its own `connector.refused` row rather than an approval-chain row, so a routine refused a connector write every night used to leave evidence this loop never read. Two of its reason codes are width questions and get a proposal: `ungranted` (no bundle effective in this scope declares the connection) and `ask-unattended` at the **`write` tier with a routine behind the turn** (the same empty-room refusal, arriving on the credential plane). Neither carries a config diff: an ungranted connector is in no bundle to render a `before` from and its declaration needs a credential id no refusal row carries, and a routine's declared permission is a store row rather than bundle config. A `destructive`-tier refusal and a **tainted** turn are lifted by nothing at all, so they are counted and never proposed. The `write`-tier refusal also posts the routine permission card itself, so the human the proposal reaches usually has a click waiting for them already — see [Routines](../capabilities/proactivity-and-routines.md).

**A connector refusal whose permission has since arrived stops proposing.** This rule is the connector family's alone: the arrival join runs inside the `connector.refused` branch and nowhere else, so an `ask-unattended` **chain** deny keeps proposing even after a `routine.permission_granted` row lands for the same routine and kind. The loop reads two rows that are not refusals — the fence lifting the same operation afterwards (`connector.unattended_lift`), and a human's click on a routine permission card (`routine.permission_granted`) — joins them to the refusal by *(routine × permission kind)*, and drops the refusals a later arrival answered. The order is the test: a permission stamped **before** a refusal demonstrably did not stop it, so those refusals stay live. Without this the report re-proposes an already-armed permission every window until the rows age out, which is how a standing scan teaches its reader to skip it.

🔴 **The join drops the routine's generation, and the order replaces it.** A permission key embeds the routine's prompt generation, and the one remedy this report offers — arm the permission by creating or editing the routine with its declaration — mints a **new** generation. Joining on the whole key therefore meant the arrival could never answer the refusals that asked for it, and the report re-proposed an already-armed permission for ever. The join now runs on the routine alone. Revoking still re-opens a proposal, because an edit that takes the declaration away mints a newer generation whose refusals are stamped *after* the arrival, and only an arrival that post-dates a refusal suppresses it.

🔴 **Which arm reaches which case.** The **click** arm is live. The connector plane is a **second refusal site that cards**: a `write`-tier `ask-unattended` refusal on a routine fire posts a routine permission card naming `tool:<the op>` in the routine's own room, so a click row now carries a connector permission kind and answers the refusal that raised it. The **lift** arm reaches two real cases. The fence refuses when its permission read answers false, and that read is fail-closed, so a transient store failure writes a refusal for a permission that was there all along; the next fire lifts and this rule retires the stale refusal. And a human who arms the permission the remedy named is answered by the next fire's lift under the new generation, which is the case the generation-free join opened.

**Everything else is counted and never proposed away.** These clusters reach the reader as a number, not as a list: the report's header line states how many refusal clusters the window held, and a cluster nobody proposes on is named nowhere in the rendered text. Reading *which* control refused means reading the audit rows. The unconditional AWS fences (`credential-read`, `argv-option`) each exist because of a verified defeat. The `ask-unattended` arrow denies a gated act in an empty room; that is the narrow control working, not a rough edge. (A `taint-ask` reason on an older row came from the taint floor, which OPE-2716 deleted.) `mode-deny-all` and an absolute element deny are a reviewed config saying no on purpose. Each of those is a control *working*; proposing to remove it because somebody bumped into it would be the loop optimising away its own reason to exist.

A single refusal is also not a proposal. One refusal is a probe, a typo, or somebody finding out what the scope can do; a **repeated** refusal is a need. A single occurrence still counts toward the cluster total in the header line, but it raises no proposal and the report names it nowhere. Read the aggregate as a denominator, and the audit rows as the detail.

## Loop 2 — tighten from disuse

Over the same window, compare what is *granted* against what was *exercised*:

- **A grant nothing used.** An AWS role this scope may assume and never assumed; a connector granted and never called. Proposal: remove the grant.
- **…and a connector nothing used *because every attempt was refused*.** A refused operation writes `connector.refused`, never `connector.op`, so on the "was it exercised?" counter a wholly-refused connection and an idle one produce the same zero. They are opposite states — nobody wants it, versus everybody wants it and cannot have it — and the proposal must not read the second as the first. So a tightening proposal for a connection that also drew refusals in the same window is **annotated, not suppressed**: it keeps the removal diff and carries the refusal count and reason breakdown inline. Removing the grant may still be right — a connection walled off by a DM-only rule and never otherwise used may be a grant nobody should hold — but the reviewer decides it against the reasons, not against the zero. Suppressing the proposal would make the report lie by omission in the other direction, and the reader of a tightening proposal is exactly the person who needs the refusal signal.
- **An allow-list wider than the traffic.** `allow: ["*"]` on a role that only ever ran `logs` commands narrows to the **services** observed — service grain, not exact operations, because narrowing to exact operations sends the next ordinary call straight back through loop 1. An allow-list with entries that covered nothing narrows to the entries that carried the traffic.

Coverage is decided by asking the **live screen** whether a single-entry allow-list would have permitted each observed command — the same function that refuses a command at runtime. There is deliberately no second matcher, so the report and the enforcement point cannot drift into disagreeing about what an entry covers.

### Disuse needs a denominator

"This grant went unused" is only evidence if the scope was doing anything at all. Over a silent window *every* grant is unused, and a report that proposed removing all of them would be confidently wrong in precisely the situation where it has learned nothing.

So tightening has two floors, and below either of them the report proposes nothing and says why:

- a window of at least **7 days** — the shortest window that contains a full weekly cycle, which is the shortest cycle most standing work has;
- at least **5 rows of the relevant family** in the window (AWS executions for an AWS grant, connector operations for a connector grant).

An empty window therefore yields no proposals at all, and the report states that in words: *an absence of evidence, not a clean bill of health.*

## The actuator is always a reviewed PR

Neither loop can change a permission. A proposal is text until a human merges a diff — the same shape `create_agent` and `declare_webhook` take, where **merge is the privilege gate**.

This is not a v1 shortcut with an "apply" button deferred to later. Runtime self-modification of the permission plane is the thing the design exists *not* to build: a loop that could widen its own grants from its own run evidence is a loop an injected run can drive, and the review is the only step in the chain an injected run cannot reach. Config-as-code *is* the review.

Proposals carry the diff as **evidence for that review**, not as an input to a codemod. They are deliberately not expressed in the [access-request](./credentials-and-planes.md) delta vocabulary: that grammar is widen-only by construction and has no shape for AWS grants at all, so half of loop 1 and *all* of loop 2 are unspellable in it — and growing a closed vocabulary the least-trusted context can emit so that it can also spell "take this away" is a different security argument than the one that grammar was reviewed under. To carry a proposal into the config repo, use the ordinary `open_pull_request` path, with its own approval card.

## Running it

`permission_fit_report` produces the report for the domain the asking channel belongs to.

```
permission_fit_report(days: 30, direction: "both")
```

- `days` — the window, 1–90 (default 30). Under 7 days, widening evidence only.
- `direction` — `"both"` (default), `"widen"`, or `"tighten"`.

Ask for it in words too: *"do we still need all this access?"*, *"why does this routine keep getting refused?"*. For the prospective, per-verb question — *"would `open_pull_request` be allowed here right now?"* — use [`explain_permission`](./security-model.md) instead; the two are the same family in opposite tenses.

**What it discloses, and what it cannot.** The entire output vocabulary is tool names, AWS command labels, refusal reasons, connector operations and integer counts. No principal identifier reaches the evidence, the proposals or the report — not because the data is unavailable but because this report is about **permissions**, not about people. That absence is load-bearing: it is what lets an unattended routine run the tightening scan at all, where the [analytics](../capabilities/analytics.md) plane (which *is* about people) fails closed without a verified sender.

Every run writes its own `permission.fit_report` audit row — a review that happened is a decision worth recording. The row carries counts and the window, never the proposal prose; the proposals are reproducible from the evidence.

## Arming the periodic scan

The tightening loop is worth running on a schedule; the widening loop is usually answered on demand, when somebody is blocked. There is no cron to configure — arm it the way you arm any standing behaviour, with a [routine](../capabilities/proactivity-and-routines.md):

> "Every Monday at 09:00, run a permission fit report for the last 30 days and post the tightening proposals here."

The routine fires unattended, the tool is available at every session grain including an unattended fire, and the report lands in the channel for a human to act on. Whether to arm it — and where the proposals should land — is the operator's choice, deliberately: a standing permission review posted into the wrong room is noise, and the right room is the one where somebody can open the PR.

The widening loop is left as an on-demand read for the same reason. An unattended deny already leaves a clean, attributable row, so nothing is lost by *not* firing a proposal the moment it happens — and a system that proposed a widening automatically, in the moment, on the strength of one refusal, would be training its operators to approve permission changes reflexively. Wiring it into a routine (*"if any routine hits an unattended deny more than twice this week, tell me"*) is a decision worth taking on purpose.
