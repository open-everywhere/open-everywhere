# AWS — **Roadmap**

> **Roadmap.** This is the *shape* of an AWS adapter-set, not a built path. None of these
> adapters ship yet. The [Vercel set](./vercel.md) is the only built reference.

A hosting platform is a [curated set of adapters](../hosting-overview.md). Here's how AWS
primitives map onto the four infrastructure seams, plus the
memory backing you would naturally co-locate with them.

## The adapter-set (proposed)

| Seam | AWS adapter | Status |
|---|---|---|
| Sandbox | Lambda (short tasks) / Fargate (long-running) | **Roadmap** |
| Operational store | RDS / Aurora (Postgres) | **Roadmap** |
| Memory backing | RDS / Aurora Postgres | **Roadmap** |
| Credential broker | Secrets Manager | **Roadmap** |
| Scheduler | EventBridge Scheduler → the routine dispatcher | **Roadmap** |

Platform-independent seams are unchanged: the [memory backing](../../extending/memory-backings.md)
(selected by the `memory.provider` setting; no platform adapter is involved off Vercel), the [model gateway](../../extending/models-and-gateway.md),
[surfaces](../../extending/surfaces.md), and the [GitHub App](../../capabilities/source-control.md).

## What you'd supply

- A sandbox adapter satisfying the [executor contract](../../extending/sandbox.md), with
  the egress firewall enforceable at its boundary.
- A registered Postgres client for the operational + memory stores
  (selected by `DATABASE_URL`; the two provider selectors override it) — see
  [Database](../../extending/database.md). Aurora/RDS satisfies the `PgClient` shape.
- A [credential broker](../../extending/credential-brokers.md) over Secrets Manager
  implementing `getSecret(ref)`, where `ref` is the secret name/ARN.
- An EventBridge schedule that pings the routine dispatcher — see
  [Scheduler & identity](../../extending/scheduler-and-identity.md).

Selection is [fail-closed](../../extending/adapter-model.md): each `OE_*` knob must name a
registered adapter or the agent refuses to start.
