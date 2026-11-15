# Pre-approval rules

**Admin-authored prose that tells the approval judge which actions your org treats as routine.**

The [approval judge](../security/security-model.md) decides the residue of actions that no written
rule resolved. On its own it sees the action facts and the standing posture only. It does not know
that your org treats a docs-only pull request as ordinary. Pre-approval rules are the channel that
tells it, in your own words.

**In `enforce` mode, the shipped `approvals.judgeMode`, a rule is the only thing that lets a gated
act run without a card.** The judge allows an act only when it cites a rule that this scope really
carries. An allow that cites no rule is an `ask`, so a person decides. Every act that ran without a
card therefore traces to a sentence an admin wrote and a reviewer read, or to a DM rule: a sentence code
wrote from an approval card, which the person confirmed for their own asks in their own DM (§7).

A rule is curated context for one decision. It is not a verdict, and it is not a chain element.

---

## 0. What a fresh install does

A scaffolded app runs the judge in `enforce` mode and ships five starter rules in
`agent/access/pre-approval-rules.ts`, bound at org scope by the `approval-policy` bundle in
`agent/access/bundles.ts`. Edit them there, review the change, and deploy it.

| Rule id | What it pre-approves | Why it is low-risk |
|---|---|---|
| `pr-asked-for-here` | Opening a pull request that the requester asked for in this turn's messages, whose repository, branch and title match the ask. | The tool reaches only the repositories granted to the room. A pull request does not merge itself, but whether a merge needs a review is the repository's own branch protection, so the rule does not count on one. A request that came only from fetched or quoted content gets a card. |
| `routine-reports-here` | Creating a routine that the requester asked for in this turn's messages, whose prompt and schedule match the ask, that reports back to this conversation, and that runs at most once an hour. | It posts only where it was asked for. Each fire costs model calls, so the rule stops at an hourly rate. A routine that declares a standing write never reaches the judge (§4). |
| `access-request-asked-for` | Sending an access request that the requester asked for in this turn's messages, for the access they named. | A request is not a grant. It notifies the admins, and the access starts only when an admin merges it. |
| `connector-write-asked-for-here` | A connector write (a Notion page, a Linear issue) that the requester asked for in this turn's messages, whose arguments match the ask, and which only creates or updates content in the workspace the domain connected. | Code keeps the risky connector calls on a card before the judge sees them (below). The rule adds what a model can read: a person asked in this turn, the call matches the ask, and nothing leaves the room. It does not cover a call that sends a message or an email, shares or publishes content, or invites or notifies people outside the conversation, and it never covers a delete. An allow runs that one call only. |
| `connector-delete-asked-for-here` | A connector delete that the requester asked for in this turn's messages, in their own words, naming exactly this item, where the call's arguments name that one item and nothing else. | A delete cannot be undone, so this is the strictest starter rule. It never covers a delete of more than one item, a bulk or batch delete, a delete by filter, query, pattern or wildcard, or a delete of a whole page tree, database, project or workspace. When the ask does not name the item, or is ambiguous about which item, a person decides. The same code floors as a write apply before the judge sees it (below). Delete this rule to keep every connector delete on a card. |

The judge sees only a rule's text, so every starter rule states its own limits. Each one says it
never covers an unattended run (a routine fire or a webhook), and each one needs the ask in the
requester's messages from **this turn**, matching the act's arguments. The judge prompt shows the
messages captured in this turn as the requester's messages. When this turn captured none, the
previous turn's messages are shown apart, marked as earlier context, so an old ask does not read as
a new one. Most acts are proposed in a child of the conversation's work session, not on the seat the
person spoke to. For those, the forward carries the person's own words from the turn that forwarded
the job, and only the message they wrote that woke that turn. It never carries the seat's summary of
the job, another person's message, or an ask from an earlier turn. A routine fire carries no ask.
One limit applies. While a job is the only one open in the work session, every worker the work
session starts in that turn joins that job. So a second worker, started for other work in the same
conversation, also sees that person's ask. The judge can then allow its act when the person's words
plausibly cover it. Write rules that name the act and its arguments, not only that a person asked. A judge allow lands on
a turn that read untrusted content exactly as on a clean turn: no taint floor turns it back into a card
(OPE-2716), so the rule's wording is the bound.

