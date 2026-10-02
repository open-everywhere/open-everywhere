# Cloudflare — **Roadmap**

> **Roadmap.** This is the *shape* of a Cloudflare adapter-set, not a built path. None of
> these adapters ship yet. The [Vercel set](./vercel.md) is the only built reference.

A hosting platform is a [curated set of adapters](../hosting-overview.md). Here's how
Cloudflare's primitives map onto the four infrastructure seams, plus the
memory backing you would naturally co-locate with them.

## The adapter-set (proposed)

| Seam | Cloudflare adapter | Status |
|---|---|---|
| Sandbox | Workers (isolate executor) | **Roadmap** |
| Operational store | D1 (with R2 for blobs) | **Roadmap** |
| Memory backing | D1 / R2, or any reachable Postgres | **Roadmap** |
| Credential broker | Workers secrets / a Cloudflare credential route | **Roadmap** |
| Scheduler | Workers Cron Triggers → the routine dispatcher | **Roadmap** |

Platform-independent seams are unchanged: the [memory backing](../../extending/memory-backings.md)
(selected by `OE_MEMORY_PROVIDER`; no platform adapter is involved off Vercel), the [model gateway](../../extending/models-and-gateway.md),
[surfaces](../../extending/surfaces.md), and the [GitHub App](../../capabilities/source-control.md)
work the same here.

## What you'd supply

- A sandbox adapter satisfying the [executor contract](../../extending/sandbox.md) — the
  egress firewall must be enforceable at this boundary. Vercel Sandbox enforces the full
  policy natively; Eve's `microsandbox` backend enforces only the host-grain part natively
  (per-host allow/deny) — credential injection and `match` narrowing are measured gaps
  (OPE-917). Open Everywhere's own `docker()` deployment gets full parity instead with a
  [forced local egress proxy](./self-host-egress.md), which is the pattern to port here.
- A registered operational-store client and memory provider. A present `DATABASE_URL` selects
  `postgres` for both; `OE_OPERATIONAL_PROVIDER` and `OE_MEMORY_PROVIDER` override it — see
  [Database](../../extending/database.md).
- A [credential broker](../../extending/credential-brokers.md) implementing `getSecret(ref)`.
- A cron source that pings the routine dispatcher on a cadence — see
  [Scheduler & identity](../../extending/scheduler-and-identity.md).

Selection is [fail-closed](../../extending/adapter-model.md): each `OE_*` knob must name a
registered adapter or the agent refuses to start.
