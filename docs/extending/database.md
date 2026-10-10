# Database & operational store

The **operational store** holds the runtime state git can't: secrets metadata, instant state,
spend counters, routine run-status, and the audit log. It's a [deploy-singleton adapter](./adapter-model.md).
There is **one dialect everywhere — Postgres**: the zero-wiring floor is an in-process, file-backed
**embedded Postgres (PGlite)**, the docker tier is a **Postgres server**, and production is
**hosted Postgres** (Neon or any `PgClient`-shaped DB). `sqlite` is **deprecated** — kept as a
legacy floor with a boot nag, not deleted; the `migrate-operational` command is the exit ramp. This
page is the seam.

## What lives here (and what doesn't)

This is the **runtime** half of the repo-vs-runtime split. Config-as-code — bundles, bindings,
grants, caps, routine *definitions* — lives in your git repo and deploys with it. The
operational store holds the things that change at runtime and have no place in git:

- **Spend** — token counters / ledgers (atomic, high-write), checked against config caps.
- **Routines** — run-status (last run, failures, paused) and ad-hoc routines; the durable
  definition is config-as-code.
- **Audit** — the append-only event log of what the agent did (see
  [Audit & provenance](../security/audit-and-provenance.md)), plus two append-only **revision
  logs** over the approval-gated text the agent follows — the **domain-skill** one (the exact
  markdown body armed by each approval) and the **routine-prompt** one (the standing instructions
  a routine has run under) — both kept so a later approved edit can't destroy what an earlier
  approver actually agreed to.
- **Runtime overrides** — break-glass deltas over config (spend-limit and connector revokes),
  reconciled back to a PR (see [The control plane](../security/control-plane.md)).

Secret **values** never live here — they sit in the [credential broker](./credential-brokers.md),
referenced by `secretRef`.

## Floor (embedded Postgres) vs server vs hosted

The store is selected at startup by `OE_OPERATIONAL_PROVIDER` **or**, when that is unset, by
whether a `DATABASE_URL` is present:

- **Embedded Postgres (PGlite) — the zero-wiring floor, the default when nothing is set.** The
  *same* Postgres store (`operational/postgres.ts`) backed by an in-process, file-backed WASM
  Postgres, so there's no dialect change from a laptop up to hosted Neon. Its data dir defaults to
  `.open-everywhere-data/pglite` beside your memory dir (override with `OE_PGLITE_DIR`). The
  OPE-113 validation spike (not kept in this repo) proved it
  crash-durable (30/30 `kill -9` cycles reopened clean, chain always verified), with these honest
  caveats: it is **single-process only** (a second process opening a live data dir corrupts it — an
  OE-level **single-writer lockfile** enforces this and refuses to boot against a live-locked dir),
  a **~250ms** WASM cold-boot, and **~660MB RSS at 200k rows** (10× sqlite on disk). Fine for dev
  and a small self-host; a tiny-RAM box should prefer the compose Postgres **server** (lighter) or
  hosted. Boot emits a one-time informational notice. It is NOT allowed on Vercel (per-instance
  ephemeral — the provider fails loud, same as sqlite).
- **`sqlite` — DEPRECATED.** The old floor: a single file on one box, **no managed durability,
  backups, or replication**, and append-only only *by contract* (no DB enforcement). Still works if
  you set `OE_OPERATIONAL_PROVIDER=sqlite`, but boot emits a loud deprecation nag. Move off it with
  `migrate-operational` — see [Graduating the operational store](../deploy/database-graduation.md).
- **`postgres` — the hosted / server backend, and what a `DATABASE_URL` selects on its own.** Neon
  (or any `PgClient`-shaped Postgres: RDS, Cloud SQL, the docker-compose `postgres:17` sidecar). It
  isn't pre-registered: it needs a deploy-supplied `PgClient` (a driver + connection string the app
  can't invent), so startup wiring calls `registerOperationalPostgres(client)` after
  `initOperationalSchema(client)`. **Setting `DATABASE_URL` is enough to select it** (OPE-2230);
  `OE_OPERATIONAL_PROVIDER=postgres` is the explicit spelling and is no longer required.