Whether a rule covers an act is the judge **model's** reading of the rule against the act. The
parts that do not depend on that reading are code: the citation must name a rule this scope
carries, the human-only class never reaches the judge, and the clamps run after it (§4).

**What always gets a card.** Some acts never reach a rule:

- every admin act — a spend limit, a connector override, lifting a halt, an admin memory read;
- a routine that declares a standing write;
- erasing remembered facts (`purge_memory`). An erasure cannot be undone, so it is human-only in
  code: the judge is not consulted, and no rule can lift it;
- every verb that is not defer-flipped (§4);
- every connector op except a write or a delete that runs with the domain's credential. An op on a
  person's own account, an op in an unattended run, an op in a turn that read external content, an
  op in a room that does not belong to exactly one domain, and an op whose input is too long for the
  card to show in full all keep the connector card. So does an op whose name carries no
  verb the classifier recognises (`execute_sql`, `run_workflow`), unless the tool annotations of its
  registered server bring its final tier down to `read`: the judge reads an op mostly by its name,
  so it is not a known write or delete. Code decides this before the judge, so no rule can change
  it. [Connectors and providers](../capabilities/connectors-and-providers.md) gives the annotation
  rules. (Until 2026-10-10 a destructive op always kept its card too. The rule of that
  day lets the judge approve a delete that a rule covers; the starter delete rule above is strict on
  purpose.)

**An allow covers one act.** The judge's cached allow is kept per session and keyed on the act's
whole arguments, the requester and whether the turn is unattended. So a cached allow answers only
for the same act, asked by the same person, in the same kind of turn. Any other act is judged again,
even in the same session. A judge allow of a connector write or delete is never cached and writes no
approval for a later call, so it runs that one call only. An identical call later in the session is
judged again. Only the judge lifts a connector card: an operator approver that
answers `allow` leaves the card. A connector card's consult reads the room's domain, so that domain's
judge disarm and halt cover it.

**When the judge cannot decide, the card is posted.** An unreachable judge model, a judge transport
that is not registered, an unparseable answer and the 30-second timeout all give the card, never an
allow. A scope with no authored rule is not consulted at all.

**Cost.** A consult makes up to two calls to the `judge` model role (a short scrutiny pass, then the
verdict pass). A cached allow costs none, and a scope with no authored rule costs none. Each gated
act that reaches the judge costs one consult.

**Turning it off.** Set `approvals: { judgeMode: "off" }` in `agent/settings/settings.ts`. Every gated
act then posts a card. `shadow` decides nothing and logs a would-be verdict beside each real card.

**`enforce` with no rules logs one boot line.** When no bound bundle carries a rule, the judge has
nothing to cite. Each consult then returns `no-rules` with no model call, so every gated act posts a
card, the same as `off`. The setting still reads `enforce`, so at boot the deployment logs this line
once (OPE-2400):

```text
[open-everywhere:approvals] the approval judge is in enforce with no rules: every gated act will ask a person. …
```

A rule counts only when a binding names its bundle, because the resolver reads bound bundles only.
To clear the line, bind a bundle with `preApprovalRules`, or set `judgeMode: "off"` to say what you
mean.

**An app scaffolded before 0.2.1 has no rules file.** `npx oe upgrade` and `npx oe upgrade --plan` offer
the target template's `agent/access/pre-approval-rules.ts` to such an app. The upgrade never writes
the file and never overwrites one you have. The offer names the template's copy and the
`approval-policy` binding to add (see `UPGRADING.md`). An app that names the file in
`.oe-template-ignore` left it out on purpose, so it is not offered.

---

## 1. What a rule is

A rule is a sentence of policy and an id:

```ts
// agent/access/bundles.ts
export const BUNDLES = [
  {
    name: "org-policy",
    preApprovalRules: [
      {
        id: "docs-only-pr",
        rule: "Opening a pull request that touches only files under docs/ is routine here.",
      },
    ],
  },
];
```

You bind the bundle to a scope with an ordinary binding:

```ts
export const BINDINGS = [
  { bundle: "org-policy", scope: { level: "org" } },
];
```

The id is what makes an auto-allow traceable. The judge cites it, and the audit row records it.

### Caps

| Limit | Value | Why |
|---|---|---|
| Characters per rule | 1,024 | A rule is a sentence of policy, not a document. |
| Rules per bundle | 50 | Keeps a scope's policy readable in one sitting. |
| Rules per resolved scope | 200 | Four rungs at the per-bundle cap. |

**A rule should state policy, never one object.** It names the tool, the kind of action and the kind
of object ("delete Notion pages this domain's agent created"), never an instance ("Notion page 7").
Code refuses a DM rule or a domain rule pull request, and config load refuses a rule in the domain
rules file, whose text names a URL, an email address, a UUID or a long hexadecimal id, a `#123`
reference, a tracker key (`ABC-123`), a platform id, a long number, or a numbered object ("page 7",
"issue 42"). The rules an admin writes in their own bundles are not checked: keeping those to policy
is the admin's and the reviewer's job. The lint is `ruleInstanceProblems` in `access/pre-approval-rules.ts`. It is
not exact: a policy limit ("more than 10000 rows") or a standard name ("UTF-8") also matches. So it
runs where code writes a rule (a DM rule, a domain rule pull request, §7) and on the domain rules file
(`defineDomainRules`, and the `domain-rules:*` bundles at config load). It does not run on the rules an
admin writes in their own bundles, because there a false positive would stop the deployment booting.

An id must be unique across your whole config. Two rules with one id make an audit row ambiguous,
so the config fails to load. An id is 1 to 64 characters. It starts with a letter or a digit, and
it then carries letters, digits, dots, dashes and underscores. It carries no whitespace, so a
`RULE: <id>` citation parses without ambiguity.

---

## 2. Where rules come from — and where they never come from

Rules live in the agent's **own config repository**, the repository that ships the deployment. That
repository's review-then-deploy pipeline **is** the authorship gate. A rule reaches a live judge
only after a person opened a pull request, a reviewer read the prose, and a deploy shipped it.

> 🔴 **Rules are never read from a repository the agent checks out to work on.**
> The agent clones repositories to fix bugs and open pull requests. If it read rules from those
> repositories, any repository could grant the agent permission by adding a file. So there is no
> loader that takes a path. The only source is the config repo's bundles, resolved through the
> access resolver. Claude Code's auto-mode refuses project-local settings for exactly this reason.

> 🔴 **The agent can never author or edit a rule.**
> No tool and no command writes a rule. There is one runtime write path, and only a person's
> confirmed click on an approval card reaches it (§7): it writes that person's own DM rule, or it
> opens a pull request for a domain rule. Its exported writers are on the human-only manifest
> (`lint:human-only-invariants`), so no agent tool may import them. The store write itself is a
> method that scan cannot see, so `test:allow-rule` pins `approvals/allow-rule-apply.ts` as the only
> caller of `upsertDmRule` in every agent code tree. Code writes the rule text from the card's frozen
> act, never the model. The one path by which the agent
> writes access config is the machine-written grants overlay, and that overlay's parser accepts
> three fields only (`name`, `connections`, `connectors`). An overlay carrying `preApprovalRules`
> is refused when it is parsed. A test pins that refusal.

---

## 3. How rules stack — add, never replace

Rules resolve down the [scope ladder](./access-and-scoping.md): `org < tenant < domain < surface`.
A narrower scope **adds** to the wider one. It never replaces it and never shrinks it.

```
org           "Docs-only pull requests are routine."
  domain      "In payments, every pull request needs a human."
    ⇒ judge sees BOTH rules, org first.
```

