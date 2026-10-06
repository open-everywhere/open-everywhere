# Observability

How you find out what the agent actually did — and why something broke — after the
fact. Open Everywhere ships **vendor-neutral seams** (structured HTTP log shipping +
standard OTel trace export), not a vendor integration: point them at whichever backend
you run. Everything on this page is **optional and fail-open** — with nothing
configured, behaviour is unchanged and nothing is exported.

This page is about **your own** observability into your deployment. It's a separate
concern from **[anonymous usage telemetry](./telemetry.md)** — a small, closed-
vocabulary, default-ON signal that tells the project maintainers your instance
exists and roughly how it's used (never what it did or said). See
[Telemetry](./telemetry.md) for the full disclosure, the opt-out, and the redirect.

## What you get with nothing configured

- **Console logs.** Every component logs `[open-everywhere:<component>] …` lines to
  stdout/stderr. These land in your platform's runtime logs — which on Vercel's Hobby
  plan are retained for **about one hour** (Pro: 1 day), with no Drains available to
  forward them. If you need to answer "why did that turn fail *yesterday*", platform
  logs alone won't do it on a free tier — configure log shipping below.
- **The audit log** — the durable "who asked for what, when" record (memory writes,
  grants, consequential actions) in the operational store. Queryable any time via the
  [control plane](../security/control-plane.md) and the in-Slack admin tools. See
  [Audit & provenance](../security/audit-and-provenance.md).