```ts
// packages/core/agent/operational/selection.ts — the pure resolution rule
export function resolveOperationalSelection(env) {
  const explicit = env.OE_OPERATIONAL_PROVIDER?.trim();
  if (explicit) return { id: explicit, floor: explicit === "sqlite" ? "sqlite" : "none" };
  if (env.DATABASE_URL?.trim()) return { id: "postgres", floor: "none" };   // ← hosted, derived
  return { id: "postgres", floor: "pglite" };                                // ← the embedded floor
}
```

A bare `DATABASE_URL` used to resolve to the deprecated `sqlite` floor. A deployment that had
connected Neon and set no selector therefore ran on a local file while believing it was on
Postgres. The memory backing follows the same rule in
`packages/core/agent/memory/backing-selection.ts`: `OE_MEMORY_PROVIDER` wins, else a present
`DATABASE_URL` selects `postgres`, else the `git` floor.

The embedded floor is armed at boot by `registerOperationalPgliteLazy()`, called from
`registerDefaultAdapters()` in `@open-everywhere/adapters` (the app's `agent/lib/register-adapters.ts`
calls it); the hosted path by the Neon adapter's
`registerOperationalPostgres(client)`. Both resolve to id `postgres` — one dialect, one store.

**"Lazy" means the store is registered at boot but *opened* on its first query** — the
single-writer lockfile, the ~250ms WASM boot and the schema init all happen then, in whichever
process actually uses the store. That is deliberate: `eve start` evaluates your agent graph inside
the **CLI** process (its sandbox-prewarm step) and then spawns the built server as a **child** that
evaluates it again, so an eager open made the CLI the lock holder and the server refused to boot
against a fresh, zero-wiring directory. A second *real* instance is still refused loudly at boot —
arming re-reads the lockfile without taking it — and the boot-time audit-chain check runs on that
first open rather than at import.

Selection is fail-closed — an unregistered provider throws at startup rather than running on the
wrong store. The same `PgClient` port backs both the operational store and the
[Postgres memory backing](./memory-backings.md); the generic SQL lives in core and only the
vendor client construction is in the adapter.

## org_id + RLS isolation

The Postgres backend partitions every table by `org_id`. The **load-bearing** isolation is the
`org_id` filter on every query — correct on any driver, under any role. On top of that, most
tables carry **row-level-security** policies keyed on the `app.current_org` GUC as
defense-in-depth. Two honest caveats about that second layer:

- The GUC-keyed policies only bite under a **non-owner, non-superuser** role. They **enforce when
  the GUC is set and permit when it is unset** (an explicit `OR … IS NULL` arm in each policy) —
  so the two-role runtime posture below can serve before per-request GUC wiring exists, and wiring
  `setOrgContext` later upgrades them to real isolation with no schema change. On the default
  single-role Neon deploy the app connects as the table *owner*, which bypasses them entirely —
  the `org_id` query filter is what actually isolates tenants in every posture.
- The **four append-only tables — `audit_entry`, `usage_events`, `domain_skill_revisions` and
  `routine_prompt_revisions`** —
  are the exception that *is* DB-enforced today: they carry `SELECT` + `INSERT`-only policies under
  **`FORCE ROW LEVEL SECURITY`**, so `UPDATE`/`DELETE` are denied even to the table owner (that's
  what `FORCE` buys — plain `ENABLE` lets the owner bypass). Append-only therefore holds whether or
  not the GUC is set. Three of the four keep GUC-free policies (`USING (true)` / `WITH CHECK
  (true)`), and isolation for those rides the `org_id` query filter alone.
- **`audit_entry` is the one append-only table that is also org-keyed.** Its `SELECT` and `INSERT`
  policies carry the same GUC predicate the mutable tables use, so a session that sets
  `app.current_org` reads and writes that org's audit rows only — and `FORCE` means this binds the
  owner too, not just a non-owner role. Read that for what it is: **nothing in the shipped runtime
  sets the GUC**, so the policy permits today and the control is the **required org at the store
  boundary** — `readAudit` refuses a read that names no org, rather than widening to every tenant.
  The policy is the second layer a deployment earns by wiring the GUC. Wire it **per request**: a
  session-wide `app.current_org` also narrows the deliberate cross-org readers (`listAuditOrgs()`
  and `scripts/verify-audit-chain.ts`, which walk every org), and `scripts/audit.ts --all-orgs`
  needs a session that leaves it unset.