This is deliberate. A reviewer who reads the org bundle knows those rules hold everywhere beneath
it, because no narrower file can quietly cancel them. There is exactly one way to remove a rule:
delete it from the config repo and deploy.

The judge sees each rule's authoring scope, so it can weigh an org-wide rule against a
surface-specific one. When two rules point in different directions, the judge decides — and
`ask` is its instructed answer when it is uncertain.

If the assembled set exceeds 200 rules, the overflow is dropped from the **narrowest** end and the
resolver warns. A narrow scope must not be able to push out the org's reviewed baseline by volume.

### There is no user-intent tier

Claude Code's auto-mode ranks explicit user intent above its allow rules, because a person is at a
keyboard during the session. An org agent acts when nobody is at a keyboard, so there is no live
intent to rank, and this store has no such tier. The judge does read the requester's own visible
messages. Those are consent signals it weighs, not a tier that outranks authored policy.

---

## 4. What stays above the store

**A rule can pre-approve an action. It can never remove an approval that policy code forces.**

A rule is an input to one judge consult. Everything the chain does around that consult is
untouched:

| Above the store | What it means |
|---|---|
| **A pinned ask** | The judge is consulted only when the ask came from a per-verb default. An operator or surface approver's ask is explicit policy — the judge never sees it, so no rule can lift it. |
| **The defer flip** | The verb's registry row must be explicitly flipped `ask → defer` by a reviewed edit. A rule cannot open a verb nobody flipped. |
| **Arming** | Rules act only in `enforce` mode, the shipped `approvals.judgeMode`. In `shadow` or `off` they lift nothing. |
| **The citation** | An enforced allow must cite a rule this scope carries. An allow that cites no rule, or a rule that does not exist, is an `ask`. |
| **Deny** | A deny from any element, or from the judge itself, is absolute and skips everything. |
| **The clamps** | Modes, the beneficiary-clicker floor and the unattended clamp run *after* the judge. They still tighten a rule-driven allow exactly as they tighten any other. |
| **The human-only class** | Every admin act (a `gate:admin` row, such as `set_spend_limit`) needs a person's click, and so does erasing remembered facts (`purge_memory`). So does a routine whose creation card declares a standing write — `pr.open`, or a connector tool that is not a read ([declared permissions](../capabilities/proactivity-and-routines.md)). The judge is not consulted for either, so no rule can lift them, and the verdict row records `source: "human-only"`. |
| **The connector fence** | A connector card reaches the chain only for an op whose name tiers it `write` or `destructive` (a delete reaches it since 2026-10-10), on the domain's credential, in an attended turn that read no external content, in a room with exactly one domain, with an input the card shows in full (`access/approver-chain.ts` `judgedConnectorOpTool`). An op whose name carries no recognised verb keeps its card. The card freezes the op's effective tier as `opTier`, and the judge reads it. A write-named op that an operator's `connectorOps` raise or a server's `destructiveHint` made destructive keeps its card, because the judge reads an op mostly by its name. Every other connector card keeps its old road and never meets the judge. A judge allow runs that one call, and only the judge can lift the card. |
| **The cache** | An enforced cached allow is keyed on the act's whole arguments, the requester and `unattended` (`approval-judge.ts` `enforcedVerdictCacheKey`), so it never answers for a different act. |

There is deliberately **no deny tier and no hard-deny tier** in this store. Denial already lives
above it, in code, where prose cannot reach it. Adding a prose deny tier would move a hard
guarantee into a place where a model's reading of a sentence decides it.

---

## 5. The audit join

Every rule-driven auto-allow is traceable to the prose that justified it.

When a rule covers the action, the judge cites its id. The `approval.judge.verdict` audit row then
carries:

| Field | Meaning |
|---|---|
| `ruleId` | The matched rule's id. Present only when the citation resolved. |
| `ruleCitation` | `matched`; `unmatched` when the judge named a rule that does not exist; `uncited` when it allowed without naming one. The last two were degraded to `ask`. |

