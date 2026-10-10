# Access requests

Widening is slow **by design** — a grant is a reviewed git change
([Config-as-code](./config-as-code.md)), never a runtime toggle. Access requests make the
slow path *ergonomic* without making it fast-and-loose: anyone in a channel can ask, the
agent turns the ask into a machine-checked delta, one tap sends it — and **an admin's
GitHub merge is the approval**. Narrowing stays instant (break-glass revoke, the
[control plane](../security/control-plane.md)); widening stays a merge.

## Three targets

A request names **which universe** it widens. All three ride the identical machinery (closed
vocabulary → frozen delta → deterministic codemod → bot-PR → merge); they differ only in who
may ask and where from.

| `target` | Universe | Who may ask | Where from |
|---|---|---|---|
| `channel` (default) | the channel's canonical `domain` scope when assigned; otherwise its standalone `surface` scope | anyone in the channel | that channel |
| `personal` | **the asker's own DM** (`principal` scope) | the asker, **for themselves only** | their DM with the agent |
| `group` | a declared [person-group](./access-and-scoping.md) — **every member's DM** | **org admins only** | a channel or a DM |

- **`personal` is self-service by construction.** The principal key is composed by the tool
  from the verified binding (`platform/<id>`, [identity](./identity.md)) and re-checked against
  the acting sender before anything is frozen — "give Bob a personal connector" is not
  expressible in the vocabulary, not merely refused. It is DM-only because the personal
  universe *is* the DM: that's where the grant lands and where it can be asked for.
- **`channel` never takes a domain name from the model.** The server resolves the asking surface
  through the canonical domain roster. A member of `payments` therefore proposes a `domain`
  binding for **every current and future room admitted by `payments`**, including rooms admitted
  by workspace or pattern rules; a room in no declared domain proposes its exact `surface`
  binding as before. The card and PR name that whole assignment before anyone can send or merge it.
- **`group` is the one address taken from the ask**, because a group isn't a room a request can
  arrive from. So it carries the standing gate — **org admin**, the same bar a domain-level
  spend cap has, since a group is org-global and no channel-derived standing bounds it — plus
  an existence check against the declared groups and the broad-group rule below.
- **A `directory:`-namespaced group can't be requested this way.** That prefix belongs to the
  machine-owned IdP-group overlay; a grant onto a directory-synced group is a hand PR.

### Domains admitted by a rule need a stated reason

A domain whose `reach` includes a whole workspace or a same-level wildcard can admit new rooms
without another binding diff. A credentialed binding there is broad under `npm run lint:access`,
so `request_access` refuses the proposal unless the ask includes a reason. That reason is
normalised and written as the binding's `allowBroad` acknowledgement, visible on the card and in
the PR. A domain containing only exact room keys gets no acknowledgement; the lint rejects a stale
or pointless one.

### Broad groups need a stated reason

`npm run lint:access` fails a credentialed binding onto a **broad** group — one holding a link-set
member (its reach grows at resolve time, with no diff anywhere) or 8+ members — unless it carries
an `allowBroad: "<reason>"` acknowledgement. So the agent **refuses a broad-group request that
gave no reason**, and writes the reason it was given through onto the binding: the requester's
own words are what the merging admin reads, and the PR that opens is one the lint lets through.
Narrow groups get no acknowledgement (the lint rejects a pointless one).

## The flow

1. **Someone asks** in a channel: *"can this channel PATCH Notion pages?"* or *"can we
   have the Linear connector here?"* — or in their DM: *"can I use the Linear connector in
   here?"* — or, from an admin: *"give the payments team the Notion connector."*
2. **The agent maps the ask to a structured delta** from a closed vocabulary (below) and
   validates it against the loaded config. Not expressible, already granted, or not
   defined? It refuses and says an admin needs to PR it by hand — no card, no request.
