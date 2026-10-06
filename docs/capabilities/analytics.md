# Analytics: natural-language querying

Ask the agent about your org's own operational data — audit actions, model-call usage,
monthly spend — **in plain language, in the chat itself**. You describe what you want;
the agent forms a structured query over a fixed schema, the host runs it, and the answer
comes back — restricted to exactly what your access already lets you see.

The design principle: **the model never writes SQL.** It picks datasets, dimensions,
measures and filters from a closed, published vocabulary; the host compiles those names
through fixed lookup tables into a parameterized query, and injects the *scope* (which
rows you may see) host-side from your verified identity — never from anything the model or
the conversation said. That keeps the surface "simple and safe, not powerful and
exploitable": there is no free-text SQL to exploit, and no way to widen your own scope by
asking cleverly.

## What you can ask

Three datasets ship (all already recorded — no new storage):

| dataset | one row is… | dimensions | measures |
|---|---|---|---|
| `audit`  | one recorded **action** (append-only) | `ts`, `platform`, `workspace`, `surface`, `action`, `principal`, `domain` | `rows` |
| `usage`  | one **model call** (append-only; the default store deletes none — see [retention](../security/spend-and-cost.md#per-event-usage-capture)) | `ts`, `surface`, `principal`, `kind`, `model`, `session`, `routine`, `depth`, `root_session`, `cost_source`, `domain` | `events`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `reasoning_reported_calls`, `cache_reported_calls`, `sessions`, `est_usd`, `measured_usd` |
| `spend`  | one **monthly** ledger row, keyed by surface, principal, routine, model and cost source (the app deletes none) | `period`, `surface`, `principal`, `routine`, `model`, `cost_source`, `domain` | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `calls`, `usd`, `usd_measured` |

The registry `packages/core/agent/analytics/registry.ts` holds this vocabulary. The model picks
names from it. A name the registry does not list fails schema validation before the host compiles
any query.

Example asks:

- *"How many memory writes did we log this week?"* → `audit`, group by day, filter
  `action` prefix `memory.`.
- *"Which channels used the most tokens this month, and roughly what did it cost?"* →
  `usage`, group by `surface`, measures `input_tokens` + `est_usd`.
- *"Show me the last 20 connector writes and who ran them"* (admins) → `audit`, rows
  mode, filter `action` prefix `connector.`.

`mode` is `aggregate` (grouped measures, the default) or `rows` (a raw listing). Rows mode
follows your standing: `scope: "self"` lists your own rows, and `scope: "domain"` or
`scope: "org"` lists rows only for an admin. The host refuses a rows request your standing does
not carry, and names aggregate mode in the refusal.

`est_usd` is always an **estimate**, labelled with the assumption behind it, and is
omitted rather than guessed when the deployment can't price a model. DM usage is bucketed
into a single `(dms)` line so a report in a channel never reveals who DMs the agent.

**How a DM is recognised, and what happens when it cannot be.** Every `usage` and `spend` row
carries the conversation mode its turn's binding resolved, and the mask reads that stamp — never the
shape of a surface id — so Slack, Discord and Teams DMs all collapse to `(dms)`. A row nothing
stamped is masked too, into a separate `(unclassified)` line: the mask fails closed rather than
publish a key it cannot classify, and it keeps that line apart from `(dms)` rather than report a
channel's spend as DM spend. Group DMs are not masked — a group is not an individual.

Rows written before that stamp existed therefore report as `(unclassified)` when you group by
`surface`, and they do so even where the older turn-origin tag could have classified them: an
aggregate query may only group by a column that cannot split one session's rows, or the distinct
session count would double. A `spend_report` or `usage_report` line reads the older tag and so masks
a few of those rows more precisely. Both answers hide the surface; they differ only in which bucket
an old row lands in. 🔴 **The bucket does not shrink by itself.** The default store deletes no usage
or spend row, so an `(unclassified)` row stays until your own retention job on the database removes
it. Only the deprecated SQLite floor prunes usage rows, after 90 days.

**Every dataset carries the full property, `audit` included.** The audit record was the last
exception: its row carried no conversation mode, so the mask fell back to a Slack id shape and a
Discord or Teams one-to-one conversation was published by id. `audit_entry` now carries
`surface_mode` like the other two tables, and **the report layer reads no id shape at all**. The
column joins the record's hash chain only on a row that carries one, so adding it left every
earlier row's link intact.

(The Slack identity mapper still falls back to the `D` channel-id prefix when an inbound activity
carries no `channel_type`. That sits upstream of the stamp, in the layer that is *entitled* to know
what a Slack id looks like — not in the mask, which never guesses.)

An audit row is stamped only when the turn's binding **resolved** the conversation rather than
gap-filling it. Four classes of row therefore report as `(unclassified)`:

- rows written before the column existed — nothing is backfilled, because the mode was knowable
  only from the turn's binding and no stored row carries one;
- rows from a writer that holds no binding;
- rows whose mode was only a default, never a reading;
- 🔴 **rows from any audit writer other than the per-action tool writer.** Only
  `agent/audit/tool-action.ts` stamps the mode today, so `memory.write`, `egress.policy`,
  `stand_down.*` and most other actions mask their surface. This one does **not** heal as rows age
  out — it is a property of those writers, and OPE-1940 tracks stamping them.

## What you can see — the scope model

Your access decides your scope; the query can only narrow *within* it, never widen it.

| your standing | `scope: "org"` | `scope: "domain"` | `scope: "self"` |
|---|---|---|---|
| **org admin** | aggregates + raw rows + audit `detail`; DM surfaces unmask only when you ask from your own DM | aggregates + rows for the channel's domain | your own rows |
| **domain admin** | refused | aggregates + rows for your domain (no DM surfaces) | your own rows |
| **member** | refused | **aggregates only** for your domain | your own rows |
| **no verified sender** | refused | refused | refused |

"Domain" means a [memory domain](./memory.md) — the channel group you're in. The `org`
value is never part of the query; it comes from the verified surface your message arrived
on, so one tenant can never read another's data by construction (Postgres row-level
security backstops it).

`scope: "self"` means *you on the platform you asked from*, not "everyone anywhere who
shares your id string". The stored principal id is an opaque vendor token, and two
vendors' id namespaces make each other no promises — so the predicate pairs your id with
the **platform of the surface you asked on**, taken from the verified binding rather than
from anything in the request. Without that pairing, a Discord account whose id happened to
spell the same string as a Slack member id would read that person's rows.

One extra belt protects bulk disclosure:

- **Rows mode requires a directly-addressed turn.** An ambient supervisor woken by
  ordinary channel chatter can never bulk-list rows; it degrades to aggregates with a
  visible note.

A turn that ingested untrusted content does **not** change this tool's behaviour. That
asymmetry is deliberate: an analytics read returns data *into the conversation*, and the
consequential actions that could carry it out of the conversation are where the
[approval gates](../security/security-model.md#4-approval-gates-are-governance-not-a-crutch)
sit — gating the read as well would only train reflexive approvals.

Every query — and every refusal — is itself audited (`analytics.query` /
`analytics.refused`), so *who has been querying analytics about whom* is answerable with
the same tool.

## The cost measures, and what a zero means

Two datasets carry cost. Read the measure name before you read the number, because several of them
answer questions that look alike and are not.

**On the `usage` dataset** — one row per model call:

- `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_write_tokens` sum their columns.
- `measured_usd` sums **the gateway's own billed** micros. It is a plain sum rather than a
  host-priced estimate, because re-deriving money that is already money would be a second opinion
  about a measurement. The column is null on every unmeasured row, so the sum treats a null as
  **nothing measured** rather than letting it poison the total.
- `reasoning_tokens` sums the reasoning column, where **unreported is a real null**.
- `reasoning_reported_calls` and `cache_reported_calls` count the calls that reported those
  dimensions at all.

🔴 **The two coverage counts are what make a zero readable.** A cache-token sum of zero does not mean
"no caching happened": the source may have published nothing, or published a zero over a call that
was discounted anyway. Pair the sum with its reported-calls count, or the number says less than it
appears to.

**On the `spend` dataset** — one row per keyed month:

- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `calls` sum the
  ledger's own columns.
- `usd_measured` sums what the gateway billed, and reads **zero on a derived row**. To read drift
  apples-to-apples, compare it against `usd` **filtered to** `cost_source = 'measured'`. Against the
  unfiltered `usd` it under-reads, because that also carries every unmeasured call.
- `reasoning_tokens` sums the ledger's reasoning column. It is **not** coalesced, because the
  ledger's column is not-null with a default of zero on both engines — unlike the usage table, where
  unreported has to stay distinguishable from a reported zero. 🔴 It is an **attribution** count and
  never money: nothing here feeds a dollar figure or a cap.

## What the compiler refuses, and what it clamps

`compileAnalyticsQuery` turns a request into one parameterised statement. Every refusal below names
the valid alternatives in its message, so a wrong query is a correction rather than a dead end.

- **A self-scoped read with no platform** throws rather than compiling. A bare principal id names no
  namespace, so the query would read across platforms. `selfPlatformConjunct` is why: a self read
  always carries **two** conjuncts, the id and the namespace it lives in. The audit dataset has a
  real platform column, and the usage and spend datasets carry the platform as the first segment of
  the surface key, matched as a bound-parameter prefix. 🔴 **A dataset with neither compiles to
  `1 = 0`** — fail-closed, because an unnamespaced self read is the defect.
- **A window wider than 365 days** is refused. Narrow the bounds.
- **A filter dimension, a measure or a group dimension that is not on the chosen dataset** is
  refused, each with the dataset's valid names listed.

Three caps bound the work, and the host applies them whatever the request asks for. Rows mode is
capped at 100 rows **in the query itself**. Aggregate output is capped at 200 groups. The aggregate
scan is capped at 5,000 pre-fold rows, which is what keeps the host-side fold correct **and**
bounded — the cap exists so a fold cannot silently drop groups.

`assembleAnalyticsSql` renders the compiled form to a single parameterised string, in either
placeholder style. Every non-parameter token is registry-derived, and the limit is the one value
inlined as a literal — always a clamped, truncated, non-negative integer.

**Two foldings happen on the host, because the query cannot express them.** `isoWeekStart` folds a
day to the Monday that starts its ISO week. `domainOfRow` folds a row's reconstructed channel key to
a domain name, using the same channel-to-domain map the rest of the system uses. A row whose key
cannot be reconstructed reports `(unassigned)`, and a key that matches no explicit domain falls back
to the `org` pseudo-domain.

`isSummableMeasure` derives summability from the registry rather than from a hard-coded list, so a
newly registered measure is treated as numeric by default instead of silently folding to zero.
`shapeRow` shapes a rows-mode row to the dataset's declared columns, masking the surface and parsing
the audit detail.

**`query_analytics` degrades rather than failing on an ambient wake.** On an ambient, non-addressed
wake it serves aggregates where rows mode was asked for, and **says so in the answer** — so the
reader knows they received a different shape, rather than reading an aggregate as a row list.

### How the query reaches the store

`runAnalyticsQuery` on the operational store executes one compiled read-only query and returns raw
rows keyed by the compiled aliases. The Postgres adapter renders the placeholders and runs it
read-only. The SQLite adapter runs the same compiled query with its own placeholders and needs no
numeric coercion.

🔴 **The compiled `org_id` conjunct is the only tenant isolation this query can rely on.**
`usage_events` selects unconditionally, and both the mutable-table policies and `audit_entry`'s own
policy **permit** while the `app.current_org` setting is unset — which is every shipped deployment.
See [Audit & provenance § Org-partitioned](../security/audit-and-provenance.md#org-partitioned) for
what a deployment that wires that setting changes, and what it must leave unset.

## What you can't ask (yet) {#what-you-cant-ask-yet}

The vocabulary is deliberately small; gaps are small additions, not redesigns. Notably:

- **Silence / "why did it stay quiet?"** — the audit log records *actions only*, so an
  abstention is not a row. A low reply rate is not derivable here; the honest source is the
  [session transcript](../security/audit-and-provenance.md#reading-it), not the absence of
  audit rows.
- **Reaction / feedback and feature-adoption analytics per org** — those live only as
  anonymous instance telemetry by contract, never tenant data.
- **Free-text search, arbitrary joins, raw SQL** — out of scope by design. Org admins who
  need a bulk export or ad-hoc SQL use the control plane, not the chat surface (roadmap).

See [Audit & provenance](../security/audit-and-provenance.md) for the audit record itself,
and [Capability & credential model](../security/credentials-and-planes.md) for how reads
are scoped across the org.
