# Config-as-code

Your repo *is* the configuration. There is no dashboard where someone clicks to widen what
the agent can reach — what it's allowed to do lives as declarative code in your own git
repo and deploys with it. This is the second organising idea of Open Everywhere: **what
lives in your repo vs. what's managed at runtime.**

It fits the grain of the runtime exactly. Eve deploys from git, and a session's config is
[frozen at session start](./agent-and-loop.md) — so making git the single source of truth
*and* the single deploy trigger isn't a constraint we impose, it's the path of least
resistance made into a feature.

## What's code, what's the database

The discriminator is **reviewable intent vs. secret / data / runtime-state** — not who can
edit it (the agent can edit either), and not secrecy of topology.

> **In code** when a thing is a deliberate **grant or rule** that benefits from
> version-control audit — history, blame, diff, rollback — *and* from approval and
> transparency. **In the operational store** when it's a **secret value**, raw
> **data / memory**, or **operational state** that's high-churn or must be instant.

| Item | Home |
|---|---|
| Bundle definitions (what a basket grants) | **code** |
| Bindings (basket → channel) | **code** |
| [Domain](./access-and-scoping.md) declarations | **code** |
| [Role & persona presets](../capabilities/roles.md) (instructions, voice, knob bundles) | **code** |
| Connector / skill code, standing instructions | **code** |
| Agent **behaviour** settings — which walls are up, which apparatus is armed, what the caps are | **code** — [`agent/settings/settings.ts`](../deploy/configuration-reference.md#agent-settings-behaviour-config-as-code) |
| [Webhook trigger](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers) declarations (hook id → scheme, read grant, and optionally a channel + instruction) | **code** |
| Secret **values** (API keys, app private key, a webhook's shared HMAC secret) | **store / vault** — never git, referenced by `secretRef` |
| Memory content | **store** (its [provider](../capabilities/memory.md)) |
| Audit log, spend counters | **store** |
| Break-glass overrides, routine run-status | **store** |

A detail that makes this clean: **bindings hold opaque channel IDs, and that's fine in
code.** A private channel's ID (`C12345678`) is an opaque handle — it leaks nothing on its
own, the repo is private, and its read-set *is* the org. So committing IDs (not names)
keeps the whole access policy — definitions *and* bindings — as config-as-code, with no
part forced into a runtime store for secrecy's sake. The store shrinks to genuine secrets,
data, and instant-state.

### …and what's an environment variable

The store is one runtime home; the **process environment** is the other, and it takes a different
cut. The line:

> **Connection targets, secrets and deployment identity are environment. Behaviour, wiring and
> policy are typed code in your repo, changed by pull request.**

A database URL, a gateway URL, an API key, and *which org this deployment is* genuinely differ per
deployment, and several of them must never appear in a diff at all — those are env. But how the
agent *behaves* is an opinion, and an opinion set by env var is one your CI never sees, `git blame`
cannot explain, and reverting is not a revert. It also cannot be proposed by the agent: the whole
[PR loop below](#the-agent-edits-its-own-config--via-pr) is unreachable for a knob that only exists
in a hosting dashboard.

So every behaviour knob lives in one typed schema, with your deployment's overrides in
`agent/settings/settings.ts` — see [Agent
settings](../deploy/configuration-reference.md#agent-settings-behaviour-config-as-code) for the
generated list. Since OPE-411 **none of them name an environment variable**: the forty-eight
mirrors that used to let an env var win over the committed file are gone, on purpose, because a
posture that a dashboard can silently outvote was never really config-as-code. OPE-411 kept one
name, `OE_MODEL_STACK`, as a harness seam for the e2e runner. OPE-2411 deleted it: the per-stack
e2e lane now sets `models.stack` on the target deployment and deploys. Every real behaviour change
now costs a diff. Read the setting with `getSettings()` on every call, so a
committed change takes effect on the next deploy without a code path caching a stale value.

### The line is a lint, not a habit

Sweeping for stray env reads kept missing them. The sweeps that deleted the settings mirrors matched
**module-level** `process.env` reads, so a read sitting lazily inside a function survived every one
of them. That is what a sweep is: it finds instances, and only a lint kills a class.

`npm run lint:env-docs` now carries that lint. It scans every `process.env.X` the runtime reads —
module level or lazy — and requires each name to be on the explicit allowlist in
`scripts/env-read-allowlist.ts`, in a class, with a stated reason the lint itself checks for. **A
read in runtime code that is on no list reds the `test` chain**, and the failure says to move the
value to settings, or to the db secret store with `getOperatorSecret()`.

The classes are the env-minimalism rule (OPE-2650). Env holds four things and
no more, and each is a permanent class: `root-of-trust` (the database DSNs, the credential
encryption key and the public origin), `store-bootstrap` (what the process needs to open the
operational store before it can read a stored secret), `platform` (a name the host or a vendor
convention defines, which the code only reads back) and `per-run-seam` (a value right for one shell
or one invocation and wrong to commit). `settings-lever` stays declared and empty: the settings
schema reads no environment. Everything else is a setting in Git or an operator secret in the db
store.

`pending-migration` is the honest backlog: **0 names**. OPE-2650 emptied it: every name that was
not a survivor moved to a setting or to an operator secret. A future name that must move is filed
there with its TARGET and a ticket.
The list is **shrink-only**: once a name moves, its entry must go, or the lint reds. The suite pins
the survivor count (36), so a new survivor costs a reviewed line. OPE-2649 deleted the four
`OE_DIRECTORY_*` names, and the `secret` and `connection` classes with them: the Okta selector and
org URL are the settings `directory.provider` and `directory.oktaOrgUrl`, and the API token is the
operator secret `OKTA_API_TOKEN`. The first sweep pull
request deleted eight names: the access-request wiring (now the `accessRequests.*` settings and the
app's own `loadAccessRequests` fields) and the deprecated `OE_AI_GATEWAY_URL` (now
`models.targets.gateway.url`). The second deleted the 22 surface-identity names: which Discord,
GitHub, Linear, Notion and Teams app this deployment is, and its AWS regions and public OIDC client,
now the `discord.*`, `github.*`, `linear.*`, `notion.*`, `teams.appId` and `aws.*` settings. The
third moved the sixteen surface credentials (the Slack, Discord, GitHub and Linear tokens and signing
secrets, the gateway key and the inline AWS token) to operator secrets read through
`operatorSecret`, with the env var of the same name kept as the on-ramp. The
fourth moved the control plane: its four credentials became operator secrets, the `OE_ADMIN_OIDC_*`
pair became the `control.adminOidc` setting, and the three self-minted keys stopped reading env. The fifth deleted sixteen
more: the egress proxy wiring, the memory selectors, log shipping and telemetry. Thirteen became
`egress.*`, `memory.*`, `observability.logShip` and `telemetry.*` settings. Three became operator
secrets. The [configuration
reference](../deploy/configuration-reference.md#moved-to-config-ope-2650) maps each deleted variable
to the line that replaces it.

Before OPE-2650 the backlog held three names: `OE_TELEMETRY` and `OE_TELEMETRY_DEBUG` (left in env
by an earlier rule) and `OE_PRINCIPAL` (the local principal stand-in). The telemetry
pair moved in OPE-2650's fifth pull request, to `telemetry.enabled` and `telemetry.debug`. `OE_PRINCIPAL` is a `per-run-seam`: a committed value would ship
to production. The first family to move off the backlog was the three webhook-verification walls,
now the `webhooks.allowUnverified*` settings. OPE-2411 moved the rest in two parts. Part 1 made
thirteen pure tunables into code constants with no setting at all (the DM seat's rotation
thresholds, the backscroll reach-back, the Notion hot-cache bounds, the log-ship batch knobs, the
webhook ingress bounds, the denial-log poll interval and the Notion API version), and took six test
valves out of shipped runtime code. A knob nobody needs to turn is not a setting. Part 2 moved every
real choice into config: the access-plane master flags and scope lists, the directory policy, the
admin control plane's role rules, the model pins, the trust declarations and the platform floors.
The [configuration reference](../deploy/configuration-reference.md#moved-to-config-ope-2411) maps
each of those deleted variables to the line that replaces it.

Three names that sat in that backlog are worth naming on their own, because each *looks* like a
legitimate env fact and is not. `OE_TRUST` read as identity but defeated a fail-closed DM downgrade.
`OE_PRINCIPAL` reads as identity but makes every autonomous fire look like a human is present.
`OE_PLATFORM` read as a host fact but was an operator switch that removed the durable-memory floor.
OPE-2411 deleted `OE_TRUST` (now `identity.blanketTrust`) and `OE_PLATFORM` (the host is now Vercel's
own `VERCEL` only). `OE_PRINCIPAL` stays in env on purpose: a committed value would ship to every
environment, production included. The class an entry is filed under is the whole gate, which is why
the suite pins the count in each.

**No PER-SURFACE vouch lives in the environment.** Every vouched surface — the Slack workspace, the
Discord guild, the GitHub org, the Microsoft 365 tenant — is a `defineSurface` line in
`agent/identity/surfaces.ts`, and a workspace identifier is an identifier, not a credential. That
matters most where the temptation is strongest: a vouch is a **trust wall**, so an environment
variable naming one surface would let a hosting dashboard grant that channel the shared org memory
with no diff and no review. Env is for infrastructure the code cannot know — a database connection
string — and the rule holds even when the identifier names your own organisation.

The blanket trust lever is the setting **`identity.blanketTrust: "internal"`** in
`agent/settings/settings.ts` (shipped `"none"`; it was the `OE_TRUST=internal` variable until
OPE-2411). It is deliberately all-or-nothing: it vouches every unverifiable surface at once, on every
platform, and it also opens the Teams single-window privacy floor whatever any declaration says. It is
the switch a single-tenant deployment throws, not a way to name one room.

Three read shapes reach the inventory. A **literal** `process.env.NAME`; a **computed key** the
scan can resolve through a `const` (`process.env[SOME_CONST]`); and a **property off the repo's
`env: NodeJS.ProcessEnv = process.env` parameter alias** (`env.OE_FOO`). A computed key the scan
CANNOT resolve — a key built from operator data, a credential slot, a settings spec field — is not
silence either: it becomes a *dynamic site*, which `scripts/env-read-allowlist.ts` must excuse by
name and reason, on the same shrink-only discipline.

Two limits are still worth knowing before you rely on the gate. A name reached through a call-site
**argument list** (`pick(env, "A", "B")`) is not inventoried by name — the site is excused instead.
And the gate scans only `.ts` files under `agent/` and `packages/` whose path contains an `agent/`
segment, so a runtime module placed outside that shape is not gated at all. The authority on what
the scan can see is the 🔴 list at the top of `scripts/env-read-scan.ts`, not this paragraph.

### And the read must run at the point of use

A setting that lives in your repo still does nothing if the code reads it too early. `getSettings()`
resolves your registered overrides over the shipped default, and `agent/lib/register-config.ts`
registers them in its own body. ESM runs every imported module's top-level code first. So a read at
**module level** sees no overrides, takes the shipped default, and keeps it for the life of the
process. Your `agent/settings/settings.ts` never applies, and nothing throws or logs.

This is not hypothetical. The table that decides which grains hold `bash` and `write_file` once
captured `delegation.oneshotAgent` at module load, so it answered the shipped default forever
(OPE-1101, fixed in OPE-1105). One instance is not the class, and only a gate kills a class.

`npm run lint:settings-boot-order` is that gate. It boots eve's three root modules — the agent
definition, the sandbox definition and the instrumentation entry — each in its own process, with a
recorder in the override slot. It reds on any read that **resolves that slot**
before registration, and it names the module, the line and the accessor. Survivors go in the
allowlist in `scripts/settings-read-probe.ts`, with a stated reason, on the same shrink-only
discipline as the env allowlist. The list is **empty today**.

Three shapes stay safe, and you should write one of them. Read inside the **function** that needs
the answer. Expose the value through a **getter**, which re-resolves on every property access. Or,
if a module truly must hold the value at import time, pass your own overrides —
`getSettings(SETTINGS_OVERRIDES)` does not consult the registered slot at all, so boot
order cannot change its answer.

Know the gate's scope before you lean on it. It boots **nine** entries, each in its own process,
and each entry reaches something the others do not. Three are eve's singleton root modules. The
sandbox definition evaluates **sixteen** imports — the adapters browser and sandbox subgraph among
them — before it imports `register-config.ts` on line 23. The instrumentation entry is the
strongest case: it never imports `register-config.ts` at all, so **every** read in its graph is
pre-registration.

The other six are eve's generated slot-root directories — `tools/`, `hooks/`, `channels/`,
`schedules/`, `skills/` and `connections/`. eve mounts those modules by *scanning* the directory,
so no singleton root imports them. Each slot root gets its own child, which imports every `.ts`
file in it and registers nothing. That is the stronger reading: the child treats every read the
directory performs as eager. The served process is gentler: `agent/agent.ts` imports
`register-config.ts` at its top, and eve mounts a slot-root module later, by scanning. The gate's
own entry note records the measurement — `register-config.ts` is module 15 of the 1,326 that boot
evaluates. A new eve root module belongs on the list the day it lands, or its graph goes
unwatched.

The survivor list in `scripts/settings-read-probe.ts` is the global one. One entry also carries a
list of its own: the `agent/tools` child excuses six module-level gate-table lookups
(`WINDOW_GATE_LOOKUPS` in `scripts/settings-boot-order-lint.ts`). Those reads capture nothing —
the mount resolver and the execute backstop re-read the row — and they look eager only because the
slot-root child boots with no registration at all.

## Behaviour settings — one shape, one store, one owner

`AgentSettings` (`packages/core/agent/settings/settings.ts`) is the resolved shape of every behaviour
opinion this deployment holds. 🔴 **It is process-global.** Nothing in it is per-org, per-domain or
per-surface: a knob that needs a scope belongs in the bundles, the memory domains, the model policy or
the spend budgets instead.

`registerSettings` writes this deployment's overrides once at boot, from
`agent/lib/register-config.ts`. It stores them in a **process-registry slot** rather than a module
variable, and that is load-bearing: two module identities are not hypothetical here. A root-versus-core
import split produces one in the repository, and the integration tier boots the **built** agent bundle
— with its own inlined copy of the module — inside the test's process. A module-local variable would
leave the running agent resolving through a copy the caller never wrote to, and the deployment would
silently revert to shipped defaults.

`resetSettingsForTest()` drops the registered overrides back to the shipped defaults, and
`overrideSettingsForTest()` patches them mid-process for a test that must hold one flag while varying
another. Both are test bootstrap only; runtime code reads the resolved values through `getSettings()`.

### The schema owns its environment names

Two lint arms keep one owner for each name, and both live in `scripts/settings-docs.ts`.

**A schema-declared ops override the configuration reference never mentions is a red.** That gate
exists because the resolver reads such a variable through a **schema field** rather than through a
literal `process.env.<NAME>` read, so the environment-documentation lint cannot see the name at all.
Without this arm, an operator-facing knob could ship undocumented.

**A runtime module outside the schema that reads a schema-owned name directly is a red.** The scan
covers every file under an `agent` path except the schema module itself, and it catches both a direct
property read and a read through that name's own `_ENV` constant. A second reader grows a second
vocabulary, a second default and a second precedence — which is the drift the single-owner rule
removed.

**The environment-documentation lint also runs backwards.** A variable a documentation table or the
example environment file still names, and that no runtime code reads any more, is a red — so the
documented surface cannot outlive the code.

## The agent edits its own config — via PR

A non-developer shouldn't have to open a code editor to ask for a change. They don't:

1. They ask in natural language ("give the payments channel read access to our Notion runbook").
2. The agent translates the request into a **diff on its own repo**.
3. It opens a **pull request**, authored as `open-everywhere[bot]`.
4. A human **reviews and approves** the diff.
5. Eve **redeploys**, and the agent reports back — *"your change is live as of deployment X."*

The crucial design point: **this needs no special "self-config" machinery.** The agent's
repo is just a repo. You grant it in a bundle's `repos:` list (bound to an admin scope),
and from there the agent clones it, drafts the change, and opens the PR using exactly the
same [source-control](../capabilities/source-control.md) path it uses for `acme/api` or any
other repo. Self-config is *emergent from a normal repo grant* — there is no separate
target or plane to secure.

### The PR review *is* the gate

Because capability changes flow through PRs, the review is the whole security model — and
it's airtight by design:

- **The bot cannot self-merge.** Branch protection + required review on `main`.
- **`CODEOWNERS` risk-tiers the diff.** Access, connection, and egress/credential code
  routes to a maintainer or security reviewer; prose, docs, and skills get a lighter touch.
- **The gates run before the merge.** A bundle edit that breaks the fail-closed guarantees is
  caught by the `test` chain, and the merge waits on that evidence.
- **Injection is defended *by the diff*.** If a user — or a booby-trapped message — asks the
  agent to "also open egress to evil.com" or "grant yourself admin," that becomes a *pull
  request a human reads*. The diff review is the prompt-injection → privilege-escalation
  defense, which is exactly why no-self-merge and `CODEOWNERS` routing are load-bearing.
- **Secrets never touch the diff.** Adding a credential splits in two: the *declaration*
  (`secretRef: "db:notion:team-key"`) goes in the PR; the *value* is added to the vault
  out-of-band by a human (`oe secret set db:notion:team-key`). The `secretRef` indirection
  enforces this.

### Two keys, and two different humans

That last bullet is worth pulling out, because the property it buys is the strongest one in
this model and the easiest to miss: **a merged PR is not, by itself, enough to make anything
happen.** Splitting the *declaration* from the *value* means two humans with different
powers must both act — whoever reviews and merges the diff, and whoever holds the store the
value lives in.

The [inbound webhook trigger](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers)
is the sharpest instance, because it is the one config surface that opens a **public,
unauthenticated URL**: `POST /webhooks/<id>` is always mounted, with an empty registry as
the only "off". Both keys are enforced by the same fail-closed gate:

- **No declaration ⇒ 404.** An id that nothing in the repo claims has nothing to
  authenticate against, so there is no endpoint behind it to attack.
- **A merged declaration whose secret nobody provisioned ⇒ 401.** The hook is *inert*. Its
  `secretRef` resolves no key, so every delivery is rejected. Merging the PR does not arm
  it; someone with access to the hook's `broker` — the env store, or the deployment's own
  encrypted credential vault — has to put the value there, separately, afterwards.

So "the agent opened a PR adding a webhook" is a change a reviewer can approve knowing it
cannot fire until a second person deliberately arms it, and a leaked or stolen merge does
not produce a live ingress. Two honest caveats, because the split defends against *one*
compromised half, not against someone holding both:

- Someone who can merge **and** already knows a value sitting in the store could point a new
  hook's `secretRef` at that existing ref. The gate checks that a key resolves, not who
  chose the ref.
- `webhooks.allowUnverified` — a local-dev escape hatch — accepts a delivery for a
  **declared** hook with *no* secret configured, which collapses the second key wherever it is
  set. It never waives signature verification once a secret **is** set, and never waives resolving
  the hook's declared signature scheme (an unregistered `source` 401s regardless). It is honoured
  for a `broker: "env"` hook and for no other broker — a `broker: "db"` secret is minted by this
  deployment, so the hatch's premise ("the secret isn't on my laptop") cannot hold for it. An
  acceptance it does produce is stamped `unverified: true` in the audit row.

### Widen slow, narrow fast

A PR plus CI plus a deploy takes minutes — right for "add Notion access," wrong for "a key
leaked, revoke it *now*." So the two directions take different lanes:

- **Widen / add capability → a PR.** It needs review anyway, and it can afford a deploy.
- **Narrow / revoke → an instant runtime override.** The break-glass lane: a subtractive,
  fail-safe override that removes a capability immediately with no deploy. It can *only* take
  access away, never add it. It's a stopgap, reconciled back into code afterward (a PR
  removes the grant permanently, or the incident clears and the override is dropped).

See [The control plane](../security/control-plane.md) for the override doctrine.

## The repo model — package layers, a template not a fork

You run your *own* copy of the agent, which raises an obvious worry: won't tracking upstream
become a merge nightmare? No — because your copy is a **scaffolded app, not a fork**.
Open Everywhere is layered so that what you edit and what upstream ships never touch the
same files:

```
Eve              the agent framework (Apache-2.0) — the one framework coupling
  ↑
core             @open-everywhere/core — platform-neutral runtime: the resolver, the
                 planes, surfaces, control plane, provider interfaces. No vendor SDKs.
  ↑
adapters         @open-everywhere/adapter-* — vendor impls (credential broker, Postgres, …)
  ↑
agent            reference template — wires core + a default adapter set + example config
  ↑
your app         scaffolded from the template: your bundles, bindings, domains, adapter
                 selection, custom connectors/skills. Shares no source with upstream.
```

Because your app contains only *your* config and adapter wiring — none of upstream's
source — **updates arrive as a version bump, not a git merge.** There's nothing of ours for
your edits to conflict with. (Open Everywhere lives this model one level up itself: it
consumes Eve as a package rather than forking it.) The pattern and the swap points are the
subject of [The adapter model](../extending/adapter-model.md).

## Provenance comes for free

Because policy lives in git, **every policy change is a commit or PR** — author, diff,
message, reviewer, timestamp. That *is* the change-audit for the policy half, with no
separate store: "what config changed, who, and when" is git history, queried not stored.
Deploy history then records *when* each commit went live. Together they give a complete
timeline over your agent's configuration — see [Audit & provenance](../security/audit-and-provenance.md).
