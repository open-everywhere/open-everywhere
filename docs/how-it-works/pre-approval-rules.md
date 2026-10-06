# Pre-approval rules

**Admin-authored prose that tells the approval judge which actions your org treats as routine.**

The [approval judge](../security/security-model.md) decides the residue of actions that no written
rule resolved. On its own it sees the action facts and the standing posture only. It does not know
that your org treats a docs-only pull request as ordinary. Pre-approval rules are the channel that
tells it, in your own words.

**In `enforce` mode, the shipped `approvals.judgeMode`, a rule is the only thing that lets a gated
act run without a card.** The judge allows an act only when it cites a rule that this scope really
carries. An allow that cites no rule is an `ask`, so a person decides. Every act that ran without a
card therefore traces to a sentence an admin wrote and a reviewer read.

A rule is curated context for one decision. It is not a verdict, and it is not a chain element.

---

## 0. What a fresh install does

A scaffolded app runs the judge in `enforce` mode and ships four starter rules in
`agent/access/pre-approval-rules.ts`, bound at org scope by the `approval-policy` bundle in
`agent/access/bundles.ts`. Edit them there, review the change, and deploy it.

| Rule id | What it pre-approves | Why it is low-risk |
|---|---|---|
| `pr-asked-for-here` | Opening a pull request that the requester asked for in this turn's messages, whose repository, branch and title match the ask. | The tool reaches only the repositories granted to the room. A pull request does not merge itself, but whether a merge needs a review is the repository's own branch protection, so the rule does not count on one. A request that came only from fetched or quoted content gets a card. |
| `routine-reports-here` | Creating a routine that the requester asked for in this turn's messages, whose prompt and schedule match the ask, that reports back to this conversation, and that runs at most once an hour. | It posts only where it was asked for. Each fire costs model calls, so the rule stops at an hourly rate. A routine that declares a standing write never reaches the judge (§4). |
| `access-request-asked-for` | Sending an access request that the requester asked for in this turn's messages, for the access they named. | A request is not a grant. It notifies the admins, and the access starts only when an admin merges it. |
| `connector-write-asked-for-here` | A connector write (a Notion page, a Linear issue) that the requester asked for in this turn's messages, whose arguments match the ask, and which only creates or updates content in the workspace the domain connected. | Code keeps the risky connector calls on a card before the judge sees them (below). The rule adds what a model can read: a person asked in this turn, the call matches the ask, and nothing leaves the room. It does not cover a call that sends a message or an email, shares or publishes content, or invites or notifies people outside the conversation. An allow runs that one call only. |

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
plausibly cover it. Write rules that name the act and its arguments, not only that a person asked. On a tainted turn the taint floor still turns a judge allow on `create_routine` back into
a card (§4).

Whether a rule covers an act is the judge **model's** reading of the rule against the act. The
parts that do not depend on that reading are code: the citation must name a rule this scope
carries, the human-only class never reaches the judge, and the clamps run after it (§4).

**What always gets a card.** Some acts never reach a rule:

- every admin act — a spend limit, a connector override, lifting a halt, an admin memory read;
- a routine that declares a standing write;
- erasing remembered facts (`purge_memory`). An erasure cannot be undone, so it is human-only in
  code: the judge is not consulted, and no rule can lift it;
- every verb that is not defer-flipped (§4);
- every connector op except a write that runs with the domain's credential. A destructive op (a
  delete, an archive), an op on a person's own account, a write in an unattended run, a write in a
  turn that read external content, a write in a room that does not belong to exactly one domain, and
  a write whose input is too long for the card to show in full all keep the connector card. Code
  decides this before the judge, so no rule can change it.

**An allow covers one act.** The judge's cached allow is kept per session and keyed on the act's
whole arguments, the requester and whether the turn is unattended. So a cached allow answers only
for the same act, asked by the same person, in the same kind of turn. Any other act is judged again,
even in the same session. A judge allow of a connector write also writes no approval for a later
call, so it runs that one call only. Only the judge lifts a connector card: an operator approver that
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
> The store has no runtime write path. There is no tool, no command and no function that writes a
> rule — the invariant holds because there is nothing to guard. The one path by which the agent
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
| **The clamps** | Modes, the taint floor and the unattended clamp run *after* the judge. They still tighten a rule-driven allow exactly as they tighten any other. |
| **The human-only class** | Every admin act (a `gate:admin` row, such as `set_spend_limit`) needs a person's click, and so does erasing remembered facts (`purge_memory`). So does a routine whose creation card declares a standing write — `pr.open`, or a connector tool that is not a read ([declared permissions](../capabilities/proactivity-and-routines.md)). The judge is not consulted for either, so no rule can lift them, and the verdict row records `source: "human-only"`. |
| **The connector fence** | A connector card reaches the chain only for a `write`-tier op on the domain's credential, in an attended turn that read no external content, in a room with exactly one domain, with an input the card shows in full (`access/approver-chain.ts` `judgedConnectorOpTool`). Every other connector card keeps its old road and never meets the judge. A judge allow runs that one call, and only the judge can lift the card. |
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

---

## See also

- [Access & scoping](./access-and-scoping.md) — the scope ladder these rules resolve on.
- [Config-as-code](./config-as-code.md) — why the config repo's review pipeline is a gate.
- [The security model](../security/security-model.md) — the approval judge and its bounds.
- [Audit & provenance](../security/audit-and-provenance.md) — reading the verdict rows.