3. **A "Request access" card** is posted *in the requesting thread*, showing the
   one-sentence grant, the exact machine delta, the **exposure delta** (below), and — for a
   domain, personal or group grant — which universe it lands in (every room the domain admits;
   whose DM; how many members' DMs, and whether that set can grow by itself). The agent only ever
   **offers** the button; a **human
   member's tap sends the request** (two-step, so an injected session can waste at most a card in
   its own thread).
4. **The tap runs host-side**: a deterministic codemod applies the frozen delta to the
   grants overlay (`agent/access/grants.generated.ts`) on branch `access-request/<id>`, a
   **bot-PR** opens via the [source-control plane](../capabilities/source-control.md),
   the **admin channel** gets a plain notification (summary + PR link — no decide card),
   and the requesting thread is told where its PR went.
5. **The admin merges in GitHub.** That merge — behind branch protection + CODEOWNERS —
   is the entire approval machinery. Deploy the merged config (or let deploy-on-merge do
   it) and the grant is live. Closing the PR unmerged declines the request.

An unmerged PR grants nothing, so opening it *before* approval is safe: the PR is the
audit artifact and the review surface, not the gate.

### The exposure delta on the card

The moment that decides exposure is the **widening**, and that moment already has a card in front
of a human. So the card carries how far the grant reaches, *before* the tap — and the PR body
carries the same frozen sentences, so the merging admin decides on what the member read.

It says three things it can prove, and one it cannot:

- **how far the domain reaches** — how many rooms the requesting room's memory domain lists, and
  which surfaces they sit on. A domain can also admit rooms by a **rule** (a whole workspace, or a
  pattern) rather than by a list, and no offline read can name those rooms. So a domain that admits
  only by a rule says that instead of printing a count, and a domain that does both says the count
  is a **floor** — otherwise a roster of four would read as the whole answer for a domain that may
  hold every room of a workspace;
- **whether those rooms share one memory** — that is, whether the domain declares a memory silo,
  which is what makes one room's reach everyone's;
- **whether the addition is new to the whole domain**, or already reachable from another room. This
  check only ever sees the rooms the domain lists, so where a rule admits more it is reported as
  "no room this domain *lists* can reach it" rather than as a domain-wide widening it cannot prove;
- and plainly, that **Open Everywhere cannot list who else can read the source itself**.

That last line is the honest half, and the bound is deliberate. There is no cross-surface identity
join and no platform hands us a source's own reader list, so a person-level claim ("this exposes N
sources to M people") would be a number we cannot stand behind. A report that reads green because
we could see nothing is worse than no report. Where the domain cannot be read at all, the card says
so in one sentence rather than dropping the delta — a silent omission would read as an all-clear.

## The vocabulary (closed, v1)

The requesting session can only emit one of two typed shapes — validated at propose time
against the loaded config, then **frozen**:

| Delta | What it does | Guard rails |
|---|---|---|
| `widen-connection` | Add HTTP methods and/or path prefixes to a connection **already effective in the target** | Base connection snapshot frozen into the delta; unrestricted axes refuse (adding a prefix list to an unrestricted connection would *narrow*) |
| `grant-connector` | Bind a connector **this deployment already defines** to the target | Already-effective refuses; undefined refuses |

"Already effective" is always asked of the **target**, never of the room the ask came from: a
group request is planned against what that group's own bindings grant, so an admin's personal
connectors never read as the team's.

Everything else — a new host, a new credential, a new repo, a brand-new integration — is
**out of vocabulary**: the agent refuses with "an admin needs to PR this by hand".
Growing the vocabulary is a reviewed code change, never a runtime decision.

## The safety model

- **Frozen args.** The delta is validated and frozen into the pending-action row at
  propose time ([the approvals doctrine](../security/security-model.md)); everything that
  runs after the tap reads only those frozen bytes. The model is never in the effect path
  after propose time.
- **Codemod, not agentic.** The diff an admin merges is produced by a deterministic,
  idempotent codemod (`packages/core/agent/access/grants-codemod.ts`) — stable key order,
  canonical array order, byte-reproducible. No model authors any part of it post-card.
