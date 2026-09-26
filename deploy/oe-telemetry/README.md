# oe-telemetry

The default anonymous-telemetry collector for [Open Everywhere](https://github.com/open-everywhere/open-everywhere)
(project name pending — see the main repo). One route: `POST /v1/logs`. It accepts
the OTLP/JSON logs envelope Open Everywhere's emitter sends, validates it against a
closed vocabulary, and stores it in Postgres. That's the whole project.

This is deliberately **open source, separately from the main app**: "we don't store
IP addresses" should be a fact you can check by reading `migrations/001_init.sql`
and `src/ip-limit.ts`, not a promise on a docs page. Go's telemetry design and
Homebrew's analytics receiver are both public for the same reason.

## Never stored, anywhere, ever

- **IP addresses.** A client IP is read once, transiently, in-memory, only to run a
  best-effort per-IP abuse check (`src/ip-limit.ts`) — it never reaches Postgres,
  never appears in a log line, never gets attached to a stored row. No table in
  `migrations/001_init.sql` has a column that could hold one; `test/no-ip-storage.test.ts`
  fails the build if that ever stops being true.
- Anything outside the closed event/attribute vocabulary defined in `src/schema.ts`
  (mirrored from the emitter's `EVENT_SCHEMA`) — org names, workspace/channel/user
  ids, message or memory content, error messages/stacks, env values. If the payload
  carries it, this collector **filters it out before storing**: an out-of-contract
  event is dropped, an out-of-contract attribute/resource key is stripped. Nothing
  outside the contract is ever stored (fail-closed on data) — but one unknown record
  no longer rejects the whole batch, so a not-yet-mirrored event can't silently take
  co-batched good records down with it.

The full vocabulary — every event, every attribute, why each one can't leak — is
documented at the source of truth: `docs/deploy/telemetry.md` in the main
Open Everywhere repo.

## What's stored

- **`events`** — one row per accepted log record: `received_at`, `instance_id`
  (a random UUID, never derived from anything identifying), `event_name`,
  `attributes` (jsonb, the flattened OTLP key/values), `resource` (jsonb, the
  resource attributes stamped on the batch). Pruned at 90 days
  (`scripts/prune.sql`).
- **`event_rollup_daily`** — per day × event × app version × surface × model,
  event count + distinct-instance count. Kept forever; this is what any future
  dashboard reads, never the raw table.
- **`rate_counter`** / **`heartbeat_dedupe`** — small bookkeeping tables for the
  per-instance rate limit and the heartbeat dedupe window, pruned after a few days.
- **`meta`** — a one-row schema-version marker, nothing else.

See `migrations/001_init.sql` for the exact DDL.

## How ingest works

1. **Transient per-IP check** (`src/ip-limit.ts`) — in-memory, best-effort, never
   persisted.
2. **32KB body cap**, **≤100 log records per batch** (`src/validate.ts`).
3. **Strict zod parse** of the OTLP/JSON shape (a malformed envelope, an oversized
   body, or a batch over the record cap rejects the **whole batch**, 400), then a
   closed-vocabulary **filter**: an unknown event name drops that one record, an
   attribute key outside the event's allow-list is stripped, an unknown resource
   attribute key is stripped — the rest of the batch still stores. Nothing outside
   the contract is ever stored, and one out-of-contract record never poisons its
   co-batched siblings.
4. **Per-instance-id rate limit** — a Postgres-backed hourly token bucket
   (`src/ratelimit.ts`), generous (abuse-blunting, not a product limiter).
5. **Heartbeat dedupe** — `oe.instance.heartbeat` is deduped to at most one stored
   row per (instance, 6h window) (`src/heartbeat.ts`), a backstop for serverless
   cold-boot storms on top of the emitter's own client-side throttle.
6. **Insert** the surviving records (`src/store.ts`).

The response body is always `{}` (OTLP's full-success shape) — the emitter is
fire-and-forget and only checks the HTTP status, so response shape is cosmetic; a
stricter OTLP client is still satisfied.

## Running locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (a free Neon branch is enough)
npm run migrate         # applies migrations/*.sql
npx vercel dev          # serves api/v1/logs.ts locally
```

Then, from another shell:

```bash
curl -X POST http://localhost:3000/v1/logs \
  -H 'content-type: application/json' \
  -d '{
    "resourceLogs": [{
      "resource": { "attributes": [
        { "key": "service.name", "value": { "stringValue": "open-everywhere" } },
        { "key": "service.instance.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000000" } }
      ]},
      "scopeLogs": [{
        "scope": { "name": "open-everywhere-telemetry" },
        "logRecords": [{
          "timeUnixNano": "1783430400000000000",
          "eventName": "oe.instance.first_boot",
          "attributes": []
        }]
      }]
    }]
  }'
```

## Tests

```bash
npm test
```

Plain Node scripts (`node:assert/strict`, run via `tsx`, one file per concern) —
no test framework dependency. Covers: valid-envelope acceptance, unknown
event/attribute rejection, oversized-body rejection, batch-size boundary,
heartbeat-dedupe window derivation, rate-limit increment, IP-limit behaviour, and
a source-scan pass asserting no code path ever writes an IP to storage.

## Deploying

See `SETUP.md` for the exact commands (this repo doesn't create its own Vercel
project or Neon database — that's an explicit, separate step).

## Rollups and retention

`scripts/rollup.sql` recomputes `event_rollup_daily` by fully re-aggregating every
day of raw history that isn't still accumulating (today) — an idempotent upsert,
not an incremental delta, so it's safe to run at any cadence, including after a
missed run. `scripts/prune.sql` then hard-deletes raw rows older than 90 days.
Both run as weekly Vercel cron jobs (`vercel.json`), rollup before prune.