- 🔴 **Upgrading to that policy writes one `audit.integrity` row, and it is the migration.** An
  existing store carries the previous `USING (true)` pair, which the expected-policy allowlist no
  longer matches. The first **owner-mode** boot drops both policies as unexpected, recreates them
  from the schema statements, logs the repair, and records a single `audit.integrity` row naming
  `audit_entry.audit_select` and `audit_entry.audit_insert`. That row is otherwise this repo's
  evidence-of-tampering signal — read this one as the upgrade. **Run the owner boot first on a
  two-role deployment:** the runtime role cannot repair the posture, so it records the same row and
  **refuses to start** until the owner boot has run.

Real `DELETE` on the *mutable* tables gives true erasure (where the git memory backing can only
remove working files) — on the tables that have a delete path at all. Several deliberately do not:
a revoked credential, a decided approval and a revoked webhook hook are **retained** rather than
removed, and under the two-role split the runtime role is not granted `DELETE` on them (see step 3
below).

### What a domain skill's history is doing in here

A **domain skill is an approval-gated instruction package**: a member proposes one, a card carries
the full markdown body, and a human clicks to arm it — after which the agent *follows* it. The live
row in `domain_skill` is an upsert, so the next approved edit overwrites the body. Without a record,
the audit trail can say who approved a skill change and when, but not **what they agreed to** —
which is the question the audit exists to answer. So every write to `domain_skill` also appends the
exact body to `domain_skill_revisions`, from *inside* the store rather than at the caller, together
with the author, the approver, and the `pending_actions` id of the card that armed it. Deleting the
skill leaves its revisions standing; that is the case where the body is otherwise gone entirely.

**Retention: it is never pruned, and neither backend has a prune path.** That is a stated position,
not an oversight. The bound isn't a sweep, it's the gate — a row can only exist because a human
clicked an approval card, so the table grows with approvals rather than with traffic (unlike
`event_dedupe` or `webhook_capture`, which an outside party can drive and which are therefore
bounded in code). If an operator ever needs bulk retention it is the same story `usage_events`
tells: a maintenance path **outside the app role**, because the app role holding `DELETE` here is
exactly what the table must not permit.

### …and what a routine's prompt history is doing in here

Same defect, one deliberate difference in shape. A **routine's prompt is a standing instruction that
fires unattended**, and `edit_routine` patches the new text straight over the live row — while the
*same* edit bumps `promptGeneration` and thereby revokes every standing permission the routine had
accumulated. The code already treats a prompt change as an **authority event**, so "what did that
authority cover" has to stay answerable, and the edit's audit row deliberately records only the
prompt's *length*. So a prompt-replacing write also appends to `routine_prompt_revisions`, from
inside the store, each row carrying the text, the `promptGeneration` it ran under (the same key a
standing grant embeds — that is the join), who asked, who armed it, and the `pending_actions` id of
the card.

**Unlike the skill log, this one starts at the first edit, not at creation.** `putDomainSkill` has
exactly one producer: a human clicking a card. `addRoutine` does not — `subscribe_pr` re-arms its
PR-watch chain by creating a *fresh* routine after every check (up to 96 per subscription), driven
by someone else's pull request. Recording every creation would make a never-pruned table grow with
**traffic**, which is the one thing the retention position cannot survive. So this log records
**supersession**, and you read it *with* the live row: rows 1…n-1 are what the routine used to say,
the row is what it says now, and a routine nobody has edited has no rows because nothing was
destroyed. The text a routine was *created* with is written lazily on its first edit, attributed
from the row (`createdBy` / `createdAt`) rather than from the edit — crediting the approver who
*replaced* an instruction as the person who armed it would be the most misleading thing this table
could say.

**The cost of that choice, stated:** cancelling a routine that was never edited leaves no row here,
where deleting a skill leaves its revisions standing. That is the narrower and honest claim — this
table exists to survive a destructive **overwrite**, which is what an edit is; a cancel is a human
deliberately removing something, and its text is still in the `routine.create` card's frozen args.

**Retention** is the same position as the skill log's, and it holds more strictly: never pruned, no
prune path, and growth bounded by *approved edits* — never by fires, never by an outside party. The
`UPDATE`/`DELETE`/`TRUNCATE` denial matters more here than on any other append-only table, because
the runtime role holds **full CRUD on `routine` itself**: whoever holds the app's credential can
already rewrite what fires unattended. What they must not be able to rewrite is the record of what a
human armed.

### Hardening: the two-role split (recommended — closes the owner-DDL escape)

