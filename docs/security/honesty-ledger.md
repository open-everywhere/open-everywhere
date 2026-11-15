# Honesty ledger

A security posture is only as good as its honesty about where it stops. The
[security model](./security-model.md) states what Open Everywhere enforces and where. This page
states two other things plainly: which decisions the agent is **structurally unable** to make for
itself, and which real gaps stand open today.

Every item below is anchored to something you can check yourself — a doc, a code comment, or a
line of shipped behaviour. Nothing here is a guess about a future release, and nothing is a hole
stated without its mitigation. This page is curated, not exhaustive: a limitation earns a place
here when it is real, current, and worth a security reviewer's time. To report a vulnerability
rather than read about a known limitation, see [`SECURITY.md`](../../SECURITY.md).

## What the agent can never do itself

Three decisions sit outside the agent's own reach, on purpose. Each one **authorises future agent
behaviour**, so the decision has to come from somewhere the agent cannot write to — otherwise the
agent would be authorising itself.

- **Grant and configuration changes.** Bundles, domains, connector grants, and the registry of
  which rooms count as internal are all **config-as-code**: they live in your git repo and change
  only through a reviewed PR. The agent can *propose* a widening — an access-request opens a PR
  against the grants file for a human to merge — but there is no runtime call that writes a grant,
  a domain membership, or the internal-room registry directly. See
  [Access & scoping](../how-it-works/access-and-scoping.md) and
  [Access requests](../how-it-works/access-requests.md).
