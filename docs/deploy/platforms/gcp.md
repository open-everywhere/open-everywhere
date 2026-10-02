# GCP — **Roadmap**

> **Roadmap.** This is the *shape* of a GCP adapter-set, not a built path. None of these
> adapters ship yet. The [Vercel set](./vercel.md) is the only built reference.

A hosting platform is a [curated set of adapters](../hosting-overview.md). Here's how Google
Cloud primitives map onto the four infrastructure seams, plus the
memory backing you would naturally co-locate with them.

## The adapter-set (proposed)

| Seam | GCP adapter | Status |
|---|---|---|
| Sandbox | Cloud Run | **Roadmap** |
| Operational store | Cloud SQL (Postgres) | **Roadmap** |
| Memory backing | Cloud SQL (Postgres) | **Roadmap** |
| Credential broker | Secret Manager | **Roadmap** |
| Scheduler | Cloud Scheduler → the routine dispatcher | **Roadmap** |

Platform-independent seams are unchanged: the [memory backing](../../extending/memory-backings.md)
(selected by `OE_MEMORY_PROVIDER`; no platform adapter is involved off Vercel), the [model gateway](../../extending/models-and-gateway.md),
[surfaces](../../extending/surfaces.md), and the [GitHub App](../../capabilities/source-control.md).

## What you'd supply

- A sandbox adapter satisfying the [executor contract](../../extending/sandbox.md), with
  the egress firewall enforceable at its boundary.
- A registered Postgres client for the operational + memory stores
  (selected by `DATABASE_URL`; the two provider selectors override it) — see
  [Database](../../extending/database.md).
- A [credential broker](../../extending/credential-brokers.md) over Secret Manager
  implementing `getSecret(ref)`, where `ref` is the secret resource name.
- A Cloud Scheduler job that pings the routine dispatcher — see
  [Scheduler & identity](../../extending/scheduler-and-identity.md).

Selection is [fail-closed](../../extending/adapter-model.md): each `OE_*` knob must name a
registered adapter or the agent refuses to start.