- **Usage rows** — per-model-call token/cost events behind `usage_report`/`session_cost`.
  🔴 **The default store never deletes them.** On the embedded-Postgres (PGlite) floor and on hosted
  Postgres, the app writes `usage_events` append-only and its prune issues no SQL. No code path
  deletes a monthly spend ledger row, on any store. Retention is your own control: a maintenance job
  on the database (on hosted Postgres, outside the app role). Only the deprecated SQLite floor
  prunes usage rows (90 days). See
  [Per-event usage capture](../security/spend-and-cost.md#per-event-usage-capture).
- **Tracing: a graceful no-op.** The OTel instrumentation module registers no provider
  unless a collector is configured, so spans flow to OpenTelemetry's no-op tracer at
  zero cost. (On Vercel itself, spans additionally feed Vercel's own Session Tracing
  on every plan — your own toolbar-initiated sessions only.)

The audit log and usage rows **are part of the observability story**: they answer
"what did the agent do and what did it cost" durably, with no external backend. What
they can't answer is "why did this request fail" — that's what the two seams below add.

## Where a reply's seconds went — the latency anchors

A slow reply has two very different causes, and one number cannot tell them apart. Open
Everywhere records **four anchors** per inbound wake, so it can:

```
vendor event time ─(1)─ ingress receipt ─(2)─ turn start ─(3)─ reply.post
```

- **(1) vendor → ingress** — the vendor's own delivery hop plus this deployment's ingress work.
- **(2) ingress → turn start** — the queue: enqueue, pickup, and the turn function's cold start.
- **(3) turn start → `reply.post`** — the turn itself: model calls, tools, the post.

(1) and (2) together are the **pre-turn** segment. It is **environmental**: none of this
deployment's turn code runs inside it, so a reply-time band never judges it. (3) is the
**in-turn** segment, and it is the only one a band applies to.

Two audit rows carry the anchors. Both are **ids and timestamps only** — never message text,
an author, or a channel name:

| Row | Written by | Carries |
| --- | --- | --- |
| `wake.ingress` | `channels/unified.ts` `divertToUnifiedWindow`, once per **admitted attended** wake on every surface that diverts into the shared window | `wakeId`, `deliveryId`, `surfaceKey`, `vendorTs`, `vendorTsSource`, `ingressTs`, `vendorToIngressMs` |
| `wake.turn_start` | `hooks/wake-turn-start.ts` at eve's `turn.started`, once per **wake-driven** turn | `wakeId`, `sessionId`, `turnId`, `turnStartTs` |

`reply.post` is the fourth anchor and already existed. **Join all three on `wakeId`** — never on
time order, because one eve turn can answer several coalesced wakes.

**`vendorTsSource` says how much weight the first anchor carries**, and the values are not
interchangeable. `slack-ts` is a Slack message's own send time and `discord-snowflake` is the
creation time inside a message id — both are the vendor's clock, to the millisecond. `vendor-time`
is a vendor-stamped ISO instant on the delivery (a GitHub or Linear comment's `createdAt`).
`receipt` is **this deployment's own front door**, used where the payload carries no vendor clock
at all (Notion, Teams) — so segment (1) is then a **lower bound**, not a measurement. On those two
surfaces the receipt is taken at the divert decision rather than at the route's first byte, so the
segment reads near zero and says nothing about the vendor's own hop. Read a `receipt` row for its
ingress and turn-start anchors, and take segment (1) from a `slack-ts`, `discord-snowflake` or
`vendor-time` row.

A wake with no `wake.turn_start` row is reported as **unsplit**: the two segments cannot be
separated without that anchor, so no band verdict is claimed at all. An internal dispatch — a task
spawn, a redrive, a routine fire — writes no `wake.ingress` row, because it has no vendor behind it.

The J1 end-to-end leg reports this split per leg and names the segment carrying the excess. The
arithmetic is `agent/channels/wake-timing.ts`; the audit-read join is
`packages/core/scripts/e2e/wake-split.ts`.

### When the wake is refused — `surface.wake_retry`

The dispatch in (2) can be **rate limited**. The queue answers 429, and without a backoff the wake
is lost: the member's message gets no reply and no turn ever starts. Open Everywhere retries that
refusal with the same bounded backoff every provider write seam uses
(`agent/channels/rate-limit-retry.ts`). It is bounded by attempts **and** by a total wait, so a
rate-limited wake is late, never infinite.

The same policy covers both dispatch topologies. Windowed wakes use
`channels/unified.ts` `divertToUnifiedWindow`; native per-container wakes use
`channels/native-wake-retry.ts` `dispatchNativeWakeWithRetry`. Teams has no native road and always
uses the windowed one.

| Row | Written by | Carries |
| --- | --- | --- |
| `surface.wake_retry` | `channels/unified.ts` for a windowed dispatch, or `channels/native-wake-retry.ts` for a native dispatch; once per refused attempt | `deliveryId`, optional `wakeId`, `surfaceKey`, `attempt`, `delayMs`, `waitedMs`, `outcome`, `refusalStatus` |

Read it beside `surface.wake_failed`. A row with `wakeId` is windowed and joins on `wakeId`; a row
without one is native and its `deliveryId` groups only that queue dispatch's refusal attempts:

- **retry rows, then a `wake.turn_start`** — the wake was refused and then delivered. Nothing was
  lost; the reply is late by `waitedMs`.
- **retry rows ending in `outcome: "exhausted"`, then `surface.wake_failed`** — the refusals
  outlasted the budget. The `wake_failed` row's message names the attempts made and the time waited.
- **native retry rows sharing one `deliveryId`, with no `wakeId`** — the native queue dispatch was
  refused. The id does not imply an ingress/turn join; no such join exists on this topology.
- **`surface.wake_failed` carrying a rate-limit message, with no retry rows** — the dispatch did not
  traverse either shared retry funnel. Treat it as a code/version mismatch or an unwrapped launch,
  not as evidence that the backoff worked.
- **`surface.wake_failed` with no retry rows and no rate-limit message** — the dispatch failed for
  some other reason. A transport failure and a permission refusal are deliberately **not** retried: a
  request the vendor never answered may already have been applied, and repeating it could wake one
  seat twice.
- **retry rows with `wakeId` but no `wake.ingress` row** — an **internal windowed** dispatch: a task
  spawn, the auto-redrive or an approval-decision wake. Those write no ingress anchor by design,
  because the anchor is a latency measure of attended arrivals.

The row is ids, counts and durations only, like the two anchors above — never the woken message.
`delayMs` is `0` on the `exhausted` row, because nothing is waited after it.

**What the wait actually costs today: about 6 seconds** — three waits of the 2 s fallback. eve names
no `Retry-After` on the refusal, so every wait uses that fallback and the 20 s total budget never
binds. Size an ingress budget against the 6 s, not the 20 s.

## Signal 1 — durable structured logs (`OE_LOG_SHIP_URL`)

Set `OE_LOG_SHIP_URL` and every console line **also** ships as a structured JSON
record — batched, fire-and-forget, POSTed as a JSON array to your endpoint. The
console output itself is untouched (platform logs keep working), shipping never blocks
a turn, transport failures are swallowed (bounded queue, drop-oldest), and the batch is
flushed at turn/session end so records leave the instance before serverless suspend.

Each record carries: `ts`, `level` (`info`/`warn`/`error`), `service`, `env`,
`component` (parsed from the `[open-everywhere:x]` prefix), `message`, `surfaceKey`
(best-effort, when the calling surface is resolvable), and — for errors — `error.name`
/ `error.message` / `error.stack`. Failed turns and sessions ship a dedicated
`level=error` record with Eve's failure code and message; uncaught exceptions are
recorded via an observe-only process monitor (crash semantics unchanged).

Works out of the box with any backend that accepts a JSON array over HTTP with a
static auth header — Axiom, Better Stack, or your own collector:

```bash
# Axiom
OE_LOG_SHIP_URL=https://api.axiom.co/v1/datasets/<dataset>/ingest
OE_LOG_SHIP_TOKEN="Bearer xaat-…"

# Better Stack (telemetry source)
OE_LOG_SHIP_URL=https://<your-ingesting-host>/
OE_LOG_SHIP_TOKEN="Bearer <source-token>"
```

Knobs (all optional): `OE_LOG_SHIP_TOKEN_HEADER` (default `authorization`),
`OE_LOG_SERVICE`, `OE_LOG_SHIP_BATCH_MAX`, `OE_LOG_SHIP_FLUSH_MS` — see the
[configuration reference](./configuration-reference.md#observability).

For **new code and error paths**, prefer the structured API over raw console — it
adds typed fields and preserves stacks:

```ts
import { oeLogger } from "../observability/ship.js"; // @open-everywhere/core/agent/observability/ship.js

const log = oeLogger("my-component");
log.info("policy applied", { surfaceKey, hostCount: hosts.length });
log.error("delivery failed", err, { surfaceKey, messageId });
```

### Inside the shipper

`logShipEnabled` answers whether the ship URL armed the path at all. Nothing below runs when it did
not.

**A record is labelled with the session's own surface, best-effort.** `surfaceKeyForLog` reads the
current session's bound surface at domain grain — the same grain the routing stamp uses — and
answers nothing outside a session, or when the context carried no platform identity. It never
throws, so a record is shipped unlabelled rather than lost.

**A caught value is shaped, never dropped.** `shapeError` turns an `Error` into its name, message
and stack. Anything else keeps its stringified form under the name `NonError`, so a thrown string or
object still reaches the sink as a readable record.

`parseConsoleArgs` pulls the `[open-everywhere:<component>]` prefix off a console line — falling back
to the component `console` — keeps the **first** `Error` argument as the structured error, and
stringifies the rest.

🔴 **A structured log never double-ships.** `oeLogger` prints its line through the **raw** console,
which the console capture cannot see, and separately enqueues the typed record. Writing through the
captured console instead would ship the same event twice, once as prose and once as structure.
`installLogShipping` arms the console capture and the process capture in one call.

**The ship queue is bounded at 500 records, dropping the oldest**, and every drop is counted.
`flushLogShip` posts the batch with the optional token header, swallows every transport failure, and
warns once — a log sink that is down must never take the deployment with it. `droppedRecordCount`
reports the drops from queue overflow and from failed flushes, so a gap in the sink is a number
rather than a guess.

## Signal 2 — traces (standard OTel env vars)

eve owns the OpenTelemetry pipeline. It registers one tracer provider for the process, from the
files in `agent/instrumentation/`, and it creates the spans for every model call (run → turn →
step/tool-call). Nothing in the app calls `registerOTel`: a second registration stops the boot.
Two destinations can receive the spans:

- **Vercel Agent Runs.** On Vercel preview and production, eve exports to Agent Runs by default.
  See eve's Agent Runs guide to configure it with `agent/instrumentation/agent-runs.ts`, or to
  turn it off.
- **Your OTLP collector.** `agent/instrumentation/otlp.ts` adds one when the **standard** OTel
  env vars name an endpoint. Any OTLP/HTTP collector works (`http/protobuf` by default,
  `http/json` with `OTEL_EXPORTER_OTLP_PROTOCOL`):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.axiom.co        # or your collector
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20xaat-…,X-Axiom-Dataset=<dataset>"
```

Each header value is percent-decoded, so write a space as `%20`. With no endpoint set, the OTLP
destination is disabled. The [configuration reference](configuration-reference.md#observability)
lists every variable.

**Spans carry no model inputs or outputs.** `agent/instrumentation/otel.ts` declares eve's
process-wide `otel()` trace policy, and the policy records neither content direction, for every
audience in every environment. This policy is a ceiling for every OpenTelemetry destination, so
no destination can add the content back. Without it, eve's default records content for a public
conversation and in development. `npm run test:instrumentation-hosted-boot` boots the app's
instrumentation through eve's registration path with Vercel's env and checks this policy.

## Signal 3 — errors & alerting

Errors are **level=error records in the same log stream** (with stacks and context),
so error tracking and alerting live in your log backend rather than behind another
vendor SDK: create a monitor/alert on `level == "error"` (and one on
`component == "eve"` for turn/session failures specifically). If you want a dedicated
error tracker (issue grouping, release tracking), Sentry's free tier works alongside
this — but it's deliberately not wired into core; the vendor-neutral stream is the
supported path.

## Recommended free-tier setup

One backend for both signals: **[Axiom](https://axiom.co)** (free Personal plan —
500 GB/month, 30-day retention, native OTLP + JSON ingest, monitors with email/Discord
notification).

1. Create an Axiom account, one dataset (e.g. `open-everywhere`), and an API token
   with ingest permission on it.
2. Set the four env vars from the snippets above (both `OE_LOG_SHIP_*` and
   `OTEL_EXPORTER_OTLP_*`) on your deployment.
3. Add a monitor: `['open-everywhere'] | where level == "error"` → notify.

Prefer Grafana Cloud (best free alerting: Slack/webhook notifiers, 500 rules) or
Honeycomb (deepest trace analysis) for traces? The seams don't care — swap the
endpoint and headers.

## The Discord relay

The always-on Gateway relay (`deploy/discord-relay/`) honours the same
`OE_LOG_SHIP_URL` / `OE_LOG_SHIP_TOKEN` / `OE_LOG_SHIP_TOKEN_HEADER` env vars, shipping
its `[oe-discord-relay]` lines to the same backend with `service: "oe-discord-relay"`
— so a relay disconnect and the deploy-side ingest failure it causes are visible in
one place. For liveness (the relay dying entirely can't log itself), point any
uptime/heartbeat checker at it — Better Stack's free uptime monitors work well.
