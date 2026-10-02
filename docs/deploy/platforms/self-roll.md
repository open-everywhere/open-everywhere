# Self-roll / generic VM — **Documented, community-verifiable**

> **📋 Documented, community-verifiable — not ✅ Supported.** This is not "Roadmap": Eve's
> own framework docs (v0.20, `docs/guides/deployment.md` §8 "Deploy without Vercel", also
> at eve.dev/docs/guides/deployment) document `eve build && PORT=3000 eve start --host
> 0.0.0.0` as a plain Node service you run "behind your own process manager, container
> platform, or reverse proxy" — first-party evidence the seams work, reinforced by
> Vercel's own labs running this exact shape end to end
> ([vercel-labs/steve](https://github.com/vercel-labs/steve), Eve 0.15). What's genuinely
> unproven is **Open Everywhere's own adapters** on this path — no OE smoke test has run
> off Vercel yet. See the full tier breakdown and evidence in the
> [hosting comparison](./comparison.md). The [Vercel set](./vercel.md) remains the only
> ✅ Supported reference.

A hosting platform is a [curated set of adapters](../hosting-overview.md). Self-rolling
means you supply an adapter for each of the four infrastructure seams and select it with the
matching `OE_*` env var. Selection is [fail-closed](../../extending/adapter-model.md) — each
knob must name a *registered* adapter or the agent refuses to start.

## The minimal contract per seam

| Seam | You must provide | Selected by |
|---|---|---|
| Sandbox | An executor where the egress firewall is enforceable (default-deny + boundary credential injection). Eve's own `docker()` is coarse-only via its native `setNetworkPolicy`; Open Everywhere's shipped `docker()` deployment restores full parity with a [forced local egress proxy](./self-host-egress.md) instead (no KVM needed). Eve's `microsandbox` (needs `/dev/kvm`) enforces host-grain allow/deny natively, but not credential injection or `match` narrowing (measured, OPE-917). | [Sandbox](../../extending/sandbox.md) |
| Operational store | A `PgClient`-shaped Postgres, registered at startup, with `org_id` partitioning + RLS — or, for single-node, leave the knob unset and take the zero-wiring embedded-Postgres (PGlite) floor. The `sqlite` floor still works but is **deprecated** and nags at boot: no managed durability, backups or replication. | `OE_OPERATIONAL_PROVIDER` |
| Memory backing | One of `git` / `sqlite` / `postgres` / `github` / `notion`, or your own `MemoryProvider`. | `OE_MEMORY_PROVIDER` |
| Credential broker | An implementation of `getSecret(ref)` over your vault, registered at startup and named on each credential's `broker` stamp (or the built-in `env` broker, always registered — env-backed credentials stamp `broker: "env"`). No global selection. | `broker:` stamps + `registerBroker(...)` |
| Scheduler | **Nothing to wire.** Running the compiled app via `eve start` (the node-server build) already fires the routine dispatcher's schedules as in-process croner jobs at boot — same build artifact as any other host. See [the cron note](./comparison.md#cron-runs-itself-off-vercel-too). | [Scheduler & identity](../../extending/scheduler-and-identity.md) |
| Durable sessions | **Nothing to wire for a single node.** The local workflow world persists to `.workflow-data` — put that directory on a persistent volume. `@workflow/world-postgres` is the seam to swap to for multi-node; take the `beta` dist-tag and match the `@workflow/world` version Eve pins (`5.0.0-beta.34` at Eve 0.54.3) — `latest` is on the 4.x line, and Eve refuses it at startup. See [durable sessions](./comparison.md#durable-sessions--the-workflow-world). | `experimental.workflow.world` in `agent/agent.ts` |

## Notes

- **Start from the shipped reference image, not from scratch.** The repo root carries a
  `Dockerfile` (builds the off-Vercel Eve node-server bundle, runs `eve start`) and a
  `docker-compose.yml` that wires the app to the [egress-proxy sidecar](./self-host-egress.md)
  on an internal-only network — the enforced-egress `docker()` topology described below. An
  opt-in integration smoke, `npm run test:docker-smoke`, builds that image and boots it off
  Vercel on the `docker()` backend to assert a clean boot, the backend resolving to `docker()`,
  and the egress posture surfacing — the first-party proof the Docker column
  [now carries](./comparison.md#what-has-actually-been-run-where).
- **The image build needs a builder with about 6 GB of memory.** `eve build` peaks at about
  5.4 GB. A smaller `--max-old-space-size` does not bring it under 4 GB: a 4 GB builder kills the
  build inside `eve build` with a 3 GB heap and with a 1.5 GB heap. On a small VM, build the image
  on a larger machine and push it to a registry. The build stage runs
  `npm ci --ignore-scripts` (the root `prepare` script needs the sources, which that layer does
  not have), then `npm rebuild` for the dependency install scripts that work on alpine, then
  `patch-package --error-on-fail` and a check that every eve patch marker is present, then
  `npm run build`.
- The simplest self-roll: the default embedded-Postgres (PGlite) operational floor — leave
  `OE_OPERATIONAL_PROVIDER` unset and set no `DATABASE_URL` — plus `git` or `sqlite` memory, the
  `env` credential broker, and `eve start` as an always-on process (cron and single-node durable
  sessions both come for free, per the table above). Setting `DATABASE_URL` selects hosted Postgres
  for the operational store AND the memory backing on its own (OPE-2230) — no selector needed.
  It used to fall to the deprecated `sqlite` floor instead, so a deployment that set a connection
  string and nothing else ran on a local file. That runs single-operator with no
  external services — but the egress firewall only *fully enforces natively* on Vercel
  Sandbox; Eve's `microsandbox` backend enforces only host-grain allow/deny natively
  (measured, OPE-917), and a plain (unwrapped) Docker or bare-metal executor gives coarse or
  no egress enforcement. Open Everywhere's own [egress-proxy sidecar](./self-host-egress.md)
  restores full parity on `docker()` without KVM (the recommended self-host default); the
  alternative is routing the sandbox through the
  [hybrid Vercel Sandbox pattern](./comparison.md#the-hybrid-option-vercel-sandbox-from-any-host)
  (UNVERIFIED live).
- **Reverse proxy rule:** forward both `/eve/` and `/.well-known/workflow/` to the app.
  Workflow callbacks land on `/.well-known/workflow/v1/flow`; proxying only `/eve/` lets
  sessions start and then stalls every run silently — no error, just a hang. This is named
  in Eve's own deployment guide.
- **Node 24.x** is required, same as the reference deploy — see [AGENTS.md](../../../AGENTS.md).
- The platform-independent seams — [model gateway](../../extending/models-and-gateway.md),
  [surfaces](../../extending/surfaces.md), the [GitHub App](../../capabilities/source-control.md)
  — work anywhere and aren't part of the host adapter-set.
- The [adapter model](../../extending/adapter-model.md) explains deploy-singleton seams
  (sandbox, broker, store) vs per-bundle policy (connectors, providers, repos).
