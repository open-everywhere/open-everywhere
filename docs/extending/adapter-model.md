# The adapter model

Everything Open Everywhere can swap — the model, the memory backing, the credential
broker, the sandbox, the database, the scheduler — is an **adapter**. This page defines the
pattern once; every other page in this section links back here instead of re-deriving it.

## What an adapter is

An adapter is a **shared interface** plus a **registry of implementations**. Core declares
a small interface (e.g. `CredentialBroker`, `MemoryProvider`, `OperationalStore`), ships at
least one portable implementation, and exposes a `register*` seam. Anything that satisfies
the interface and registers under a name is selectable — by an env var, or per-bundle config.

The implementations are of **mixed provenance**, and the registry doesn't care which is which:

- some ship in **core** (`@open-everywhere/core`) — the zero-dependency portable defaults;
- some ship in the **adapters package** (`@open-everywhere/adapters`) — vendor bindings like
  Neon Postgres or the Vercel Sandbox, kept out of core so core stays vendor-SDK-free;
- some ship in a **provider bundle** (`packages/providers/<name>`, staged — see
  [provider bundles](./provider-bundles.md)) — a chat/work/connector surface's whole vendor
  coupling (Notion, Linear, Slack, …), registering into all three plane contracts it supports;
- some you **write in your own consuming repo** — implement the interface, call the register
  seam at startup, select it. No core change, no fork.

This is the *swappable seams* half of Open Everywhere's design. The other half — the scoping
resolver, the egress firewall, the two credential planes, the
audit model — is the **fixed spine**, held constant on purpose. See
[Access & scoping](../how-it-works/access-and-scoping.md) and the
[security model](../security/security-model.md) for the spine; this section is the seams.

## `env` is just a core adapter, not a privileged built-in

The clearest way to see the pattern: the default credential broker, `env` (read a secret from
a named environment variable), implements the **same** `CredentialBroker` interface as Vercel
Connect or any vault, and registers through the **same** registry. It ships in core only
because reading `process.env` needs no SDK — which makes it the guaranteed zero-wiring floor
for local dev, CI, and self-host. Nothing is special-cased in the lookup. A core adapter, but
an adapter all the same:

```ts
// packages/core/agent/access/credentials.ts
export const envBroker: CredentialBroker = {
  async getSecret(ref) {
    const v = process.env[ref];
    if (!v) throw new CredentialError(`secret not found for ref "${ref}" (set env ${ref})`);
    return v;
  },
};
registerBroker(ENV_BROKER, envBroker); // registers like any other; always available
```

The same shape recurs everywhere: `git`/`sqlite` are the in-core memory defaults; the in-core
operational-store floor is an **embedded Postgres (PGlite)** — the same dialect as the hosted
backend (`sqlite` there is deprecated); the generic OIDC verifier is the in-core admin-IdP
default. Vendor adapters register alongside them and win only when explicitly selected.

### 🔴 Your adapter may not reach for a new env var

`envBroker` above is the *sanctioned* `process.env` reader; your adapter is not. Adding a
`process.env.X` read to runtime code — under `agent/` or `packages/**/agent/**`, at module level or
lazily inside a function — **reds the `test` chain** unless the name is on the allowlist in
`scripts/env-read-allowlist.ts` (`npm run lint:env-docs`). The red says where the value belongs
instead.

