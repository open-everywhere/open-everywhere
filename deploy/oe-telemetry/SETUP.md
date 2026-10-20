# Orchestrator setup

This project does not create its own cloud resources. Whoever deploys it (the
orchestrator, not this repo's code) needs to run the following, in order.

## 1. Create the Neon database

Create a Neon project/branch (the free tier is more than sufficient). Copy the pooled connection
string; it becomes `DATABASE_URL`.

## 2. Apply the migration

```bash
DATABASE_URL='<neon-connection-string>' npm run migrate
```

This runs `migrations/001_init.sql` (idempotent — `CREATE TABLE IF NOT EXISTS`
throughout, safe to re-run).

## 3. Create the Vercel project

```bash
vercel link --scope <your-team>
```

(Or `vercel deploy` the first time from this directory with the same `--scope`;
either creates the project if it doesn't exist yet.)

## 4. Set environment variables on Vercel

```bash
vercel env add DATABASE_URL production --scope <your-team>
vercel env add CRON_SECRET production --scope <your-team>
```

`CRON_SECRET` should be a long random string (e.g. `openssl rand -hex 32`) — Vercel
sends it back as `Authorization: Bearer $CRON_SECRET` on cron-triggered
invocations of `/api/cron/rollup` and `/api/cron/prune`; both routes 401 without a
match, including a request from Vercel's own scheduler if the env var is missing.

## 5. Deploy

```bash
vercel deploy --prod --scope <your-team>
```

## 6. Point the emitter at it

In the main Open Everywhere deploy, an empty `telemetry.url` setting (the shipped value) sends to
`https://oe-telemetry.vercel.app/v1/logs` (see
`packages/core/agent/observability/telemetry.ts`'s `DEFAULT_TELEMETRY_URL`) — if
this project's Vercel deployment gets a different domain, update that constant (and
`docs/deploy/telemetry.md`) in the main repo to match.

## 7. Verify

```bash
curl -i -X POST https://<your-domain>/v1/logs \
  -H 'content-type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"open-everywhere"}}]},"scopeLogs":[{"scope":{"name":"open-everywhere-telemetry"},"logRecords":[{"timeUnixNano":"1","eventName":"oe.instance.first_boot","attributes":[]}]}]}]}'
# expect: HTTP/2 200, body {}

curl -i -X POST https://<your-domain>/v1/logs -H 'content-type: application/json' -d '{"bogus":true}'
# expect: HTTP/2 400, body {}
```

Then check the Neon `events` table has one new row for the first request and none
for the second.

## Ongoing

- Rollup + prune run automatically (weekly Vercel crons, `vercel.json`).
- To manually trigger either outside their schedule:
  `curl -X POST https://<your-domain>/api/cron/rollup -H "Authorization: Bearer $CRON_SECRET"`
  (same for `/api/cron/prune`).
