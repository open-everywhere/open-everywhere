# Core / app separation

This page describes the core/app split: the dependency direction the codebase already enforces
today, the inversion pattern that makes it possible, and how the boundary test keeps it from eroding.
The registry seam lives in `agent/lib/register-config.ts`, `packages/core/agent/access/config.ts` and
`packages/core/agent/model/routing.ts`. The e2e scripts `packages/core/scripts/e2e/read-channel.ts`,
`rotate-window-lib.ts` and `rotate-window.ts` follow the app-tree boundary rule.

## The dependency direction

```
eve  ←  @open-everywhere/core  ←  {  @open-everywhere/adapters,  provider bundles  }  ←  app (root agent/)
```

- **Eve** is the sole framework dependency. Nothing below it is Eve-specific except the thin
  files Eve's filesystem discovery requires (see below).
- **Core** (`packages/core`) is the fixed spine — the resolver, memory tiers, the egress firewall,
  the audit/spend model, and the **plane contracts** a chat/work/connector provider registers
  against (see [provider bundles](./extending/provider-bundles.md)). Core imports **no vendor
  SDK** and **no sibling package** — the boundary test (`packages/core/scripts/boundary-test.ts`,
  section 1) scans every file under `packages/core/agent` and `packages/core/scripts` and fails on
  a `@vercel/*`, `@neondatabase/*`, `pg`, `aws-sdk`-shaped specifier, on any
  `@open-everywhere/adapters` import, or on any `@open-everywhere/*` import that isn't core itself.
- **Adapters** (`packages/adapters`) and **provider bundles** (`packages/providers/<name>`) are
  **peers**, not stacked on each other. Both are vendor implementations riding core's registries:
  adapters bind deploy-level singletons (the Vercel AI Gateway model transport, the Vercel Sandbox,
  Neon Postgres, the own-rolled OAuth flow); provider bundles bind a chat/work/connector surface
  across all three plane contracts at once. All six surfaces are now extracted bundles —
  `notion`, `slack`, `discord`, `teams`, `linear`, `github` — each registered by one
  `registerXProvider()` call listed in the generated `agent/lib/providers.generated.ts`. Neither may import the other, and
  neither may import the app tree — boundary-test.ts sections 2/2b enforce this for adapters;
  sections 4/5 hold the identical rule for the provider bundles.
- **The app** (root `agent/`) is the deployer's own repo: config-as-code (bundles, bindings,
  domains, model routing policy), the roster declaration (`roster.config.ts` + `roster.lock.json`)
  from which `oe build` MATERIALISES the thin re-export stubs Eve's filename discovery needs
  (`agent/channels/*.ts`, `agent/tools/*.ts`, … — gitignored build output), and the two boot-time
  wiring modules
  (`agent/lib/register-config.ts`, `agent/lib/register-adapters.ts`) that compose everything
  together before any hook, tool, or connection handler runs. `register-adapters.ts` is one call
  into the product's `registerDefaultAdapters()` (`@open-everywhere/adapters/agent/register-defaults.js`,
  OPE-2301). The adapter wiring, the store selection rules and the floors live in that function, so an
  upgrade of the package upgrades them. The app adds its own adapters in the call's `customAdapters` hook. The app may import vendor SDKs
  only through adapters — boundary-test.ts section 3 asserts the app tree itself stays
  vendor-SDK-free.

This is what makes a future `git filter-repo` cut of `packages/core` into its own repository
**mechanical rather than archaeological**: every dependency crosses a layer boundary through a
named, tested seam, never a relative import that assumes a shared working tree.

## What each layer may know about