The rule it enforces is [config-as-code](../how-it-works/config-as-code.md#the-line-is-a-lint-not-a-habit)'s:
a **connection target, a secret, or this deployment's identity** is environment; anything that
decides how the agent *behaves* — a wall, a floor, a cap, a clock, a policy — is a typed setting in
`packages/core/agent/settings/settings.ts`, read with `getSettings()` and changed by pull request.
So an adapter's endpoint, DSN or credential ref is env and needs an allowlist entry with a reason;
its retry ceiling, page size or cache lifetime is a setting and needs none.

Two things this gate does not see, so do not rely on it as proof: a read through a computed key
(`process.env[ref]`, as `envBroker` itself does) and a read through the `env: NodeJS.ProcessEnv =
process.env` parameter alias this repo uses for testability. Both are invisible to it, and both are
still bound by the rule.

## Two scopes of selection: deploy-singleton vs per-bundle

Adapters fall into two groups by **how broadly one choice applies**:

- **Deploy-level singletons** — one per deployment, chosen at startup, usually by an `OE_*`
  env var. The whole instance runs on it. These are the *substrate* seams:
  - the **credential brokers** — registered when configured (the `env` adapter always; the `db`
    broker when its AES key is armed; a vendor broker when wired). No global selection: each
    credential names its home broker. See [credential brokers](./credential-brokers.md)
  - the **operational store / database** (`OE_OPERATIONAL_PROVIDER`) — see [database](./database.md)
  - the **execution sandbox** (an Eve-owned backend) — see [sandbox](./sandbox.md)
  - the **scheduler** and **control-plane identity** — see [scheduler & identity](./scheduler-and-identity.md)

- **Per-bundle / per-resource policy** — selected *inside config-as-code*, varying within a
  single deployment. Different domains, bundles, or silos can use different implementations
  at once. These are the *capability* seams:
  - **memory backings** — each silo names its own `provider` (one silo on Postgres, another
    on Notion, another on git) — see [memory backings](./memory-backings.md)
  - **connectors & providers** — each provider names its connection, credentials, allowlist
    — see [connectors](./connectors.md)
  - **repos** (source control) — each bundle grants its own repo set — see
    [source-control backends](./source-control-backends.md)

The memory provider is the clearest illustration: there's an env-selected *singleton* default
(`getProvider()`), **and** a per-silo selector (`providerById()`) so one deployment can run
many silos on different backends simultaneously.

## Fail-closed selection — no silent fallback

The named adapter **must work**. If a credential names a broker (or a deployment names a provider
or store) that isn't registered, Open Everywhere **throws** rather than quietly substituting
another. For credentials there is no global selection at all — a credential names its home broker,
and an unstamped one fails closed too:

```ts
// brokerFor(name), credentials.ts — the name comes from the credential's `broker` stamp
const broker = BROKERS[name];
if (!broker) {
  throw new CredentialError(
    `credential home broker "${name}" is not registered … Refusing to fall back to another broker (fail closed).`,
  );
}
```

This is a security property, not pedantry. Silently falling back to `env` for a configured
vendor broker could inject the **wrong** secret — a coincidentally-named environment variable,
or a stale dev value — against a production integration. The memory provider does the same:
an unknown or unregistered silo `provider` fails loud rather than dropping memory on the floor.
The rule across the seam set: a misconfigured adapter is a startup error you see immediately,
never a wrong-secret or lost-data surprise at runtime.

## An adapter ships impl *and* the management understanding — never policy

An adapter is a **vertical slice of a vendor**. It owns two things:

1. the **runtime implementation** of the core interface (resolve a secret, read a tier, query
   the store); and
2. the **management understanding** for that vendor's **resource lifecycle** — how to
   provision the database, run a migration, set up the Connect OAuth connector, rotate a
   secret, manage the cron. That knowledge is irreducibly vendor-specific and has no home in
   core. It ships from the adapter package as a skill (knowledge-first; scripts or an MCP
   server only when the vendor already offers a tool-shaped surface worth adopting).

What an adapter **never** owns is **policy**. Grants, caps, bundles, and bindings are
vendor-neutral and live in **git PRs + the control plane** ([access & scoping](../how-it-works/access-and-scoping.md),
[the control plane](../security/control-plane.md)). An adapter that starts editing grants has
re-created the dashboard-with-write-access that the config-as-code model exists to avoid. The
line is hard: an adapter manages *its vendor's resources*; it never manages *who is allowed to
reach them*.

## Writing your own adapter

The recipe is the same for every seam:

1. Implement the core interface (e.g. `CredentialBroker.getSecret(ref)`).
2. Call the register seam at startup (`registerBroker("my-vault", myBroker)`), from the
   `customAdapters` hook in your app's `agent/lib/register-adapters.ts` (see
   [the app's adapter wiring](#the-apps-adapter-wiring) below).
3. Point config at it — for a credential broker, stamp the credentials it owns `broker: "my-vault"`
   (there is no global selection); for other seams, name it in per-bundle / env config.

Because core depends on **no vendor SDK** (Eve is the sole framework dependency, and Eve runs
off Vercel), your adapter lives entirely in your own repo. A boundary test in core asserts the
dependency direction `eve ← core ← { adapters, provider bundles } ← app` (adapters and provider
bundles are peers, not stacked on each other — see
[core/app separation](../core-app-separation.md)), so the layering can't quietly erode.

**Don't pre-split a seam before a second real implementation needs it** is still the default —
keep the portable default and the one vendor binding in-tree until the boundary actually earns
its keep. This is exactly why PR/SCM verbs stay GitHub-hardcoded in core with no registry: there
is only one implementation, so no seam exists yet to extract.

**Provider bundles are the named exception, not a contradiction.** Splitting Slack, Notion,
Linear, etc. out of core into their own packages (`packages/providers/<name>`, [provider
bundles](./provider-bundles.md)) doesn't wait for a second implementation of any one platform —
it's already decided and staged. The split there isn't speculative abstraction; it's
**packaging-driven**: an org that only uses Slack shouldn't need Discord's or Teams's code (or
eventually its dependencies) anywhere near its deployment, and a third party should be able to
contribute a new chat surface without a core PR. The doctrine and the exception coexist because
they answer different questions — "has this seam earned an abstraction?" (no, for PR/SCM verbs)
versus "should this vendor's code ship to everyone regardless of whether they use it?" (no, for
every chat/work/connector provider, which is why the packaging split doesn't wait).

### The app's adapter wiring

An app's `agent/lib/register-adapters.ts` is one call (OPE-2301):

```ts
import { registerDefaultAdapters } from "@open-everywhere/adapters/agent/register-defaults.js";
import { SELECTED_PROVIDERS } from "./providers.generated.js";
import { loadDomains, loadSilos } from "../memory/config/domains.js";
import { domainMemoryGrants } from "./memory-grants.js";

await registerDefaultAdapters({
  providers: SELECTED_PROVIDERS,
  memory: { domains: loadDomains, silos: loadSilos, grants: domainMemoryGrants },
  customAdapters: () => {
    registerBroker("my-vault", myBroker);
  },
});
```

`registerDefaultAdapters()` is product code. It declares the provider selection, registers the
default adapters and every selected provider bundle, and wires the operational store with the
product's rules: the Neon gate asks core's `resolveOperationalSelection` and
`resolveMemoryProviderId`, and the PGlite floor arms from the resolved floor. An upgrade of
`@open-everywhere/adapters` upgrades all of it, so the app's file needs no merge on upgrade.

`customAdapters` is the app's hook. It runs once, after every default adapter and provider bundle
registers, and before the boot checks that read those registries (the connector memory grants, the
subtree claims), the store wiring and the slash-command reconcile. A registration in the hook
therefore replaces a default one, and the same boot checks see it. The store selection is not a
hook point: the Neon gate and the PGlite floor are product rules. Keep the hook's imports static,
for the one-chunk reason above. `registerDefaultAdapters()` wires once per process. A second
call in the same process returns the first call's result and runs nothing again, because eve 0.71
evaluates `agent/agent.ts` more than once in one build process. A second run would declare the
provider selection again, which clears the gate's records, and run every bundle's `register()`,
the boot checks and the slash-command reconcile again.

### Import the ports from one door: the adapter-api barrel

Every register seam, port interface, and helper an adapter needs is re-exported from a single
entry point — `@open-everywhere/core/agent/adapter-api.js`. Import from it and nothing else:

```ts
import { registerBroker, type CredentialBroker } from "@open-everywhere/core/agent/adapter-api.js";
```

This is the whole public surface core promises adapters — a small, curated API rather than the
run of core's internals. The boundary test enforces it strictly: an adapter (or the app's
`register-adapters.ts`) that reaches past the barrel into a deep `@open-everywhere/core/...` path
fails the build. If you need a core symbol the barrel doesn't export yet, that's the signal the
port is missing — add it to the barrel, don't tunnel around it. Keeping every adapter behind one
door is what makes the future repo split (core ↔ adapters) mechanical instead of archaeological.

### A seam a surface may DECLINE: the wake arm's per-surface contract

Most of the barrel is a port an adapter implements. One entry works the other way round, and an
adapter author meeting it should know why.

The **wake seam** ([drop-in arms](./drop-in-arms.md#the-additive-instance-the-wake-decision)) lets a
deployment register an arm that ADDS an ambient wake where the built-in name-drop abstained. The arm
runs on a chat message, so the question "does this surface hand the arm that message?" belongs to the
surface, not to core. `WAKE_ARM_SURFACE_CONTRACT` (`packages/core/agent/channels/wake-arm.ts`,
exported from the barrel) is where each surface answers it:

| surface | offers the seam | fields the arm receives |
| --- | --- | --- |
| Slack | yes — from the **name-drop route only** | `text` (the AUTHORED text), `channelId`, `authorId` |
| Discord | no | — |
| Teams, GitHub, Linear, Notion | no | — |

🔴 **"Offers" is a claim about a ROUTE, not about a vendor.** Slack offers the seam from
`routeNameDropEvent`, and a large class of Slack deployments never reaches it: a domain running the
ambient supervisor is diverted to `routeSupervisorEvent` beforehand, and a domain whose
`nameDropWake` flag is off — the shipped default — returns before the arm rung. An arm registered on
a deployment like that is inert and says nothing about it.

**The declaration lives in core, and the composer reads it.** A surface does not decide this in its
own package, and it is not documentation:

- `wakeAfterArm` refuses to call an arm for a surface whose entry says `offers: false`, whatever that
  surface's route passes it;
- an offering surface's `fields` list is what the arm actually receives. The composer builds the
  arm's input from the declaration, so a route cannot widen what a consumer's arm sees by passing
  more, and the arm's `text` is clipped to `WAKE_ARM_MAX_TEXT_CHARS` before it leaves the seam.

**Offering the seam is a property of the route, not a choice of style.** A surface can offer it only
if its ambient route can report a real ABSTENTION — "the built-in had no opinion" — separately from a
policy drop. Slack's `routeNameDropEvent` stages its gates and can. Discord's `nameDropEligible`
folds the name match into one boolean and cannot, so Discord declines until somebody splits that
function. Teams has a name-drop route since OPE-2444, and it declines for Discord's reason: its
`resolveTeamsNameDrop` answers one boolean. GitHub, Linear and Notion have no ambient name-drop route
at all.

So a new chat surface adapter joins this table with `offers: false` and a `note` saying which of
those two it is. Changing that to `true` is a change to core plus that surface's route, reviewed
together.

## The connector-transport seam is swappable too

The connector plane — how a host-side tool call reaches a third-party service — is itself a seam
(`packages/core/agent/connections/connector-transport.ts`). The shipped default, and the only transport registered
today, is **direct**: the runtime resolves the credential and makes the call in-process, host-side.

A deployment could instead route the connector plane through an external **integration gateway** —
a separate service that holds the work-surface credentials and makes the call on the agent's behalf,
so the credential never reaches OE's process at all. Nothing ships wired to one today (an earlier
Executor-sidecar integration was removed as unused — OPE-372), but the registry the direct transport
sits on is generic: a vendor adapter registers a `ConnectorTransport` (priority + `isActive` +
`resolve`) and a connection selects among transports by config, never a hardcoded vendor branch. A
self-hoster wanting this posture would write an adapter against that seam — **ToolHive**
(Apache-2.0) is one plausible target. The rule from ["never pre-split a
seam"](#writing-your-own-adapter) still applies: build the adapter when there is a real second
transport to register, not speculatively.

## On Vercel / Off Vercel

- **On Vercel (the reference path):** a curated *set* of adapters fills every seam and is
  wired for you — the core credential brokers (`env`/`db`), Neon Postgres (memory + operational
  store), the Vercel Sandbox (execution + egress firewall), Vercel Cron (scheduler).
  Choosing the Vercel platform = choosing this adapter-set. See the
  [hosting overview](../deploy/hosting-overview.md).
- **Off Vercel:** you assemble your own set. The zero-wiring floor (`env` broker, embedded-Postgres
  (PGlite) operational store, local `git` memory) runs with nothing extra; swap individual seams up
  to your own KMS, hosted Postgres, sandbox, or scheduler by implementing the interface and
  registering it.
  Each seam page below ends with its own On-Vercel / Off-Vercel note.