- **Who a turn is acting for.** The identity a gated action checks is resolved by the host, from
  platform-verified message data, before any model call runs — never from anything the model
  writes. A delegated worker is handed its asker on the same channel its other stamps ride on, and
  that stamp wins over anything the worker's own opening instructions say. No tool call, and no
  wording in a message, can make a turn act as someone else. See
  [Security model § Approval gates](./security-model.md#4-approval-gates-are-governance-not-a-crutch).
- **Approval verdicts.** A tool can *propose* a gated action; it cannot decide one. The decision
  comes from a human's button click, or — only on a deployment that has explicitly armed it — a
  separate, reasoning-blind reviewer that never sees the proposing session's own reasoning or tool
  output. The session that proposed an action can never grade its own proposal. See
  [Security model § The unified approver chain](./security-model.md#the-unified-approver-chain).

## Known limitations

- **Stopping a turn does not undo it.** Every surface has a stop control and an acknowledgement
  naming what had already run, but the model's history only rolls back to the last completed step:
  tool calls inside the interrupted step already ran and are not undone, and a sandbox shell
  command already in flight cannot be killed. See
  [Stopping a turn](../how-it-works/agent-and-loop.md#stopping-a-turn).
- **The upgrade diff fence cannot make itself run.** It refuses any pull request that changes the
  access plane, the approvals plane, the audit chain, the mint's permission sets, `agent/access/`,
  `scripts/deploy/`, the fence itself, or a security lint driver — whoever
  authored it. The authorship test it used to apply was removed at OPE-1315: it armed on the pull
  request's author and on a forgeable trailer, and neither fired for an agent that opened its
  pull request under a person's GitHub token, so an agent's access-plane diff read as a person's. What
  refusing everything costs is that a person's hand-written config change also needs an
  explicit review-and-override; what it buys is a rung that cannot misclassify. On
  this repo `npm run deploy:merge-fence` is invoked by a session following its own run definition,
  so a session that skips the rung merges unjudged. A second rung narrows that:
  `npm run deploy:merge-attest -- --pr <n> --fence` runs the same base-ref fence **outside** the
  judged session and posts the verdict on the head as the `oe/upgrade-fence` commit status, so a
  head no rung judged carries no status. It closes the gap only where the default branch requires
  that status — a person adds the protection rule, and `--require-protection` refuses to post an
  attestation that would gate nothing.
  A deployment whose runner is a GitHub Actions workflow has the matching gap — Actions runs the
  head's workflow, so a pull request can delete the step that judges it — and closes it by not
  naming the `workflows` capability on the upgrade binding and by making the check required through
  branch protection. See [The upgrade diff fence](./self-upgrade-fence.md).
- **The pre-merge fence's reads are not bound to one another (accepted, OPE-1246).** `runMergeFence`
  makes several GitHub reads. Only the FIRST is tied to a sha: the pull-request record, whose
  `head.sha` must equal the caller's own `git rev-parse HEAD`, and a disagreement refuses. The
  changed-file list and — since OPE-1226 — the commit list are read separately, and neither read
  names the sha the rung then clears. A force-push landing between those reads makes the rung judge
  a file list or a commit list that need not belong to the sha it clears. This is accepted rather
  than fixed, for two reasons. The window is one short round trip, and the only person who can push
  into it is the branch's own author, who can equally push the clean version and re-run — so the
  gap buys an attacker nothing they do not already have. And the bound version is a real change to
  two code paths: `GET /repos/{o}/{r}/pulls/{n}/commits` takes no sha parameter, so binding it means
  moving to the compare endpoint over `base.sha...head.sha`. The property has held since OPE-1172;
  OPE-1226 widened it by one read rather than introducing it. Re-open it if the fence ever runs
  somewhere the pushing author is not the person the rung is protecting against.
- **Prompt injection is bounded, not prevented.** Open Everywhere does not try to stop a model from
  being talked into *attempting* something by hostile text in a message, a page, or a connector
  result. It fences untrusted content as data and relies on egress scoping and approval gates to
  bound what an induced attempt can actually reach. One body of text escapes the fence entirely:
  provider-executed web-search results are consumed inside the model call itself, so no in-tree
  wrapper can touch them — the only mitigation there is a standing instruction. See
  [Security model § The threat model](./security-model.md#the-threat-model-in-one-breath).
- **Two narrow exceptions to "a credential never enters the sandbox."** The rule holds for every
  read credential on a fully enforced backend, and for the whole connector plane. Two windows are
  narrower. First: the short-lived write token used to push a proposed PR branch rides inline in
  the sandbox's own `git` command for that one push. It stays in memory only and is never
  persisted, but it does ride inside the process for that window, unlike the read token. Second:
  wherever the firewall is not actually enforced, even the read-only checkout token falls back to
  being written into `git`'s own config instead of injected at the firewall. The gate is
  `isEnforced()`, stamped from whether the policy APPLIED. So the window opens on a sandbox
  backend that cannot enforce a fine-grained network policy, and on ANY backend running the
  policy in dry-run (`egress.enforce: false`). Vercel Sandbox, and Docker paired with Open
  Everywhere's own egress-proxy, do enforce — they carry the second exception only in dry-run.
  Eve's own `microsandbox` would carry it always: it enforces host-grain allow/deny natively, but
  at-boundary credential injection silently does not happen there (measured, OPE-917). It is not a posture a deployment can reach —
  the setting `sandbox.selfHostBackend` takes `"docker"` or `"justbash"` and refuses to boot on anything else — so the
  measurement is a finding held open by that refusal rather than a live exception on a shipped tier.
  See [Source-control backends](../extending/source-control-backends.md).
- **Plain Docker self-hosting is a different isolation class from the Vercel tier.** Vercel Sandbox
  isolates a session in a hardware-virtualised microVM. Plain Docker isolates by
  container only — process and namespace isolation, not a hardware boundary — and its own network
  policy is coarse (allow-all or deny-all) unless paired with Open Everywhere's egress-proxy sidecar
  to restore the fine-grained firewall property. The two are not interchangeable postures: pick the
  tier deliberately. See [Sandbox](../extending/sandbox.md).
- **The unified cross-surface window ships off.** The single shared conversation that follows a
  person across Slack, Discord, Teams, Notion, GitHub and Linear is a deliberate opt-in, not the
  shipped default. A fresh self-host starts single-surface until an operator turns it on.
- **Positively identifying a non-member author is uneven across surfaces.** Whether a chat
  message's author can be *positively* confirmed as an outsider — which decides whether shared
  memory engages and whether a read withholds that author's text — depends on
  what the platform's API can answer. Slack, Linear and GitHub can each refute a non-member
  positively; Microsoft Teams can, when a roster lookup succeeds; Discord and Notion cannot refute
  an author at all. On the surfaces that can't, the deployment relies on an operator's own
  declaration of who counts as internal rather than a platform-verified fact. See
  [Security model § Tenant isolation](./security-model.md#3-tenant-isolation--one-team-never-reads-another).
- **No ONE artefact answers "what can this domain see," from the domain's own point of view.**
  The information — sources, grants, connectors, memory silos, member roster — lives entirely in
  reviewed config, so it is knowable, and three outputs each render part of it.
  `npm run access:preview` prints a scope's resolved domain, reachable hosts, credentials, repos,
  plugins, skills, subagents, connectors and instruction stack, with the compiled firewall policy.
  `memory_admin_list` enumerates org → domains → silos → files. On a cross-surface window,
  `unified_domain_audit` gives the domain-grain view, the read-across exposure map and the domain's
  admins. What no single output carries is all of it at once for an ordinary domain, member roster
  included. A reviewer still joins the three by hand.
- **No public capability manifest.** Which of the agent's uniform actions a given platform actually
  honours (posting mid-turn, reacting to a message, and so on) is declared per adapter in
  `packages/providers/<id>/agent/surface-parity.ts` and published as generated tables in
  [the chat-surface contract](../extending/chat-surface-contract.md), which
  `npm run lint:surface-parity` keeps joined to those declarations. What is missing is a stable,
  machine-readable **address**: a Markdown matrix in this repository is not something an outside
  integrator can query.
- **Source control is GitHub-only today.** The plane that clones a repo, commits, and opens a PR
  under the agent's own bot identity is hardcoded to a GitHub App. GitLab and Bitbucket are a real,
  designed seam — not a shipped one. See
  [Source-control backends](../extending/source-control-backends.md).
- **The audit chain proves tampering to the operator, not to an outside party.** Every row is
  hash-chained to the one before it, so an operator with read access can detect a rewrite or a
  deleted row. What doesn't exist yet is anchoring the chain to a witness outside the operator's own
  control — so a full owner-rewrite of the whole history is, today, undetectable to someone who
  isn't the operator. See
  [Audit & provenance § Properties that make the log trustworthy](./audit-and-provenance.md#properties-that-make-the-log-trustworthy).

This ledger is a living page: a limitation that gets fixed is deleted, not marked "resolved" —
the doc states what is true now.