| Layer | May import | May never import |
|---|---|---|
| core | Eve, itself | any vendor SDK, `@open-everywhere/adapters`, any provider bundle, the app |
| adapters | core (via the barrel only), vendor SDKs | any provider bundle, the app |
| provider bundles | core (via the barrel only), the bundle's own vendor deps | any other bundle, `@open-everywhere/adapters`, the app |
| app | core, adapters, provider bundles, vendor SDKs *for its own config*, but wiring goes through adapters | — (it's the leaf) |

🔴 **The core row binds `packages/core` PRODUCT modules, and one half of it is doctrine rather than
a gate.** Section 1 scans `packages/core/agent` and `packages/core/scripts` for three things only: a
vendor-SDK specifier, an `@open-everywhere/adapters` import, and any other non-core
`@open-everywhere/*` import. A **relative climb** out of the package is never checked. Live-only
scripts under `packages/core/scripts/{e2e,eval}` do read the app tree. `e2e/rotate-window.ts` is one: it is a live-only tool that product code never
imports, so the boundary exempts it. They read it
through `packages/core/agent/scaffold/app-root.ts` (see [below](#scripts-that-read-the-deployers-app)),
not by a relative climb. A product module under `packages/core/agent` that climbed into `agent/`
would break the split just as badly and no suite would say so. Keep the rule by review there.

**One run-time reach from core into adapters, pinned (OPE-2560, OPE-2647).** `oe erase` must end a
person's credentials and saved browser profile, and the purge hooks and the box backend that do it
live in adapters. The local control entry (`npm run control`) must arm the identity-directory
adapter, which also lives in adapters. Both go through one function in
`packages/core/scripts/operator-store-connect.ts`, `importAdaptersModule`. It loads
`@open-everywhere/adapters/agent/<subpath>` with a name-as-variable dynamic import, the recipe
`neonClient` uses for the Postgres driver. `connectOperatorHolders` loads `operator-holders.js`, and
`connectOperatorDirectory` loads `directory/register.js`. It is not a dependency: core declares no adapters
dependency, nothing under `packages/core/agent` reaches it, `scripts/` is never traced into a hosted
function, and a missing package makes the command stop before it changes anything. Section 1 does not
see a variable specifier, so it pins this one by its string instead: that file is the only core file
with a quoted string literal that opens with `@open-everywhere/adapters/`, and it has exactly one. A second
quoted literal that names the package fails the gate. A specifier assembled from parts, or a template
literal, is not caught: review keeps those out.

"Via the barrel only" means through `@open-everywhere/core/agent/adapter-api.js` and nothing else
— see [The adapter model § Import the ports from one door](./extending/adapter-model.md#import-the-ports-from-one-door-the-adapter-api-barrel).

### Scripts that read the deployer's app

A product script that reads the deployer's app config — the e2e driver, the evals, and the root
config and model tools (`config-validate`, `config-snapshot-build`, `access-lint`, `e2e-stack-lane`
and the rest) — finds the app root at run time with `resolveAppRoot()`, then imports the app's
modules from that directory with `importAppModule()`. A relative import from the script's own file
cannot find the app when a consumer pins the product as a git submodule: it lands in the product's
reference app. The resolution order:

1. `OE_APP_ROOT`, when set. It must be the absolute path of the app directory.
2. Else a walk upward to the first directory that holds `package.json` and `agent/agent.ts`. The
   walk starts at the working directory. When npm moved the script into a workspace package, the
   walk starts at `INIT_CWD` instead. npm resets `INIT_CWD` to its own working directory on every
   npm call, so the INNERMOST npm call decides:
   - `npm run e2e:driver --workspace @open-everywhere/core` from the consumer's root: the innermost
     call runs at the consumer's root, so the walk finds the consumer's app.
   - A nested `npm run` (`npm test --workspace @open-everywhere/core` → `test:chain` → each
     `npm run test:x`): the innermost call runs in `product/packages/core`, so the walk finds
     `product/`. For the product's own unit chain, that is the intended target. A consumer that
     wants its own app under a nested `npm run` sets `OE_APP_ROOT`.
3. Else the script stops with an error that names both options.

So run the e2e driver and the evals from inside your app, or set `OE_APP_ROOT`. The root tools
import `@open-everywhere/core/agent/scaffold/app-root.js`, which resolves to the core package's
`dist/`. Run `npm run build:packages` in a fresh checkout before `validate:config`, `lint:access`
or the ops MCP server. A `cd
product/packages/core && npm run e2e:driver` from a consumer resolves the product's reference app —
use the `--workspace` form from the consumer's root instead. A relative `typeof import("../agent/…")`
stays in these scripts for the static types only. TypeScript erases it. Three root lints read the
product's own tree by design and keep their relative imports: `model-ids-lint`,
`own-account-gate-lint` and `surface-parity` also read `packages/**` source files.

## The config dependency-inversion pattern

Core needs deployer-owned data — the bundle/binding definitions, the plugin registry, skill
content, memory domains, role presets, webhook triggers, spend budgets, the model-policy envelope
— to do its job (resolve access, route a model call, render a skill). All of that data is **app
data**: it lives in the deployer's own repo (`agent/access/bundles.ts`, `agent/memory/config/domains/`,
…) and differs per fork. Core cannot import it directly without becoming coupled to one
deployment's config shape.

The fix is dependency inversion, not a direct import in either direction:

1. Core declares the shape it needs as a plain interface (`AppConfig`, `access/config.ts`) and a
   registration function (`registerConfig`).
2. The app's own module — `agent/lib/register-config.ts` — imports its **own** config files
   (`access/bundles.ts`, `memory/config/domains.ts`, the plugin registry, …), assembles them into an
   `AppConfig`, and calls `registerConfig(appConfig)` once at boot, as a side-effect import from
   `agent.ts` (the agent definition, loaded before any hook/tool/connection handler runs).
3. Every core consumer that needs deployer config reads it back out through `getConfig()` —
   never `process.env`, never a relative import into `agent/`.

The same shape recurs for models: `core/agent/model/routing.ts` owns the routing **decision**
(which route applies to a call's surface, fail-soft dispatch, memoization) but knows nothing about
*how* a model id becomes a callable model — that's the `ModelBackend` interface, implemented by
the adapter layer (`packages/adapters/agent/model/gateway.ts`, the reference Vercel AI Gateway
backend). A self-host on OpenRouter or a direct provider SDK writes its own `ModelBackend`; the
schema, the resolution logic, and the wrapper in core are unchanged.

**Rule of thumb**: if a core module wants to read `process.env` directly, or import a path under
the app's `agent/` tree, or import a vendor SDK, that's the dependency direction breaking — the
fix is always a registry (`register*` in core, called from the app or an adapter at boot), never
a direct import in either direction.

Two module homes matter here and are easy to conflate:

- `agent/lib/` — **import-only**. Files here are never mounted or discovered by Eve; they exist
  purely to be imported for their side effects (`register-config.ts`, `register-adapters.ts`).
  Because no consumer calls `getConfig()` (or reads an adapter registry) at module top level,
  registration always completes before the first resolve.
- `agent/channels/`, `agent/tools/` (and `hooks/`, `schedules/`, `skills/`, `connections/`) —
  **discovered by filename, and GENERATED**. Eve mounts every module here as a channel or tool; each
  file is a one-line re-export of the core (or adapters, or provider bundle) implementation — e.g.
  `export { default } from "@open-everywhere/core/agent/channels/slack.js"`, or for an extracted
  bundle `export { default } from "@open-everywhere/provider-notion/agent/channels/notion.js"` — see
  [provider bundles § bundle anatomy](./extending/provider-bundles.md#bundle-anatomy). All six
  directories are `oe build` output and are gitignored: the reviewable surface is `roster.config.ts`
  + `roster.lock.json` ([tools & the roster](./extending/tools.md)). `agent/subagents/` is NOT
  generated — a declared subagent is authored content.

## How the boundary test enforces it

`packages/core/scripts/boundary-test.ts` (`npm run test:boundary --workspace @open-everywhere/core`)
is **pure static analysis** —
it reads source files as text and scans import/export/require specifiers; it never executes
anything, so it can assert facts a running test can't (e.g. that a forbidden import is *absent*
anywhere in a tree, including in a branch nothing currently calls).

The file labels its sections `1`, `1b`, `2`, `2b`, `3`, `4`, `4b`, `5`, `6`, `7`. Use those labels —
the code's own comments cite them, and renumbering them breaks every cross-reference. In file
order:

- **1 — Core is portable.** No vendor SDK, no `@open-everywhere/adapters`, no sibling package other
  than core itself, scanned across `packages/core/agent` and `packages/core/scripts`.
- **1b — `binding-pr.ts` holds no GitHub coupling.** A named-file regression guard: the
  credential-binding flow must route GitHub specifics (`api.github.com`, `GITHUB_TOKEN`) through
  the swappable `ConfigPrProvider` port, never inline. The companion assertion proves the coupling
  *moved* to `config-pr-github.ts`, not vanished — the same "moved, not vanished" check section 6
  repeats for every provider bundle.
- **2 — Adapters reach core by package name.** Never a relative climb into core's source tree, and
  never an import of the app.
- **2b — Adapters reach core only through the adapter-api barrel.** Any `@open-everywhere/core/...`
  specifier that isn't exactly `@open-everywhere/core/agent/adapter-api.(js|ts)` fails. Applies to
  every file under `packages/adapters/agent`, `packages/adapters/scripts`, and the app's
  `agent/lib/register-adapters.ts`.
- **3 — The app stays vendor-SDK-free.** The same vendor-SDK regex as section 1, scanned across the
  whole `agent/` tree.
- **4 — Provider bundles (OPE-114) reach core only through the barrel.** The same rule as section
  2b, one layer out. Self-activating: it enumerates `packages/providers/*` at run time and is a
  clean no-op while that directory is empty.
- **4b — The event plane is reachable through the barrel, and only through it (OPE-193).** The
  barrel must re-export `registerEventNormalizer` and `registerEventScopeGrant`, and nothing outside
  core may reach `routines/event-model.ts` or `routines/event-authz.ts` by a deep specifier. Neither
  registrar sat on the barrel once, so a bundle could contribute a signature verifier and then had
  nowhere to put the normalizer and scope grant that make it a work surface. This pins both halves:
  the door exists, and it is the only way in.
- **5 — Provider bundles import no sibling bundle, no adapters, no app.** Catches a bundle importing
  a peer `@open-everywhere/provider-*` package, the `@open-everywhere/adapters` aggregate, or an
  `agent/(tools|channels|hooks)/` app path written as a non-relative specifier. Relative
  specifiers are exempt from the app-tree pattern: a bundle's own sources legitimately live under
  `<bundle>/agent/channels|tools/`, and a relative app-tree reach necessarily climbs out of the
  package, which section 4's climb check already hard-fails. Also self-activating.
- **6 — Provider bundles own their vendor coupling; core carries zero residue.** For each bundle
  that exists, at least one of its pinned vendor fingerprints (a host literal like
  `api.notion.com`, an env-var name like `NOTION_CHANNEL_API_KEY`) must appear under the bundle,
  and none of them may remain anywhere under `packages/core/agent`. Generalises the
  `binding-pr.ts`/`config-pr-github.ts` precedent (section 1b) to every provider.
- **7 — Self-test.** The bundle-boundary machinery (the predicates under sections 4, 5 and 6) runs
  directly against a synthetic, deliberately-mis-wired fixture bundle in a temp directory, proving
  the guards actually *fire* rather than merely never having been triggered. It makes those
  sections' pass/fail accounting real at any bundle count, including zero.

Sections 4, 5 and 6 are **live against all six bundles today**, not dormant. They were written to
self-activate so they could land before the first extraction; they now scan every package under
`packages/providers/`.

Run it from the core workspace — there is no root script of that name:

```bash
npm run test:boundary --workspace @open-everywhere/core
```

It is a leg of core's `test:chain`, and the root `npm test` reaches every package's `test:chain`
through `test:suites` (`scripts/chain/_legs.ts`), so it runs as part of `npm test` too.

## Where the provider-bundle layer fits today

**All six surfaces are now extracted bundles** under `packages/providers/*`
(`@open-everywhere/provider-notion`, `-slack`, `-discord`, `-teams`, `-linear`, `-github`). Each carries its own chat/work surface, read tools, and memory backing, and each is
registered by exactly one `registerXProvider()` call — the full set is the `SELECTED_PROVIDERS`
table in `agent/lib/providers.generated.ts` (built from `roster.config.ts`), driven by `registerDefaultAdapters()` (which `register-adapters.ts` calls) via `declareProviderSelection()`
so an unselected provider mounts nothing. The boundary test's provider-bundle sections (4, 5 and 6
above) are live against every bundle: barrel-only core imports, no sibling/adapters/app reach, and
vendor-string ownership (e.g. `api.notion.com` / `NOTION_CHANNEL_API_KEY` present in the notion
bundle, zero residue under `packages/core/agent`). The plane contracts core exposes (chat-surface
identity/capability/post/read/reaction/origin registries; the work-surface entity-action and read
registries; the connector/credential plane) are what each bundle binds into at its
`register.js`. See [provider bundles](./extending/provider-bundles.md) for the contracts, the
bundle-anatomy recipe, and the findings later extractions inherited.
