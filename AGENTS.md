# AGENTS.md — Open Everywhere

Canonical guide for coding agents and human contributors. **Read this first.** It is
the source of truth for how the repo is laid out, how to build/test/deploy it, and what
must never be committed. Deeper reference lives in [`docs/`](./docs/README.md); this file
points you at the right page rather than duplicating it.

> **Before you write about the runtime, read [`docs/glossary.md`](./docs/glossary.md).** It is the
> ratified vocabulary — seat, worker, grain, posture, taint, tier, judge, scope — with the
> `file:line` that is the source of truth for each. Use those words exactly.

> Operator-private, machine-specific instructions do **not** belong here. Put them in
> `CLAUDE.local.md` (gitignored, uncommitted) — see [Private local instructions](#private-local-instructions).

---

## What this is

Open Everywhere is an open, self-hostable autonomous teammate you tag in your chat tools —
**Slack, Microsoft Teams, Discord, Linear**. It runs multi-step tasks over long
horizons, remembers context per team, and asks before doing anything consequential. It is
built on **[Vercel Eve](https://eve.dev)** and picks its models from a **named stack**
(`agent/model/stacks.ts`) via the Vercel AI Gateway. The shipped default is `american-closed`
(every role on `openai/gpt-6-luna`); an alternative `chinese-open-weights` stack (DeepSeek V4
Flash) also ships. You run it, you own the data, you pick the model.

Two ideas run through the whole design (see [Core concepts](./docs/introduction/core-concepts.md)):

- **Fixed spine vs swappable seams.** Eve gives you an agent; Open Everywhere gives you a
  *governed* agent. The governance (scoping resolver, egress firewall, credential planes,
  audit) is held constant on purpose; everything else (model, memory backing, sandbox,
  database, surfaces) is a swappable **adapter**.
- **Repo vs runtime.** Config lives in your git repo and deploys with it. Secrets, state, and
  spend live in the operational store and change at runtime.
- **The conversational seat is lean; a worker does the work.** A seat that can
  delegate holds 18 tools at most, the lean roster (`packages/core/agent/access/lean-seat.ts`, `LEAN_SEAT_TOOLS`,
  enforced by deletion at the model-call seam). Everything else — every read, `bash`, every
  cross-surface write — is worker-only
  (`packages/core/agent/access/worker-capability-index.generated.ts`). Each conversation runs on
  three tiers: the conversation seat forwards a job with `work` and never waits, the
  conversation's own **work session** starts a worker for the job with eve's `agent`, and the
  worker does it. See [The three tiers](./docs/how-it-works/agent-and-loop.md#the-three-tiers-seat-work-session-worker).

---

## Repo layout

An npm workspace rooted at the deployer app, with `packages/*` and `packages/providers/*` as
workspaces: `packages/core`, `packages/adapters`, `packages/create` (the scaffolder), and six
extracted provider bundles under `packages/providers/*` (slack, discord, teams, github,
linear, notion). Node's ESM (`"type": "module"` everywhere); TypeScript throughout, run directly
via `tsx` (no separate compile step for tests).

```
open-everywhere/
├── agent/                     # THE DEPLOYER APP: config-as-code + thin re-exports
│   ├── agent.ts               #   defineAgent() entry — model + gateway + compaction config
│   ├── access/bundles.ts      #   ★ the "admin console": capability bundles + bindings (config-as-code)
│   ├── access/providers.ts    #   connector/provider declarations
│   ├── channels/*.ts          #   one-line re-exports of surfaces (core: teams/discord/linear/github/webhooks; bundles: slack, notion)
│   ├── memory/config/domains.ts #  memory domains + per-domain model routing
│   ├── settings/settings.ts   #   ★ this deploy's BEHAVIOUR overrides (schema: packages/core/agent/settings/)
│   ├── roles/roles.ts         #   role/persona preset library (bind via a domain's `role:`)
│   ├── subagents/<name>/      #   declared subagents: own prompt, ZERO tools (no outputSchema — see below)
│   ├── connections/*.ts       #   host-side connector definitions (e.g. notion)
│   ├── spend/, skills/, ...    #  per-deploy config for the corresponding core subsystem
│   └── lib/register-*.ts      #   boot-time registration of app config + adapters into core
├── packages/core/             # @open-everywhere/core — THE FIXED SPINE (zero vendor SDKs)
│   └── agent/
│       ├── identity/          #   binding.ts — every message → one platform-agnostic SurfaceBinding; trust.ts
│       ├── access/            #   resolver, egress firewall, connector hard-gate, untrusted boundary
│       ├── channels/          #   surface adapters still in core (teams, discord, linear, github, engagement) + the neutral spine (post-arms, channel-read, turn-delivery)
│       ├── memory/            #   tiered memory: resolve, silo, partition, providers (git/sqlite/postgres/notion), dream cycle
│       ├── approvals/, audit/, routines/, spend/, control/, scm/, plugins/, skills/, tools/
│       └── model/             #   per-domain model routing (transport-agnostic)
├── packages/adapters/         # @open-everywhere/adapters — VENDOR BINDINGS (kept out of core)
│   └── agent/
│       ├── model/gateway.ts   #   Vercel AI Gateway transport + dream-judge
│       ├── oe-oauth/          #   own-rolled OAuth user-auth-flow (connector-plane OAuth mint/refresh)
│       ├── postgres/neon.ts   #   Neon Postgres
│       ├── sandbox/           #   Vercel Sandbox lifecycle
│       └── spend/             #   Gateway catalog pricing source
├── docs/                      # the consumer/operator manual (source of truth for architecture)
├── scripts/                   # app-tier tests + config checks (see scripts/README.md for the
│                               #   app-tier/core-tier split and naming convention)
└── deploy/                    # deployment helpers (e.g. discord-relay — actively under construction)
```

**The core/app split is the load-bearing convention.** `packages/core` is the portable,
vendor-SDK-free spine — it owns *behaviour* (the resolver, memory tiers, the firewall) and the
`register*` seams. `packages/adapters` holds vendor implementations (Neon, the Vercel Sandbox,
the AI Gateway model transport, the own-rolled OAuth flow) so core stays dependency-light. The root `agent/` is
the **deployer's own repo template**: it holds config-as-code (bundles, domains, model choice),
registers app config + chosen adapters at boot, and re-exports the core channels. A fork
customises `agent/*` and, if needed, writes its own adapters — usually without touching core.
See [The adapter model](./docs/extending/adapter-model.md) — read it before adding any seam.

Key seams to know:

- **Identity → access.** `packages/core/agent/identity/binding.ts` maps each inbound event to a
  single `SurfaceBinding` (platform, workspace, surface, mode, visibility). The resolver
  (`packages/core/agent/access/`) turns that binding into effective access from the bundles/
  bindings in `agent/access/bundles.ts` — **deterministic, narrowest-wins, no fallback.** See
  [Access & scoping](./docs/how-it-works/access-and-scoping.md) (the keystone) and
  [Identity](./docs/how-it-works/identity.md).
- **Memory.** Tiered and agent-centric: a shared **workspace** brain + an isolated **surface**
  silo per channel/team, materialised on disk. Public surfaces contribute up; private surfaces
  and DMs stay walled (**fail-closed** visibility). Pluggable backend (`git` → `sqlite` → Neon
  Postgres). See [Memory](./docs/capabilities/memory.md).
- **Surfaces = channels.** Each chat platform is a channel adapter under
  `packages/core/agent/channels/`, re-exported from `agent/channels/`. Slack is the reference
  implementation. See [Surfaces](./docs/extending/surfaces.md).

---

## Setup

**Node 24.x is required** (`package.json#engines` — Eve's floor; use `nvm use 24`). Then:

```bash
git clone <repo-url>
cd open-everywhere
npm install                       # or `npm ci` for a clean, lockfile-exact install
cp .env.example .env.local        # fill in AI_GATEWAY_API_KEY (or run `eve link`)
npm run dev                       # eve dev — boots the agent on http://localhost:3000
```

`.env.example` is the full, documented env surface (**names and guidance only — no values**).
Highlights: `AI_GATEWAY_API_KEY` (model auth to the Gateway; on a deployed Vercel project OIDC
is auto-injected, no key needed), per-surface credentials (`SLACK_*`, `LINEAR_*`, `DISCORD_*`,
etc.), memory/operational store selectors (`OE_MEMORY_PROVIDER`, `OE_OPERATIONAL_PROVIDER`, …), and
control-plane admin auth (`OE_ADMIN_*`). The deployment's own identity is NOT here — it is tracked
config in `agent/identity/surfaces.ts` (see below). Read the inline comments in `.env.example` and
the [Configuration reference](./docs/deploy/configuration-reference.md).

Copy `.env.example` to `.env.local` (gitignored) — never edit `.env.example` to hold real values.

**This repo's own `npm install` runs with no `min-release-age` cooldown.** A cooldown blunts a
fresh-publish supply-chain attack. It delays a package version from resolving until the
version has aged on the registry. A malicious release then has that long to get caught and
unpublished before `npm install` can touch it. It gates any version npm must resolve, floating
or exact-pinned — so it would gate eve too, our largest-blast-radius dependency. Under OPE-945 that
trade-off is guidance for consumer projects that build on Open Everywhere, not a
gate on our own dependency intake: eve ships several times a day, so a multi-day cooldown would
keep this repo permanently behind it. The tracked `.npmrc` records this choice and points to the
consumer guidance in
[`docs/introduction/quick-start.md`](./docs/introduction/quick-start.md).

---

## Build / test / typecheck

Run from the repo root. Develop with targeted tests locally (a single test file, a workspace
suite, `typecheck:all`), then push a branch and open a PR.

**There is no CI yet.** No workflow runs, and no check appears on a pull request. A pull request
is proved by its own gates: **`typecheck:all`**, **`test`**, **`build`** (`eve build`) and
**`test:integration`**. Run all four on the head you push, and put one line per suite in the
pull-request body:

```
OE_PROOF sha=<sha> suite=<name> exit=<integer>
```

Before a merge, a maintainer re-runs the same four suites. The maintainer can record the verdict as ONE commit status, `oe/cloud-proof`:
`npm run deploy:cloud-proof-verify -- <file>` re-parses the evidence, and
`npm run deploy:cloud-proof-post` posts it. Only a literal `exit=0` on every reported suite can
become a `success`; a narrative claim of success changes nothing. Evidence format, the two
scripts and the trust model: [The `oe/cloud-proof` lane](./docs/deploy/cloud-proof.md).

**Before a merge — the upgrade diff fence, on two rungs.** The fence refuses any pull request that
changes the access plane, the approvals plane, the audit chain, the mint's permission sets,
`agent/access/`, `scripts/deploy/`, the fence itself, or a security lint driver.
Both rungs run the same fence, and neither reads who authored the pull request (OPE-1315): a
protected-path diff merges only on the maintainer's explicit review-and-override. Merge only on
exit 0, whichever rung you ran.

- `npm run deploy:merge-fence -- --pr <n>` — the AUTHORING session's rung, run on its own pull
  request from a checkout standing on that pull request's head. `--sha` defaults to the current
  commit, and the rung refuses when that sha is not the pull request's head.
- `npm run deploy:merge-attest -- --pr <n> --fence` — the MAINTAINER's rung, run from a session
  that holds the status credential. It posts the verdict as `oe/upgrade-fence` on the head. A
  posted `failure` exits 1, so a posted status is never permission to merge, and no branch
  protection rule requires that context today, so it records rather than gates.
  `--require-protection` refuses to post until a rule does.

See [docs/security/self-upgrade-fence.md](./docs/security/self-upgrade-fence.md).

**After a squash merge — move the proof.** A commit status does not follow a sha it was not
posted on, so a squash mints a tip with no proof. `npm run deploy:merge-attest -- --pr <n>
--transfer --merge-sha <sha>` moves the head's green `oe/cloud-proof` onto the merge commit, and
refuses unless the two TREES are identical (OPE-1168).

**Before a deploy — `npm run deploy:ci-gate`.** It reads the tip's `oe/cloud-proof`, and walks
back through first-parent ancestors when the tip carries none, refusing if the cumulative diff
since the nearest green ancestor touches a runtime path. See § Deploy rule 4.

**A red on main is fix-forward priority.** Fix it or revert it ahead of other work, because main
is the tree every deploy ships and the deploy chain refuses to ship over an unproven main
(§ Deploy, rule 4).

**Use Node 24.** The version matters, because five Discord golden-timeline scenarios diverge on
event ordering under Node 22. Prefer targeted single-file runs while you develop.

**Any test OUTSIDE `packages/core/scripts/**` can read a STALE `packages/core/dist` (OPE-888,
OPE-936).** The boundary is the IMPORT FORM, not the directory. A test that imports
`@open-everywhere/core/agent/...` through the package specifier resolves through the workspace
symlink's export map to `packages/core/dist/...` — the BUILT tree. Only a test under
`packages/core/scripts/**` imports the same module by relative path (`../agent/...`) and reads
source directly. So a source edit under `packages/core/agent/**` is invisible until
`npm run build -w @open-everywhere/core` runs — to a repo-root `scripts/*` test AND to every
provider/adapter bundle test under `packages/**/scripts/**`, which import core the same way.

A full `npm test` is unaffected — its `pretest` hook always rebuilds first — but a local, targeted
break-and-revert proof can go **false GREEN**: the assertion never saw the break, not because it
is vacuous. So **rebuild core before you trust a local red or green** from any such test that
just changed under a core source edit. A repo-root `scripts/*` test may instead call
`assertCoreDistFresh()` (`scripts/core-dist-freshness.ts`) at its top, which throws and names the
fix — `reply-test.ts` is the template. A bundle test may not: reaching up to a repo-root script
crosses the package boundary, so rebuild core by hand there.

To land several branches together, first merge them into one staging branch. This is the
exception path, not the default flow. Use it for a batch with a semantic conflict, or a batch that
must land atomically.

| Command | What it does |
|---|---|
| `npm run dev` | `eve dev` — local agent (needs a Gateway key or `eve link`) |
| `npm run build` | `eve build` — production build. **Must pass before any deploy.** Chains `postbuild` (below) automatically. |
| *(`postbuild`, chained after `npm run build`)* | Two gates that read the just-built `.output/server/index.mjs`, because no `tsx`-tier test can see what the bundler does. `agent-version-seam-bundle-test.ts` (OPE-1041) asserts the eve pin and app version resolve with no runtime filesystem read, and both baked literals survive bundling. `dynamic-callback-closure-bundle-test.ts` (OPE-1063, also `npm run test:dynamic-closure-bundle`) asserts no `defineTool` callback carries an undeclared capture into eve's durable descriptor — a capture that does not serialize makes eve drop the whole resolver's result, so the tools vanish from the seat with no red. Both run wherever `npm run build` runs, including a proof run's `build` suite — no separate deploy-checklist step |
| `npm run typecheck` | `tsc --noEmit` on the root app |
| `npm run typecheck:all` | root + `@open-everywhere/core` + `@open-everywhere/adapters` + every `@open-everywhere/provider-*` + the scaffolder |
| `npm test` | full deterministic suite: `lint:script-chain` (fail-fast, serial), the provider-discord echo, then `test:suites` — every package's script-test chain PLUS the root package's own chain (the root `test-chain.txt`) (config lints, roster, boot, deploy-ops, …), batched together (no live model, no secrets). ~97 s on a 4-core box (OPE-709; was ~166 s after OPE-703, ~619 s before it) |
| `npm run test:suites` | the batched script-test tier (OPE-703, extended OPE-709): ONE vitest run over `scripts/chain/`, spreading the ~454 suites named by each package's chain list (`test-chain.txt`) — including the root package's own — across forked workers. It replaced a serial `&&` walk that spent ~0.54 s of `npm run` spawn per leg. Every suite still runs alone (`npm run test:<name>`, `--workspace <pkg>` for a workspace one), and each package's `test:chain` (root included) still walks serially |
| `npm run lint:hosted-externals` | checks built deploy output (`.vercel/output`) for imports that would be missing at cold start. Not part of `npm test` — there is nothing to check until you have built. |
| `npm run test:boot` | **cold-start gate** — boots the whole agent graph (every module under `agent/`, against a throwaway state dir) and fails on a module-load throw, a duplicate channel route, a malformed schedule cron, or a dynamic model bound off `step.started`. In the `test` chain; nothing else in the deterministic tier ever loads `agent/agent.ts` |
| `npm run test:integration` | **integration tier (OPE-442)** — vitest over `tests/integration/**`: boots the BUILT agent in-process per test file (own fork, own PGlite), drives real signed wakes through a SCRIPTED model (no inference, no credentials, no docker) and asserts on real toolsets, approval-chain audit rows and the reply choke point. Includes the offline first-wake gate (`wake-smoke.test.ts`, OPE-456) — a real HMAC-signed Discord relay mention through the NATIVE dispatch path, asserting the turn woke, ran and reached the audit trail. **Not in the `test` chain** (it runs `oe:build` + `eve build` first; `OE_IT_SKIP_BUILD=1` skips that on an already-built tree). See [Testing](./docs/extending/testing.md) for which tier a new test belongs to |
| `npm run lint:script-chain` | every `npm run X` leg named by any package.json script resolves to a defined script (a renamed leg otherwise dies minutes into the chain). First leg of the `test` chain |
| `npm run lint:traced-externals` | source-side half of `lint:hosted-externals`: an eve-force-externalised package imported by runtime code but absent from `build.externalDependencies` — a dead lambda at cold start. In the `test` chain (needs no build) |
| `npm run lint:eve-patch` | the committed `patches/` are actually in the installed bytes (patch-package failures are warnings, not errors), and every workspace pins the patched version. In the `test` chain |
| `npm run lint:env-docs` | **three arms over one scan.** (1) ratchet: a **new** `process.env.X` the runtime reads that neither `.env.example` nor `docs/` mentions. (2) reverse: a documented var that nothing reads any more. (3) allowlist (OPE-1152): a runtime env read that no entry allows, answered "move it to settings/config". Arm 3 wants an entry in `scripts/env-read-allowlist.ts` for every **literal** `process.env.X` under an `agent/` path, in one of six classes, with a stated reason. A read through the repo's `env` parameter alias or a computed key is outside the scan — see [Config-as-code](./docs/how-it-works/config-as-code.md#the-line-is-a-lint-not-a-habit) for both limits. `--list` prints the whole inventory. In the `test` chain |
| `npm run deploy:verify` | post-deploy HTTP probe of the running agent (`/control/v1/audit`), with **auto-rollback** on failure. Operator/agent script, never CI — see [Rollback, verify, record](./docs/deploy/rollback.md) |
| `npm run deploy:smoke` | **the post-deploy smoke gate**: a signed webhook POST → `200` → the deployment's own `webhook.fired` + `reply.post` audit rows, joined by the delivery id it minted and by the wake id the fire minted (so a green says THIS delivery produced THIS reply); an unsigned POST → `401` with no trace. **No LLM judge anywhere** — reply QUALITY is reported by the e2e pack's S20 and never gates (OPE-433). Reds, never auto-rolls-back. Logic pinned offline by `npm run test:deploy-smoke` |
| `npm run rollback` | one command: re-point the production alias at the last known-good deployment (`--to <url>`, `--dry-run`) |
| `npm run deploy:record` | stamp the gitignored known-good pointer after a deploy passes its probe, so `rollback` is one hop |
| `npm run smoke` | core smoke test (`smoke --workspace @open-everywhere/core`) |
| `npm run access:preview` | preview how a binding resolves against the current bundles |
| `npm run lint:connections` | validate connector/provider config |
| `npm run lint:provider-selection` | pin the generated provider selection (`agent/lib/providers.generated.ts`) to the workspace deps and the boot wiring — and every provider-plane seam in core to the boot gate |
| `npm run docs:generate` | recompile the shipped manual into the bundle after editing anything under `docs/` (see below) |
| `npm run lint:docs` | verify the compiled manual still matches `docs/` byte-for-byte (in the `test` chain) |
| `npm run oe:build` | materialise the eve slot tree (`agent/{tools,channels,hooks,schedules,skills,connections}/` + `agent/lib/providers.generated.ts`) from `roster.config.ts`. Runs automatically via `pre{build,test,typecheck,dev,start}`; `-- --show` prints the tree without writing it |
| `npm run lint:roster` | verify the materialised tree byte-equals what `roster.config.ts` + `roster.lock.json` plan, that every exclusion names a real contribution with a reason, and that nothing is UNREVIEWED (in the `test` chain). See [Tools & the roster](./docs/extending/tools.md) |
| `npm run lint:contributions` | verify every package's `agent/contributions.ts` catalogue resolves, is slug-legal and (for tools + hooks) is 1:1 with its directory (in the `test` chain) |
| `npm run lint:capability-docs` | verify every mounted tool is described somewhere in `docs/` (in the `test` chain) |
| `npm run lint:principal-gate` | verify every refusal gate over a principal identity declares whether it means *accountability* ("somebody nameable must exist") or *presence* ("a human must be here, acting") — and reads an accessor that can deliver it. Also verifies every approval site derives attendedness through `unattendedOf(ctx)` and no `requestApproval` propose site omits it (in the `test` chain). `--list` prints the whole inventory |

**Edited something under `docs/`? Run `npm run docs:generate` and commit the result.** The agent
serves its own manual through the `read_docs` tool, and `docs/` does **not** exist on disk in a
hosted deployment (`eve build` emits JS; no `.md` rides along), so the manual is compiled into
generated TS modules — `packages/core/agent/docs/generated/*.ts` for the deployment-wide docs (inside
core, so the npm package ships them; the app registers them from `agent/lib/register-docs.ts`) and
`packages/providers/<id>/agent/docs-generated.ts` for each bundle's own surface runbook. `lint:docs`
fails the build if they drift, if a provider bundle has no `docs/deploy/surfaces/<id>.md`, if a file
in that directory maps to no bundle, or if a bundle stops registering its docs. Never hand-edit a
generated module. See [Self-documentation](./docs/capabilities/self-documentation.md).

**Adding a tool? A page of `docs/` has to name it.** `lint:capability-docs` is total over the
mounted, model-visible tool surface — the same set `lint:consequence` pins a tier over — so a new
tool that no doc mentions reds `lint:capability-docs` instead of shipping as an undocumented
capability. Mounted is
not the same as reachable: which of a session's mounted tools actually resolve for *this* seat
is a separate, per-wake decision (the lean-seat cut above, plus the window-gate manifest) — see
[Where else tools are enumerated](./docs/extending/tools.md#where-else-tools-are-enumerated). Coverage is
*derived*, not declared: write `` `your_tool` `` as an inline code span in the prose of whichever
page covers it (a fenced code sample does not count), then run `npm run docs:generate`. There is no
doc-per-tool expectation — one page documents many tools. The only escape hatch is
`UNDOCUMENTED_TOOLS` in `packages/core/agent/docs/capability-map.ts`, which today carries exactly
the three resolver *files* that mount other tools and are never seen by the model; a tool being
internal-sounding is not a reason, and the lint rejects an exemption for a tool that turns out to be
documented anyway.

The heavy test surface lives in the workspaces: `npm run test --workspace @open-everywhere/core`
chains ~150 `scripts/<name>-test.ts` suites (resolver, identity, egress, memory, control plane,
approvals, per-surface, …); the adapters workspace has its own gateway/sandbox/pricing suites, and
each `packages/providers/*` bundle carries its own.
Operational CLIs also live in core scripts: `npm run spend`, `npm run audit`, `npm run routines`,
`npm run control`, `npm run ops` (run with `--workspace @open-everywhere/core`).

**Adding behaviour = adding a test.** Unit-level behaviour gets a plain-assertion
`scripts/<name>-test.ts` that exits non-zero on failure. Define a `test:<name>` script for it in
that package's `package.json` and append one line, `test:<name>`, to that package's `test-chain.txt`.
`npm test` reads the list, so nothing else names the suite. Never edit the `test:chain` script: it only
runs `scripts/chain/run-chain.ts` over the list (OPE-2286). Behaviour that spans seams — toolset assembly, delegation, taint,
approvals, audit, the reply path — gets a vitest test in `tests/integration/` instead
([Testing](./docs/extending/testing.md) has the decision rule). Bug fixes add a regression test
that fails before the fix.

### Live e2e driver pack — secrets

`npm test` above is the deterministic, secret-free gate every run executes on its own commit; this
repo runs no workflow, so nothing else runs it (see § Build/test/typecheck). Separately,
`packages/core/scripts/e2e/{runner,scenarios,env}.ts` is a **live** pack that drives a real
deployed instance over real Slack/Discord/Teams/GitHub/Linear/Notion accounts (`npm run
e2e:driver` from `packages/core`, or `npm run test:e2e-driver` from the repo root) — it is
**not** part of `npm test` and is run on demand against a deployment you own. It never invents or requires a specific fixture: every credential is an
independent, capability-shaped opt-in (`env.ts`'s `resolveCapabilities`) — anything unset
self-skips the scenarios that need it, naming the exact env var(s) to set, rather than failing.

- **Local sourcing:** copy [`.env.e2e.example`](./.env.e2e.example) (committed — names +
  placeholders only) to `.env.e2e` at the repo root (gitignored by the blanket `.env*` rule) and
  fill in your own fixtures' real values. Source it from the repo root **before** any `cd` (a
  relative `. ./.env.e2e` after `cd` silently fails to find the file):
  ```
  set -a && . ./.env.e2e && set +a && cd packages/core && npm run e2e:driver
  ```
- **Automated sourcing (a cloud run, or a fork's own CI):** the `.env.e2e` file itself must never
  be committed or uploaded. Each var arrives as a named secret in the run's environment, and no
  secret value is ever written to a file on the runner's disk. A run without those secrets should
  skip the pack rather than fail — the harness already self-skips per scenario and names the exact
  env var it wanted.
- The authoritative per-var doc lives in `env.ts`'s `ENV` registry; the coverage-matrix view
  (which scenario needs which capability) is `packages/core/scripts/e2e/AUDIT.md`'s "Harness env
  families" section.

---

## Deploy

Open Everywhere is a **Vercel app** (Eve compiles to a Vercel deployment). Four rules:

1. **`git push` does not deploy.** Pushing updates the repo; deploying is a separate, explicit
   Vercel step (`vercel deploy --prod …` or a Vercel Git integration you configure). Don't
   assume a push went live.
2. **Build before you deploy.** Run `npm run build` (`eve build`) and make sure it's green first;
   a broken build must never be promoted. The pinned Node major (24) matters — build and deploy
   on the same major the runtime uses.
3. **A green build is not proof the function boots.** A hosted function ships only what the bundler
   inlined plus what Eve *traced* into `<func>/node_modules`; anything else surviving as a bare
   import is unresolvable at cold start, and because it fails at module load the whole function
   dies. The build never runs the lambda, so it cannot see this. After building the deploy output
   (`vercel build --prod`), run `npm run lint:hosted-externals` — it asserts every bare import in
   every built function resolves from inside that function's own bundle. If it fails, name the
   package in `build.externalDependencies` in `agent/agent.ts` and rebuild.
4. **Read main's proof before you deploy.** The four suites prove a tree in the run that made it,
   not in a pull-request check (§ Build/test/typecheck), so the deploy chain must read the tip's
   proof and refuse to ship over a missing, red or still-running one. `npm run deploy:ci-gate`
   (`scripts/deploy/ci-gate.ts`) is that check — run it before every deploy, never hand-roll the
   `gh api` call.

   **No `gh` on PATH is not a reason to skip the check (OPE-1117).** A cloud sandbox has
   no `gh` CLI installed. When the spawn fails to start at all (ENOENT/EACCES — never a real `gh`
   failure, which still refuses exactly as before), `deploy:ci-gate` falls back to the GitHub REST
   API directly over `fetch`, authenticated with `GH_TOKEN` (or `GITHUB_TOKEN`). Both transports
   feed the same verdict logic, so the fallback changes nothing about what counts as green. With
   neither `gh` nor a token, the gate still refuses — naming both remedies.

   **`oe/cloud-proof` is the door the gate actually uses (OPE-1113 P1).** The gate still reads
   GitHub check-runs first, but no workflow posts any, so every sha on this repo reaches the
   zero-check-run branch. There `deploy:ci-gate` reads the tip's `oe/cloud-proof` commit status —
   a run proved the tree, and the maintainer mechanically verified the evidence and posted the
   status. A check-run-based verdict, red or green, still outranks it; that ordering matters for
   a fork that does run Actions. See
   [The `oe/cloud-proof` lane](./docs/deploy/cloud-proof.md) for the evidence format, the two
   scripts, and the trust model stated honestly (the same trust root as a self-hosted Actions
   runner — no more).

   **The tip can be legitimately proofless (the walk-back).** When the tip carries no
   `oe/cloud-proof` at all, the gate walks back through `main`'s first-parent history for the
   nearest commit with a green one, then re-derives — never trusting any outside verdict — that
   the cumulative diff from there to the tip sits entirely inside `scripts/ci/skippable-paths.ts`'s
   skippable set (`.claude/**`, `docs/**`, a root `*.md` file). It refuses on a red or pending
   ancestor, a status page it cannot prove it read completely, an unreadable diff, a runtime path
   in that diff, or no green proof found within its depth bound — fail closed on every ambiguity,
   same discipline as the rest of this gate.

The target Vercel **scope/team is deployer-specific** — do not hardcode any particular team or
scope name in code, docs, or these files. Each operator supplies their own. Full path:
[Vercel deploy guide](./docs/deploy/platforms/vercel.md) and the
[Setup runbook](./docs/deploy/setup-runbook.md). Other hosting targets are adapter sets — see
[Hosting overview](./docs/deploy/hosting-overview.md) (non-Vercel platforms are marked **Roadmap**).

---

## How to extend

Everything swappable follows the one pattern in [The adapter model](./docs/extending/adapter-model.md)
— a shared interface, a registry, and a `register*` seam. Read that page first, then the
specific guide:

- **Add a surface / channel** — [Surfaces](./docs/extending/surfaces.md). One identity mapper +
  one channel adapter; the whole system keys off a single platform-agnostic `SurfaceBinding`.
  🔴 **Never run `eve add channel/<provider>` in this repo or on a deployment of it.** eve's
  registry installs its own stock channel scaffolds at the same canonical paths OE's governed
  surfaces occupy (`agent/channels/slack.ts` etc.), its conflict inspector treats those paths as
  eve's own, and `--overwrite` silently replaces a governed surface (identity binding, unified
  window, spend gates) with an ungoverned stock channel. Surfaces are added through the OE
  provider-bundle pattern below, never through eve's registry.
  Model new surfaces on the extracted slack bundle (`packages/providers/slack/`) and `identity/binding.ts`;
  see [provider bundles](./docs/extending/provider-bundles.md) for the registration seams — and add
  the bundle to `roster.config.ts`'s `providers` map — that one row generates its app-tree stubs
  AND its row in `agent/lib/providers.generated.ts`; without it the boot gate refuses every seam it
  registers.
- **Add an adapter** (model, memory backing, credential broker, sandbox, database, scheduler) —
  the [Extending](./docs/README.md#5-extending--the-swappable-seams) section:
  [models](./docs/extending/models-and-gateway.md), [memory backings](./docs/extending/memory-backings.md),
  [credential brokers](./docs/extending/credential-brokers.md), [sandbox](./docs/extending/sandbox.md),
  [database](./docs/extending/database.md), [source-control backends](./docs/extending/source-control-backends.md).
- **Add a tool / skill / connector** — [Tools & the roster](./docs/extending/tools.md),
  [Skills & plugins](./docs/capabilities/skills-and-plugins.md) and
  [Connectors](./docs/extending/connectors.md). Prefer skill-wraps-API over raw tool sprawl. A tool
  is one entry in its package's `agent/contributions.ts`; the app **decides** about it in
  `roster.config.ts` and `roster.lock.json` records the decision, so those two files are the
  **capability roster** and `npm run lint:roster` fails when they stop being a decision about
  everything the installed packages contribute. `agent/{tools,channels,hooks,schedules,skills,
  connections}/` are **gitignored build output** — never hand-edit a file there; it evaporates on
  the next `oe build`.
- **Add a declared subagent** (`agent/subagents/<name>/`) — only when a *clean context* is the
  point; a skill is the lighter choice otherwise. See
  [Declared subagents](./docs/capabilities/skills-and-plugins.md#declared-subagents-the-specialist-unit).
  It inherits **nothing** (an empty slot falls back to the framework default, not to the root's),
  so it ships with its own instructions, a `disableTool()` sentinel per default-mounted framework
  tool, and its own `hooks/spend.ts`. A RESERVED slot carries nothing: eve 0.69.0 and later throw on any
  authored module at `connection_search`, `connection_execute` or `connection_tools`, so do not write
  a sentinel or a no-op replacement there. `npm run lint:subagents` (in the `test` chain) pins these
  rules: no authored `outputSchema`, its own instructions file, a sentinel per default-mounted slot,
  nothing authored at a reserved slot, and its own spend hook. OPE-2254 re-derived its reader on eve's
  reserved slots, so it runs on the eve 0.71.0 pin. `npm run test:subagent-zero-hands` covers the
  sentinel set a second time against the real subagent tree, and it pins that eve still scopes its
  connection registry to the active node, which is what keeps a subagent declaring no connections
  connector-free. 🔴 Do NOT author `outputSchema`: eve 0.67.0 removed it from
  `defineAgent`, so it is a typecheck error, and a schema is requested per turn by the caller instead.
  `packages/core/agent/subagents/contracts.ts` still holds the result contracts for the re-derivation
  (OPE-2250). The name also needs a row
  in `packages/core/agent/access/consequence.ts` **and**
  `packages/core/agent/access/window-gate-manifest.ts`.
- **Change access/capability config** — edit `agent/access/bundles.ts` (config-as-code, reviewed
  by PR). Read its in-file safety rules before binding any repo or credential.
- **Add or change a BEHAVIOUR knob** — it goes in the typed schema
  (`packages/core/agent/settings/settings.ts`), not in a fresh `process.env` read. The line:
  **connection targets, secrets and deployment identity are env; behaviour, wiring and policy are
  typed code, changed by PR.** A new setting declares its shipped default, its parser and its
  validation. **Do not give it an env-var name** — that list is closed since OPE-411, and the
  one surviving entry (`OE_MODEL_STACK`) is a harness seam, not a precedent. Run `npm run
  docs:generate` after — the operator table in `docs/deploy/configuration-reference.md` is
  generated from the schema.
  🔴 **A ROSTER IS POLICY, SO IT IS TYPED CODE**. The line above already decides
  this, and two changes read it the wrong way anyway: a vouch list, a domain roster, a membership
  set or any other named list of things the agent treats differently is BEHAVIOUR, so it goes in
  typed code under `agent/**` and changes by PR. 🔴 The ruling reaches past a roster, and it NARROWS
  the deployment-identity half of the line above. A room key, a tenant or workspace id, a domain
  roster and a trust declaration are all TRACKED literals: they live in Git and change by PR. Env
  keeps INFRASTRUCTURE only — connection strings, and the bootstrap credentials that reach a store.
  (Application secrets are neither, per `agent/settings/settings.ts`: they live in the DB-backed
  secret store.) The deployment's own identity obeys the ruling: `OE_ORG`, `OE_SURFACE`,
  `OE_WORKSPACE` and the older `OE_CHANNEL` spelling are GONE, with no fallback, and setting one has
  no effect. The org, the ambient workspace and the ambient room are declared as
  `deploymentIdentity` in `agent/identity/surfaces.ts` and registered at boot; `deploymentOrg()`,
  `ambientWorkspace()` and `ambientSurface()` in
  `packages/core/agent/identity/deployment-identity.ts` are the only readers. An operator-tier CLI
  cannot import that declaration, so it names the org with `--org` instead — after a `--`, or npm
  eats the flag (see the [Configuration reference](./docs/deploy/configuration-reference.md)). The
  measured incidents are `OE_E2E_ENGAGED_SURFACES` (an e2e domain roster) and
  `OE_TEAMS_INTERNAL_SURFACES` (the Teams membership vouch).
  🔴 **"THERE IS NOWHERE TO PUT IT" IS THE ARGUMENT THAT LOST.** `OE_TEAMS_INTERNAL_SURFACES` was
  defended as unavoidable — its entries are operator identifiers, real tenant and thread ids, said
  to have no reviewable home in a source-open repository. OPE-1489 put them in one: the vouch in
  `agent/identity/surfaces.ts`, the window roster in `agent/memory/config/domains.ts`. As
  `scripts/env-read-allowlist.ts` now records it, "the landing zone they were said to lack was the
  config file all along". So when a roster seems to have nowhere to live, the answer is a ticket to
  build it a home, never a var.
  Arm 3 of `lint:env-docs` catches neither incident: it checks THAT a name is allowlisted, and a
  change that adds a var adds its own `scripts/env-read-allowlist.ts` entry beside the read. The
  control that does fire is the per-class census in `test:env-read-allowlist`, which reds when a
  class grows until someone edits the count — so the census puts the decision in a reviewer's diff,
  and this rule tells the reviewer which way to decide it.
  Read the setting with `getSettings()` **per call** rather than a module-level `const` in
  `packages/core`: ESM evaluates a core module's body before `agent/lib/register-config.ts`
  calls `registerSettings`, so an eager read would silently ignore
  `agent/settings/settings.ts`. If the value has to be shared across modules, export a **function** that
  calls `getSettings()` per invocation (`channels/turn-delivery.ts` `supervisorRotateTurnBudget()`
  is the shape) — never an eagerly-initialised `const`, and never one hidden a level down inside a
  module-level object literal. App-tier modules (`agent/agent.ts`, `agent/sandbox/sandbox.ts`) may
  read at module load: they import `register-config.js` first, so registration has already happened.

---

## Conventions

- **One word, one meaning — use [`docs/glossary.md`](./docs/glossary.md).** The **seat** is the
  narrow conversational session (18 tools); the **work session** is the one session per
  conversation that runs its jobs; the **worker** is the wide delegated child (seat + 98, including
  `bash` and `write_file`). A conversation seat does its real work by forwarding it with `work`. Never
  write a bare "agent" for a running session. The glossary cites the code for every term — read
  that code before you assert what a run can do.
- 🔴 **Friendly names everywhere — a person never reads a raw id.** A member id (`U…`), a channel,
  server or Discord id, a Teams id, a scope or principal key (`slack/T…/C…`), a session id
  (`wrun_…`) and a meeting id (`mtg_…`) are join keys. In text a person reads — a reply, a card, a
  notice, a DM, on any surface — a person is a display name, a place is a `#name`, the platform
  channel mention or plain words, and anything else is plain words. Audit rows, store rows, logs
  and model-facing tool results keep the exact id. The guard is structural: every post arm,
  message-ops arm and email transport is stored wrapped by the outbound guard
  (`packages/core/agent/channels/friendly-outbound.ts`), and the Slack, Discord, Teams, GitHub,
  Linear, Notion and Google Chat write seams run the payload guard on every message write. It does NOT reach a
  Slack post through eve's own session client or a Discord thread title, so do not post that way
  with an id in the text. So: render a person or a place in host copy with `personWords` /
  `placeWords` (`channels/friendly-ids.ts`); put a name beside every id a tool result returns
  (`nameBesideId`, `placeBesideKey`); let the model ask `look_up` rather than materialising a list;
  and when you add a surface, post only through its registered arms and its one write seam, and
  register a name resolver (`registerFriendlyNameResolver`). Proof: `npm run test:friendly-names`
  (every surface), `test:friendly-ids` (host copy) and `lint:friendly-ids` (no new raw-key
  interpolation). See
  [`docs/extending/chat-surface-contract.md` §4.12.1](./docs/extending/chat-surface-contract.md).
- **TypeScript + ESM.** `"type": "module"` in every package; use `.js` import specifiers for
  local ESM imports even though the sources are `.ts` (see the existing files). Run via `tsx`.
- **Fail-closed security posture.** New surfaces and trust decisions default to the *safe* side:
  visibility defaults to **private**, external content defaults to **untrusted**, an
  unenforceable egress policy **aborts** the session rather than running open. When you add a
  surface, its identity/visibility interpretation lives in **one tested place** (its
  `*-identity.ts`), not scattered across the code.
- **Test alongside code.** Every behavioural change ships with a `scripts/*-test.ts` appended to
  its package's `test-chain.txt`. Keep the suite deterministic and secret-free.
- **Keep the load-bearing types honest.** No `any`-escapes that defeat the resolver/identity
  types — the access model depends on them.
- **Match the surrounding code.** Comment density, naming, and idiom follow the file you're in.
  This codebase favours dense explanatory comments on security- and Eve-coupling-sensitive code
  (why, and what breaks if it changes) — keep that where it earns its place.
- **A module header states WHAT the module does and WHAT INVARIANT it holds** — not the history of
  how the author arrived there. Design reasoning goes in the pull request or an issue; an invariant
  that can be asserted goes in a **test name**, which is the half that cannot rot. Keep a
  fail-closed rationale ("this refuses because…") in the header: that *is* the invariant.
- **Never layer a correction onto a header.** If a header is now wrong, **rewrite it**. A
  change-log in a header ("this used to say X, corrected to Y") asks every future reader to diff it
  mentally against the code below, and volume of confident prose reads as rigour — which is how a
  wrong claim survives review.
- **Security-sensitive areas get extra care** (closer review; see `CONTRIBUTING.md`): the egress
  firewall + credential injection, the connector hard-gate (`test:connector-scope` fails loud on
  an Eve bump), and the untrusted/prompt-injection boundary. **CI invariant:** this repo runs no
  workflow at all. A fork that adds one must trigger on `pull_request` (never
  `pull_request_target`) and needs **no secrets**, so a fork PR runs safely — never introduce a
  secret-bearing `pull_request_target` that checks out the PR head.
- **Contributions are DCO-signed** (`git commit -s`) — no CLA. The enforcing check is the pre-merge
  fence: `npm run deploy:merge-fence -- --pr <n>` refuses a pull request whose commits carry no
  `Signed-off-by: Name <email>` trailer (merge commits exempt). It gates a merge only when the
  maintainer runs it before the merge. Nothing attests that it ran, and it does not gate a click
  on the merge button. See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Writing for people

Any string the product shows to a person in a room — a host notice, a card line, a claim-guard
note, a status line, a tool result the model is told to relay — follows the agent's own voice. The
canonical statement is the "Your voice" section (`REPLY_STYLE_RUBRIC`,
`packages/core/agent/instructions/access.ts`), which every root session renders. Do not copy it
into another prompt block: point at it. `npm run test:voice` pins it.

**The reader is an ordinary office worker who is not technical.** They read the message once and
must understand it the first time. Write for that person, not for the engineer who built the
feature.

- **The result in a line or two.** Lead with what happened or what you need from them. Cut the
  rest.
- **Names, never ids.** Say "Ana", "#general", "the Q3 budget page". Never put a user, channel,
  page, session, task, wake or pending id, a scope key (`slack/T1/C2`), a credential id or a file
  path from the agent's own storage into a person-facing string. Use
  `channels/friendly-ids.ts` (`placeWords`) to turn an address into words.
- **No machinery.** No workers, hand-offs, delegation, tools or tool names, sessions, wakes,
  turns, how approvals are routed, grants, gates, policies, trust levels, fences or security
  checks. Say what happened in the team's words: "Sam needs to approve it in #ops", not "a card was
  raised on the approval plane for slack/T1/C2".
- **Don't repeat a card.** When a card already shows an outcome, the room gets nothing more about
  it.
- **No debug detail.** No error class, stack, HTTP status or verb, schema complaint or config path
  in a room. Put it on the audit row, where an operator reads it.
- **A limit says who can help.** "An admin can turn that on", not the setting or rule name.
- **A tool result the model relays is a person-facing string too.** Do not tell the model to
  "report the pending id" or to "tell the user" a mechanism; give it the fact and let the voice
  section shape the words.
- **One string table for one fact.** Export a host line as a constant, and make every test and
  detector import it rather than copy it, so a rewording moves them together.
- **Run it through the detector.** `personTextFaults` (`packages/core/agent/channels/person-text.ts`)
  flags raw ids, debug terms and trust-plumbing phrases. A test that renders a person-facing
  string asserts that the list is empty. Throw `PersonFacingError` for an error a person reads.

Strings an operator reads (audit rows, logs, the control plane, `docs/`) are not covered: they keep
their precise terms.

---

## Definition of done

A pull request reports what it finished: the premise, the tests it drove RED, the docs, and the
gate exit codes. **Scope expands to the obvious:** a change that finds a defect in a file or a
mechanism it already holds fixes it in the SAME pull request. List each one under an
**"Also fixed"** heading, one line each with the file. **Every follow-up issue carries a
premise-evidence line:** the `git grep` or `git log -S` command run against current `main`, and
what it showed.

---

## Security — what must NOT be committed

This repo is **open source** (Apache-2.0) and public. Everything you commit is public forever, and
a secret already committed is a secret already spent. The single most important rule:
**no secrets, ever.**

**Never commit:**

- **Secrets, credentials, tokens, API keys, private keys.** No `.env` / `.env.local` /
  `.env.*.local`, no `AI_GATEWAY_API_KEY`, `SLACK_BOT_TOKEN`, bot tokens, signing secrets,
  webhook secrets, `OE_GITHUB_APP_PRIVATE_KEY` PEMs, `OE_ADMIN_STATIC_TOKEN`, etc. Only
  `.env.example` (names + guidance, no values) is tracked.
- **Generated credential / auth artifacts.** Pulled Vercel env snapshots (`env-prod`,
  `env-*.local`), OIDC JWTs, session tokens, any credential blob. These are gitignored — keep
  it that way.
- **Personal or end-user data.** Conversation/DM content, per-team **memory stores**
  (`.open-everywhere-memory/`, `*.sqlite3*`), audit/spend/routine local stores, the `.eve/`,
  `.output/`, `.workflow-data/` runtime dirs. These are *other people's* data — never in git.
- **Heavy media / binaries.** Videos, large images, model weights, sample datasets. Keep the
  repo source-only.
- **Operator-specific identifiers.** Concrete Vercel team/scope names, private Slack channel
  IDs, personal deploy config. Describe deploy generically; the operator supplies their own.

**Never log secrets.** Credentials are injected at the egress firewall and must never enter the
sandbox or appear in logs, error messages, or test output. When adding logging near credential
handling, log the *ref/name*, never the value.

Most of the above is already covered by `.gitignore`. If you add a new subsystem that writes
local state or pulls a secret to disk, **add its path to `.gitignore` in the same change** — and
double-check `git status` before committing. If you find a tracked secret, do **not** try to
rewrite history yourself — flag the maintainer (rotate the secret, then scrub). Report
vulnerabilities privately per [SECURITY.md](./SECURITY.md), never in a public issue.

---

## Private local instructions

Operator- or machine-specific instructions (private ops rules, a personal deploy scope, local
shortcuts) belong in **`CLAUDE.local.md`** at the repo root. It is **gitignored and never
committed** — it's the home for anything that shouldn't be in the public, committed guidance
files. Do not put private content in `AGENTS.md`, `CLAUDE.md`, or any tracked file.

---

## Pointers

- Consumer/operator manual: [`docs/README.md`](./docs/README.md)
- Architecture keystone: [Access & scoping](./docs/how-it-works/access-and-scoping.md)
- Security model: [`docs/security/security-model.md`](./docs/security/security-model.md)
- Contributing + the PR bar: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](./SECURITY.md) · Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · Support: [`SUPPORT.md`](./SUPPORT.md)
