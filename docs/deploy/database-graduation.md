# Graduating the operational store

Open Everywhere's zero-wiring floor for the [operational store](../extending/database.md) is an
**embedded Postgres (PGlite)** — an in-process, file-backed Postgres, the *same dialect* you run in
production. It's the right default for local dev and a tiny single-instance self-host: no database
to provision, a data dir next to your memory dir, and no engine change when you move up. This page
is about the two ways up — to a **Postgres server** or to **hosted Postgres** — and the one
supported command that moves your data across without losing anything. (The legacy **sqlite** floor
is deprecated but still migrates the same way — it's just another Postgres-dialect target on the
far side.)

## What the floor means

The embedded (PGlite) floor is a **single process on one box**, durable to local disk. It buys zero
setup, and it costs you what a managed/server database gives you: **backups, replication,
multi-instance access, and a smaller RAM footprint** (in-process WASM Postgres is heavier than a
Postgres server — see the [OPE-113 spike](../../packages/core/scripts/spikes/pglite-floor-spike.ts):
~660MB RSS at 200k rows, ~250ms cold-boot, and it is **single-writer only** — an OE lockfile refuses
a second process). If the box dies, the disk fills, or you scale past one instance, the operational
store — your **audit log, spend ledger, break-glass connector revocations, routine run-status, and
(if pinned to sqlite) personal memory** — is at risk or simply wrong (each instance would read its
own local file).

Because these are *security controls*, running them on any floor in production is a quiet
liability. The embedded floor emits a one-time informational boot notice; the deprecated **sqlite**
floor emits a loud deprecation nag naming the migration command. Both fire once per process, never
per-request, and neither fires on a hosted-Postgres deploy. On serverless (Vercel) the floors don't
just warn — the operational provider **refuses to boot**, because a per-instance ephemeral store
would make a `revoke_connector` report success and never take effect.

## When to graduate

Graduate the moment any of these is true:

- You're running **real org data** you'd be unhappy to lose or unable to audit.
- You're (or will be) running **more than one instance** / any serverless platform.
- You want **backups, point-in-time recovery, or replication**.
- You want the **two-role append-only hardening** for the audit log
  ([database.md → the two-role split](../extending/database.md#hardening-the-two-role-split-recommended--closes-the-owner-ddl-escape)),
  which only exists on Postgres.

There's no rush for a laptop or a throwaway demo — that's exactly what the floor is for.

## Choosing a target

Neon is the default hosted target — provisioned automatically on Vercel (see
[database.md → On Vercel / Off Vercel](../extending/database.md#on-vercel--off-vercel)). Off
Vercel, or if you'd rather bring your own Postgres, here's what to weigh.

### Why Neon

Zero ops — no server to patch, size, or restart — a real free tier, and wiring is a plain
`DATABASE_URL` (no VPC, no security group, no IAM role to get right). Scale-to-zero also fits
Open Everywhere's actual load shape: a routine dispatcher tick and the occasional real
conversation, not a constant query stream — see the tick economics below for the honest
version of what "scale-to-zero" buys you in practice. Neon also gives you real regional
choice — pick e.g. AWS `eu-west-2` (London) at project creation. **Region is immutable after
creation**: there's no "move region" button, only a new project and a `migrate-operational`
hop across, so decide it on day 0, before real data lands.

### The tick economics, honestly

The routine dispatcher (`packages/core/agent/schedules/dispatch.ts`) reads the routine store
on every tick, 24/7, whether or not any routine is actually due — see
[Proactivity & routines → How firing works](../capabilities/proactivity-and-routines.md#how-firing-works)
for the full mechanics. It ticks every `DISPATCH_TICK_MINUTES` (10 — a source constant in
`packages/core/agent/routines/schedule.ts`, not an env var, so changing it means a fork and
rebuild), deliberately not every minute: the in-code comment on `dispatch.ts`'s
`defineSchedule` call records a 2026-07-07 incident where a 1-minute tick held Neon's compute
endpoint awake ~84% of the time and the bill became pure compute.

Even at 10 minutes, against Neon's default 5-minute autosuspend, the ticks alone hold the
endpoint roughly half awake: each tick resets the idle timer, the endpoint stays up for the
following ~5 minutes, then sleeps for the other ~5 until the next tick lands — a ~50% duty
cycle from routine dispatch **before any real conversation happens**. On the Launch plan's
smallest compute size (0.25 CU) that floor is on the order of **$10/month**; a deployment
with real business-hours usage on top of it lands more like **$25–40/month** — in the same
range as a fixed-price small managed Postgres, not free. Under the defaults, the database can
never sleep longer than ~5 minutes at a stretch.

Two knobs, if that floor matters to you:

- **Raise `DISPATCH_TICK_MINUTES`.** The only cost is routine lateness (a routine fires that
  much later than its due instant at worst — correctness is unaffected, tick cadence never
  causes a double-fire or a skip; see the routines doc above). This is a source change, not a
  runtime setting.
- **A plan with a shorter (or configurable) autosuspend timeout.** Neon's paid tiers let you
  set the suspend timeout per branch — check your current plan's limits rather than assuming
  the 5-minute default applies.

### Fixed-price alternates

If you're running near-always-on — routines firing more often than autosuspend can ever
recover between, or steady conversational traffic through the day — a fixed-price box removes
the duty-cycle math entirely and can be cheaper or simply more predictable. Anything that
speaks the Postgres wire protocol plugs into the
[`PgClient`](../extending/database.md#pointing-at-your-own-postgres) seam; a small managed
instance is a reasonable default:

- **DigitalOcean Managed PostgreSQL** — from ~$15/month.
- **Fly.io Managed Postgres** — has a London region, ~$38/month for the smallest tier.
- **AWS RDS `db.t4g.small`** — roughly $20–26/month depending on region and storage.

Aurora Serverless v2 is worth a mention only to flag it: its per-I/O billing can bite on a
chatty small-row workload like routine dispatch and spend-ledger writes. Measure your actual
query volume before assuming it beats a fixed-price box — don't take it on faith either way.

See the [pooler caveat](../extending/database.md#the-pooler-caveat) before pointing a
self-hosted or RDS Postgres at real serverless concurrency.

## The command

Pick a target and run, **from `packages/core`**:

```bash
# → hosted Postgres (Neon, RDS/Aurora, Cloud SQL, self-hosted — anything you can build a PgClient for)
DATABASE_URL="postgres://…" npx tsx scripts/migrate-operational.ts

# → the embedded Postgres (PGlite) floor — e.g. graduating a legacy sqlite floor onto it locally
npx tsx scripts/migrate-operational.ts --pglite-dir .open-everywhere-data/pglite
```

Because there is **one dialect everywhere**, every hop is the same mechanism: sqlite → embedded,
sqlite → hosted, or embedded → hosted (a plain Postgres dump/restore also works for the last one,
since both ends are real Postgres).

Flags:

- `--source PATH` — read a specific sqlite file instead of the runtime default
  (`OE_SQLITE_PATH`, else `OE_MEMORY_DIR/open-everywhere.sqlite3`).
- `--pglite-dir <dir>` — migrate **into an embedded Postgres data dir** instead of hosted Postgres.
  Takes the same single-writer lock the runtime floor takes, so it refuses a dir a live instance
  holds. `DATABASE_URL` isn't needed with this flag.
- `--force-empty-check-off` — allow migrating **into a non-empty target**. By default the
  migration **refuses a non-empty target** so you can't accidentally merge into or clobber a live
  database; pass this only when you deliberately intend to add to an existing one.

The script never prints `DATABASE_URL` or any credential.

What it does, in order:

1. Creates the schema on the target (`initOperationalSchema`) — idempotent.
2. Refuses a non-empty target unless you passed `--force-empty-check-off`.
3. Copies **every** operational table row-for-row. The table list is derived from the schema and
   guarded by a test, so a table added in a future version can't be silently skipped. It is
   **fail-loud**: any single row that won't insert aborts the whole migration (no partial-silent
   success).
4. **Re-verifies the audit hash chain on the target** and prints a per-table `source → target`
   row-count summary.

If your **memory backing** is also on sqlite (`OE_MEMORY_PROVIDER=sqlite`), its tables are copied
too. If memory is **git** (the default), the script says so and skips it — git history is already
off-DB and portable. If memory is already Postgres, likewise nothing to do.

After it prints `✓ migration complete`, set `OE_OPERATIONAL_PROVIDER=postgres` (and
`OE_MEMORY_PROVIDER=postgres` if you migrated memory), register the client at startup, and the
boot warning goes away.

## The chain-verify guarantee

The audit log is an [append-only hash chain](../security/audit-and-provenance.md): each row stores
the `sha256` of the previous row for its org, so a deleted or mutated row is *detectable*. The
migration preserves that chain **verbatim** — the stored `prev_sha` values are **copied, never
recomputed** — and then, as its final step, **runs the same chain walk you'd run by hand** against
the **target**: the shared `findChainBreak` library that
[`scripts/verify-audit-chain.ts`](../../packages/core/scripts/verify-audit-chain.ts) drives, over
every org's full chain from its genesis. If any org's chain doesn't verify, **the migration fails**
rather than reporting a false success.

The practical consequence: if your *source* chain was already broken (tampering, or an
out-of-band edit to the sqlite file), the migration surfaces it loudly instead of silently
copying a compromised history onto your new database. A clean source produces a clean, verified
target — same chain, same guarantees, now on managed infrastructure.

One honest bound: a source with **no audit rows at all** migrates to a target with no audit rows,
and the step reports `0 org chain(s) intact`. That is a true statement about an empty log, not a
verification — the same distinction the verifier CLI draws with its
[exit code 3](../security/audit-and-provenance.md#the-verifier-cli).
