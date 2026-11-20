# Provider bundles

> **Status: ALL SIX providers are extracted (OPE-114 stages 3–4).** `packages/providers/*`
> carries notion (stage 3 — the first, incl. the "notion" memory backing), then github
> (chat surface only — the SCM subsystem stays in core), teams (the first to move a **read
> adapter** — Microsoft Graph — and a **routine dispatcher**), linear, discord (the
> deepest-integrated: a custom gateway webhook transport, admin approval cards, a guild-admin
> spend bypass, routine dispatch), and finally slack (stage 4 — the whole reference surface: the
> front door, channel, supervisor/engagement pipeline, identity mapper, read tools, attachment
> plane, slash commands, the governance roster arm, and the `slack-bridge` seam core's generic
> spine consumes). Each is an `@open-everywhere/provider-<name>` workspace package registered by
> one `register<X>Provider()` boot call, which `registerDefaultAdapters()` makes from the app's
> generated selection table (the app's `agent/lib/register-adapters.ts` calls it); core registers NO
> provider inline. See [§ status](#status--whats-actually-extracted) for exactly what moved and
> the findings future bundles inherit.

**Naming collision, read first:** "provider bundle" here is a *package* — a `packages/providers/<name>`
workspace package (`@open-everywhere/provider-<name>`) grouping one vendor's chat + work +
connector code. It is unrelated to two other uses of overlapping words elsewhere in these docs:

- a **bundle** (see [core concepts](../introduction/core-concepts.md)) is a named basket of
  capability *grants* bound to a scope — access-control config, nothing to do with packaging.
- a **provider** (see [connectors & providers](../capabilities/connectors-and-providers.md)) is
  the connector-plane unit — one vendor's MCP connection plus the credentials configured against
  it — nothing to do with packaging either.

A provider bundle *contains* the code that, among other things, defines a provider in that second
sense. Three different nouns, three different layers; keep them separate when reading.

## The three plane contracts

Core exposes three contracts a provider bundle registers into. A bundle implements whichever
subset its vendor actually supports — "undefined = unsupported, never faked" is the rule
throughout (the same doctrine `entity-actions.ts` established first).

### Chat-surface plane

Everything about talking to users on a platform. This section is the *mechanical* half — which
`register*` function to call and where. The *semantic* half — what each generic verb must do, what
it may refuse, and how a provider declares an ability it does not have — is
[the chat-surface contract](./chat-surface-contract.md), which also audits all six shipped
providers against the verb set.

Eight registration seams, each a per-platform
registry (keyed by a runtime `platform: string`, populated by a direct call from the bundle that
owns the implementation):

| Seam | Register fn | Lives in (today) | What registering means |
|---|---|---|---|
| Identity binding | `registerIdentityMapper(platform, mapper)` | `identity/binding.ts` | how a raw webhook event resolves to `(partition, mode, visibility)` |
| Capability manifest | `registerCapabilityManifest(platform, manifest)` | `identity/capabilities.ts` | which of the agent's uniform verbs (`midTurnPost`, `reactions`) this platform actually honours |
| Post arm | `registerPostArm(arm)` | `channels/post-arms.ts` | how to resolve a reply target and dispatch a mid-turn post / unified-window post / redrive on this platform |
| Wake-origin codec | `registerWakeOriginCodec(platform, codec)` | `channels/wake-origin-codec.ts` | validate/derive a stored `UnifiedWakeOrigin` row for this platform (see [status](#status--whats-actually-extracted) — the one non-mechanical seam) |
| Read adapter | `registerReadAdapter(adapter)` | `channels/channel-read.ts` | how `read_channel`/thread reads render this platform's history. It receives the platform's own container id, resolved host-side from the turn's own binding — the model names no container (see the glossary's **container fence**). A CHAT surface also implements the optional `refutedAuthorIds` member — see below |
| Reaction surface | `registerReactionSurface(platform)` | `channels/reaction-ingest.ts` | declares that this platform's inbound reaction path reaches `ingestReaction`. `lint:surface-parity` cross-checks the declaration against the bundle's `reaction-feedback-ingest` row — see [status](#status--whats-actually-extracted) |
| Routine dispatch | `registerRoutineDispatch(platform, provider)` | `schedules/routine-dispatch.ts` | how a fired `create_routine`/cron routine's stored target resolves to this platform's channel module + adapter receive-target (only a platform whose channel supports a PROACTIVE post-back needs this — added OPE-114 stage 4) |
| Credential-presence probe | `registerSurfaceCredentialProbe(platform, probe)` | `observability/telemetry.ts` | reports this platform "configured" for the heartbeat diagnostic without core hardcoding the vendor's env-var name (added OPE-114 stage 4). The probe may be async, for a credential the store holds (OPE-2241) |

**Your surface gets the opaque channel key for free.** The model addresses a container by one
`ch_…` **channel key**, never by a vendor id and never by naming a platform. The single core wake
renderer mints it, and the read verbs decode it, so a new bundle registers a read adapter and
nothing else: it never mints a key, and it never sees one. Its `readChannel`/`readThread` take the
platform's own container id, exactly as before. See the [glossary](../glossary.md#5-scope).

**A chat read adapter also grades its page's authors.** `ReadAdapter.refutedAuthorIds` answers
"which of these authors is positively refuted?" as a `readonly string[]`, and ONE consumer reads that
answer: the `externalPolicy.authorGrain: "withhold"` read consequence (those authors' message text is replaced by
the arrived-marker). Implement it by handing your platform's own per-author evidence to the shared
join, never by writing a second one:

```ts
import { refutedReadAuthorIds, resolvePartition } from "@open-everywhere/core/agent/adapter-api.js";

async refutedAuthorIds(ctx, lines) {
  return await refutedReadAuthorIds(lines, resolvePartition(ctx).workspaceKey, {
    // Optional. Your platform's OWN verdict for one author: true = positively refuted,
    // false = a confirmed member, undefined = could not check (never a refutation).
    surfaceRefuted: async (authorId) => …,
    // Optional. The author's FULLY-QUALIFIED group-rung keys (`<platform>/<tenant>/role:<id>`).
    // `undefined` means CANNOT CHECK and skips that author — never return an unverified `[]`.
    memberships: async (authorId) => …,
  });
}
```

Two rules the join enforces for you, and both matter. It probes **distinct** authors, so a
200-message page costs one lookup per person. And it fails **open** everywhere — no probe, an
unarmed tenant, an unreadable author, a throw — because a bit that is always set is one nobody can
act on. Your line normalizer supplies the evidence it reads: set `authorId` on a human line and
`bot: true` on a machine one. Both stop at the adapter boundary and never reach the model.

Plus the provider-neutral turn-delivery helpers (`channels/turn-delivery.ts` — `isNoReply`,
`finalMessageAction`, bare-stop detection, name-drop matching, standing-seat rotation) that
every chat-surface bundle imports rather than reimplementing; they were lifted out of
`slack-events.ts` in OPE-114 Stage 0 for exactly this reason.

### Work-surface plane

Everything about the provider as a *ticketing/entity* system rather than a chat channel — issue
state, assignment, labels:

| Seam | Register fn | Lives in (today) | What registering means |
|---|---|---|---|
| Entity actions | `registerEntityActionAdapter(adapter)` | `channels/entity-actions.ts` | `setState`/`assign`/`addLabel` verbs against this platform's entities (Linear, GitHub registered) |
| Read adapter | shared with chat-surface, above | `channels/channel-read.ts` | — |

### Event-ingress plane

How this provider's *webhooks* get in: authenticated, translated into the vendor-neutral event
shape, and authorized. All three are per-vendor and all three are yours — a bundle that brings only
one of them cannot carry a work surface, which is why they are listed together. The doctrine behind
them — one instance-wide ingress per vendor, what a scope path may be derived from, and
[what decides whether we can mint a source's secret](./webhook-ingress.md#5-what-decides-whether-we-can-mint-a-sources-secret)
— is [Webhook ingress](./webhook-ingress.md):

| Seam | Register fn | Lives in (today) | What registering means |
|---|---|---|---|
| Signature verifier | `registerWebhookVerifier(verifier)` | `webhooks/verifier.ts` | how a delivery declaring `source: "<vendor>"` is authenticated, in that vendor's own scheme — including whether it signs a timestamp (`signedTimestamp`), which is what decides whether replay is defended at all |
| Event normalizer | `registerEventNormalizer(normalizer)` | `routines/event-model.ts` | how this vendor's payload becomes a `NormalizedEvent` — the scope path and the matchable `fields` a routine's [jq filter](../capabilities/proactivity-and-routines.md#event-filters-are-jq) reads, plus the declarations (`matchKeys` for the tool description and the create-time probe, `scopeKeys`/`scopeKinds` for the mandatory-narrowing refusal) |
| Event scope grant | `registerEventScopeGrant(grant)` | `routines/event-authz.ts` | whether a domain's effective access grants **read** over the scope path a delivery proved — i.e. whether a routine may be woken by it at all |
| Event reach probe | `registerEventReach(source, probe)` | `routines/event-reach.ts` | whether this vendor's deliveries ARRIVE: does the route the bundle mounts hold what its gate needs (a signing secret) to admit a delivery into the routine plane? A normalizer alone proves only that a payload can be read. With no probe, the seat never offers an event watch on the source; a probe that says no makes `create_routine` refuse an event routine on it, and the dispatcher tells an armed one's room (OPE-2547, [the manual](../capabilities/proactivity-and-routines.md#does-the-apps-event-reach-here)) |

Three things worth knowing before you write them:

- **Resolution is by the delivery's *declared* source, never sniffed from the payload.** All three
  registries key on the same string. Sniffing would hand the sender its choice of verifier and
  normalizer, and picking the normalizer that proves the shallowest scope path is a way to make the
  read-grant check weaker.
- **Your grant adapter decides which step of the scope path is authoritative.** Core requires only
  that the path is non-empty; it has no opinion about which end of it matters. GitHub's adapter reads
  the `container` step (a repo, because that is what a GitHub grant is written over) and refuses a
  delivery that proves only a `tenant` — widening to "any repo under a granted owner" would silently
  convert every single-repo grant into an org-wide one. Pick the step your vendor's own permission
  model is expressed at, and if the credential you actually hold cannot express anything narrower
  than the whole tenant, **say so** rather than returning `true`.
- **De-selecting the bundle fails the source closed, it does not open it.** Set `provider` on the
  normalizer and the grant and registration routes through the provider gate, so a de-selected
  bundle registers neither and every event on that source is then refused `no-grant-adapter`.

**Known gap, deliberately not generalised:** PR/SCM verbs (`open_pull_request` and siblings) have
no registry — they're GitHub-hardcoded in core. Per the [adapter model's don't-pre-split
doctrine](./adapter-model.md#writing-your-own-adapter), this stays as-is until a second SCM
(GitLab, Gitea) actually needs the abstraction; a GitHub bundle takes the chat surface + the
entity-action adapter + identity, and the PR/SCM tools stay behind in core regardless.

### Connector/credential plane

Already fully extracted (R1–R8) — a provider bundle that also needs its vendor as an MCP
connector/credential source rides the existing `CredentialBroker` / `ConnectorTransport` /
`ExclusiveCredentialHome` ports from the [adapter-api barrel](./adapter-model.md#import-the-ports-from-one-door-the-adapter-api-barrel).
Nothing new here — see [credentials & the two planes](../security/credentials-and-planes.md) and
[connectors](./connectors.md).

## Bundle anatomy

A provider bundle is a **workspace package**: `packages/providers/<name>` /
`@open-everywhere/provider-<name>`. Nothing publishes them today — `packages/create` does not yet
ship them (see the [extraction plan's distribution stage](#status--whats-actually-extracted)) — and
no bundle sets `"private": true`, so the manifest does not refuse a publish either. It has three
parts:

1. **The implementation** — the vendor's channel/identity/post-arm/tool code, moved verbatim out
   of core (or, for GitHub-shaped work, written fresh). Imports core **only** via the adapter-api
   barrel (`@open-everywhere/core/agent/adapter-api.js`) — the same rule adapters already follow,
   enforced by `boundary-test.ts` rules 4–6 (see
   [core/app separation](../core-app-separation.md#how-the-boundary-test-enforces-it)).
2. **Thin app-tree stub files** — because Eve mounts channels and tools by *filename* under the
   app's `agent/channels/*.ts` and `agent/tools/*.ts` (there is no `eve.config`; discovery is pure
   filesystem convention), the app tree still needs one file per channel/tool. Each stub is a
   one-line re-export, the same shape core→app stubs already use:
   ```ts
   // agent/channels/notion.ts
   export { default } from "@open-everywhere/provider-notion/agent/channels/notion.js";
   ```
3. **One `registerXProvider()` boot call** — a single function (e.g. `registerNotionProvider()`)
   that calls every register seam the bundle implements. The generated selection table
   (`agent/lib/providers.generated.ts`) imports it **statically**, and `registerDefaultAdapters()`
   calls it once at boot. Not a dynamic `import()`: Eve bundles
   the agent definition and its whole import graph into one rolldown chunk, and a literal dynamic
   import code-splits into a second chunk, tripping Eve's "expected one authored module"
   invariant — the same reason the boot wiring keeps every adapter wire-up static.

Eve's native extension packaging (tools/connections/skills/instructions/hooks, mounted at build
time) is **deliberately not used** for any of this — an extension's tools and instructions sit in
the graph unconditionally, even flag-off, and the in-tree agent-browser adapter
(`packages/adapters/agent/browser/register.ts`) already hit a config-binding fragility across a
vendor upgrade using that path even for tools alone. Provider bundles use the runtime-registry
route instead, precisely to keep an unselected bundle's cost at zero.

## Selecting which bundles a deployment carries

Stage 4 made every provider a bundle; **stage 5 made the choice of bundles *declared*;** OPE-375
made it **one row**. Selecting a provider is a single entry in `roster.config.ts`:

```ts
// roster.config.ts
export default defineRoster({
  providers: {
    notion: true,
    slack: { about: "the reference surface — identity mapper, post arm, read adapter, cards, …" },
  },
});
```

`npm run oe:build` derives everything else from that entry: the bundle's app-tree stubs
(`agent/channels/slack.ts`, `agent/channels/slack-commands.ts`, …) **and** its row in the generated
`agent/lib/providers.generated.ts`:

```ts
export const SELECTED_PROVIDERS: readonly SelectedProvider[] = [
  { id: "notion", register: registerNotionProvider },
  { id: "slack", register: registerSlackProvider },
];
```

De-selecting is deleting that one row (or setting it to `false`) and rebuilding — the stubs
disappear with it. Only the workspace **dependency** in `package.json` is still yours to keep in
step, and `npm run lint:provider-selection` fails the build if it drifts.

`registerDefaultAdapters()` (which the app's `agent/lib/register-adapters.ts` calls with the table)
hands the ids to `declareProviderSelection()` **before anything registers**, then drives the table.
That is the only provider knowledge in the boot wiring — there is no second call list to fall out of
step with the selection.

**An unselected provider is structurally absent, not merely inert**, at three layers:

| Layer | Where | What an unselected provider gets |
|---|---|---|
| Build | `oe build` (from `roster.config.ts`) | no config row ⇒ no app-tree stub is generated — and Eve mounts channels/tools **by filename**, so with no stub there is no route: an inbound event 404s at the edge before any OE code runs |
| Boot | `access/provider-selection.ts` (`admitProviderRegistration`) | every platform-keyed seam refuses its row, so it is missing from the identity-mapper, capability, post-arm, codec, read, reaction, routine, card, admin, label and probe registries alike |
| Turn | `channels/unified.ts` (`admitInboundSurface`) | a cross-surface wake whose *origin* is that provider is dropped and audited (`provider.unselected_wake_refused`), never delivered into a window it could not reply from |

The boot gate is the load-bearing one: because every downstream resolution already fails closed on a
missing registry row (no post arm ⇒ the reply spine refuses; no read adapter ⇒ a read fails loud; no
codec ⇒ a stored origin is invalid), refusing the *registration* propagates to every resolution point
for free. Nothing new refuses; the row simply is not there.

**De-selecting a provider moves four things together, and the lint fails the build unless all four
do:** the manifest row + import, the app-tree stubs (`agent/channels/<x>.ts`, `agent/tools/<x>.ts`),
the `@open-everywhere/provider-<x>` dependency in `package.json`, and (optionally) the bundle
directory. Adding one is the same list in reverse. The lint also enforces **seam totality**: every
provider-plane `register*` seam in core must call `admitProviderRegistration`, or be listed in
`UNGATED_SEAMS` with the reason it carries no per-provider row — so a new seam cannot silently
readmit an unselected provider.

Core never names a provider in any of this: the ids are opaque strings the app supplies, and the
manifest lives in the app tree where vendor names belong.

**Undeclared selection = library mode.** Core-as-a-library (unit tests, `eve dev` wiring, an embedder
composing its own graph) has no deployment and therefore no selection, so before
`declareProviderSelection()` is called the gate admits everything. The deployed app always declares
— it is the wiring module's first act, and the lint pins that it is — so the permissive state is
unreachable in a built instance.

**One honest hole, reported loudly.** ESM runs core's own module-load wiring while the app's wiring
module is still importing, so a row that lands before the declaration cannot be retracted. Exactly
one such row exists today: `channels/entity-actions.ts` registering the SCM issue adapter, which
stays in core by doctrine. If a deployment de-selects that provider, `declareProviderSelection()`
warns that the row survives rather than pretending otherwise.

**Still parked (OPE-23):** publishing bundles as real `@open-everywhere/provider-*` npm packages, so
an unselected bundle is never even *installed*. Until then distribution is fork-the-monorepo and
every bundle's source ships in the fork whether selected or not — but nothing an unselected provider
owns is mounted, registered, or reachable.

## Boundary rules a bundle must satisfy

Enforced today by `boundary-test.ts` (self-activating: a clean no-op with zero bundles, applied
automatically the moment one appears under `packages/providers/`):

- **Barrel-only core access** — every `@open-everywhere/core/...` import must be exactly the
  adapter-api barrel; a relative path that climbs out of the bundle's own directory back into
  core's source tree is equally a violation.
- **No cross-bundle, no adapters, no app** — a bundle never imports a sibling
  `@open-everywhere/provider-*` package, the `@open-everywhere/adapters` aggregate, or any
  `agent/(tools|channels|hooks)/` app path.
- **Vendor-string ownership** — a pinned table of that vendor's host/env-var fingerprints (e.g.
  `api.notion.com`, `NOTION_CHANNEL_API_KEY` for Notion) must appear *somewhere* under the bundle
  once it's extracted, and *nowhere* under `packages/core/agent` any more — generalises the
  `binding-pr.ts` / `config-pr-github.ts` GitHub-coupling precedent that already exists in core to
  every provider.

A synthetic fixture test in `boundary-test.ts` proves each rule actually fires (a deep core
import, a relative climb, a cross-bundle import, a vendor-string residue) before any real bundle
exists, so the first real extraction lands against machinery that's already exercised.

## Precedent: entity-actions and post-arms

`channels/entity-actions.ts` (pre-dating OPE-114) and `channels/post-arms.ts` (OPE-114 Stage 1c)
are the templates every plane-contract registry above copies: a module-private
`Record<string, T>`/`Map`, an exported `registerX(platform, impl)`, populated by a direct call from
the bundle that owns the implementation — `registerEntityActionAdapter(linearEntityAdapter)` in
`packages/providers/linear/agent/register.ts`, `registerPostArm(githubPostArm)` in
`packages/providers/github/agent/register.ts`. Extraction was mechanical for these seams: the
per-provider implementation and its `registerX(...)` call moved into the bundle's own module, and
the registry itself and every call-site that resolves through it by platform string were untouched.
Core keeps exactly one inline row — `registerEntityActionAdapter(githubEntityAdapter)` at the bottom
of `channels/entity-actions.ts`, the honest hole this page names below.

## Status — what's actually extracted

**Stages 0–1 (done):** the provider-neutral turn-delivery helpers moved out of
`channels/slack-events.ts`; every chat-surface/work-surface seam above became a per-platform
registry in place — no file moves, no behaviour change.

**Stage 2 (done):** this doc, the adapter-api barrel exposure of the chat/work-surface planes, and
the boundary-test bundle rules (self-activating, fixture-proven).

**Stage 3 (done — the proof): Notion is extracted.** `packages/providers/notion` carries the
channel + supervisor + webhook core + REST layer + identity (mapper included), the post arm, the
wake-origin codec, the two read tools, and the memory backing — all three planes in one bundle
("pick Notion" = one package). `registerNotionProvider()` (`agent/register.ts`) performs every
registration and is called once at boot from the generated selection table. The bundle owns its
vendor strings (`api.notion.com`, `NOTION_CHANNEL_API_KEY` — zero residue under
`packages/core/agent`, boundary rule 6), ships its own test suite (`scripts/`, on the bundle's own
`test:chain`, which `npm test` batches), and every remaining platform stays exactly where it was: real
code, in core, registered from core. External npm distribution is still gated on the OPE-23
publishing story; until then bundles are workspace packages inside this monorepo and every
provider ships in the fork.

**Stage 4 (done): Teams is extracted.** `packages/providers/teams` carries the channel + front +
supervisor + identity (mapper included) + post arm + wake-origin codec (which also owns the
Bot-Connector `serviceUrl` allowlist `isTrustedTeamsServiceUrl`) + the **Microsoft Graph read
adapter** + the **proactive routine dispatcher**. `registerTeamsProvider()` (`agent/register.ts`)
performs every registration and is called once at boot from the generated selection table. The
bundle owns its vendor strings (`graph.microsoft.com`, `smba.trafficmanager.net` — zero residue under
`packages/core/agent`). Teams surfaced **two seams notion did not need**, both now part of the
contract every later read/routine surface inherits:

- **Read-adapter registration** (`registerReadAdapter`, exposed via the barrel with the live
  `READ_ADAPTERS` / `resolveReadAdapter` / `supportedReadPlatforms()` views). A read on an
  unregistered surface fails loud. `SUPPORTED_READ_PLATFORMS` is a **live view** over the same
  registry — `registerReadAdapter` pushes into the very array it exports — so a bundle-registered
  adapter appears in it after boot; `supportedReadPlatforms()` is the equivalent getter.
- **Routine dispatch** (`registerRoutineDispatch`, `schedules/routine-dispatch.ts` — deliberately a
  standalone module so the barrel re-exports the seam without pulling the dispatcher's
  `defineSchedule` default). A bundle whose surface supports proactive fires registers a
  `resolveTarget(routine) → DispatchTarget`; core keeps only the slack resolver inline (reaching the
  extracted slack channel through the provider bridge). `DispatchTarget.channel` widened to the generic eve `Channel` and `.target` to an open
  record arm so an extracted bundle supplies its own channel + receive-target shape.

Cross-cutting core coverage that used to exercise teams *through the registries* (reply arming/target/
execute, the manifest row, the read routing, the routine-fire item-15 property, the chat-audit
closing-prose drop row, the codec derivations) moved to the app-level
`scripts/teams-provider-integration-test.ts` + the relocated `scripts/unified-window-test.ts`; core
suites now pin the fail-closed UNREGISTERED defaults.

**Stage 4 (done — the deep one): Discord is extracted.** `packages/providers/discord` carries the
custom gateway webhook transport (`discord-gateway.ts`, the privacy floor + divert), the interaction
channel + approval-click front, the admin approval CARD render/poster/click flow, the wake backscroll,
the post arm, the wake-origin codec, the read adapter, the `/oe` slash-command half, and the identity
mapper — registered by `registerDiscordProvider()` (`agent/register.ts`). Discord's coupling was far
deeper than notion's, so it generalised **six registry seams** in core — five of them new, routine
dispatch being shared with the Teams seam rather than new (each mirrors the
post-arms pattern — a module-private registry + a `registerX` fn — so a bundle owns the vendor code
and core dispatches by platform key):

| Seam | Core module | Populated by | What core code dispatches through it |
|---|---|---|---|
| Surface message ops | `channels/surface-message-ops.ts` | `registerSurfaceMessageOps` | post-with-anchor / edit / file-upload — `tools/post_file.ts`, the approval decision-notice (Slack keeps its arms inline) |
| Approval-card poster | `approvals/flow.ts` (`registerCardPoster`) | `registerCardPoster(platform, poster)` | the propose tools select `{ postCard: cardPosterFor(platform) }` instead of importing the vendor card poster |
| Judge-lift notice poster | `approvals/flow.ts` (`registerJudgeLiftNoticePoster`) | `registerJudgeLiftNoticePoster(platform, poster)` | the BUTTON arm of the judge-lift notice — the room's only trace of an action the approval judge lifted, and the one "This should not have run" button, in this surface's own envelope. **It is optional, and it is not the whole road.** `postJudgeLiftNotice` (`approvals/flow.ts`) picks a registered poster, else Slack's built-in Block Kit render, else the shared plain-text render on this bundle's `SurfaceMessageOps` transport — so a bundle that registers no poster still posts the notice, carrying the overrule as an instruction in words. **Register one only once the tap comes back**, the same rule the unified component plane takes: a button that settles nothing is worse than no button. Register it beside the card poster when you do — they are separate hooks because their contracts differ (the card announces a PENDING action and its failure is fatal; the notice reports an action that already RAN and its failure is swallowed). Slack registers neither: core's built-in path renders both |
| Routine dispatch | `schedules/routine-dispatch.ts` | `registerRoutineDispatch` | `schedules/dispatch.ts` resolves the channel + receive-target a cron fire `to(channel, target).send(…)`s into (unified with the teams seam) |
| Native admin check | `access/native-admin.ts` | `registerNativeAdminCheck` | the spend-cap bypass's native leg (`spend/bypass.ts`) — Discord's guild-ADMINISTRATOR REST verdict |
| Scope-label resolver | `approvals/scope-label.ts` | `registerScopeLabelResolver` | friendly approval-card labels (`#channel`, `the <guild> server`) per surface |

Discord also flipped `channels/channel-read.ts`'s `SUPPORTED_READ_PLATFORMS` **snapshot → a live
`supportedReadPlatforms()` getter**: it was a load-time `Object.keys(registry)` that captured discord
only because discord registered at core load; an extracted bundle registers at BOOT (after core
loads), so a frozen snapshot would miss it. The `UnifiedWakeOrigin` union keeps its discord arm (wire
schema); `wake-origin-codecs.ts` now registers NO codec in core at all — every per-platform codec
lives in its provider bundle and registers at boot, so core fails closed on a stored row of any
platform, and `packages/core/scripts/wake-origin-fixtures-test.ts` freezes stored-row compatibility, run from
the app root by `test:wake-origin-fixtures` once every bundle has registered.
Because discord's test apparatus (the golden-timeline scenario harness + many mixed tests) reaches
deep into core internals that are NOT small "adapter ports", those tests are **app-tier** (root
`scripts/`, composing core + the bundle like `notion-provider-integration-test.ts`) rather than in
the bundle's own `scripts/`, keeping the core adapter-api barrel a small surface.

**Stage 4 (done): Slack is extracted** — the deepest-coupled surface, and the one that forced the
seam set to be complete. `packages/providers/slack` carries the front door (`slack-front.ts`),
the channel + supervisor/engagement pipeline (`slack-events.ts`, `slack.ts`), identity capture +
the mapper (`slack-identity.ts`), the read spine + read adapter (`slack-read.ts`), the trusted
attachment plane (`slack-attachments.ts` + the host-pinned `slack-attachment-fetch.ts`), slash
commands, the post arm, the wake-origin codec, and the OPE-110 governance roster arm.
`registerSlackProvider()` registers all of it. Two stage-4-specific seams exist beyond the
standard plane contracts:

- **The slack bridge** (`core channels/slack-bridge.ts`, `registerSlackBridge`): core's GENERIC
  spine keeps small platform-branched Slack calls — approval/connector cards and credential
  intake post via `slackForm`, spend/usage reports resolve display names, the routine/webhook
  dispatchers dispatch into the Slack channel object, the approval flow verifies a DM partner,
  instructions render the readable-channel list. Those resolve through this one registry with
  fail-closed defaults (unregistered ⇒ exactly the "Slack not configured" behaviour: posts
  return undefined, the internal-channel gate stays closed, dispatch dry-runs).
- **Ops-plane registries**: `registerSurfaceAppManifest` (ops/surface-manifest.ts) in the light ops
  arm, and `registerSurfaceCredentialProbe` (observability/telemetry.ts) in `register.ts`, let the
  bundle own its vendor env-key knowledge (`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` are its rule-6
  fingerprints). The credential probe registers in `register.ts` and not in the light arm because it
  reads the credential store, which the light door cannot reach (OPE-2241). The shipped ops MCP entry
  is now the APP-tier `scripts/ops-mcp.ts`, which registers the bundles' light ops arms
  (`agent/ops.ts` — no channel graph) before serving.

With slack landed the OPE-114 extraction sweep is COMPLETE: every provider ships as a bundle and
core registers none inline. External npm distribution is still gated on the OPE-23 publishing
story; until then bundles are workspace packages inside this monorepo and every provider ships in
the fork.

**Stage-3 findings the next extractions inherit** (each was discovered the hard way here):

- **Wake-origin codec completeness moved from compile time to runtime.** Core's
  `channels/wake-origin-codecs.ts` used to map exhaustively over `UnifiedWakeOrigin["platform"]`;
  with notion's codec in the bundle it now maps over the *not-yet-extracted* arms only. The
  six-arm completeness guarantee is a **runtime assertion in the app-level unified-window test**
  (`scripts/unified-window-test.ts` at the repo root — it runs `registerNotionProvider()` first,
  then asserts every union platform resolves a codec). The `UnifiedWakeOrigin` TYPE union
  (including the notion arm) stays in core: it is the wire schema for stored rows.
- **The stored-data fixtures oracle is now invoked from the app tier.** The oracle file
  (`packages/core/scripts/wake-origin-fixtures-test.ts`) is frozen and unchanged, but core alone
  can no longer validate notion rows (correct fail-closed behaviour for an instance without the
  bundle), and a core script may not import a provider package (boundary rule 1) — so the root
  `test` chain runs it through `scripts/wake-origin-fixtures-boot.ts`, which registers the bundle
  first and then imports the untouched oracle. Core's `pretest` hook was retired in its favour.
- **Cross-cutting core tests split three ways.** Core suites that exercised notion *through the
  registries* (reply arming/execute, the manifest row, codec derivations) now pin the fail-closed
  UNREGISTERED defaults in core alone; the registered behaviour moved to the app-level
  `scripts/notion-provider-integration-test.ts` (which composes core + bundle exactly as the
  deployed app does) and to the bundle's own suite. The four-surface single-window proof
  (`unified-window-test.ts`) moved wholesale to the repo root for the same reason.
- **Boundary rule 5 exempts relative specifiers.** A bundle's own sources live under
  `<bundle>/agent/channels|tools/` — the sanctioned layout — so the app-tree pattern
  (`agent/(tools|channels|hooks)/`) only applies to non-relative specifiers; a relative app-tree
  reach necessarily climbs out of the package, which rule 4 already hard-fails.
- **Security manifests stay pinned by the `test` chain, in core, BY DECISION** (`access/source-gate-manifest.ts`,
  `access/window-gate-manifest.ts`, `access/work-mount-manifest.ts`, `access/consequence.ts` keep
  their `read_notion_*` rows); the root lints now *scan* bundle tool sources too
  (`scripts/source-gate-lint.ts` and `scripts/work-mount-lint.ts` enumerate
  `packages/providers/*/agent/tools`; `scripts/consequence-lint.ts` resolves
  `@open-everywhere/provider-<x>` re-exports to `packages/providers/<x>`).
- **The dynamic-tool doctrine travels with the tools.** A bundle's dynamic tool mounts through
  `sessionMountedTool` (from `@open-everywhere/core/agent/adapter-api.js`). eve 1.x runs every
  `defineDynamic` function before every model call, so the helper keeps the seat decision in
  `ctx.memo`, keyed on the session. A session keeps the seat it started with until a deployment
  change; eve then discards the memo and decides the seat again from the session's latest frame. A
  fresh process on the same deployment reads the same decision back. The bundle carries its own test (`scripts/dynamic-replay-test.ts`).
  `npm run lint:dynamic-tools` refuses a file that calls `defineDynamic(` directly with no
  `memoized(`. Its exemption list is closed: each entry names one file, a reason, and the leg whose
  test fails if the reason stops being true. Two core files are on it. The seat cut must re-decide
  before each model call, so a halt lands on the next one. The connector mount keeps its own
  listing memo, keyed by session and principal and held for one turn on a refusal or a sign-in need.
- **One tool name, one implementation per session.** eve 1.x builds each session's tools from the
  value its dynamic returns for that session, so two sessions that mount different entries under one
  name are each offered their own (`credential-grant-borrow-mount-test.ts` §6 passes each chat's
  mount through eve's `contributeTools`, and runs each chat's own entry). A tool that
  needs several implementations under one name — the `reply` plane's unified/per-surface pair —
  registers them with `sessionVariantTool`, which memoizes the variant key for the session.
  A dynamic tool no longer replaces a static tool of the same name: define a per-session tool ONLY
  in a dynamic file. `packages/core/scripts/dynamic-entry-collision-test.ts` fails on a dynamic name
  that equals a static tool file name, and on a new overlap with eve's default tools.
  A variant family that fences its own result declares its mounted name with
  `setVariantProjectedName` (`access/connector-result-fence.ts`), so the connector executed-fact line
  is never added to its result.

**Two known non-mechanical spots** for the remaining sweep:

- `registerWakeOriginCodec`'s platform parameter is type-constrained to core's closed
  `UnifiedWakeOrigin["platform"]` union — moving an *already registered* platform's codec into its
  bundle is mechanical (notion proved it), but a genuinely NEW platform still needs a core PR
  widening the union first, because a `UnifiedWakeOrigin` is stored data.
- `registerReactionSurface(platform)` (`channels/reaction-ingest.ts`) maintains a membership set that
  `npm run lint:surface-parity` reads. That gate's two arms do not cover the same set: an
  **underclaim** always reds (a `reaction-feedback-ingest` row declared `unsupported` that the
  registry contradicts), while an **overclaim** reds only a bare `"supported"` — a
  `{ supported: "<note>" }` cell is exempt by design, so a bundle using the noted form is trusted to
  keep its own registration honest. Nothing at RUNTIME branches on the set: an unregistered platform
  behaves exactly as it always did.