So "which authored rule let this run without a card?" is one query. Every enforced allow carries a
rule id, and an allow that matched no rule never ran without a card.

### The fence against invented rules

The model writes the citation, so a fabricated id is the obvious way to launder an allow. The
citation is therefore **validated against the rules that run actually supplied**:

> An allow citing a rule id that is not in the scope's authored rules is **degraded to `ask`**.

That fails closed to a human, which is the same card the verb produced before its defer flip. The
bad citation stays on the audit row as `ruleCitation: "unmatched"`, so the attempt is queryable.

The judge's allow cache carries the same discipline. A cached allow keeps its rule id, so a cache
hit is as traceable as a fresh consult, and an enforce lookup refuses a cached allow with no rule id. A cached allow is dropped when the resolved rule set
changes, so a lift authored for one scope is never replayed in a scope whose admins never wrote it.

---

## 6. Writing rules that work

- **Describe the action, not the outcome.** "Opening a pull request against docs/ is routine" beats
  "helpful changes are fine".
- **Name the boundary.** A rule that says where it stops is a rule a reviewer can check.
- **Do not write deny rules.** They do nothing here. Denial belongs in the registry row or an
  operator approver, where it is code.
- **Expect the rule to be read by a model.** Write the sentence you would give a new colleague on
  their first day.
- **Keep the id stable.** Audit rows point at it. Renaming an id breaks the trail back to older
  decisions.

**Measure whether the judge reads a rule the same way every time.** One live decision proves
little, because the judge is a model. `packages/core/scripts/eval/approval-judge-consistency.ts`
draws three pinned routine asks many times: one from a Slack channel, one from a person's own DM,
and one from a GitHub issue. The words of each ask meet every clause of `routine-reports-here`.
The Slack asks should get an allow that cites the rule. The GitHub ask should get an ask: GitHub
has no routine post-back, so the routine reports to the domain's `reportChannel`, not back to the
issue, and the rule does not cover it. The script prints each case's verdict spread and the judge's
stated reason for each unexpected verdict. It exits 1 when a case flips between draws, or when a
case steadily gets another verdict than expected. Run it from `packages/core` with your own gateway
key from `.env.e2e`:

```
npx tsx scripts/eval/approval-judge-consistency.ts --repeats 10
```

The live e2e leg `S-JUDGE-LIFT-NOTICE` makes the same ask in a Slack room, up to three times. When
no ask is lifted, its skip gives the reason for each ask: the judge's own answer and reason from its
`approval.judge.verdict` row, or the chain step that decided before the judge was asked.

---

## 7. Approve and allow things like this

An approval card can carry a third option: **Approve, and allow things like this** (OPE-2456). It approves the one act, and it adds a rule so the judge can lift
the next act of the same kind without a card. **Plain Approve stays one-off and never writes a
rule.**

**A rule starts only from a person's explicit choice.** The agent never proposes a rule. The risk is
an admin who approves a rule pull request on trust while the person only wanted one act approved. So
no tool reaches the rule writers, and the option is the only way in.

**The person reads the rule before anything is written.** On Slack the button opens a confirmation
dialog that shows the proposed rule in plain words. The click is sent only when the person confirms.
Teams and Discord cards send a tap with no confirmation first, so they do not show the option.

**Code writes the rule, never the model.** The rule is one fixed sentence built from the card's
frozen act: the tool, the kind of action and the kind of object. It never quotes an argument. For
example: "In this DM, open pull requests with open_pull_request when the person asked for it in this
turn, with matching arguments. Never in an unattended run." A connector rule names the op's own verb
("archive issues with the linear connector's archive_issue", "trash pages … with the notion
connector's trash_page"). The verb is part of the rule's id, so a rule widens only with ops of the
same verb. The instance lint (§1) checks it too.

**Where the option appears.** Only where a rule could lift the act:

- the judge is in `enforce` mode;
- the act reaches the judge: `open_pull_request`, a `create_routine` that declares no standing write,
  or a connector write or delete that passes every connector floor (§4);
- the card's kind is `pr.open` or `routine.create` (`ALLOW_RULE_TOOL_KINDS` in
  `approvals/allow-rule.ts`), or it is a connector card. Eligibility is by kind alone (OPE-2717): a
  proposal raised after a read gets the option too, and a frozen `tainted` flag on an older card is
  ignored. `request_access` is not an eligible kind, so it gets no option;
