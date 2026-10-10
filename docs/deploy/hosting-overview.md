# Hosting overview — platforms are adapter-sets

A hosting platform isn't one choice — it's a *curated set* of default adapters that
fit together: a sandbox to run the agent, a database for operational state, a credential
broker for secrets, and a scheduler to fire routines. Choosing a platform means choosing
that set. You can still swap any individual seam.

## The idea

Open Everywhere is built from [swappable seams](../extending/adapter-model.md) — each one
an adapter behind a shared interface. Four of those seams are *infrastructure* seams: they
depend on where the agent runs.

- **Sandbox** — the isolated executor the agent's tools (and the egress firewall) run in.
- **Operational store** — the database holding secrets, instant state, spend counters,
  routines, and audit. A present `DATABASE_URL` selects hosted Postgres on its own;
  `OE_OPERATIONAL_PROVIDER` overrides that. With neither set it defaults to an
  **embedded Postgres (PGlite)** floor — the *same dialect* as production, zero wiring, single-process/local-disk durable (boot
  emits an informational notice); step up to a Postgres server (the docker-compose sidecar) or
  hosted Postgres and graduate real production data with the supported migration
  ([Graduating the operational store](./database-graduation.md)). Legacy `sqlite` is deprecated.
- **Credential brokers** — where named secrets are vaulted; each credential names its home broker
  (`env`/`db`/…), registered when configured. (OAuth tokens are minted on a separate seam, the
  connector plane's own-rolled user-auth-flow.)
- **Scheduler** — the cron source that ticks the [routine dispatcher](../capabilities/proactivity-and-routines.md).

A **hosting platform** is just a coherent default for all four — adapters that are built to
run together on that provider's primitives. Vercel's set is the reference path, and it is
fully built. Every other platform is a known *shape*: the same four seams, filled by that
provider's equivalents.

The other seams — [model](../extending/models-and-gateway.md),
[surfaces](../extending/surfaces.md), [memory backing](../extending/memory-backings.md),
and [source control](../capabilities/source-control.md) — are platform-independent. The
AI Gateway, your Slack/Teams/Discord surfaces, and the GitHub App work the same wherever
the agent is hosted, so they aren't part of the platform adapter-set.

## On Vercel vs off Vercel

- **On Vercel** is the reference happy path: a one-click deploy wires the whole set —
  Vercel Sandbox, Neon Postgres, the core credential brokers (`env`/`db`), and a scheduled cron —
  with OIDC handling model auth. This is the only set that is built and exercised end to end.
- **Off Vercel** means assembling your own set: pick the adapter for each of the four
  infrastructure seams, satisfy each seam's contract, and select it with the matching
  `OE_*` env var. The non-Vercel platform guides below sketch each set; none ship as a
  turnkey adapter yet. Not all "off Vercel" is equally proven, though: a generic
  Docker/VM self-host is **documented and community-verifiable** — Eve's own framework
  docs cover it first-party — while Cloudflare/AWS/Azure/GCP remain genuinely
  **Roadmap**: no adapter built, no first-party proof either. See the
  [hosting comparison](./platforms/comparison.md) for the honest, evidence-based
  three-tier breakdown; the table below is a coarser seam-by-seam map across more
  platform names, not a claim that they're all equally far along.

> Selection is **fail-closed**: each `OE_*` knob must name a *registered* adapter or the
> agent refuses to start. There is no silent fallback to a weaker default — a missing
> Postgres client or an unknown broker is an error, not a downgrade. See the
> [adapter model](../extending/adapter-model.md).

## Seam → platform adapter map

| Seam | Vercel (built) | Cloudflare | AWS | Azure | GCP | Self-roll (Docker/VM) |
|---|---|---|---|---|---|---|
| Sandbox | Vercel Sandbox | Workers | Lambda / Fargate | Container Apps | Cloud Run | `justbash` behind the [egress-proxy sidecar](./platforms/self-host-egress.md) (enforced egress, development-grade filesystem isolation). `docker()` contains the filesystem but cannot run behind the proxy or in the shipped image (OPE-2407). Eve ships a KVM-dependent `microsandbox` backend, but Open Everywhere does not wire it: the setting `sandbox.selfHostBackend` accepts only `"docker"`/`"justbash"` and refuses anything else at boot |
| Operational store | Neon Postgres | D1 | RDS / Aurora | Azure Postgres | Cloud SQL | any Postgres |
| Credential broker | `env` / `db` (core) | Workers secrets | Secrets Manager | Key Vault | Secret Manager | `env` / `db` / Vault |
| Scheduler | scheduled cron | Workers Cron | EventBridge | Azure Scheduler | Cloud Scheduler | none to wire — `eve start` fires it in-process |
| Status | **Built** | **Roadmap** | **Roadmap** | **Roadmap** | **Roadmap** | **Documented, community-verifiable** |

The connector-plane transport is also a swappable seam — see the [adapter
model](../extending/adapter-model.md#the-connector-transport-seam-is-swappable-too) — but nothing
ships wired to an external integration gateway today; the direct transport (host-side, in-process)
is the only one registered.

Platform-independent seams (the same on every row): the
[model gateway](../extending/models-and-gateway.md),
[surfaces](../extending/surfaces.md), the [GitHub App source-control backend](../capabilities/source-control.md),
and the [memory backings](../extending/memory-backings.md) (git / sqlite / postgres / github / notion).

## Platform guides

- [Hosting comparison](./platforms/comparison.md) — the four realistic shapes (Vercel,
  KVM self-host, Docker self-host, container PaaS) side by side, capability by capability.
- [Vercel](./platforms/vercel.md) — the reference path, built.
- [Cloudflare](./platforms/cloudflare.md) — **Roadmap**.
- [AWS](./platforms/aws.md) — **Roadmap**.
- [Azure](./platforms/azure.md) — **Roadmap**.
- [GCP](./platforms/gcp.md) — **Roadmap**.
- [Self-roll / generic VM](./platforms/self-roll.md) — **Documented, community-verifiable**;
  the minimal contract each seam must satisfy, and what's genuinely proven vs merely documented.

Once you've picked a platform, the [setup runbook](./setup-runbook.md) walks the full
configuration, and the [configuration reference](./configuration-reference.md) lists every
field and env var.