- **The single-scope invariant.** A request may only alter the *target* scope's effective
  access — one scope per codemod run, at whichever level. Enforced twice in code, and reported
  a third way: the tool
  derives the surface from the verified binding and resolves its canonical domain server-side
  (never model input, the group name excepted);
  the codemod refuses to edit any overlay bundle bound to more than one scope (it clones a
  fresh single-bound bundle instead) and never touches code bundles at all — widening works by
  cloning the connection into the target's own overlay bundle, which
  [narrowest-wins](./access-and-scoping.md) applies for that scope only; and `npm run config:diff`,
  run by hand on a PR that touches `agent/**`, reports it if any other scope's resolution changes —
  no runner invokes it today. Overlay bundles
  are namespaced per level (`grants:domain:<name>`, `grants:<surface-key>`,
  `grants:principal:<key>`, `grants:group:<name>`), and the address grammars make a collision between them
  impossible rather than unlikely. That check is the grants-overlay leg of `config:diff`
  (`scripts/access-diff.ts`), and it too runs on demand rather than on a trigger. Its
  other leg diffs the *resolved* config of any PR touching `agent/**` — so a freehand
  TypeScript edit that moves a scope's access side-on (re-rostering a domain, re-pointing a
  silo, editing a provider) is reported too, as a finding rather than a failure, since a
  hand-authored change may legitimately be broad.
- **Merge is the gate.** There is no approve button of ours on the admin side — GitHub's
  merge button, behind branch protection + CODEOWNERS on the grants overlay, is the one
  privilege gate. The member tap on the card is an injection gate (a human reads the
  exact delta), not a privilege gate.
- **Validation before the PR, and again at the merge gate.** The tap re-runs full bundle/binding
  validation on the *merged* result (code baseline + candidate overlay, plus the current merged
  domain and person-group registries). A domain deleted or renamed while its card was waiting
  refuses before a branch exists and keeps the frozen name rather than retargeting; a grant onto
  a group nobody declared likewise refuses before a PR exists. This runs before any commit or PR;
  the `config-validate` gate (`npm run validate:config`) re-loads the merged
  config and compiles the egress policy for every bound scope, fail-closed asserted.
- **The deploy backstop.** Config is fail-loud at boot, and deploys are
  **build-then-promote** (`vercel deploy --prod` builds before promoting) — a
  merged-but-broken config yields a red pipeline while the previous deployment stays
  live. Worst case is a red pipeline, never a downed agent.

## Provisioning a whole agent (`create_agent`)

