# Exit and your data

Open Everywhere keeps your data in stores you own: your Postgres database, your Git repository and
the host that serves the agent. This page states what the exit kit does with that data. It covers
four tools: an org export, a per-person erasure, a transcript delete and an org retention setting.
Each section says what the tool reaches and, as plainly, what it does not.

The code is `packages/core/agent/exit/`. The one list of tables the kit knows is
`agent/exit/catalogue.ts`. `npm run test:exit-kit` runs every tool on the sqlite floor and on
embedded Postgres, against session runs written by eve's own workflow world.

## Where your data lives

| Data | Store | Notes |
|---|---|---|
| Settings, access bundles, domains, roles | Your Git repository (`agent/`) | You already hold it. The export points at it and does not copy it. |
| Audit log, routines, grants, approval cards, conversation state | The operational store (Postgres, or the sqlite floor) | 51 tables. `agent/exit/catalogue.ts` says what each one holds. |
| Memory | The memory backing: Postgres, the sqlite file, or a Git working tree | DM and personal memory always sits on a database backing, never in Git. |
| Session transcripts | eve's workflow world | Off Vercel: files under `.eve/.workflow-data` on the host. On Vercel: Vercel's hosted workflow store. |
| Secrets | The operational store, encrypted (`stored_credential`) | Never exported. |

## The org export — `oe export`

```bash
oe export --out ./oe-export --org <org> [--transcripts-dir DIR]
```

The command opens the deployment's own store with `DATABASE_URL`, like `oe secret`. It writes:

- `operational/<table>.jsonl` — every row of every operational table for the org, one JSON object per
  line, with the column names the database uses.
- `memory/<backing>.jsonl` — every memory file, one object per file: `tierPath`, `relPath` and the
  Markdown `content`.
- `transcripts/workflow-data/` — eve's session runs, file for file (`runs/`, `events/`, `steps/`,
  `hooks/`, `streams/`), when the transcripts are on the local world. The copy is the host's whole
  local world: on a host that serves several orgs, it holds every org's runs.
- `transcripts/sessions/<id>.jsonl` — when the command finds no workflow directory and can read
  through the deployment (see below): one session's events, one JSON object per line (`index`, `at`,
  `type`, `data`, in eve's own event shape).
- `manifest.json` — the format version, the row count per table, a sha256 (see below), the result of
  an audit-chain walk from genesis, and the list of what is not in the export.
- `README.md` — how to read the rest.

JSON Lines and Markdown are open formats. You need no Open Everywhere code to read them. The audit
log is `operational/audit_entry.jsonl`: each row's `prev_sha` is the sha256 of the row before it, so
you can repeat the chain walk on the export.

**Not in the export:**

- **Secret values.** The `stored_credential.ciphertext` column and the identity-link nonce hashes are
  written as `[secret — not exported]`. The secret names, connectors and owners are exported.
- **Config.** Settings, bundles, domains and roles are in your Git repository.
- **Each transcript the command could not read.** The manifest lists each one under
  `transcripts.unreached`, with the reason, and the README says how many. See below.
- **Git history of a Git memory backing.** The export reads the working tree. Earlier versions stay
  in that repository's history, which you already hold.
- **Memory on a GitHub or Notion backing.** Those files live in your own GitHub or Notion workspace.

**Transcripts on Vercel (OPE-2561).** On Vercel the transcripts are in Vercel's hosted workflow store.
This command cannot list that store, so it accounts for the sessions that the org's operational rows
name: the usage and tool-call ledgers, the soak captures, the turn anchors and the status lines. A
session that no row names is not in that list. When the command finds no workflow directory, it reads each of those
sessions through the deployment's own transcript route,
`GET /control/v1/session/:sessionId/transcript`. It uses the deploy plane's names, the same ones that
`deploy:smoke` and the `session_transcript` tool use:

