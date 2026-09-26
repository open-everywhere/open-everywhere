# Pre-approval rules

**Admin-authored prose that tells the approval judge which actions your org treats as routine.**

The [approval judge](../security/security-model.md) decides the residue of actions that no written
rule resolved. On its own it sees the action facts and the standing posture only. It does not know
that your org treats a docs-only pull request as ordinary. Pre-approval rules are the channel that
tells it, in your own words.

A rule is curated context for one decision. It is not a verdict, and it is not a chain element.

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
| **Arming** | The deployment must set `approvals.judgeMode` to `enforce`. Rules change nothing otherwise. |
| **Deny** | A deny from any element, or from the judge itself, is absolute and skips everything. |
| **The clamps** | Modes, the taint floor and the unattended clamp run *after* the judge. They still tighten a rule-driven allow exactly as they tighten any other. |
| **The human-only class** | A routine whose creation card declares a standing write — `pr.open`, or a connector tool that is not a read — is armed by a person's click only. The judge is not consulted for it, so no rule can lift it ([declared permissions](../capabilities/proactivity-and-routines.md)). |

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
| `ruleCitation` | `matched`, or `unmatched` when the judge named a rule that does not exist. |

So "which authored rule let this run without a card?" is one query, and an allow that matched no
rule carries no id — the field says something precisely because it is not always there.

### The fence against invented rules

The model writes the citation, so a fabricated id is the obvious way to launder an allow. The
citation is therefore **validated against the rules that run actually supplied**:

> An allow citing a rule id that is not in the scope's authored rules is **degraded to `ask`**.

That fails closed to a human, which is the same card the verb produced before its defer flip. The
bad citation stays on the audit row as `ruleCitation: "unmatched"`, so the attempt is queryable.

The judge's allow cache carries the same discipline. A cached allow keeps its rule id, so a cache
hit is as traceable as a fresh consult. A cached allow is dropped when the resolved rule set
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
