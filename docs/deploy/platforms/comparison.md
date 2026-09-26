# Hosting comparison — what runs where

A [hosting platform is a curated set of adapters](../hosting-overview.md). This page puts
the four realistic hosting shapes side by side — rows are capabilities, cells are status —
so you can pick a package the way you'd read a pricing table. It compares:

- **Vercel (managed)** — the reference deploy: one-click, serverless, Vercel Sandbox.
- **KVM-capable self-host** — bare metal or a VDS with `/dev/kvm`, running the
  **microsandbox** backend. Gives native host-grain egress enforcement, but not full
  firewall parity — see [the measurement](#the-differentiator-row-the-egress-firewall).
- **Plain-VPS Docker self-host** — any small Linux VM with Docker. The cheapest,
  simplest self-host — at the cost of fine-grained egress enforcement.
- **Container PaaS** — Railway, Fly.io, Render and similar. Deploy-a-container
  convenience, but no isolated executor with an enforceable firewall.

The other cloud platform pages ([Cloudflare](./cloudflare.md), [AWS](./aws.md),
[Azure](./azure.md), [GCP](./gcp.md)) remain **Roadmap** — the seams exist but nothing is
built or proven for them, so they aren't columns here.

## Legend

| Status | Meaning |
|---|---|
| ✅ **Supported** | Built and exercised — either the reference deploy itself, or a component that is genuinely platform-independent (works unchanged wherever the agent runs). |
| 📋 **Documented, community-verifiable** | The seam exists and has first-party proof (Eve's vendor ran it — see [what has actually been run where](#what-has-actually-been-run-where)), but Open Everywhere's own adapters have **not** been smoke-tested on it yet. |
| 🚧 **Possible with loss** | It runs, but a named guarantee is given up. The loss is spelled out — don't accept it by accident. |
| ⛔ **Structurally unavailable** | Not a matter of wiring or effort — the platform cannot provide it. |

## The matrix

| Capability | Vercel (managed) | KVM self-host (bare metal / VDS) | Docker self-host (any VPS) | Container PaaS (Railway / Fly / Render) |
|---|---|---|---|---|
| **Overall** | ✅ Reference deploy, run end to end | 📋 Seams proven first-party — Eve's own framework docs now cover this (see [below](#what-has-actually-been-run-where)); not OE-smoke-tested | 📋 Same, minus egress parity — but the OE image's **boot** is now first-party smoke-verified off Vercel (clean boot + `docker()` backend + egress posture; a full live turn is still unverified — [details](#what-has-actually-been-run-where)) | 🚧 Boots only with egress enforcement disabled; unproven for Eve |
| **Durable sessions / workflow runtime** | ✅ Vercel Workflow (the default) | 📋 Local world (`.workflow-data` on the box's persistent disk) is the off-Vercel **default** for a single node — no seam-swap needed; `@workflow/world-postgres` is the multi-node option — see [notes](#durable-sessions--the-workflow-world) | 📋 Same | 📋 Same, if a single always-on instance with a persistent volume; `@workflow/world-postgres` for multi-instance |
| **Sandbox execution** | ✅ Vercel Sandbox (Firecracker microVM) | 📋 microsandbox — Eve ships it (`eve/sandbox/microsandbox`, needs `/dev/kvm`), but **Open Everywhere does not expose it as a backend**: `OE_SANDBOX_BACKEND` accepts only `docker`/`justbash` and rejects anything else fail-loud at boot, so even a KVM host can't select it without a code change (see [note](#microsandbox-is-not-a-selectable-open-everywhere-backend)) | 📋 `docker()` backend (Eve built-in) — **the OE default off Vercel, now boot-smoke-verified** (`npm run test:docker-smoke` builds the image and boots it on `docker()` via the daemon socket; see [below](#what-has-actually-been-run-where)) | 🚧 Docker-backend shape at best, unverified; ⛔ microsandbox on Fly Machines (no nested virt) |
| **Fine-grained egress firewall** ★ | ✅ Full: per-host allow + credential injection at the boundary | 🚧 Host-grain allow/deny only, measured (OPE-917) — no at-boundary credential injection, no `match` narrowing, and not a selectable OE backend today | 📋 Full parity via Open Everywhere's own **egress-proxy sidecar** on `docker()` (the shipped, [documented](./self-host-egress.md) self-host path — no KVM needed; the Tier B MITM + credential-injection mechanic is live-verified on the `justbash` backend, and the end-to-end credentialed checkout on `docker()` is still live-pending) — coarse-only if you skip it, or run the [hybrid Vercel Sandbox pattern](#the-hybrid-option-vercel-sandbox-from-any-host) (UNVERIFIED live) instead | 🚧 Same loss as plain Docker unless you wire the same egress-proxy sidecar yourself, or worse (`just-bash`); hybrid Vercel Sandbox applies here too (UNVERIFIED live) |
| **Model routing** | ✅ AI Gateway, OIDC auto-auth | ✅ Portable — same Gateway via `AI_GATEWAY_API_KEY`, or any provider via `ModelBackend` | ✅ Same | ✅ Same |
| **Credential broker** | ✅ `env` + `db` (core); OAuth connectors via the built-in own-rolled flow | ✅ `env` broker (core, zero-dependency) or your own vault — static keys only | ✅ Same | ✅ Same (platform secrets feed `env`) |
| **Postgres / memory** | ✅ Neon (marketplace, `DATABASE_URL` injected) | ✅ Any `PgClient`-shaped Postgres; embedded-Postgres (PGlite) floor for single-node — same dialect, zero wiring | ✅ Same | ✅ Platform-managed Postgres |
| **Scheduler / cron** | ✅ Eve-generated Vercel Cron | ✅ In-process croner, zero wiring — compiled into the `eve start` node-server build itself, so it's the same on every self-host box; see [note](#cron-runs-itself-off-vercel-too) | ✅ Same | ✅ Same — the instance just can't be allowed to scale to zero |
| **Discord ambient relay** | ✅ but needs a **separate** always-on host — serverless can't hold the Gateway WebSocket | ✅ Co-hosts on the same box: a second systemd unit posting to localhost | ✅ Same — the separate-host requirement disappears | ✅ Natural fit — the relay is a plain always-on Node service |
| **One-click deploy / DX** | ✅ Deploy button + quickstart skill | ❌ None — you own provisioning, TLS, systemd, patching, plus the microsandbox install | ❌ None — same, minus the KVM step | 🚧 Good container-deploy DX, but no Open Everywhere template or turnkey set |
| **Rough monthly cost shape** | Usage-based; near-zero idle compute (the sandbox stops after each turn) + managed DB; the relay host bills separately if you use Discord ambient | Cheap **bare metal or VDS** from roughly $11/mo — see the [KVM note](#the-kvm-tier-means-bare-metal-or-a-vds) | Cheapest entry: any small VPS, flat monthly; ops burden entirely yours — the session container is stopped at turn end, so idle containers do not accumulate on the box | Per-service monthly; each always-on service bills separately |

★ The differentiator row. If you read one section below, read
[the egress firewall](#the-differentiator-row-the-egress-firewall).

## The differentiator row: the egress firewall

The [egress firewall](../../security/security-model.md) is Open Everywhere's strongest
control: default-deny per-host egress, with credentials **injected at the firewall** so a
secret never enters the sandbox. Via Eve's own `setNetworkPolicy`, that guarantee is only as
good as the executor underneath it — only **Vercel Sandbox** applies the full fine-grained
policy natively (per-host allow, credential injection, `match` narrowing). **microsandbox
applies only the host-grain part** — allow/deny-by-default is enforced natively, but
credential injection silently no-ops (Eve never enables TLS interception, so the real value
never replaces the placeholder) and `match` narrowing is dropped (measured, OPE-917;
upstream defect filed as OPE-954). Plain Docker enforces coarse allow-all / deny-all only,
and `just-bash` rejects network policies entirely. Open Everywhere's off-Vercel deployment
sidesteps the Docker limit rather than hitting it: it pushes the compiled policy to a
**forced local egress proxy** in front of `docker()` instead of relying on Eve's own
`setNetworkPolicy`, restoring full parity without KVM — see
[Self-host with enforced egress](./self-host-egress.md).

On a backend that can't apply the fine-grained policy, the session **aborts** rather than
running unenforced (fail-closed — the sandbox's own default is allow-all, so an unenforced
session is an unfirewalled one). Setting `egress.allowUnenforced: true` overrides that
abort with a warning. Be clear-eyed about what that flag gives up:

- **Default-deny egress is gone.** The sandbox session runs on the executor's allow-all
  default — the agent can reach any host, not just the ones its
  [bundles](../../how-it-works/access-and-scoping.md) declare.
- **At-boundary credential injection is gone.** There is no firewall to stamp auth headers
  onto outbound requests, so the "the agent *uses* a credential it never *holds*" property
  doesn't hold — credentialed egress hosts don't work as designed.
- **The exfiltration backstop is gone.** The security model deliberately assumes the agent
  can be *talked into* attempting anything (prompt injection) and relies on constraining
  what it can *reach*. Without enforcement, that containment is not there.

Everything else — access scoping, approval gates, org isolation, append-only audit — still
holds; those are enforced host-side, not in the sandbox. The KVM tier does not buy the full
egress guarantee today: **microsandbox** enforces host-grain allow/deny natively, at the
cost of needing `/dev/kvm`, but not credential injection or `match` narrowing (measured,
OPE-917) — and it is not a selectable OE backend regardless (see
[below](#microsandbox-is-not-a-selectable-open-everywhere-backend)). Open Everywhere's own
**egress-proxy sidecar** (see [Self-host with enforced egress](./self-host-egress.md)) is
the path that gets full parity on plain `docker()`, no KVM needed — which is why that's the
recommended self-host default rather than the KVM tier.

### The KVM tier means bare metal or a VDS

microsandbox requires hardware virtualization (`/dev/kvm`). Checking the mainstream cheap
cloud VPS providers (a project finding, mid-2026): **nested virtualization is not available
on ordinary cloud VPS instances** — the big low-cost providers block it on their standard
shared-vCPU lines, and where it exists at all it's confined to VDS or dedicated tiers. So
the realistic KVM tier is **cheap bare metal** (the OVH Eco / Kimsufi class, from roughly
$11/mo) **or a VDS**, not a $5 cloud VPS. Prices drift and cloud-VPS pricing has been
volatile in 2026, so treat any number here as a shape, not a quote.

One structural negative worth recording: **Fly Machines cannot host microsandbox** — Fly's
Machines are themselves Firecracker VMs with no nested-virtualization support, so there is
no way to get `/dev/kvm` inside one. (Fly's own Sprites product is the right *shape* of
sandbox, but it would need a hand-authored Eve `SandboxBackend`, which doesn't exist.)

## Durable sessions — the workflow world

What makes a chat survive a redeploy — session parking, transcript durability, resumable
hooks — is Eve's durable workflow runtime. On Vercel it's the built-in default (backed by
`@vercel/queue`). Off Vercel, the **default is the local world**: run state persists to
`.workflow-data` on disk (Eve's own deployment guide, §8), which is enough for durable
resume — continuation tokens, Slack thread resume — **on a single node, provided that
directory sits on a persistent volume**. You don't need to swap anything to get durable
sessions on one box.

Eve also exposes a seam to swap the "world" package for a Postgres-backed one
(`@workflow/world-postgres`) for multi-node or fully-stateless hosts, and that swap has
been **proven live off-Vercel**, though on Eve 0.15 — many releases behind the pin this repo
runs — see [below](#what-has-actually-been-run-where). Caveats, faithfully carried over:

- Open Everywhere's own config **doesn't set either seam explicitly** — the repo relies on
  Eve's default (Vercel Workflow on Vercel, local world off it) today. Wiring the Postgres
  world is a config change (`experimental.workflow.world` in `agent/agent.ts`), not new
  engineering, but it hasn't been done or tested here.
- **Eve names the `@workflow/*` line it needs — match it, and take the `beta` dist-tag.**
  Eve 0.54.3 declares `@workflow/core` 5.0.0-beta.50 and `@workflow/world` 5.0.0-beta.34 in
  the `devDependencies` block of its own `node_modules/eve/package.json`. At startup
  `assertConfiguredWorldCompatibility` reads that line and refuses a configured world whose
  `@workflow/core` or `@workflow/world` dependency sits on a different major or a different
  prerelease tag. Re-measured on 2026-09-14 at the 0.52.2 → 0.54.3 bump:
  `@workflow/world-postgres` `latest` (4.3.6) is on the 4.x line and this check refuses it. The
  `beta` tag (5.0.0-beta.42) depends on `@workflow/world` 5.0.0-beta.35 — one build ahead of
  Eve's own pin, on the same major and the same `beta` tag — and passes, because the check
  compares the major and the prerelease tag, not the build number. Re-measure on any Eve bump;
  both the tag and the pinned line move.
- **A second startup check reads the world's spec version.** Eve admits a world whose
  declared `specVersion` falls in the range `[SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  SPEC_VERSION_MAX_SUPPORTED]`, and refuses anything else through
  `assertWorldSupportsRuntimeProtocol`. Under Eve 0.54.3 that range is still `[6, 7]` (re-read at the bump). A world on
  the wrong `@workflow/*` line never reaches this check, because the package-line check
  above refuses it first.
- **Passing both startup checks does not prove replay works.** The world validates every
  event, run and hook against the zod schemas of its own pinned `@workflow/world`, while the
  runtime writes those rows from Eve's compiled `@workflow/core`. If the two builds disagree
  on a field, the failure is a `ZodError` in the middle of a run, not at boot — and the spec
  version is one coarse integer that cannot express that drift. Keep the world's
  `@workflow/world` version equal to the one Eve pins, and re-check it on every Eve bump.
- **A reverse proxy in front of a self-host must forward two paths, not one:** `/eve/`
  *and* `/.well-known/workflow/` (workflow callbacks land on
  `/.well-known/workflow/v1/flow`). Proxying only `/eve/` lets sessions start normally and
  then **stalls runs silently** — no error, just a session that never resumes. This is
  named explicitly in Eve's own deployment guide; treat it as the first thing to check if
  a self-hosted turn hangs.

On a container PaaS the same local-world-on-a-volume shape applies for a single always-on
instance; the Postgres-world shape applies for multi-instance. Fit varies: Render's native
background-worker / cron / durable-workflow service types are the closest generic-PaaS
match for the park/resume pattern; Railway has no dedicated background-worker service
type, so long-running work ends up inside the web service. Neither has been attempted for
Eve.

## Cron runs itself, off Vercel too

The scheduler row above reads ✅, not 📋, for a concrete reason: Eve's `eve build` output
off Vercel is a standard Nitro `node-server` bundle, and running it with `eve start`
compiles Open Everywhere's own routine dispatcher schedules straight into **in-process
croner jobs that start automatically at server boot** — no external cron pinger, no
systemd timer, no platform cron trigger needed. This was confirmed directly against our
own built `.output/server/index.mjs` (`nitro.json` preset `node-server`), which starts a
`startScheduleRunner(...)` call at boot. Because it's the same build artifact regardless
of which box runs it, the behaviour is identical on KVM self-host, Docker self-host, or a
container PaaS — it isn't something Open Everywhere has to wire per platform.

The one caveat: this fires **only** when the process is actually run via `eve start` (the
compiled node-server output that owns the boot sequence). A bespoke HTTP-only host that
imports Eve's routes without going through `eve start` compiles the schedules but never
fires them — so an always-on `eve start` process is the requirement, not an assumption.

## The hybrid option: Vercel Sandbox from any host

A newer option worth naming on its own: you can run the app anywhere always-on and **still
use Vercel Sandbox as the executor**, via `VERCEL_TOKEN` + `VERCEL_TEAM_ID` +
`VERCEL_PROJECT_ID`. Vercel's own sandbox auth documentation names non-Vercel hosting as a
supported access-token flow, and Eve's sandbox credential chain already reads exactly those
env vars as its fallback (after the on-platform OIDC token). Sandbox pricing is the same
either way (~$0.128/vCPU-hr active, ~$0.60/M sandbox creations as of this writing).

**The exact self-hoster config (code path verified, not live-run — 2026-07-24):** on an
off-Vercel box, set the OE platform seam **`OE_PLATFORM=vercel`** — this is what makes
`onVercel()` true, so Open Everywhere selects the `vercel()` sandbox backend *and* takes the
on-Vercel egress path (`sandbox.setNetworkPolicy`, full firewall parity) instead of the
self-host proxy push. Then provide the three Vercel credentials so Eve can authenticate
sandbox creation from off-platform:

```
OE_PLATFORM=vercel
VERCEL_TOKEN=<a Vercel access token>
VERCEL_TEAM_ID=<team/org id>        # or VERCEL_ORG_ID
VERCEL_PROJECT_ID=<project id>
```

Both halves were confirmed by reading the shipped code: Eve's
`getVercelSandboxCredentials` resolves `token ?? VERCEL_OIDC_TOKEN ?? VERCEL_TOKEN`,
`VERCEL_TEAM_ID ?? VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`
(`node_modules/eve/dist/src/execution/sandbox/bindings/vercel-credentials.js`); OE's
platform seam resolves `OE_PLATFORM` over `process.env.VERCEL`
(`packages/core/agent/access/platform.ts`). **No one has run this path live**, so it stays
UNVERIFIED below — the wiring is proven to exist, the round-trip is not.

If it works as documented, this converts "self-host = lose the firewall, or buy KVM bare
metal" into "self-host = keep a metered Vercel Sandbox bill" — full egress-firewall
parity, stop-after-turn, and `extend_workspace_time` unchanged, on a Docker box or a
container PaaS instance with no KVM in sight.

**This is UNVERIFIED live.** No one has run Open Everywhere this way; it's a documentation-
level inference from Vercel's own auth docs plus Eve's credential-chain source, not a
tested path. It also trades a scoped, short-lived OIDC token for a long-lived personal
access token sitting on a box you don't control the way Vercel controls its own
infrastructure — a real credential-hygiene trade-off to weigh, not a free upgrade. Treat
the egress-firewall cells above that reference this pattern as "plausible, not proven."

## What has actually been run where

An honest confidence note, because the statuses above are only as good as their evidence:

- **Vercel is the only deploy that has run Open Everywhere end to end.** Every ✅ in that
  column is backed by the reference deploy itself.
- **Off-Vercel self-host is now first-party documented, not just third-party proven.**
  Eve's own framework docs (v0.20, `docs/guides/deployment.md`, also published at
  eve.dev/docs/guides/deployment) ship a dedicated *"§8 Deploy without Vercel"* section:
  `eve build && PORT=3000 eve start --host 0.0.0.0` as "a normal Node service behind your
  own process manager, container platform, or reverse proxy." That's Eve's vendor
  documenting the path itself, not just a labs demo. Separately, Vercel's own labs
  published [vercel-labs/steve](https://github.com/vercel-labs/steve) — Eve running with
  zero Vercel-proprietary infrastructure: a self-hosted Postgres workflow world, the Docker
  sandbox backend, direct-to-provider model calls, deployed to a plain VPS under systemd
  (pinned to Eve 0.15 — older, but still a full live run). Together that's strong
  first-party evidence the *seams* work. It is **not** proof that Open Everywhere's
  specific adapters — the egress policy compiler, memory silos, the spend ledger —
  survive the swap: no OE smoke test has been run off Vercel yet. Hence 📋, not ✅.
- **The microsandbox tier has been booted and measured, not just documented.** A proving run
  (OPE-917) built a microsandbox microVM on a real KVM host and drove it against the same
  policy the OE egress compiler produces. Result: host-grain allow + deny-by-default +
  `deny-all` are enforced natively; at-boundary credential injection does not happen (Eve
  never enables TLS interception, so the placeholder header reaches the real origin
  unchanged); `match` (method/path) narrowing is dropped. Upstream defect filed: OPE-954.
- **The hybrid Vercel-Sandbox-from-any-host pattern (previous section) is UNVERIFIED
  live** — it's the one claim in this document that rests on reading two vendors' docs
  side by side rather than on any proof run, first- or third-party.
- **Open Everywhere's own Docker boot IS now first-party smoke-verified — but only the
  boot, not a full turn.** The repo ships a reference image (root `Dockerfile` +
  `docker-compose.yml`) and an opt-in integration smoke, `npm run test:docker-smoke`
  (`scripts/docker-smoke.sh`). It builds the image, boots it **off Vercel on the default
  `docker()` sandbox backend** with the Docker daemon socket mounted, and asserts: a clean
  boot (the Eve node-server actually serves HTTP), the backend resolving to `docker()` **and
  Eve initializing a real sandbox template through the socket** (so the backend genuinely
  functions, not just that it was selected), and the boot-time egress warning. This was run
  green on a developer machine (Docker Desktop, 2026-07-24). The image build then broke as the
  workspace grew (OPE-2187). The fixed build stage installs, patches eve and completes
  `build:packages` + `oe build` under a 4 GB limit, but `eve build` needs a builder with about
  6 GB of memory, and the smoke has not re-run on the fixed image. What it does **not** cover, and
  what therefore keeps the Docker column at 📋 rather than ✅: a full **live turn** — a real
  model call, a chat round-trip, memory materialization, or spend stamping. Those seams (the
  egress policy compiler in a live session, memory silos, the spend ledger) remain unproven
  off-platform. So: the *self-host boot* is OE-verified; *running OE end to end* off Vercel
  is not.

If you self-host and verify a column, that's exactly the community verification the 📋
status is asking for — please report what you find.

## microsandbox is not a selectable Open Everywhere backend

microsandbox is a real Eve capability — Eve ships the backend
(`eve/sandbox/microsandbox`, depending on the `microsandbox` npm package) — but it does not
give full egress-firewall parity even where it is wired. A proving run (OPE-917) measured
it directly: host-grain allow/deny-by-default is enforced natively, given `/dev/kvm`, but
at-boundary credential injection silently does not happen (Eve never enables TLS
interception on this backend, so a `requireTlsIdentity` secret never substitutes) and
`match` (method/path) narrowing is dropped. That gap is an upstream eve defect, filed as
OPE-954.

On top of that gap, **Open Everywhere does not currently wire microsandbox at all.** The
off-Vercel backend selector (`agent/sandbox/backend-select.ts`) accepts only two values —
`docker` (the default) and `justbash` (a dev opt-in) — and rejects anything else, including
`microsandbox`, *fail-loud at boot* (`unknown OE_SANDBOX_BACKEND=… — Refusing to boot`).
This is the deliberate OPE-106 posture: the contained `docker()` backend plus the
egress-proxy sidecar already gets full egress parity without KVM, so microsandbox wasn't
wired.

The practical consequence for this column: even on a host that *has* `/dev/kvm`, you cannot
select microsandbox through configuration today, and wiring it would not by itself close
the credential-injection or `match` gap above — that needs the upstream eve fix first.
Treat the microsandbox tier as **measured at host-grain only, unavailable at the OE level,
and blocked upstream for the rest** — not a path to full parity today.

## Choosing

- **Want it to just work, with the full security story:** Vercel. It's the reference for a
  reason, and stop-after-turn keeps idle cost near zero.
- **Want self-host without giving up the firewall:** the [egress-proxy sidecar](./self-host-egress.md)
  on plain `docker()` is the path with full parity today, no KVM needed. The KVM tier
  (bare metal or a VDS + microsandbox) gives native host-grain enforcement only —
  credential injection and `match` narrowing are measured gaps (OPE-917), and OE doesn't
  wire the backend yet either.
- **Want the cheapest box and accept coarse egress:** Docker on any VPS. Understand
  [what you're giving up](#the-differentiator-row-the-egress-firewall) first — set
  `egress.allowUnenforced: true` only as a knowing choice.
- **Want cheap-box economics without giving up the firewall, and are willing to be the
  first to verify it:** the [hybrid Vercel Sandbox pattern](#the-hybrid-option-vercel-sandbox-from-any-host)
  on a Docker box or container PaaS instance — UNVERIFIED, but the cheapest path to full
  parity if it holds up.
- **Container PaaS:** fine as a host for the Discord relay today; as a host for the agent
  itself it is the weakest column — unproven for Eve and no enforceable firewall (absent
  the unverified hybrid pattern).
- One consistent self-host win: the **Discord ambient relay co-hosts for free**. On Vercel
  it needs its own always-on host because serverless can't hold a WebSocket; on any
  self-host box it's just a second systemd unit posting to localhost.

## Next

- [Hosting overview](../hosting-overview.md) — platforms as adapter-sets, and the seam map.
- [Vercel](./vercel.md) — the reference path. · [Self-roll](./self-roll.md) — the minimal
  contract per seam.
- **Adding a stack (how the seams behind this matrix are extended):**
  [the adapter model](../../extending/adapter-model.md) for the pattern, then the specific
  seam page for each row above — [sandbox](../../extending/sandbox.md) (the executor +
  firewall boundary), [database](../../extending/database.md) (operational store /
  memory), [scheduler & identity](../../extending/scheduler-and-identity.md) (cron
  sources), [models & the AI Gateway](../../extending/models-and-gateway.md)
  (`ModelBackend`), and [credential brokers](../../extending/credential-brokers.md). A new
  platform is a named implementation of each, not new architecture.
- [Security model](../../security/security-model.md) — what the firewall guarantees and where.
- [Configuration reference](../configuration-reference.md) — `egress.enforce`,
  `egress.allowUnenforced`, and every other knob.