`request_access` widens a channel's canonical domain, or one standalone channel when it has no
domain. Its sibling `create_agent` uses the same
propose → member-card → bot-PR → admin-merge flow to stand up a **whole channel-resident
agent** in one reviewable diff. In Open Everywhere an "agent" is not a distinct object — it
is the composition of three existing config primitives: a memory **domain** (the channel
that shares one brain), a memory **silo** (where that brain's data lives), and an access
**bundle** + a domain-scoped **binding** (its standing instructions + connectors). Asking
*"make this channel a support agent backed by our Notion handbook"* freezes an `AgentSpec`,
posts the member card, and — on the tap — opens one PR writing the machine-owned
**agents overlay** (`agent/memory/config/agents.generated.ts`) from a deterministic codemod
(`packages/core/agent/memory/agents-codemod.ts`), so no model authors any part of the diff.

It inherits the same safety model above (frozen args, codemod-not-agentic, validation
before the PR and again at the merge gate, merge-is-the-gate, deploy backstop) plus two of its own:

- **Attended-human only.** Creating an agent is standing-behaviour authorship, so — like
  `create_skill` — it requires a verified *acting* sender and refuses a routine fire; a
  fire may not stand up an agent in the person it is attributed to.
- **The exposure invariant.** Pass `exposed: true` for an agent a wider, less-trusted
  audience will reach; it is then forced **curated read-only** — it may only read a
  read-only silo and never inherits the org brain — enforced at propose time and re-asserted
  at every config load, so an exposed agent provably cannot leak internal memory outward.

The channel binding is taken from the verified surface key (never model input); a name
collision, a channel that already belongs to a domain, or an undefined connector all refuse
at propose time.

## Assumptions

- **Admins live in GitHub.** The approval surface is a PR review — an admin who can't
  merge can't approve. The admin-channel message is a notification, not a control.
- **Branch protection + CODEOWNERS are enabled** on the config repo (see the runbook
  below) — with hundreds of people able to read the config repo, they are what make the
  merge button an actual gate. `.github/CODEOWNERS` in this repo carries the
  grants-overlay line.
- **The config repo is transparent-by-design** (secret *references* only, never values;
  it is the audit surface). Sensitive standing context belongs in a domain's memory silo,
  never in scope instructions; config-repo grants never bind to guest-reachable scopes —
  and the `request_access` tool refuses on externally-shared channels for the same
  reason.

## Enabling it (operator)

Fail-closed: with either of the first two unset, the tool refuses politely and the flow
is off.

```bash
OE_ACCESS_ADMIN_CHANNEL=C…        # Slack channel that hears "PR opened — merge to grant"
OE_ACCESS_CONFIG_REPO=owner/repo  # this deployment's config repo (the grants overlay lives here)
OE_ACCESS_CONFIG_BASE=main        # optional, default main
OE_ACCESS_GRANTS_PATH=agent/access/grants.generated.ts   # optional, default shown
```

A dry run is not an environment variable. Set `dryRun: true` in the app's
`agent/access/access-requests.ts` to make taps validate and report with no branch or PR (e2e).
It was `OE_ACCESS_DRY_RUN=1` until OPE-2411.

The GitHub App (`OE_GITHUB_APP_*`) needs write access to the config repo — the same
plane that signs every other bot-PR.

## Runbook — the bits only a human can do

These are repo/platform settings no code change can make for you:

1. **Branch protection** on the config repo's base branch (GitHub → Settings → Branches):
   require a pull request before merging, and require review from Code Owners. Require
   whatever status checks your own fork posts — **this repo posts none**, because it
   has no workflows (AGENTS.md § Build/test/typecheck). Without branch protection,
   CODEOWNERS is advisory and the merge button isn't a gate.
2. **Review the CODEOWNERS line** (`.github/CODEOWNERS`): replace the owner with your
   real admin team/users on a fork.
3. **Deploy-on-merge** (optional but recommended — it's what makes merge = live).
   Copy the template in the repository, at `docs/how-it-works/deploy-on-merge.yml.example`, to
   `.github/workflows/deploy-on-merge.yml` on your fork and fill in its secrets.
   🔴 **The template lives under `docs/`, not under `.github/workflows/`**, because this
   repo runs no GitHub Actions of its own — a file here costs no Actions minutes and cannot
   run by accident. It needs the `VERCEL_TOKEN` secret plus the
   `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` variables, and it runs `scripts/deploy/verify.ts`
   as its post-deploy step. Arm that step with `OE_DEPLOY_SCOPE`, `OE_DEPLOY_ALIAS` and
   `OE_DEPLOY_CONTROL_TOKEN` as repo secrets — it probes the live agent, auto-rolls-back
   on a dead probe, and checks the cron registration. Keep the job off `pull_request`
   events, so a fork PR never reaches those secrets. The team-scoped `VERCEL_TOKEN` this
   step sets is all the verify step needs: it reads and moves the alias through the Vercel
   REST API rather than the `vercel` CLI, which cannot authenticate a team-scoped token
   on a runner with no `vercel login` session (OPE-1045).
4. **Merged/closed notification back to the requesting thread** is not wired yet: today
   the thread learns the PR URL and can watch it; a GitHub webhook → thread-notify
   ("granted, live" / "declined") is the natural follow-up once a deploy-on-merge
   workflow exists to anchor "live" to.