- the token: `OE_DEPLOY_CONTROL_TOKEN`, else `E2E_CONTROL_READ_TOKEN`. Its sha256 must be in the
  deployment's `OE_CONTROL_READ_TOKENS`;
- the deployment: `E2E_TARGET_URL`, else `OE_DEPLOY_BASE_URL`, else `https://$OE_DEPLOY_ALIAS`.

Each read writes one `control.service_call` audit row on the deployment, as every read of that route
does. The manifest's `transcripts.store` is then `deployment`. The manifest names each session the
route could not read, with the reason:

- the deployment holds no such session (it expired, or the store's retention removed it). The command
  goes on with the next session;
- any other failure (a refused token, a disarmed read plane, the network). The command stops reading,
  and names that session and every later one with the same reason.

A read that returns no event at all writes no file, and the session is named as not reached. A read
that ends before a terminal event (the session is parked or still running, or the route stopped after
1.5 s with no new event) writes what it read. The manifest lists that session under
`transcripts.incomplete`, with the event count.

With no token or no deployment URL, the command reads nothing, names every session, and the reason
says which names to set. The command prints how many sessions are not in the export, and exits 0.

**The digest.** The manifest's `sha256` covers, in the order the export wrote them: each non-empty
table file's name, then its bytes; each `memory/<backing>.jsonl` file's name, then its bytes, also when
that file is empty; for a local transcript copy, `transcripts/workflow-data`, then the run count as a
decimal string (those transcript files are counted, not hashed); and for transcripts read through the
deployment, each `transcripts/sessions/<id>.jsonl` file's name, then its bytes.

**The export reads in pages (OPE-2574).** No database read returns a whole table. Each table, the
audit chain and the memory files on a Postgres or sqlite backing come back in pages of at most 1,000
rows. A Git memory backing reads its working tree from disk. On Postgres, a page also stops
at 8 MiB: the store first reads the size of each row, then reads only the rows that fit. A hosted
driver can cap one response (Neon's HTTP driver refuses one over 64 MiB), so a large store still
exports. A single row wider than 8 MiB comes back alone. A row wider than the driver's cap cannot
come back through that driver at all. The sqlite floor reads in process, so it pages by rows only.

The export writes one `exit.export` audit row with the counts and the digest.

## Per-person erasure — `oe erase`

```bash
oe erase --person slack/T0123/U0456 [--dm slack/T0123/D0456] [--box-backend vercel|docker] --yes [--transcripts-dir DIR]
```

The person is a principal key: `platform/id`, or `platform/workspace/id` on Slack and other
tenant-scoped platforms. The command refuses to run without `--yes`. Run `oe export` first if you
need a copy.

**First, the erasure ends the person's authority (OPE-2560).** Before it deletes a row, `oe erase`
runs the same levers the agent runs, so it writes the same audit rows:

- **A confirmed account on a live link-set:** the `revoke_link_set` lever. It tombstones every account
  on the set, purges the credentials stored against the set and against each account, revokes every
  credential grant a confirmed account lends, and forgets each confirmed account's personal browser.
  It writes `identity.link.revoked`.
- **An account on a set that is already revoked:** the `purge_link_set_credentials` lever (it writes
  `identity.link.credentials_purged`), then the grants and the browser of the account you named.
- **A suggested account, no link-set, or a row whose set no longer exists:** the account's own
  credentials, grants and browser. A suggested row is an unproven claim that the set is this person,
  so the erasure does not revoke the set on it.

The `exit.person_erased` row records what ended (`linkSet`, `accountsRevoked`, `credentialsPurged`,
`grantsRevoked`, `browsersForgotten`, `authorityFailures`, `revocationsFailed`). `authorityEnded` is true
only when every lever ran with no failure. The report prints the counts on the "Ended first" line.

**How the command reaches the credentials and the browser.** The deployed agent registers the
credential-purge hooks and the box backend at boot. The operator process registers neither by itself,
so `oe erase` loads them from the `@open-everywhere/adapters` package that every app installs. Run
the command from the app's root after `npm install`. Without the package, the command stops before it
changes anything.

- **Credentials.** The `oe-oauth` and `aws-sso` purge hooks run. The operator process loads no
  connection module, so the `oe-oauth` hook finds the person's tokens by their stored ref. A token is
  revoked at the provider when the stored client names a revocation endpoint (a discovered server).
  **A revocation call that fails is a recorded failure (OPE-2565).** The holder tries the call once
  more. If the second call also fails, the command still deletes the token from the vault, because a
  provider that is down must not keep a secret at rest with us. The token then stays valid at the
  provider until it expires, so the report prints the provider's name as a failure, the command exits
  1, `revocationsFailed` counts it and `authorityEnded` is false. A re-run cannot revoke it, because
  the vault row is gone: remove the app's access in the provider's own settings to end the token now.
  `oe erase` never reports an IdP grant this way, because it cannot revoke one (see below). The revoke
  lever in the deployed agent, which declares the `xaa` connections, reports a refused IdP revocation
  as `idp:<issuer host>`.
  A static client's secret lives in its connection declaration, so its token is deleted from the vault
  but not revoked at the provider. The token stays valid at the provider until it expires. A person's
  IdP grant for `xaa` connections is also deleted from the vault but not revoked at the IdP, because
  the IdP client lives in the connection declaration. It stays valid at the IdP until it expires. Such
  a token is not a failure, because no revocation call was possible: `authorityEnded` means that every
  lever ran and every revocation call that ran succeeded, not that every token is dead at its provider.
- **The saved browser profile.** Name the deployment's box backend with `--box-backend vercel` or
  `--box-backend docker`. The command does not guess it, because a laptop cannot tell which backend the
  deployment runs on. A wrong guess would delete the browser record and leave the profile, with the
  person's logins, on the real backend. `vercel` uses the Vercel Sandbox SDK, which reads its own
  credentials from the shell (for example, after `vercel env pull`). `docker` must run on the host
  that serves the agent, where the profile's volume is.
- **With no `--box-backend`, the command changes nothing when a profile exists.** It first checks
  every account the levers would reach: on a revoke, every confirmed account on the set. If any of
  them has a saved browser record, it revokes, purges and erases nothing, names the accounts, and
  exits 1. Run it again with the flag. It refuses instead of going on because the revoke ends the
  other accounts' holdings only once: after the set is revoked, no lever reaches their browsers
  again.

A failed step after that check does not stop the erasure. The rows it deletes grant nothing, and the rows a lever needs
(the linked accounts, the browser record) are kept. The report names each step that failed, and the
command exits 1. Run `oe erase` again for the same person to finish the named account's steps. The
revoke ends the other accounts' holdings only once, so a holding that failed on another account of
the set is not reached by that re-run. The re-run names each such account. End its holdings with
`oe erase --person <that account>`. The tombstone flips every account on the set to `revoked`, so the
command reads the `identity.link.confirmed` audit rows to tell which accounts were confirmed. An
account that was only ever suggested onto the set may be another person: the revoke left its holdings
alone, and the report lists it as "left alone", not as a failure. Erase it only after you establish
that it is the same person. The check reads every `identity.link.confirmed` row of the set, at any
size of the audit log: the store filters the rows by the set's id before it reads them (OPE-2565). A
confirmation whose audit row is missing (the audit append is best-effort) reads as suggested: its
holding is still listed, but as "left alone".

**What the erasure removes:**

- The rows the catalogue matches by the person's id: the watch and cover records, status lines, the
  words of repeated questions, memory proposals, DM rules and the proactive address. Where a table
  names the platform (status lines), the person's bare id matches only on their own platform. Where it
  does not, the bare id matches on its own, so two platforms that issue the same bare id would both
  match.
- Every row keyed to one of the person's DM rooms: the conversation tail and DM summary, routines set
  up in the DM, and soak captures. The DM rooms come from the person's DM rules in the
  store, plus each `--dm` room you name. The report warns when it finds none.
- The personal memory of those DM rooms, on the database backing.
- The session transcripts that are the person's alone: a DM session, or a session whose every model
  call the usage ledger attributes to the person. Only on the local world: on Vercel's hosted store,
  see the backing table below.

**What the erasure keeps, and why:**

- **The append-only rows.** The audit log, the usage and tool-call ledgers, and the skill and prompt
  histories are append-only. On Postgres, FORCE ROW LEVEL SECURITY refuses the delete, and the audit
  log is hash-chained. These rows carry the person's platform id. The usage and tool-call ledgers
  record counts, models, tool names and outcomes. The audit log records the facts of each action, such
  as tool names and short summaries.
- **Shared session transcripts.** A channel conversation that other people took part in is their
  record too. The command lists these sessions. Delete one with `oe transcript delete` if you decide
  to.
- **Spend counters.** They hold token and cost counts per person and month.
- **Facts about the person in shared memory.** Memory bullets carry no author, so the erasure cannot
  find them by id. Remove them with Forget (the purge card) or by an edit to the memory.
- **A live session.** Deleting the files under a running session corrupts it. The report counts the
  live sessions it left. Run the erasure again after they finish.
- **The last event an event routine matched.** An event routine keeps the last event its trigger
  matched on its own row (OPE-2540), so a test run can replay it. The kept event holds the event's kind,
  scope, matchable fields and one-line summary. Those can carry the person's handle (for example a
  GitHub `sender`) or the title they wrote. The erasure removes it only with a routine in the person's
  own DM room. A later match that the routine may read often replaces it, but not always: the
  routine tries to keep at most one event a minute, and a match that the read grant refuses, a match
  too large to keep, or a failed write leaves the old one in place. Only deleting the routine removes
  it for certain.
- **Columns that name the person as the actor on another record**, such as `created_by`, `set_by`,
  `decided_by`, `engaged_by` and `established_by`. The catalogue does not match them.
- **Rows that protect the person or the system.** These name the person, and deleting them would do
  harm. `agent/exit/catalogue.ts` marks each one `keptOnErase` with its reason, and the report lists
  them:

  | Table | Why it stays |
  |---|---|
  | `person_opt_out` | It is the person's own opt-out. Deleting it would let the agent act on their content again. |
  | `dm_audience` | It holds the person's stop of proactive DMs. Deleting it would let the agent start a DM with them again. |
  | `pending_actions` | A decided card is the approval record the audit story relies on. A decided connector card's stored input is already dropped (OPE-2390). |
  | `credential_grant` | `oe erase` revokes every live grant the person lends first. A revoked or spent row keeps a once-only grant single-use. |
  | `credential_grant_ask` | A decided ask is the record its grant was minted from. |
  | `identity_linked_ids` | When the person's account is confirmed on a link-set, `oe erase` revokes the set first and reads these rows to end their credentials, browser profile and grants. The tombstoned rows stay as the revoke's record, and they stop the accounts being linked again. A suggested row, or a row whose set is gone, stays as the record of an unproven claim. It grants nothing, because only a confirmed row resolves. |
  | `personal_browser` | `oe erase` forgets the browser first, which deletes this row with the saved profile. The row stays only when the forget failed, because it is the only record of where the profile is. |
  | `identity_link_challenges` | A spent challenge stops a used link code from being claimed again. |
  | `credential_intake` | A spent "set a key" request is a single-use token, and it holds no content. |

**A library caller ends authority itself.** The `erasePerson` function (`agent/exit/erase.ts`) only
deletes data. `oe erase` calls `endPersonAuthority` (`agent/exit/authority.ts`) before it. A caller
that runs `erasePerson` alone gets `authority: null` in the report and `authorityEnded: false` on the
audit row, so the gap is visible.

**Run it with the owner credential.** The erasure deletes from some tables the runtime role holds no
DELETE on (memory proposals, the watch and cover records, the proactive address). With the two-role
split's runtime `DATABASE_URL`, those tables are refused: the report names them, the command exits 1,
and every other table is still erased. Run it again with the owner `DATABASE_URL` to finish.

**What erasure means on each backing:**

| Backing | Effect |
|---|---|
| Postgres (hosted or embedded) | The rows and memory files are deleted. The database's own backups and point-in-time recovery still hold them until those age out under your provider's policy. |
| sqlite floor | The rows and memory files are deleted from the file. Copies of the file are not touched. |
| Git memory | DM memory never lands in Git. A shared Git memory tier is not touched by the erasure. |
| Local workflow world | The run's files are deleted: run, events, steps, hooks and streams. |
| Vercel hosted workflow store | Not deleted. The store offers no delete call: eve's workflow `World` interface (eve 0.71) can list and read a run, but cannot delete one. The report names each of the person's own sessions that stays, with the reason, and the audit row counts them as `transcriptsUnreached`. Vercel's own retention applies. |
| A deployment that swapped in another workflow world (for example `@workflow/world-postgres`) | Not reachable. The transcripts are in that world's own tables. |

The erasure writes one `exit.person_erased` audit row. The row names the person only by the sha256 of
the principal key, and it holds the counts per table, never an erased value. The hash is unsalted:
anyone who holds the person's id can match it. It is a lookup key, not anonymisation. The row appends
to the chain like any other row, so the chain stays verifiable after the erasure.

## Delete one transcript — `oe transcript delete`

```bash
oe transcript delete wrun_01ABC… [--transcripts-dir DIR]
```

The session id is the `wrun_…` id that audit rows carry as `sessionId`. The command deletes the run's
files from the local world and the soak captures recorded for the same session. It refuses a run that
is still going, and a run whose record is unreadable or missing, because then nothing proves the run
finished. It writes one `exit.transcript_deleted` audit row. Off the serving host (for example against
a Vercel deployment) the command refuses, exits 1, and says that the session is NOT deleted and why.
No command can delete a transcript on Vercel's hosted workflow store, because the store offers no
delete call.

**Run it on the right host.** A laptop is off Vercel even when the deployment is on Vercel. So the
operator commands never guess where the agent's transcripts are. They use `--transcripts-dir` when you
give it, else `./.eve/.workflow-data` when that directory exists, else none. Each report prints the
directory it used.

## The org retention setting

Two settings in `agent/settings/settings.ts` age data out. The daily tidy pass (04:00 UTC) applies
them.

| Setting | Default | What it ages out |
|---|---|---|
| `retention.sessionTranscriptDays` | 90 | Finished session transcripts on the local world, by their last activity. A live run is never touched. |
| `retention.storedStateDays` | 90 | Conversational state: conversation tails and DM summaries, job results, Slack file links, captured webhook bodies, status lines, the words of repeated questions and soak captures. |

`0` keeps that data. The 90-day default matches `spend.usageEventsTtlDays`, the retention window the
settings already shipped.

The sweep never ages out the append-only rows, memory, config, routines (with the last event an event
routine matched, which only deleting the routine removes for certain), grants, decided approval
cards, memory proposals or meeting data. Meeting data expires by its own clock, and it holds
long-lived provenance marks that keep a meeting recap's text marked as untrusted. The sweep runs in the deployed process, so it ages only the tables the
runtime role may delete from; `npm run test:exit-kit` holds that rule. Each run
writes one `exit.retention_swept` audit row per org with the counts, so a day with nothing to age out
still shows that the sweep ran. On Vercel the transcript half cannot reach the hosted store, and the
row says `transcriptStore: "hosted"`.

## Related

- [Audit & provenance](./audit-and-provenance.md) — the hash chain the erasure keeps verifiable.
- [Memory](../capabilities/memory.md) — the backings, and Forget.
- [Configuration reference](../deploy/configuration-reference.md) — every setting, generated.