`FORCE` denies `UPDATE`/`DELETE` *as DML*, but the table **owner can still run DDL**: one
`DROP POLICY` or `ALTER TABLE … DISABLE ROW LEVEL SECURITY` and the log is rewritable. On the
single-role deploy the app *is* the owner, so anyone holding the app's connection string defeats
append-only in two statements. The fix is serving the app as a **non-owner runtime role** —
Postgres refuses those DDL statements to a non-owner outright, so the credential the deployed app
actually holds (the one most exposed: env vars, function logs, a compromised instance) can no
longer disable the protection. Both schema inits are **role-aware**: under the owner they apply
the schema as always (and if they find the append-only posture was broken while the app was down,
they repair it and report what they found); under a non-owner runtime role they skip DDL, verify the
posture, and **refuse to boot** if it doesn't hold. The operational init verifies
`verifyAppendOnlyAudit` and records an `audit.integrity` row; the memory init verifies
`verifyMemoryIsolation` and reports on the console — the memory paragraph below says why it writes
no row.

🔴 **The owner-mode apply re-creates the RLS policies inside ONE transaction, under an advisory
lock.** Postgres has no `CREATE POLICY IF NOT EXISTS`, so a re-apply drops each policy first. In
autocommit that left every append-only table with `FORCE` on and no policy — deny-all to every role,
the owner included — until its own `CREATE POLICY` landed, and an init that died inside the span
left the store that way until the next owner-mode boot. The span is now atomic and serialised, so an
aborted init rolls back and two inits cannot race each other. Only the policy span runs in a
transaction: wrapping the whole apply would hold `ACCESS EXCLUSIVE` on every table for about 28
seconds and block the serving app. The `audit.integrity` row a repair writes also names the cause —
`aborted-init`, `tampering` or `unknown`. See
[Audit & provenance](../security/audit-and-provenance.md#how-boot-verifies-the-append-only-posture)
for the whole contract.

🔴 **The memory schema applies its policy span the same way.** `memory_file` and `memory_tier` carry
one `org_id` isolation policy each, and `initPostgresSchema` used to drop and recreate both in
autocommit. These two tables carry no `FORCE`, so the owner never noticed — but a **non-owner
runtime role serving while an owner boot re-applied the schema was denied every memory read and
write** for that span, and an init that died inside it left the store that way until the next
owner-mode boot, because the memory init runs no DDL under a non-owner role. The span is now one
transaction under `pg_advisory_xact_lock`, in the same shape and the same advisory-lock class as the
operational store's, with its own key so neither span waits on the other. Both stores' spans fall
back to the old autocommit loop on a client with no `withConnection` seam, and warn once per process
when they do — on **any** such client, the embedded PGlite floor included. The warning itself says
the floor is the expected case, so a floor boot printing it is normal, not a misconfiguration.

**What `verifyMemoryIsolation` covers (boot-time, on `memory_file` and `memory_tier`):** the table
exists; RLS is `ENABLE`d; the one expected `*_org_isolation` policy is present, is **permissive and
`FOR ALL`**, and nothing else is; and that policy still reads `app.current_org`. So a policy widened
to `USING (true)` is a violation, and so is one carrying the expected name under the wrong shape —
`AS RESTRICTIVE`, or `FOR UPDATE` — which denies the runtime role every read while a name-only check
would call the store sound. A non-owner boot **refuses** on any violation and names the cause
(`aborted-init`, `tampering` or `unknown` — the same three the operational store uses) together with
the remedy that fits it. An owner boot repairs what a re-`CREATE` fixes and **reports** the rest on
the console rather than refusing: the memory policies are defence-in-depth, the `org_id` filter on
every query is what isolates tenants, and turning that signal into a refused boot would be an
outage. 🔴 **The owner boot drops nothing it did not create**, so a foreign policy is named and left
in place — re-running the owner init does not clear one, and an operator has to `DROP POLICY` it by
hand. Both boot messages say so rather than sending a responder round that loop. The memory store
writes **no
`audit.integrity` row**: its schema init runs before the operational one, so on a fresh database
`audit_entry` does not exist yet and the operational store is not registered. The console report and
the boot error are the record.

**What `verifyAppendOnlyAudit` covers (boot-time, on `audit_entry`, `usage_events`,
`domain_skill_revisions` and `routine_prompt_revisions`):** the table
exists; RLS is `ENABLE`d **and** `FORCE`d; a `SELECT` and an `INSERT` policy are present; **no**
policy permits `UPDATE`/`DELETE`/`ALL`; the **full policy set matches an exact allowlist** — so a
foreign or `RESTRICTIVE` policy is rejected too, including a `RESTRICTIVE … FOR INSERT WITH CHECK
(false)` that blocks appends while permitting reads (not caught by a mutation-only check); **no**
non-internal `INSERT`/`UPDATE`/`DELETE` trigger exists — a `BEFORE INSERT … RETURN NULL` trigger
that silently swallows every audit row is caught (we define none, so any is hostile); and **no**
non-owner role holds an `UPDATE`/`DELETE`/`TRUNCATE` grant — an owner `GRANT` slip that would let
the runtime role (or `PUBLIC`) mutate/wipe the log despite RLS. On an owner-mode boot these are not
just detected but **surgically healed** — unexpected policies dropped, hostile triggers dropped,
stray grants revoked (all recorded in the `audit.integrity` row's `healed_artifacts`) — closing a
prior gap where a re-CREATE-by-known-name schema apply left a foreign/restrictive policy in place.

**What it does NOT cover:** a break-**and-restore** performed entirely *between* two boots that
leaves no persistent catalog state — the tamper happened and was undone while nothing was verifying,
so there is no artifact left for boot-time verification to see, and no `audit.integrity` row is
written. Closing that requires the append log to be **tamper-evident regardless of catalog state** —
a cryptographic hash chain anchored to an independent witness, which remains the **next planned
layer**, not something the current posture provides. Do not read the current guarantee as
unconditional tamper-proofing.

To adopt it:

1. Keep the **owner role** (Neon: `neondb_owner`) for schema/migrations: run one boot (or
   `initOperationalSchema` + `initPostgresSchema`) with it — and re-run it after every upgrade
   that changes the schema, *before* pointing the runtime at the new build.

   🔴 **An upgrade that changes a table's VERB set needs step 3 re-run too, not only step 1.** A
   new table is the obvious case; a new verb on an existing table is the one that slips through,
   because the schema is unchanged and the boot reports nothing. The runtime role keeps the old
   grant, and the code path that needs the new verb fails at runtime with `permission denied`.
   OPE-1821 is a live example in the other direction: it added `served_code_fingerprint` and
   `served_domain_fingerprint` to `channel_session`, whose UPDATE grant the runtime role already
   holds, and it dropped the `DELETE` on `notice_claim` that OPE-1751 needed. A deployment whose
   runtime role still holds that `DELETE` keeps reach nothing uses; re-run `runtimeRoleGrantsSql` to
   take it back.
2. **Create the runtime role in SQL** (not via the Neon console, so it picks up no elevated
   platform role memberships): `CREATE ROLE oe_runtime LOGIN PASSWORD '…';`
3. **Grant it exactly what the app needs** — run the statements
   `runtimeRoleGrantsSql("oe_runtime")` exports (`packages/core/agent/operational/postgres.ts`);
   the operational test executes that same list against a real engine, so the docs and the grants
   can't drift. In short: `USAGE` on the schema, sequence usage, `SELECT, INSERT` **only** on
   `audit_entry`/`usage_events`/`domain_skill_revisions`/`routine_prompt_revisions` with everything
   else revoked (belt at the
   privilege layer, braces
   at the RLS layer), and on the mutable tables **exactly the verbs each table's code path
   issues** — which is *not* the same set for every table. Most get `SELECT, INSERT, UPDATE,
   DELETE`; the ones with no delete path (`spend_ledger`, `channel_session`, `pending_actions`,
   `instance_meta`, `credential_intake`) get no `DELETE`, and
   `event_dedupe` — written once per key and pruned by TTL — gets no `UPDATE`. `stored_credential`
   is the interesting one: it *does* hold `DELETE`, because the row there **is** the secret, so
   offboarding has to be able to destroy it rather than retire it by status — see
   [Identity](../how-it-works/identity.md). The evidence survives in `audit_entry`, which holds no
   `DELETE` for this role at all. `TRUNCATE` is
   revoked from every table, including those that do hold `DELETE`: **RLS does not filter
   `TRUNCATE`**, so that privilege would wipe every tenant's rows regardless of the org policy.

   Each `GRANT` is paired with a `REVOKE` of the verbs that table does *not* need, so re-running
   the list also **tightens a role provisioned by an older build** rather than only adding to it.
   Re-run after any migration that adds a table — deliberately no `ALTER DEFAULT PRIVILEGES`, so a
   future append-only table can't silently inherit `UPDATE`/`DELETE`. When you add a mutable table,
   add it to `MUTABLE_TABLE_VERBS` with the verbs your statements actually use: note that
   `INSERT … ON CONFLICT DO UPDATE` needs `UPDATE` as well as `INSERT`, while
   `INSERT … ON CONFLICT DO NOTHING` does not. **Forgetting is a gate failure, not a production
   one:** the operational test derives the expected grants from both sides — coverage from the
   canonical table list, and the verbs from the SQL the store issues — and fails if a table holds
   no grant, holds too few verbs for its own statements, or holds a verb no statement uses.
4. Point `DATABASE_URL` at the runtime role, and park the owner/migration string under
   **`OE_DB_OWNER_URL`** (re-run the owner boot from it after a schema-changing upgrade). Boot
   verifies the posture and serves. `preflight` then reports it (`OE_DB_OWNER_URL` present ⇒
   two-role).

   🔴 **The split is MANUAL, and single-role is the shipped default.** Nothing provisions this for
   you: generate the runtime password yourself, run the statements above as the owner, and set the
   two variables by hand. An earlier version of this page said the setup wizard defaulted to the
   split — it did, and OPE-2233 retired that wizard with the rest of the interactive setup, so the
   claim is gone with it. Until you do step 4, `DATABASE_URL` is the OWNER role and one
   `DROP POLICY` from the app's own credential defeats append-only. `preflight` says so on every
   run: `single-role (owner-DDL escape open)`.
5. Optionally wire the per-request GUC (`SET LOCAL app.current_org = <org>` inside each
   transaction — not a pooled `set_config(..., false)`, which a multiplexing pool like Neon's can
   leak across sessions) to turn the GUC-keyed policies — the mutable tables' and `audit_entry`'s —
   into real per-tenant RLS. Leave it unset on the connections that read across orgs by design
   (the chain verifier, `scripts/audit.ts --all-orgs`).

**Honestly scoped residual risk:** whoever holds the *owner* credential (or Neon console/API
access, or a true superuser / `BYPASSRLS` role) can still drop the policies and rewrite the log —
the split narrows the append-only guarantee's attack surface to the migration credential, it does
not make the log tamper-proof against the database's own administrators. Detection is
boot-time-only (`audit.integrity` rows): a break-and-restore *between* boots leaves no trace.
Cryptographic tamper-evidence (a hash chain anchored to an independent witness) remains a
separate, planned layer. On the **single-role** default the shipped posture is unchanged:
`org_id` filter = isolation; `FORCE` RLS = append-only against DML, with the owner-DDL escape
open — plus the new boot-time verify-and-record.

## Pointing at your own Postgres

1. Construct a `PgClient` for your driver — anything matching `{ query(text, params) }`: Neon
   serverless, node-postgres, RDS/Aurora, pglite.
2. Initialise the schema (`initOperationalSchema(client)`; and `initPostgresSchema(client)` for
   memory) and register: `registerOperationalPostgres(client)`.
3. Select it: `OE_OPERATIONAL_PROVIDER=postgres`.

The Neon adapter does exactly this from `DATABASE_URL`; a different Postgres just means swapping
the client construction in your own app's adapter wiring.

### The pooler caveat

The shipped adapter (`packages/adapters/agent/postgres/neon.ts`) builds one `Pool` from
`@neondatabase/serverless` — Neon's WebSocket driver, not raw TCP — at startup, and reuses it
across warm invocations of the same function instance. Neon (and Supabase) front their
endpoints with a built-in connection pooler, so this holds up under serverless concurrency
even with many warm instances each holding a connection open.

A swap to plain-TCP `pg` (node-postgres) against RDS, Cloud SQL, or a self-hosted Postgres is
a small adapter — `PgClient` is a one-method port, and `neon.ts` minus its WS-proxy plumbing
is roughly the size to expect (~40 lines). But without a pooler in front of it, that adapter
under real serverless concurrency — each warm instance opening its own connection — can
exhaust `max_connections` well before traffic looks heavy. Front such a deployment with
PgBouncer (self-hosted, or offered by most managed Postgres providers) or RDS Proxy
(RDS/Aurora) once traffic is non-trivial — don't wait for the outage to add it. See
[Graduating the operational store → Fixed-price alternates](../deploy/database-graduation.md#fixed-price-alternates)
for the hosts this applies to.

## On Vercel / Off Vercel

- **On Vercel:** Neon Postgres is the default (provisioned via the Neon marketplace integration,
  registered from `DATABASE_URL`), with `org_id` + RLS isolation and real erasure. The embedded
  (PGlite) and sqlite floors are **refused** there — a per-instance ephemeral store would make a
  `revoke_connector` report success and never take effect. The marketplace flow picks a Neon
  project **region at creation, and it's immutable after** (AWS `eu-west-2`/London among the
  choices) — decide it before real data lands. See
  [Graduating the operational store → Choosing a target](../deploy/database-graduation.md#choosing-a-target)
  for why Neon's the default and what the always-on tick economics actually cost.
- **Off Vercel:** the **embedded Postgres (PGlite) floor** runs with zero wiring for local or tiny
  self-host — same dialect as prod. Step up to a real Postgres **server** with the docker-compose
  `postgres:17` sidecar (lighter RAM than in-process WASM), or point at any managed Postgres (RDS,
  Cloud SQL, Neon, self-hosted) by constructing a `PgClient` and registering it — the generic SQL
  impl is vendor-neutral, so only the driver line changes. The one dialect end-to-end means
  `migrate-operational` moves data between any two of these without a rewrite.

## Testing against a real Postgres, not just PGlite (OPE-385)

The store/migration assertion suites (`operational-test.ts`, `postgres-test.ts`,
`migrate-operational-test.ts`, `legacy-schema-fixture-test.ts`, all in `packages/core/scripts/`)
run by default against embedded PGlite — that's what plain `npm test` exercises on every push, and
it stays that way: **zero
dependencies, no Docker, no network**, so a fresh clone can run the full gate immediately. But
PGlite (PG 18.3) is not the engine prod runs — prod is hosted Neon (measured PostgreSQL 17.10),
reached through the real `@neondatabase/serverless` driver, and that combination was never
exercised by CI until this lane.

**Run it locally** (needs Docker):

```
npm run test:pg-real
```

This brings up `docker-compose.test-pg.yml` — a real `postgres:17-alpine` server plus the
`neon-wsproxy` bridge the shipped Neon driver needs (it speaks WebSocket, not raw TCP; see the
compose file's comments and `agent/postgres/neon.ts`) — under the dedicated compose project
`ope385-ci` so it never collides with anything else running, waits for the proxy to accept
connections, runs the same four test scripts through the real driver, and tears the sidecar back
down. It requires no secrets: the sidecar's Postgres credentials are throwaway, compose-local-only
values.

**How the switch works:** the four test scripts build their `PgClient` through
`packages/core/scripts/test-pg-driver.ts`'s `openTestPg()` instead of calling `new PGlite()`
directly. With `OE_TEST_PG_URL` unset (the default) it opens an in-process PGlite instance,
unchanged. With `OE_TEST_PG_URL` set (as `test-pg-real.sh` does) it dynamically imports
`@neondatabase/serverless` — the exact driver `agent/postgres/neon.ts` constructs for prod — and
routes it through `OE_TEST_PG_WS` (the local wsproxy, `host:port`, no scheme — the same shape
`OE_NEON_WS_PROXY` documents above) exactly as the app tier does. Each call opens a **fresh
throwaway database** (`CREATE DATABASE` / `DROP DATABASE` around the run) rather than reusing one
connection, since several test sections need more than one isolated instance in a single run and
Postgres roles (`CREATE ROLE open_everywhere_app` / `oe_table_owner` / `oe_runtime`, all exercised
by the RLS/two-role sections) are cluster-wide, not per-database — the two files that create one
`DROP ROLE IF EXISTS` immediately before, so the lane is safe to re-run against a live sidecar
without a full teardown in between.

🔴 **No scheduled runner drives this lane today.** A nightly `.github/workflows/pg-real.yml`
used to run `npm run test:pg-real`; this repo has no workflows now, so the lane runs
only when somebody runs it by hand. That was always meant to be **periodic, not per-push**: it
needs Docker and a real DB engine, which is slower and heavier than the default PGlite gate, and
a transient failure there should not block an unrelated change. Run it before any change to the
Postgres adapter, and treat a green PGlite tier as no evidence about the real engine.