- the room is the person's own Slack DM with the agent, or a Slack room of exactly one domain on a
  deployment with a config repo and an admin channel.

An admin act, a memory erasure, a routine with a standing write, and a connector op on a person's own
account get no option, because no rule can lift them.

**In a DM, the rule is the person's own and applies at once.** It is stored for that DM room
(`dm_rule` in the operational store). The judge reads it only for acts the DM's owner asks for in that
DM. The judge prompt says that a `dm` rule was confirmed by the requester, not written by an admin.
The person sees each rule under **Your rules** in the Home tab and removes it there; removal applies
at once. One person keeps at most 20 DM rules.

**In a domain room, the rule opens a pull request.** It adds one line to the app's
`agent/access/domain-rules.ts`, or widens the line for the same tool and kind of action. The pull
request names who asked for the act, who confirmed the rule, the card's id, and quotes the act in the
card's own words. The admin channel gets a note. Nothing applies until an admin merges it. Each
domain's merged rules become one bundle (`domain-rules:<domain>`), bound at that domain's scope only.
A deployment with `loadAccessRequests().dryRun` writes the audit row and opens nothing.

An app scaffolded before this feature has no `agent/access/domain-rules.ts`. Copy the template's file,
and add the two `domainRuleBundles` / `domainRuleBindings` lines to `agent/access/bundles.ts` as the
template does. Until then a domain rule click approves the act, writes no rule, and the card says
that the file is missing. `npx oe upgrade --plan` lists the file as missing. The path is
`accessRequests.domainRulesPath` when the app keeps the file elsewhere.

**A rule does not lift its own act again — while that card stays its source.** A rule is never
read for the act its source card approved: the same kind, scope and arguments. So a second delivery
of that step posts a new card, and the act runs again only if a person approves that card. When a
later card widens the rule, the rule's source moves to that card. From then on the rule can lift the
earlier act, on a later proposal and on a redelivery of the earlier step.

**Merge before add.** A rule's id names its tool and kind of action, never the object. So a second
card for the same tool widens the rule with one more kind of object instead of adding a rule. In a
DM an identical rule changes nothing, and the card says so.

**Guests and external rooms get the strictest default.** The rule step needs a positive answer at
each check, and an unknown answer writes no rule:

- the clicker must be confirmed a full member of the workspace (a guest, a Slack Connect account, or
  a failed lookup writes no rule);
- in a DM, the clicker must be the person the DM belongs to;
- in a domain room, the room's members must be readable and its audience floor must not be `guest`
  (an externally shared channel, or a channel with a guest in it).

A refused rule step still approves the act. The card's outcome line says why no rule was written, and
an `approval.rule.refused` row records it.

**A DM rule is not a grant.** It never skips the judge. The judge still reads each act against it, and
the human-only class, the clamps and the connector floors (§4) stay above it. Session and thread
grants stay removed (OPE-2363), and nothing here writes one.

| Audit row | When |
|---|---|
| `approval.rule.added` | A DM rule was added or widened. |
| `approval.rule.proposed` | A domain rule pull request was opened or updated. |
| `approval.rule.refused` | The option was clicked, the act was approved, and no rule was written. |
| `approval.rule.removed` | A person removed a DM rule in the Home tab. |

---

## See also

- [Access & scoping](./access-and-scoping.md) — the scope ladder these rules resolve on.
- [Config-as-code](./config-as-code.md) — why the config repo's review pipeline is a gate.
- [The security model](../security/security-model.md) — the approval judge and its bounds.
- [Audit & provenance](../security/audit-and-provenance.md) — reading the verdict rows.
