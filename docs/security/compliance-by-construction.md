# Compliance by construction

Open Everywhere holds no certification. It is not a hosted service, so there is no audited
operator, no SOC 2 report and no trust centre. Nothing on this page is a substitute for one.

What a self-hosted deployment *does* give you is a set of controls that hold because of how the
code is built, not because an operator promises to run it a certain way. This page lists those
controls. **Every row names the file that enforces it and the gate that proves it**, so you can
check each claim against this repository rather than against us. Where a control is narrower than
the sentence a vendor would write, the row says so.

Read [Security model](./security-model.md) for the threat model these controls sit inside, and
[Honesty ledger](./honesty-ledger.md) for what the agent still cannot do.

## What "by construction" means here

A control is structural when removing it breaks a build, a lint or a test — not when a runbook says
not to remove it. Every row below is structural in that sense. A property that depends on how you
configure or operate your deployment is listed under [What is yours to
decide](#what-is-yours-to-decide) instead, because calling it structural would be false.

## The controls

### Egress is default-deny, and credentials stay out of the sandbox — with two recorded exceptions

Resolved access compiles to a sandbox `NetworkPolicy` in which every host that is not explicitly
allowed is denied — an empty allow set compiles to `deny-all` rather than to nothing. A credentialed
host gets an allow rule whose `transform` injects the auth header **at the firewall**, so the secret
is not present in the sandbox process that the model drives. Two narrow windows are the exception,
and the [honesty ledger](./honesty-ledger.md#known-limitations) records both: the short-lived write
token for a proposed PR branch rides inline in the sandbox's own `git` push command, and wherever
the firewall is not actually enforced the read-only checkout token is written into the clone's
`git` config instead of injected at the firewall. The second window opens on a backend that cannot
apply a fine-grained policy, and on any backend running the policy in dry-run
(`egress.enforce: false`) — the gate is whether the policy applied, not which backend is under it.

- Enforced by: `packages/core/agent/access/egress.ts`, with the resolved network-access level in
  `packages/core/agent/access/network-access.ts`.
- Proved by: `npm run test:egress`, `npm run test:network-access`, `npm run test:self-host-egress`,
  `npm run test:egress-proxy`.
- 🔴 **Three things narrow this, and an assessor should ask about all three.** A binding that
  resolves `networkAccess: "full"` adds a `"*"` catch-all and the deny stops meaning anything (the
  default is `none`, `access/network-access.ts`). And the policy is *enforced* only where a firewall
  applies it. That is the Vercel Sandbox natively. Off Vercel, it is the egress-proxy sidecar the
  default `docker()` backend runs beside the sandbox. The deployment arms that proxy by setting
  `OE_EGRESS_PROXY_URL`. Unarmed, `docker()` takes only the coarse allow-all/deny-all strings, and
  the dev-only `justbash` backend rejects a network policy outright. And `egress.enforce: false`
  puts the session in dry-run. The policy is compiled and audited, never applied, so the session
  runs unfirewalled. A `deny-all` produced by a compile error is applied even then. The compilation
  is structural. The enforcement depends on where you run and what you declared. See
  [Security model](./security-model.md) for the per-backend picture.
- 🔴 **A failed apply refuses the turn, and two settings turn that off.** At `session.started` a
  rejected policy apply refuses the turn with `ctx.cancel()`, so the agent never runs a turn
  unenforced — the platform's own session default is allow-all, so an unenforced session is an
  unfirewalled one. The hook does not throw, because eve logs and swallows a hook's throw
  (OPE-2249, `agent/hooks/control-refusal.ts`). A failed turn-level re-apply refuses the turn too
  when no policy is in force yet. It only logs when the new policy covers the one still in force.
  When the new policy narrows it, the turn is refused instead (OPE-2158,
  [Revocation latency](./revocation-latency.md)).
  `egress.allowUnenforced: true` restores warn-and-continue at session start. `egress.enforce:
  false` reaches the same end earlier: it attempts no apply at all, so there is no failure to abort
  on. A deployment that sets either one has opted out of this row (`agent/hooks/egress.ts`).
- Read: [Credentials & the two planes](./credentials-and-planes.md).

### A connector credential is fenced to the hosts it declares

At token-mint time the connector transport refuses to hand back a token when the connection's
`directUrl` host is outside the bound credential's declared `endpoints.hosts`. It is live in this
tree: the Notion and GitHub credentials in `agent/access/connector-credentials.ts` declare
`endpoints` (and the Notion ones narrow `pathPrefixes` and `methods` as well).

- Enforced by: `assertCredentialEndpointHostAllowed`
  (`packages/core/agent/access/credential-endpoints.ts`), called from
  `packages/core/agent/connections/connector-auth.ts` and reached through
  `connections/connector-transport.ts`.
- Proved by: `npm run test:connector-transport-host-fence`, `npm run test:credential-narrowing`.
- 🔴 **It is an operator narrowing, not a floor.** `endpoints` is optional and **absent means
  unnarrowed** — a credential that declares none reaches the vendor's whole API, exactly as before
  the module existed. There is no lint requiring one, because there is no per-vendor path inventory
  to lint against. So the right question is not "is the fence on" but "which of my credentials
  declare rules".

### The audit record is hash-chained

Every audit row stores the sha256 of the preceding row for the same org. A verifier walks the chain
and recomputes each link, so a deleted middle row or a mutated field surfaces as a chain break. The
hash commits to who, where, when, what and the payload — not to a chosen subset.

- Enforced by: `packages/core/agent/audit/chain.ts`, under the append-only Postgres policies in
  `packages/core/agent/operational/postgres.ts`.
- Proved by: `npm run test:audit`, `npm run test:audit-chain-serialisation`,
  `npm run test:verify-audit-chain-cli`.
- 🔴 **It is tamper-DETECTABLE, not publicly tamper-EVIDENT.** Nothing outside the deployment
  witnesses the chain head today, so an owner credential that rewrote history *and* re-chained it
  would leave the walk clean. An external anchor is named as deferred in `chain.ts` itself.
- Read: [Audit & provenance](./audit-and-provenance.md).

### Reach is declared in Git, and an undeclared tenant is refused at boot

A domain's `reach` is the set of surfaces the agent serves, and it is a tracked literal. A
deployment that declares more than one tenant of a tenant-scoped platform fails config load rather
than degrading at runtime, because two people sharing one principal key produces no error anywhere
— it produces the wrong answer to "is this an admin".

- Enforced by: `packages/core/agent/access/tenant-admission.ts` and
  `packages/core/agent/identity/principal-key.ts`.
- Proved by: `npm run test:tenant-admission`, `npm run lint:principal-key`, `npm run test:boot`.
- Read: [Access & scoping](../how-it-works/access-and-scoping.md).

### Behaviour lives in Git, never in an environment variable

A vouch list, a domain roster, a room key, a workspace id and a trust declaration are all tracked
literals: they live in typed code under `agent/**` and change by pull request. Environment keeps
infrastructure only — connection strings, and the bootstrap credentials that reach a store. The
deployment's own identity obeys the same rule and is declared in `agent/identity/surfaces.ts`.

- Enforced by: `agent/settings/settings.ts` and `scripts/env-read-allowlist.ts`.
- Proved by: `npm run lint:env-docs`, `npm run test:env-read-allowlist`,
  `npm run test:deployment-identity`, `npm run lint:ambient-env`.
- 🔴 **The allowlist checks that a name is declared, not that it should be.** Two shipped changes
  added a roster to environment and passed this lint, because each added its own allowlist entry
  beside the read. The gate is a record of a decision, not a substitute for making one.
- Read: [Config-as-code](../how-it-works/config-as-code.md).

### A consequential act needs a human, and which acts those are is a table

Every tool carries a declared consequence, and the approver chain routes a consequential act to a
human decision. The mapping is a table in code, not a judgement made per call, and lints refuse a
new sink that joins the tree without an entry.

- Enforced by: `packages/core/agent/access/consequence.ts`,
  `packages/core/agent/access/approver-chain.ts`, and the approvals plane under
  `packages/core/agent/approvals/`.
- Proved by: `npm run lint:consequence`, `npm run lint:human-only-invariants`,
  `npm run lint:access`, `npm run test:approver-chain`, `npm run test:approvals`.
- 🔴 **"A human" includes a human who decided in advance, and an assessor should ask which.** Three
  routes reach an act without a fresh decision: an auto-approve arrow, a **pre-approval rule** an
  admin wrote for a scope, and a **standing grant** — including the per-routine permission a click
  arms so an unattended 03:00 fire is not left waiting on a card nobody will see. Each is recorded
  and revocable, and none of them is a human looking at that act. What is structural is that the
  act reaches the chain at all, and that its consequence is a table rather than a per-call
  judgement.
- Read: [Pre-approval rules](../how-it-works/pre-approval-rules.md).

### There is a break-glass halt, and it fails closed

One halt question is asked at every enforcement arrow. Every arrow fails CLOSED: a store it cannot
read answers "halted", because a control whose reader fails open is a control an incident can switch
off by breaking the database. The lift path fails open in the same failure, so a halt can never
block its own removal.

- Enforced by: `packages/core/agent/access/halt.ts` and
  `packages/core/agent/access/halt-state.ts`.
- Proved by: `npm run test:halt`, `npm run test:approver-chain-flow`.
- 🔴 **A halt stops consequential acts; it does not take the agent off the air, and it does not stop
  reading.** A consequential act is one whose effect escapes the conversation, so a halted deployment
  still reads, still talks, still delegates a read, still puts a file into the asking room, and still
  keeps the conversation in memory. **Two arrows are the exception and every halt text names them:**
  the connector credential wall refuses any op through a connected integration, read verbs included,
  and `assertEgressReach` refuses `describe_image` on a URL. A halt paragraph claiming a wider reach
  than the arrows enforce is a refusal generator, which is what the soak run of 2026-09-12 measured
  (OPE-1758).
- 🔴 **The host says that it is halted, not the turn.** The chat `halt` posts the confirmation
  itself, and the `admin.halt.set` row carries `announced`. A brake defended on being LOUD cannot
  leave the announcement to the model.

### The agent cannot edit its own guardrails

A change that touches the access plane, the approvals plane, the audit chain, the mint bodies, the
merge-gate surface or the fence itself is refused by the pre-merge fence, whoever authored it. The
fence does not read the author, so no identity exempts a diff from it. The protected set is one
tracked list, and the fence is extracted from the pull request's **base** ref, so a diff cannot
weaken the copy that judges it.

- Enforced by: `scripts/upgrade-fence/manifest.ts`, `scripts/upgrade-diff-fence.ts` and
  `scripts/deploy/merge-fence*.ts`.
- Proved by: `npm run test:upgrade-diff-fence`, `npm run test:deploy-merge-fence`,
  `npm run test:deploy-merge-attest`.
- 🔴 **This is the weakest row on the page, and it is here because the refusal is real, not because
  the gate is.** The fence runs as a rung a person invokes before merging; its refusal is
  **overridable** by a reviewed override, and this repository has no CI, so nothing stops a merge
  made from the GitHub UI without running it. It becomes a gate only behind a branch-protection
  rule, which a person must add — and repository admin rights bypass even that. What the fence
  structurally guarantees is that the review happens, never that the review was good.
- Read: [The upgrade diff fence](./self-upgrade-fence.md).

### A number a document states is checked against the code

A number that a tracked document states **and that this registry names** must be the number the code
holds, and a document that quietly stops stating a registered number goes red too.

- Enforced by: `packages/core/agent/docs/counted-claims.ts`, driven by
  `scripts/counted-claims-lint.ts`.
- Proved by: `npm run lint:counted-claims`, `npm run test:counted-claims`.
- 🔴 **The registry is OPT-IN, so this is a habit with teeth, not a total property.** It checks the
  claims somebody registered — a number nobody registered is not checked at all, including several
  on this page. Read a checked number as verified and an unchecked one as prose.

## What is yours to decide

These matter to an assessor and are **not** structural. They are configuration, and the deployment
that runs them is yours.

| Property | Where it is decided | What this repository does |
| --- | --- | --- |
| **Data residency** | Your gateway's routing and your sandbox region | Both legs are pinnable, and the sandbox region is asserted by `npm run test:sandbox-region`. See [Models & the AI Gateway](../extending/models-and-gateway.md). |
| **Zero data retention** | Your gateway, as an org policy | 🔴 Open Everywhere sets **no** per-call ZDR flag, and that is deliberate — a per-call pin on a model with no ZDR-attested route turns a governance option into an outage. The gateway is the layer that knows which upstreams are attested. |
| **"Nobody trains on your data"** | Your gateway and your model providers | Open Everywhere enforces nothing here and claims nothing. It is a self-hosted client: it sends what you route where you route it. The claim is your providers' to make, in their terms. |
| **Retention of your own rows** | Your operational store | Audit, usage and spend rows live in your database. The audit record has **no delete path** in this tree — see [Audit & provenance](./audit-and-provenance.md). 🔴 The default store deletes no usage or spend row either: retention is your own job on the database — see [Spend & cost controls](./spend-and-cost.md#per-event-usage-capture). |
| **Who may act** | Your `agent/access/` config | Bundles, grants and credential bindings are yours to write, and a per-binding expansion is a guardrail change that the fence holds. |

## Using this page in an assessment

Each row above answers a question an assessor asks, and answers it with a file rather than an
assurance. The honest framing is: *this deployment is operated by us, and here is what the software
makes impossible regardless of how we operate it.* That is a different claim from a certification,
and it is narrower. It is also checkable, which a certification is not.

If a row here ever overstates what the named file does, that is a defect in this page. Correct the
page in the same change that corrects the code.
