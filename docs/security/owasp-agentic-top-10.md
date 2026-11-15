# OWASP Top 10 for Agentic Applications (2026)

The OWASP GenAI Security Project published the
[Top 10 for Agentic Applications](https://genai.owasp.org/) in December 2025, with the identifiers
`ASI01` to `ASI10`. This page maps each risk to the Open Everywhere control that answers it, the
file that enforces the control, the gate that proves it, and the gap that stays open.

The list is a taxonomy, not a certification. A row here says what the code does. It does not say
that a deployment is "OWASP compliant", and no such status exists. Read the
[Security model](./security-model.md) for the threat model, and
[Compliance by construction](./compliance-by-construction.md) for the controls in more depth.

| ID | Risk | The control that answers it | The gap |
| --- | --- | --- | --- |
| ASI01 | Agent goal hijack | Untrusted content is fenced as data, and a turn that read it is tainted | A fence is a signal to the model, not a proof |
| ASI02 | Tool misuse and exploitation | Every agent tool has a declared consequence, a connector operation is tiered by its verb or its server's read-only hint, and the approver chain routes a consequential act to a human | A standing grant or a pre-approval rule skips the fresh decision; a connector card has no approver-standing check |
| ASI03 | Identity and privilege abuse | Per-person bindings, credentials outside the sandbox, credentials fenced to their hosts | A credential with no declared `endpoints` reaches the vendor's whole API |
| ASI04 | Agentic supply chain vulnerabilities | The roster lock refuses an unreviewed contribution, and MCP servers are declared in Git | No signature check on packages or on model weights |
| ASI05 | Unexpected code execution | Code runs in a sandbox with default-deny egress | The enforcement depends on the host and two settings |
| ASI06 | Memory and context poisoning | Memory is partitioned per domain, writes are fenced, and edits carry provenance | No content check on what an authorised writer stores |
| ASI07 | Insecure inter-agent communication | Inbound A2A callers are declared and authenticated; a peer's answer is untrusted | Only declared peers; no message-level signature |
| ASI08 | Cascading failures | Spend caps, a fail-closed halt, the stall guard and the loop breaker | Caps fail open and bound cost only |
| ASI09 | Human-agent trust exploitation | Approval cards are host-rendered with cleaned values, and the audit log records what the agent did | Model-authored values still appear; a card cannot make a person read it |
| ASI10 | Rogue agents | Stop, halt, the hash-chained audit log, and a fence the agent cannot edit | The fence is a review rung, not a CI gate |

## ASI01 — Agent goal hijack

**The control.** Content from outside the trust boundary is wrapped in an
`<untrusted_external_data>` envelope with a fresh nonce, so the model reads it as data
(`packages/core/agent/access/untrusted.ts`). The ingestion marks the turn as tainted
(`packages/core/agent/access/taint-enforcement.ts`), and the approval card discloses that. A
consequential tool asks a human through its registry tier on every turn; no approval verdict reads
taint (OPE-2716). The tool-set projection applies the same fence to connector and MCP results before each model
call (`packages/core/agent/access/untrusted-projection.ts`).

- Proved by: `npm run test:untrusted`, `npm run test:untrusted-projection`, `npm run test:taint`.
- **The gap.** An envelope tells the model what is data. It does not stop a model that ignores it,
  which is why the approval chain exists beside it. Since OPE-2716 that chain does not tighten on a
  tainted turn: a lowering (a config allow, an armed judge) applies whatever the turn read. Provider-executed web search runs at the provider, so
  no in-tree seam can fence its results.

## ASI02 — Tool misuse and exploitation

**The control.** Each agent tool carries a declared consequence in one table, and lints refuse a new
agent tool with no entry (`packages/core/agent/access/consequence.ts`). A connector or MCP operation
has no row there: it takes its tier from the verb in its name. An unknown verb is gated, unless an
org-admitted MCP server marks the tool read-only (`readOnlyHint`), which opens that one tool. The
approver chain routes a consequential act to a human decision
(`packages/core/agent/access/approver-chain.ts`).

- Proved by: `npm run lint:consequence`, `npm run test:approver-chain`, `npm run test:approvals`.
- **The gap.** Three routes reach an act without a fresh decision: an auto-approve arrow, a
  pre-approval rule, and a standing grant. Each is recorded and revocable
  ([Compliance by construction](./compliance-by-construction.md#a-consequential-act-needs-a-human-and-which-acts-those-are-is-a-table)).
  A connector or MCP operation's approval card carries no approver-standing check: whoever can click
  the card can approve it (`packages/core/agent/access/consequence.ts`).

## ASI03 — Identity and privilege abuse

**The control.** Each session runs under one platform-neutral identity, mapped from the platform's own (`packages/core/agent/identity/binding.ts`).
A secret is injected at the firewall, so the sandbox process does not hold it
(`packages/core/agent/access/egress.ts`). A connector credential refuses to mint for a host outside
its declared `endpoints` (`packages/core/agent/access/credential-endpoints.ts`). A second tenant of a
tenant-scoped platform fails config load (`packages/core/agent/access/tenant-admission.ts`).

- Proved by: `npm run test:egress`, `npm run test:connector-transport-host-fence`,
  `npm run test:tenant-admission`.
- **The gap.** `endpoints` is optional, and a credential that declares none reaches the vendor's whole
  API. Two narrow windows put a token in the sandbox; the
  [honesty ledger](./honesty-ledger.md#known-limitations) records both.

## ASI04 — Agentic supply chain vulnerabilities

**The control.** `roster.lock.json` records every contributed tool, skill and slot. `oe build --check`
refuses a contribution the lock has not reviewed, and there is no bypass flag
(`packages/core/agent/scaffold/roster-plan.ts`). MCP servers are declared in
`agent/access/mcp-servers.ts`, in Git. The eve runtime is pinned to one version in `package.json`.

- Proved by: `npm run lint:roster`, `npm run test:roster-build`, `npm run test:mcp-servers`.
- **The gap.** Open Everywhere checks what a package contributes, not who built it: there is no
  signature check beyond npm's lockfile integrity hashes. The model's weights are the provider's.
  `models.dataPolicy` sets terms for the provider; it does not verify the model.

## ASI05 — Unexpected code execution

**The control.** The agent's code runs in a sandbox: the Vercel Sandbox on Vercel, and a Docker
backend off it (`packages/core/agent/sandbox/backend-select.ts`). The sandbox's network policy is
default-deny, and an empty allow set compiles to deny-all (`packages/core/agent/access/egress.ts`,
`packages/core/agent/access/network-access.ts`). A failed policy apply refuses the turn.

- Proved by: `npm run test:egress`, `npm run test:sandbox-backend`, `npm run test:self-host-egress`.
- **The gap.** A binding that resolves `networkAccess: "full"` opens every host.
  `egress.enforce: false` runs the policy in dry-run, and `egress.allowUnenforced: true` lets a session
  run when the backend cannot apply it. Off Vercel, a host allow-list is enforced only by the
  egress-proxy sidecar in front of the `justbash` backend; the `docker` backend applies only the coarse
  deny-all (`packages/core/agent/access/self-host-egress.ts`).

## ASI06 — Memory and context poisoning

**The control.** Memory is partitioned by domain, so one team's memory is not another's context
(`packages/core/agent/memory/partition.ts`). A write into a silo the session does not own is refused
at the tool (`packages/core/agent/memory/write-fence.ts`). A human edit carries a provenance mark, so
the dream cycle does not propose to correct it away (`packages/core/agent/memory/provenance.ts`).
Every memory write that changes a silo goes through one road that writes an audit row
(`packages/core/agent/memory/write-road.ts`).

- Proved by: `npm run test:memory-write-fence`, `npm run test:memory-provenance`, `npm run test:audit`.
- **The gap.** Nothing checks the truth of what an authorised writer stores. A false fact written by
  a person with write access persists until someone corrects it. The audit log tells you who wrote it,
  but its row is best-effort: a write that lands while the audit store fails keeps the bytes and loses
  the row.

## ASI07 — Insecure inter-agent communication

**The control.** An inbound A2A request must authenticate as a declared caller, by a JWT verified
against that caller's declared key set or by a bearer secret compared in constant time
(`packages/core/agent/a2a/inbound/auth.ts`). Outbound, each request is pinned to the declared card's
origin and passes the reach decision and the SSRF guard (`packages/core/agent/a2a/egress.ts`). A
remote agent's answer is fenced as untrusted content and taints the turn
(`packages/core/agent/a2a/output.ts`). Subagents run inside the same deployment and the same audit
log.

- Proved by: `npm run test:a2a-inbound`, `npm run test:a2a-client`.
- **The gap.** Trust is per declared peer, over TLS. A message carries no signature of its own, so a
  compromised declared peer is trusted as that peer, and its answer is still only untrusted data.

## ASI08 — Cascading failures

**The control.** Spend caps refuse a turn over budget, per channel and per workspace
(`packages/core/agent/spend/check.ts`). The halt fails closed: a store it cannot read answers
"halted" (`packages/core/agent/access/halt.ts`). The stall guard detects a repeated identical tool
call and tells the model (`packages/core/agent/stall/guard.ts`), and the loop breaker does the same
for a repeated result (`packages/core/agent/access/loop-breaker.ts`).

- Proved by: `npm run test:spend`, `npm run test:halt`, `npm run test:stall-guard`,
  `npm run test:loop-breaker`.
- **The gap.** A cap bounds cost, and it is not a security boundary: the cap check fails open when
  the store cannot be read, an admin steps over a cap visibly, and the turn that crosses a cap
  completes (`spend/check.ts`, `spend/bypass.ts`). The stall guard only nudges: eve gives a hook no
  way to abort a turn. A failure in a third-party tool can still repeat inside the cap.

## ASI09 — Human-agent trust exploitation

**The control.** The host renders the approval card from the frozen act: code writes each sentence,
and a model-supplied value inside it is cleaned so it cannot forge markup, a mention or a link
(`packages/core/agent/approvals/card.ts`, `packages/core/agent/approvals/plain-summary.ts`). The audit log records
each act and the transcript records why, so a person can check a claim against the record
([Audit & provenance](./audit-and-provenance.md)).

- Proved by: `npm run test:approvals`, `npm run test:reply-provenance`.
- **The gap.** Some frozen fields carry model-authored text (a routine description, a connection
  name), and the approver reads it as text. A person still makes the decision. A card cannot make them
  read it, and a confident reply can still be wrong. This risk is mostly about people, and code bounds only part of it.

## ASI10 — Rogue agents

**The control.** `/oe stop` cancels a turn with no model call
(`packages/core/agent/channels/turn-cancel.ts`). The halt stops every consequential act at every
enforcement arrow (`packages/core/agent/access/halt.ts`). The hash-chained audit log records what the
agent did (`packages/core/agent/audit/chain.ts`). The agent cannot edit its own guardrails: the
pre-merge fence refuses a diff to the access, approval or audit planes, whoever wrote it
(`scripts/upgrade-diff-fence.ts`).

- Proved by: `npm run test:turn-cancel`, `npm run test:halt`, `npm run test:audit`,
  `npm run test:upgrade-diff-fence`.
- **The gap.** A halt stops acts, not reading. The fence is a rung a person runs before a merge, and
  this repository has no CI to force it
  ([Compliance by construction](./compliance-by-construction.md#the-agent-cannot-edit-its-own-guardrails)).
  The audit chain is tamper-detectable, not publicly tamper-evident.
