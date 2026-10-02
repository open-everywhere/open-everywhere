# Memory

How Open Everywhere remembers things per team: opt-in **domains**, each backed by
one or more named **silos**, all reached through file tools and never dumped into
the model's context.

Memory is **opt-in and explicitly controlled**. There is no automatic
`org → workspace → channel → DM` tier stack that conjures a separate brain for
every channel. You declare *where* memory lives and *who shares it*, and the agent
only ever sees the slice that belongs to the channel it's answering in.

## The mental model: domains and silos

Two declarations carry the whole system.

- A **domain** is the anchor. It names the channels that feed it and the memory
  silo(s) it reads and writes. (What those channels are *allowed to reach* is not a
  field here — an [access binding](../how-it-works/access-and-scoping.md) names the
  domain instead.) A domain is the
  unit — it is not reusable, and a **channel belongs to at most one domain**
  (enforced at config load). That single rule kills the "which silo does this note
  go to?" ambiguity: a new note has exactly one home.
- A **silo** is a named, reusable backing — the durable place a domain's memory
  lives. A silo is referenced by name, so **many domains can point at the same
  silo**, and a silo referenced by N domains is genuinely **one brain**: written
  once, read by all.

```ts
defineDomain({
  name: "transactions",
  reach: ["slack/T/A", "slack/T/B"],      // exclusive — one domain per channel
  memory: ["transactions-silo", "org-baseline"],
})
// Capability is bound, not declared here:
//   defineBinding({ bundle: "transactions-tools",
//                   scope: { level: "domain", domain: "transactions" } })

defineMemorySilo({
  name: "transactions-silo",
  provider: "github",                 // postgres | sqlite | github | notion
  container: "engineering-memory",    // repo (github) | parent page (notion) | db
  path: "memory/transactions",        // subtree within the container
})
```

Resolution is **one hop**: a channel resolves to its domain, the domain resolves to
its silo(s) and bundle. No inheritance, no walking up a tree.

The same `reach` list also takes **containers** — a whole tenant, or a same-level glob — so you
need not list 500 repos by hand:

```ts
defineDomain({
  name: "platform",
  reach: ["github/acme"],        // every repo under this owner, incl. ones created later
  memory: "platform-silo",
})

defineDomain({
  name: "payments",
  reach:   ["github/acme/payments-*"],       // just the payments repos…
  exclude: ["github/acme/payments-secrets"], // …but never this one
  memory: "payments-silo",
})
```

**Most specific wins.** An exact key beats a container; a longer container beats a shorter one.
So `payments` above takes the payments repos even though `platform` reaches the whole owner, and
naming one repo outright in a third domain takes it from both — no exclusion needed. `exclude`
is for the other job: carving a surface out of **that** domain. It is a veto on one domain, not on
all of them — another domain that reaches the same key still takes the surface.
Resolution is still one hop and still lands on at most one domain — two entries that reach
exactly the same keys are refused at config load, because nothing can order them.
See [Access & scoping](../how-it-works/access-and-scoping.md#reach-exact-keys-and-containers)
for the full rule (including a worked 500-repo example), and why a container is a capability
grant rather than a privacy boundary.

Threads count as their channel. On Slack that's automatic (a thread shares the
channel's key); on **Discord**, where a thread is technically its own channel id,
Open Everywhere resolves the thread's **parent channel** for domain membership (and
spend caps) — list the channel in `reach:` and its threads follow. The thread
keeps its own conversation (session + per-thread notes); see the
[Discord surface guide](../deploy/surfaces/discord.md#auto-thread-mention-conversations).

The domain is also where per-channel-group *behaviour* settings live — e.g.
`nameDropWake: true` lets the agent give a judged reply when a top-level Slack
message says its name without @mentioning it (off by default; see the
[Slack surface guide](../deploy/surfaces/slack.md)), and `models` routes which
model (and reasoning effort / gateway provider pin) a group's sessions use —
set a workspace default on the `org` pseudo-domain and override per group; see
the [configuration reference](../deploy/configuration-reference.md#memory-domain--silo).

Domains and scoping are the same spine the access resolver runs on — see
[Access & scoping](../how-it-works/access-and-scoping.md). For the vocabulary in
one place, see [Core concepts](../introduction/core-concepts.md).

## Multiple silos, one composition

A domain's `memory` is a single name **or a list**. Each silo in the list
materialises into its **own** directory in the sandbox — `memory/transactions-silo/`,
`memory/org-baseline/` — so they co-exist with no merge and no precedence: the same
filename in two silos is simply two distinct paths. Reads come from every silo in
the list; **writes go to the non-read-only silos** (a worker edits their files directly, and
every writable silo is persisted when the work is handed back — see
[the capture seam](#writing-memory-files-not-a-verb)). On a delegating conversational seat
the write itself runs in a worker — the seat hands the fact off — but it lands in the same
silo wherever it runs.

Backings compose freely — a domain can read a read-only Notion baseline, write its
own learned notes to a GitHub silo, and share an `org-baseline` Postgres silo with
ten other domains, all at once.

### `includeOrg` — share the org baseline without re-listing it

Rather than re-list the org silos in every domain, a domain can pull the `org`
pseudo-domain's silo set in as one auto-tracking unit:

```ts
defineDomain({ name: "transactions", reach: [...], memory: "transactions-silo",
               includeOrg: "readonly" })
```

`"readonly"` includes the org silos here forced read-only (read company knowledge,
don't write it); `"inherit"` includes them with their native read/write so a domain
can contribute to a deliberately-writable company-wide silo. Because memory resolves
fresh each session, changing the `org` domain's silo list updates every
`includeOrg` domain automatically — there is no copy to keep in sync.

## Criteria pseudo-domains: `org`, `public`, `dm`

Three optional fallback domains are selected by **trust/mode** instead of a channel
list. Each is off unless you define it, each is a singleton, and each carries the
full domain toolkit (multiple silos, per-silo read/write, `includeOrg`) and can be
named by an access binding like any other domain.

- **`org`** — the catch-all for internal channels in no explicit domain. An
  unassigned channel is *unknown trust*, so it gets a shared brain only when you opt
  in. A read-only curated baseline is the recommended default, but it's the silo's
  own `readOnly` flag — you can mix a read-only baseline with a deliberately-writable
  org silo. An explicit domain does **not** auto-inherit `org`; to share it, list its
  silos or use `includeOrg`.
- **`public`** — the destination for external/guest channels and external DM
  partners. **Read-only by construction**: external sessions never write shared
  memory. Empty unless you curate it (e.g. a read-only "how we work with partners"
  silo). It's the *only* shared memory an external session can reach.
- **`dm`** — the shared **read** layer for an internal DM partner, stacked on top of
  the always-present personal silo (below).

These are not the rejected auto-stack — each is one explicit, optional,
criteria-selected domain. `org` as a *partition* (the `org_id` isolation wall) is
unrelated; the `org` pseudo-domain is configured content, not an inferred level.

## DM and personal memory

A one-to-one DM always gets a **per-user, DB-backed personal silo** — read-write, isolated
per principal, never written to git or Notion by construction. A **group DM** is not a DM here:
it is execution-only and resolves to no memory at all, personal silo included. On top of that, an
**internal** DM partner reads the `dm` pseudo-domain's silos (commonly just the org
baseline via `includeOrg`), **read-only**; an **external** DM partner reads `public`
instead. The personal silo is the only *writable* memory in a DM, and it exposes
nothing internal either way.

## The trust gate (the security keystone)

**Internal memory requires internal trust.** This is a hard, fail-closed, *runtime*
gate — the single most important safety property of the memory model, because
surfacing internal memory to an outsider is a serious leak.

A channel is **external** when it is externally shared (Slack Connect / shared /
org-shared, and the Teams/Discord equivalents) **or** has guest / external
members (restricted, ultra-restricted, or stranger accounts). An external channel
reads only `public` and writes nothing shared. If no `public` domain is configured,
it gets no memory at all.

Config can never override this. A channel explicitly listed in an internal domain
still routes to `public` the moment it becomes externally shared or a guest joins —
the gate is re-evaluated **per session**, so a sharing change after config time is
caught. There is no "admit this external channel" escape hatch.

DM partner trust is the same gate applied to a 1:1: a full workspace member is
internal; a guest, a Connect stranger, a different workspace, or a failed lookup is
external (**fail-closed**). On Slack this is positively verified per session via a
cached `users.info` lookup. Other surfaces have no partner lookup yet and **fail closed to
external** for DMs. The per-user personal silo is granted regardless.

A **routine firing in a DM** is checked the same way, against the person who created
it. There is no human sending a message on an unattended fire, so the partner it
verifies is the routine's recorded creator, and it verifies them **on every single
fire** — nothing about standing is stored on the routine. A routine armed by a current
member therefore reads exactly what that person's own DM reads, including the org
baseline; once they leave, are downgraded to a guest, or move workspace, the very next
fire resolves `external` and the shared layer drops away, with the personal silo
untouched. Being attributed to someone is **not** the same as acting as them: the fire
is recorded and billed under its creator, and holds none of their admin standing or
personal connector access (see [Access & scoping](../how-it-works/access-and-scoping.md)).

**Guest / external-principal detection** is the same demotion applied per acting
principal on every surface: a detected guest **overrides an operator vouch** and routes
to `public`, exactly as a restricted Slack DM partner does. Each platform reads the
strongest signal it has, cached like Slack's `users.info` (same TTL), and **fails toward
external** when the signal is unavailable — never inventing a policy the Slack path
doesn't already use:

| Platform | Guest / external signal | Source |
| --- | --- | --- |
| **Slack** | externally-shared channel; restricted / ultra-restricted / stranger DM partner | `conversations.info` / `users.info` (cached) |
| **Teams** | tenant `userType` / roster `userRole` **= guest** (cross-org B2B account) | Bot Connector roster (cached); no Graph app needed |
| **Discord** | `member.pending` — membership-screening / verification **incomplete** | interaction / gateway payload (free; no privileged intent) |
| **Linear** | `User.guest` — org-external collaborator, not a full workspace member | GraphQL (cached) |
| **GitHub** | public repo, or a non-member/outside author association | webhook `author_association` |

For Teams, Discord and Linear a positively-detected guest is the demotion trigger;
being a member is **not** itself proof of internal trust (a public Discord guild or a
multi-tenant Teams deployment is full of strangers), so an un-vouched surface still
**fails closed to external** — internal trust comes from the channel verdict or an
operator vouch, never from bare membership. What each signal proves and does **not**
prove is documented at its resolver (`teamsTrust` / `discordTrust` / `linearTrust`).

The same posture is described from the access side in the
[Security model](../security/security-model.md).

## Backings: where memory physically lives

A silo's `{ provider, container, path }` is vendor + container + subtree. Five
backings exist today:

| Provider | Class | Role |
| --- | --- | --- |
| `git` | first-party (core) | The default when the deployment sets no `OE_MEMORY_PROVIDER` **and** no `DATABASE_URL`: a local git store. With a `DATABASE_URL` present the default is `postgres` (OPE-2230). |
| `postgres` (Neon) / `sqlite` | first-party (core) | The DB backings; DM/personal memory always lands here. |
| `github` | connector-owned (github bundle) | A repo subtree via the GitHub Contents API (reuses the source-control plane). |
| `notion` | connector-owned (notion bundle) | A Notion page subtree, materialised to Markdown (a read-only hot-cache by default; append-only write-back when the silo's author opts in). |

**A first-party backing's "connection" is the deployment identity** (`DATABASE_URL`, the sqlite
path) — the deployment holds the credential, so there is nothing to grant. **A connector-owned
backing rides the domain's connector access**: it lives in the provider package beside the
connector that already reaches the source, declares a memory capability on it, and is subject to
the **prefetch invariant** — a domain may project exactly what its connector grants reach, and a
silo naming a connector the domain doesn't hold, or a container outside that grant (a `github`
silo on an ungranted repo), is a **fail-loud config error at load**, not a runtime surprise. A
shared brain is always materialised with the connection's **app-principal** credential, never a
user-subject OAuth token. Full detail — including the three declarable modes — in
[Memory backings](../extending/memory-backings.md#connector-owned-memory).

**The agent never sees the backing.** At session start the host reads only the
resolved domain's files and materialises them into plain Markdown under
`/workspace/memory/<silo>/`. No repo checkout, no path, no credential ever enters
the sandbox — so "hide the rest of the store" is automatic: there is nothing to
hide. When the work is done the host reads each **writable** silo's directory back and
persists it; read-only silos are never written back.

**A citation renders as its silo-relative path, never the sandbox mount.** When the
agent cites a memory file it read, the reply choke point truncates the sandbox
mount prefix (`/workspace/memory/`, with or without a `file://` scheme) down to
`<silo>/<path>` before the text reaches a member — plain text, never a link. The
mount is real only inside that turn's ephemeral sandbox; the silo-relative path is
the stable, durable referent, since the silo persists across sessions even though
the mount does not.

**A session cannot destroy a silo on the way out.** That capture-seam persist is the
whole memory write path, with no confirmation card in front of it — deliberately, because a
write that waits on a click nobody gives is a write that never happens. Any session holding
the sandbox file tools (a delegated worker, for instance) could otherwise rewrite the whole
brain on its way out. Three things stop it. Persist is a **union** over what the store
already holds, so a file deleted inside the sandbox is never deleted from the store; a
**destructive-write floor** refuses an overwrite that drops more than half of a file's
existing lines **and at least three of them**, so a small subtraction always lands; and the
lines a persist *does* remove are recorded in the `memory.write`
audit row by **SHA-256 and length, never by content** — so a deletion is attributable and
verifiable after the fact without the audit log becoming the place erased data survives. The
row records up to 50 removed lines; past that it keeps the total count and marks itself
truncated.
Adding, reordering and ordinary editing all land as normal — only genuine subtraction is
refused. When the floor fires, the store keeps its own copy, the session's version is parked
alongside it as `<file>.rejected-<session>.md` so a human can promote it deliberately, and a
`memory.write_refused` row lands in the audit log.

The full backing matrix — the `MemoryProvider` interface, per-silo selection, and
how to add a backing of your own — lives in
[Memory backings](../extending/memory-backings.md).

An org admin can inspect and, if needed, directly edit any silo's files — list every
silo they're allowed to see, read one file, or write/delete one — through the control
plane's MCP, no database console required. See
[The control plane: Memory-admin](../security/control-plane.md#memory-admin-inspecting-and-editing-the-org-brain-without-sql).

## Memory content is reached through tools, never injected into context

No memory content is poured into the model's prompt. The agent discovers and reads it the way an
engineer reads a repo. The **index** is the one exception, and it carries no content: the host
renders the same table of contents described below into the seat's system prompt each turn, so a
seat knows what exists before it reads anything.

At session start the host also writes that **top-level index** at
`/workspace/memory/MEMORY.md` — a table of contents listing every silo in this
channel's plan, each silo's one-line purpose, its source label, and how to reach it
(a file directory to read, or, for a hot-cache, the skill that updates it). The base
instruction tells the agent to read that index first, then read or grep the topic
files it needs.

A silo is **self-describing**: it carries `description` (a stable one-line purpose,
surfaced in the index), an optional `skill` (the verb that teaches how to update
the source), and its mode flags. The index is generated entirely from the silo
definitions, so it carries what the filesystem can't — purpose, source, and update
route.

## Writing memory: files, not a verb

That top-level index is about *silos*; each silo also has its own **`MEMORY.md`**, a curated
table of contents beside its topic files.

**There is no save verb.** The agent writes memory the way it writes any file: a worker edits
`/workspace/memory/<silo>/…` with ordinary file tools, and the host captures the whole writable
tree, merges it over whatever the store holds by
then, and audits each silo's write. Correcting a fact is the same act as adding one — edit the
line. Nothing gates an ordinary memory write, which is the point: a correction that waits on an
approval click nobody gives is a correction that is silently lost.

**A save SUPERSEDES the section's previous statement of the same subject — it does not stack.**
Editing the line is the correction, so a second line stating the same fact is not a correction at
all: it is a pair the next reader has to choose between, and the reader chooses wrong. Measured on
the e2e `S-MEM-READ` leg of a live run: the pack seeded `the OPE121 canary code is obsidian-NNNNN`
into one silo on every board and removed none, so the silo held several. Asked what the files say,
the seat answered with a previous board's value and called the tree "inconsistent". The write was
correct and the read was correct; the stack was the defect.

**The writer applies the rule, because the writer is the only thing that knows the fact.** The
memory index carries it in the clause that names the write path
(`packages/core/agent/memory/listing.ts`), including inside the brief a delegating seat hands its
worker — so every writer reads it, in every silo, on the session it is in. A silo seeded **from now
on** also carries it in its own `MEMORY.md` (`seedFor`, `packages/core/agent/memory/layout.ts`).
🔴 That seed runs only on an EMPTY tier — `ensureTier` returns the existing map the moment it has
keys (`packages/core/agent/memory/store.ts`) — so a silo that already exists keeps its old on-disk
file and never gains the sentence. For those, the index is the only copy. An
[append-only silo](#opting-a-notion-silo-into-write-back) is told neither rule: it refuses an edit
above the last line, so that instruction would name a save its own persist then drops.

🔴 **The host does NOT decide "the same subject" by similarity, and the measurement is why.** The
obvious mechanical rule — score a new bullet against the existing ones and rewrite the close one —
**deletes live facts**. The repo's own word-overlap kernel (`contentWords` + `jaccard`,
`packages/core/agent/memory/dream/ops.ts`) keeps only tokens longer than three characters, minus
stopwords, so the discriminator between two facts is usually exactly what it drops. Measured on that
kernel at the time of writing:

| Pair (dates stripped) | Score | What it is |
|---|---:|---|
| `Kim joined the billing team` / `Tom joined the billing team` | 1.00 | two facts |
| `the release cadence is every 30 days` / `… every 60 days` | 1.00 | one fact |
| `the prod database lives in us-east-1` / `the dev database …` | 0.75 | two facts |
| `recurring workflow — deploy site staging` / `… deploy production site` | 0.71 | two workflows |
| `payments use stripe` / `payments use adyen` | 0.33 | one fact |

The two classes overlap completely, and the false-positive class reaches 1.00, so no threshold
separates them — `dream/ops.ts` says as much where it declares `factTokens`. Substituting that
stricter token set does not separate them either. This is also why the rule would contradict the
plane's own posture: a same-polarity, high-overlap pair is a **`consolidate`**, one of the
[`DESTRUCTIVE_KINDS`](#what-the-dream-cycle-may-do-by-itself) the dream cycle only ever **proposes**
for review, at a stricter bar than any auto-apply could use.

**So every host road that supersedes keys on an EXACT identity.** The dream cycle's recurrence
enrichment writes `RECURRING.md` through `supersedeUnderSection`
(`packages/core/agent/memory/markdown.ts`) with the bullet's **workflow signature** as the key
(`enrichmentSignatureOf`, `packages/core/agent/memory/dream/learn.ts`). A byte-equal signature is
the same workflow by construction, so a re-delivered enrichment updates its own count instead of
duplicating itself. A bullet with no signature — every distilled fact — and every signature not
already present both **append**, exactly as before. The `memory.write` row counts what it rewrote
(`superseded`), because the row's file and version counts cannot tell a rewrite from an addition.

**The newest statement of a fact is the current one.** Where two lines about one subject do stand,
the date stamp settles them — the later line is the current value, and the pair is not a conflict to
report. Both recall leads in the memory index say so, and so does a silo seeded from now on, for the
reader who opens the file without the index in front of it (with the same empty-tier bound as
above). The rule stops where the
ordering does: bullets are day-granular, so a pair sharing one date, or carrying no date, is
reported as a disagreement rather than resolved by picking. A seat with no recall route is told none
of this: it reads nothing, so a rule for resolving what it found would be a dead affordance.

**A write outside this conversation's own silos is refused, in the same turn.** The capture reads
the silos this conversation resolved — nothing else. So a write into any other directory under
`/workspace/memory/` would look like it worked and then reach no store. The write tool refuses that
call instead, and the refusal names the silos this conversation *can* write. This is the same
fail-loud rule a [read-only silo](#notion-a-read-only-hot-cache-by-default) follows, for the same reason:
silently dropping a memory update is a lost memory update. Three cases refuse:

- **A silo this conversation does not have.** Usually a worker that is confused about which channel
  group it is in, or one that was handed the wrong group. Both are worth saying out loud, so the
  write is refused rather than re-filed under a heading nobody chose.
- **A read-only silo** — a curated baseline, or a Notion cache. The refusal names the update route
  that does save (the source's own tools for a cache, a writable silo for a baseline).
- **The top-level `MEMORY.md` index**, which the host rebuilds every session from the silo list.

**A shell command takes the same answer, from the filesystem rather than the tool.** The refusal
above reads the write tool's own path, and a shell command is not read. So the memory directory
itself is made unwritable once the conversation's silos are in place — not the silos, only the
directory that holds them. Adding a new entry there needs write on that directory, so
`mkdir memory/<some-other-silo>` fails on the spot, while editing and adding files inside a silo the
conversation *does* have is untouched. The failure the agent sees is a permission error rather than
the write tool's sentence, which is why the tool's refusal is still the one that names the route.

This is a guardrail, not a wall: the sandbox files belong to the same user the agent's shell runs
as, so an agent that sets out to defeat it can. The same is true of the read-only silo lock. What it
buys is that a *confused* write fails in the turn instead of being accepted and dropped. The
capture's own drop-and-log stays as the backstop behind both.

**When the capture runs.** Delegated work is the common way memory gets written, so the capture
keys on the moment that work comes back — not on the session ending. There are five points, and
they are all the same diff-based persist. A sixth, the in-turn
[explicit remember-ask](#an-explicit-remember-ask-writes-inside-the-turn), runs that same persist
before the reply is posted rather than at an edge:

- **A worker hands its result back.** The host records the settlement first, then persists, so the
  store can lag the seat's own notice by one step.
- **A delegation returns to the seat that asked for it.** A worker that runs inside the seat's own
  sandbox writes into the *seat's* memory tree, so the seat is the one that persists it, at the
  moment the answer arrives. This covers both a normal delegation and one that ran in the
  background. Without it, such a worker's edits would sit in the sandbox until the seat's session
  ended — for a standing seat, that can be hours or days, during which every other conversation
  reads the old bytes. If a delegated worker still holds the tree, the persist **skips** rather
  than capture a half-written file, and a later persist point carries the edit. Each skip spends
  one hold from every task it names and writes a `memory.settlement_flush` audit row. One task may
  hold four attempts closed; after that the host drops it and persists anyway, because a task the
  seat never peeked at would otherwise hold the flush shut for the session's life.
- **A turn ends, on a conversation that has delegated.** The backstop. A seat that delegates and
  then never looks at the result reaches neither point above, so its worker's edits would otherwise
  wait for the seat's session to end. It runs at most once per delegation rather than once per
  turn, skips on a still-running worker exactly as the point above does, and a conversation that
  has never delegated does no work here at all.
- **A turn ends, on a conversation that edited memory itself**, when provenance marking is armed. A
  conversation whose seat holds the sandbox file tools can write its own memory tree without
  delegating anything, and the four points above would never carry that edit. So the turn's own
  diff — the one that already marks bullets added on a turn that read outside content — reports
  which memory areas *changed*, and the persist runs on that report. A turn that changed nothing
  does no work here. A still-running delegated worker **defers** this persist rather than killing
  it: the provenance baseline has already advanced, so no later turn re-reports that edit, and the
  skipped tier is therefore REMEMBERED (`unflushedEdits`, `packages/core/agent/hooks/memory.ts`)
  and re-offered on the next turn end until a persist actually runs. Dropping it instead is what
  made the skip a silent lost write. Two things still cost the carry: a persist that RAN but whose
  silo writes FAILED clears it anyway, and the log says so; and a container the host cannot read
  loses it silently. In both cases only the session-end persist can still find those bytes. The
  in-turn remember-ask flush takes the opposite decision on purpose — it consumes its intent only
  when a durable memory write LANDED for the turn, and retires the ask after four posts that ran the
  persist and landed nothing. A persist that failed or threw spends none of those four, so such an
  ask stays armed and re-offers the write on every post.
  Because it rides that diff, it does **not** fire when `taint.mode` is `"off"`: on such a
  deployment a conversation that edits memory without delegating must delegate, or wait for the
  session to end, for the edit to reach the store — and a standing conversation's session ends by
  rotation, which overwrites the edit rather than saving it.
- **A session ends**, on success *and* on failure. The last resort, and on the shipped build only
  the failure half of it runs: the agent framework does not signal the end of a session that
  completes normally.

Each persist is a diff against what the store holds by then, so a repeat pass writes and audits
nothing. Every write row names one of five outcomes (`MemoryPersistOutcome`,
`packages/core/agent/hooks/memory.ts`) — `completed`, `failed`, `settled`, `edited` or
`write-intent`. The three delegation points all stamp `settled`; a turn-end tree edit stamps
`edited`; an [explicit remember-ask](#an-explicit-remember-ask-writes-inside-the-turn) stamps
`write-intent`. The separate `memory.settlement_flush` row names which of those edges ran.

> **Why no verb.** Open Everywhere shipped dedicated `remember`/`forget` tools until OPE-389.
> They were justified as governance, but the capture seam already carried the audit half for
> free — and the approval half caused real data loss: an "update this fact" request decomposed
> into forget-then-remember, inherited the destructive verb's blocking card, and when nobody
> clicked, the correction was written nowhere. Claude Tag has never used memory verbs, and the
> managed-Agents team retreated from exactly this design ("too opinionated… a simple file system
> was better"). What survives is the one thing an edit genuinely cannot do: erasure.

### The shape memory keeps

The verbs used to enforce this shape in code; now it is convention, taught in the agent's
instructions and seeded into every new silo's `MEMORY.md`:

- **A dated bullet is the atomic unit** — `- 2026-07-04: Ada owns billing` — filed under one of
  four sections (`Standing instructions` / `People / ownership` / `Decisions` / `Notes`).
  Everything downstream (the wikilink graph, the dream cycle) reads that same shape.
- **One fact, one bullet.** A new statement of a fact a section already holds rewrites that
  bullet in place rather than adding a second — see
  [A save supersedes](#writing-memory-files-not-a-verb) above. The date on the bullet is what
  makes the rule readable: where two statements do stand, the later one is current.
- **A section fans out to a topic file.** `standing.md`, `people.md`, `decisions.md`,
  `notes.md` hold each kind's **complete** history; `MEMORY.md`'s section keeps only the most
  recent bullets plus a `_Full history: [[people]]_` pointer. The index is a map, not the
  archive.
- **Facts link up.** `[[wikilinks]]` on 1–3 related subjects are real graph edges: the wikilink
  graph (`packages/core/agent/memory/graph.ts`) and the dream cycle's candidate narrowing
  (`packages/core/agent/memory/dream/candidates.ts`) read every markdown file in a tier — the index *and* its
  topic files — so a fact reachable only by a shared `[[link]]`, not lexical overlap, still
  surfaces.
- **Provenance is marked on the bullet, and written in prose.** A fact learned from a fetched page,
  a connector result or an issue body says so twice. The agent is asked to say it in its own words —
  in the one place every writer reads, the seeded `MEMORY.md` itself
  (`packages/core/agent/memory/layout.ts`): *"if a fact came from outside this conversation … say so
  on the bullet: nothing else records where it came from."* And the host marks it, whether the agent
  remembers to or not:

  ```
  - 2026-08-22: [unverified claim; the turn ingested web, github] Ada owns billing  [external-provenance: added on a turn that ingested web, github]
  ```

  **Two carriers, one claim.** The suffix is the tag. The `[unverified claim; …]` lead is the same
  statement inside the sentence, ahead of the assertion. The suffix alone was a footnote, and a
  footnote detaches: a later session that skimmed the bullet — or copied the sentence into a summary,
  another file or a reply — carried the fact and left the tag behind. The lead travels with the words
  a reader takes away.

  **What the mark claims.** The bullet was not in the memory tree when the turn started, and that
  turn read external content. It does *not* claim the read came first — a bullet written earlier in
  the same turn than the read carries the mark too. Nor does either carrier claim the bullet came
  *from* what the turn read; that is a causal claim the baseline cannot prove. The claim is
  deliberately turn-scoped: marking a whole *session* is what the taint model refuses to do, because
  a bullet written on a clean turn would then carry a claim the trail can disprove.

  **How it is derived.** The host keeps a per-turn baseline of the writable memory tree — the line
  digests, never the lines. At the end of a turn that ingested external content, every **bullet** the
  baseline did not hold takes the suffix, in the sandbox, before the next persist reads the tree. So
  the mark rides the ordinary capture seam and no write path changes.

  **How the sentence is re-cast.** The attribution is *inserted* — after the date stamp, ahead of the
  statement. Nothing is deleted, re-ordered or re-worded, so the worst case on a shape the rule
  misreads is a hedge in front of a line that did not need one.

  The rule is a **blocklist**: it names the shapes it refuses and re-casts everything else. It
  refuses a question, a task or checkbox line, a sentence that already names a source or already
  hedges, a dated shape it cannot split cleanly, and a fragment under three words. It does *not*
  judge whether a line is a real sentence — a shell command or a table row written as a bullet takes
  the hedge too. A word is counted in any script, but a script that does not space its words
  (Chinese, Japanese) reads as one word, so those bullets fall under the count. **A declined bullet
  still takes the suffix** — tag-only is the fallback, never nothing.

  **The dream cycle compares the fact, not the carriers.** The word-overlap kernel every pairing
  shares (`packages/core/agent/memory/dream/ops.ts`) strips both carriers before it measures two
  bullets — their words and their polarity alike — so a hedged fact and its plain duplicate read the
  same. Without that strip the carriers' own eight words dominated a short bullet: an attributed
  claim scored 0.47 against its OWN duplicate, under both pair bars, so the cycle never proposed
  merging them — while two *unrelated* bullets marked by the same turn scored 0.53 and were offered
  to the judge as a near-duplicate pair. Marking a fact must not hide it from its duplicate, nor bind
  it to a stranger that shares only its attribution. The strip matches each carrier's full lead-in,
  so a bullet that merely quotes an opening token keeps all of its own words.

  **What it does not cover**, stated plainly rather than implied:

  - only **bullets**. Prose, a heading or a fenced code block added on the same turn takes no mark —
    which is why the prose instruction above still matters.
  - only a session that holds the **sandbox file tools**. That is the usual delegated worker, and
    it is also a seat that carries those tools: such a seat writes memory files itself and takes
    the mark too.
  - only as completely as the **taint marks** themselves. A source that ingests without marking the
    turn produces an unmarked bullet, silently.
  - nothing at all when `taint.mode` is `off`.

  A marking pass that marks at least one bullet writes a `memory.provenance_marked` audit row — the
  count, the files and the ingestion kinds, never the marked line. A pass that marks nothing writes
  no row. The durable, forensic half is still the audit trail (a
  `memory.write` row per persist) plus the turn-scoped taint fences; the mark is what carries the
  fact into the store itself, where the dream cycle and the next reader see it.
- **A standing INSTRUCTION is heavier than a fact**, because future turns are told to follow it.
  It is written only when a human asked for a rule — never from inferred behaviour and never
  from content the agent merely read. That, too, is now instruction rather than a card.

## Purging: the one memory verb

`purge_memory` is the rare, destructive counterpart to editing: it **removes** facts rather than
changing them. A `match` phrase is swept across **every writable silo** the session holds — all
their files, not one — and every distinct bullet it resolves to is frozen for removal. Zero
matches errors rather than guessing, and a runaway match (more than 25 distinct bullets) errors
too, so one click can never empty a brain.

**What a purge actually achieves is the silo's BACKING, not the verb.** The purge rewrites the
file through the backing's normal write, so there are three outcomes. A `sqlite` or `postgres`
silo overwrites the row and keeps no version history, so the line is gone. A `git` or `github`
silo commits the rewritten file, so the line leaves the agent's memory but stays in the previous
commit. A **`notion` silo removes nothing at all**: that backing is append-only, the write throws,
and the fact stays live — see
[Opting a Notion silo into write-back](#opting-a-notion-silo-into-write-back) below.

The approval card states which case applies to each silo it will touch, so the person asking to be
forgotten reads the honest answer before anyone clicks. True erasure on a retention request needs
the SQL backings — see
[Backings: where memory physically lives](#backings-where-memory-physically-lives).

Use it only when someone asks for information to be genuinely removed: a mistake that must not
persist, personal data, a retention request. **Correcting or rewording a fact is not a purge** —
it is an edit, and routing it through this verb re-creates the deadlock the verb split exists to
kill.

`purge_memory` doesn't act directly — like the other propose-then-approve tools, it **proposes**:
a code-rendered card is posted showing every bullet it resolved and the files it will touch, and
any member of the channel can click to confirm — the same trust tier whose worker can already
edit that silo, since the card exists to defeat injection, not to gate privilege.

One path skips the card, and it is the same one every carded verb carries: an **approver chain**
that lowers this verb erases at once and posts a notice instead. Taint does not close that path —
`purge_memory` declares `taint: "disclose"`, so a tainted turn discloses its provenance and the
verdict is unchanged. See
[The control plane: In-Slack approvals](../security/control-plane.md#in-slack-approvals) for the
propose → card → click mechanics shared with the other admin-mutation tools.

You can ask from a room that can't host a card (a Teams or Linear conversation): the card is
posted into a card-capable channel in the **same domain** and the agent tells you where, which
matters more here than for most verbs — the card is the only place the bullets appear verbatim,
and the domain boundary is what keeps that text in front of the audience that already shared the
brain it came from.

`purge_memory` also **redacts by construction**: the pending card is the only place a resolved
bullet appears verbatim. Everything durable the flow writes — the frozen approval args, the audit
rows, the provider commit message — carries a SHA-256 of the line plus its length, never its
text, so asking the agent to erase something doesn't preserve that something in the one log built
to resist deletion. The same construction is what lets the capture seam audit an ordinary
freehand deletion. See
[Audit & provenance](../security/audit-and-provenance.md#properties-that-make-the-log-trustworthy).

**File-level deletion is a different, narrower operation** and stays control-plane-only:
`memory_delete_file` removes a whole file from a silo and is an org-admin, direct edit — see
[The control plane: Memory-admin](../security/control-plane.md#memory-admin-inspecting-and-editing-the-org-brain-without-sql).
`purge_memory` only ever trims bullets out of files that survive.

`memory_write_file` similarly stamps an in-file **human-edit marker** (`edited_by`/`edited_at`, a
leading `<!-- oe:human-edit … -->` comment — `packages/core/agent/memory/provenance.ts`) on every direct admin
write, never on an agent write. See "Memory hygiene: the dream cycle" below for why: it's the
signal that stops the nightly tidy pass from mistaking a human's deliberate edit for agent drift.

## Admin inspection, in the governance channel or a DM

An org or domain admin isn't limited to whatever silo the channel they're in resolves
to. `memory_admin_list`/`memory_admin_read` — ordinary in-Slack agent tools — let an
admin enumerate and read any silo their role covers. Two fences apply, and both must
pass. The **role** fence is the caller's own admin standing, scanned across every domain
rather than the current channel's. The **venue** fence is the room the answer renders
into: the org-wide view answers only in the governance channel or in a DM with the
asker, because it is a map of memory beyond the room that asked. In any other channel
the same ask is narrowed to that channel's own domain, or redirected. They're a
read-only bridge to the same silo enumeration/read logic behind the out-of-band
`memory_list`/`memory_read` MCP tools. Every file read writes a `memory.admin_read` row; a silo
listing writes a row only where the venue fence narrows or redirects it. See
[The control plane: Memory-admin, from inside Slack](../security/control-plane.md#memory-admin-from-inside-slack)
for the full gating rules.

## Curated subsets: `select`

When a silo's backing is a tree (a Notion page hierarchy or a GitHub directory) you
can pull part of it. By default a silo pulls the selected root **and all descendants**
(`recursive: true`); set `recursive: false` for just the root page. For finer control,
`select` is a per-node generalisation:

```ts
{ name: "handbook", provider: "notion", container: "<root-page-id>", readOnly: true,
  select: { default: "include", rules: [{ path: "onboarding", mode: "recurse" }] } }
```

`default` is what unlisted nodes get (`"recurse"` = take all then prune, `"include"`
= take only the root plus nodes you tick on). Each `rule` keys on a `path` relative
to the root with a `mode`: `recurse` (node + subtree), `include` (just that node), or
`exclude` (drop node + subtree). **Most-specific wins.** The model is per-container,
so it applies identically to a GitHub silo (a node is a directory; a path naming one
file can be excluded individually).

## Notion: a read-only hot-cache by default

A Notion silo is read-only unless its author says otherwise. That default is optimised
for the ~95% case where a knowledge base is *read*, not written:

- **Read is a read-only materialised hot-cache on disk.** The page subtree is pulled
  to **Markdown** files (low-token, grep-able, offline) and the agent reads them with
  ordinary file tools. Inter-page links within the same subtree are rewritten to
  relative on-disk paths so the agent can follow them; links outside the subtree
  degrade to a plain placeholder (no `notion.so` URLs leak into memory).
- **The cache is read-only, enforced fail-loud.** After materialising, the host
  `chmod`s the directory un-writable, so an agent edit hits a visible error *in the
  same turn* and the agent re-routes to the right tool. The write tool refuses the same
  edit up front, with a message that names the update route (see
  [Writing memory](#writing-memory-files-not-a-verb)). This is deliberate: silently
  dropping a read-only edit at session end would be a lost memory update — exactly
  the failure to avoid. The file banner and the top-level index name the correct
  route.
- **Writes (the rare case) go through Notion's own tools** (the `notion` connector),
  which mutate the source natively — no Markdown→blocks reserialisation, no
  degradation. The cache then refreshes from Notion. The lossy round-trip is
  structurally gone.
- **Rich blocks Markdown can't carry** (tables, images, embeds) are not dropped —
  the codec emits a typed `[notion:<type> id=<id>]` placeholder telling the agent to
  fetch that block by id via the tools.

The principle behind the default: **a file is writable if and only if the file IS
the source of truth.** A GitHub or DB silo (the file *is* the source) is writable; a
Notion cache (the file is a *projection*) is read-only and updated through the
source's tools. So route the agent's own learned, writable memory to a GitHub or DB
silo, and use Notion for a curated baseline it reads and occasionally updates.

### Opting a Notion silo into write-back

**The opt-in has two halves, and both are yours to set.** Leave the silo's `readOnly`
unset, *and* let the deployment's notion `memory` credential reach the write. The shipped
entry in `agent/access/connector-credentials.ts` declares
`methods: ["GET"]`, so on an unchanged deployment the endpoint fence refuses every append
before it is dispatched. That is deliberate: widening a credential's method set is a
capability expansion, so it belongs in the operator's own access config and never in a
provider package. Add `"PATCH"` to that entry's `methods` when you want write-back, and say
why in the comment beside it.

With both halves set, the backing persists what the session added through **Notion's own
block-append API**. The append is the only mutation it makes: it adds blocks to the end of
the page a file key names, and it never edits or removes one. The memory index tells the
agent so — a writable Notion silo is listed `writable but APPEND-ONLY`, not plain writable.

Four things REFUSE, and each one leaves Notion untouched:

- **a write to a read-only silo** — the update route is the Notion tools, which the
  refusal names;
- **a file key with no page** in the pulled subtree — this backing appends to pages that
  exist, and creating one is a different decision (where in the tree, under what title);
- **an edit or a deletion above the tail** — an append cannot express it, so the write is
  refused rather than half-applied;
- **a line the codec cannot store unchanged** — every batch is rendered back through the
  same blocks→Markdown codec before any of it is dispatched, and any difference throws.

**A refusal discards the whole tier's write, not just the offending file.** The four checks
run over every file before any append is dispatched, so no half-written state reaches
Notion — and the other files' new lines are refused with it.

**Three host-minted file shapes can never map to a page**, so they refuse every write on
this backing: `RECURRING.md` (the dream cycle's enrichment), `<file>.conflict-<session>.md`
(a concurrent write parked by the merge) and `<file>.rejected-<session>.md` (a destructive
overwrite parked by the write guard). A deployment that runs the dream cycle, or that shares
one silo across concurrent sessions, must keep its writable memory on a backing that owns
its files.

**Where a refusal shows up.** `persistMemoryNow` catches it per silo: one host log line
(`PERSIST FAILED for … → <silo>`) and a `failed` count in the flush summary. There is no
audit row for it, and nothing appears in the conversation. So the refusals stop bytes from
being reported as saved when they were not — they do not tell a member anything, and only
an operator reading host logs learns that a write was refused.

Prefer a GitHub or DB silo for the agent's own learned memory. Opt a Notion silo into
write-back only where the Notion page IS the record you want appended to — a running
decision log, a per-domain journal.

Two more limits to weigh. A writable Notion silo cannot be **erased**: block deletion is not
implemented, so `deleteTier` refuses, and `purge_memory` throws at the write step *after* a
human approved the erasure — the approved fact stays in Notion and no `memory.purge` audit
row is written. And a Notion write is a **consequential effect on a vendor** that carries no
per-write approval card, because memory persists host-side at session end, outside any turn
— the two config opt-ins ARE the human decision, and the `memory.write` audit row is the
record that a write happened.

The Notion integration token resolves through the credential broker
(`getSecret`) — the same seam egress and connectors use — never a raw env read. **Which**
integration depends on the silo's owning domain: a domain that binds its own Notion `memory`
credential projects its subtree under THAT integration, and a domain that binds none uses the org
default. In a session, a silo is read under the credential of the domain whose `memory` list named
it, even when two domains list the same silo. Only the silo-first readers — the control plane, the
tidy schedule and the purge worker — fall back to the org default for a silo with two owners. See
[One integration per domain](../deploy/surfaces/notion.md#step-4--one-integration-per-domain-optional),
[Connectors & providers](./connectors-and-providers.md) and
[Credential brokers](../extending/credential-brokers.md).

## Memory hygiene: the dream cycle

Memory that only grows rots. A nightly **dream cycle** keeps each writable **configured**
silo healthy in two modes. (Scope, honestly: the cycle walks the silos declared in your
memory config — personal DM memory is never touched by it. A user's private notes are
theirs; nothing rewrites or retires them behind their back.)

- **Tidy** (scheduled): safe, idempotent fixes — dropping byte-identical duplicate
  bullets, canonicalising `[[wikilinks]]`, reordering index lists by how well-connected
  a note is — are applied automatically. Anything **destructive** (merging near-duplicates,
  resolving a contradiction, retiring a superseded fact) is only ever **proposed**: it
  lands in the proposal review queue for a human to review — with a taint-clean row in
  the audit trail alongside it — never applied by the cycle.
  **A merge survivor keeps the disclosure.** When a consolidation merges a bullet carrying an
  external-provenance mark with an unmarked one, the proposed survivor carries the mark, so a
  merge never launders the disclosure. The survivor takes the carriers of the first merged
  bullet that disclosed anything — the rule conserves a disclosure, it does not compare two
  marks for strictness. Call that bullet the **donor**. **Supersession is decided by what the
  survivor says**, not by the proposal's label. The survivor is tested against the donor, the
  same source whose disclosure the copy would take. On a supersession the donor is not always
  the retired bullet: where only the newer bullet discloses, the newer bullet is the donor.
  A survivor that re-types the donor is the same fact again, so it keeps the disclosure; a
  survivor that states a different fact takes no mark. Three tests separate them: the two lines
  must agree in polarity, the survivor must drop no word the donor used, and the two must
  overlap above a threshold. That is a word test and not a reading of the sentence, so a
  survivor that only adds words to the donor's fact still counts as a re-typing.
  **A file a human just direct-edited through the memory-admin control plane
  (`memory_write_file`) is skipped by the destructive pass entirely** — the write stamps
  an in-file marker (`packages/core/agent/memory/provenance.ts`) precisely because tidy only ever sees
  the materialized files, never the audit log, and a human's deliberate edit must never
  get read back as agent drift and proposed for "correction". The safe fixes above still
  run over every file, marked or not — they're non-lossy formatting, not a judgment call.
- **Learn** (end of a turn): a workflow that keeps recurring is distilled into 1–3 durable
  facts — with their `[[wikilinks]]` — appended to `RECURRING.md` in the **first writable silo**,
  not spread across every writable one.
  Recurrence is the gate: one-off chatter never becomes memory. Learn observes **one request
  per turn**, so a long conversation is many requests rather than one request seen many
  times, and it observes only a request a **named person actually wrote**. Four kinds of
  turn are skipped. Three of them carry no human's request: a delegated worker's
  turn (its opening message is the brief the agent wrote to itself), a routine fire's turn
  (its prompt is the same host-composed text on every run), and any delivery the agent
  cannot attribute to exactly one author — a system notification, or several messages
  coalesced into one delivery.
  The fourth is a turn whose request is an **instruction about memory** rather than a fact for
  memory — "permanently erase from memory every stored fact about X", "forget that", "don't
  remember this". Such an ask is an action ON memory, and learning it puts the erased subject
  back as a rule. The skip is complete: the turn gets no recurrence count, no `RECURRING.md`
  bullet and no `SKILL.md` draft. The distiller never reads the ask either — not as the
  request, and not as one of the session's messages.
  A **remember-ask** that carries an ordinary fact stays learnable: the agent learns "don't forget
  the door code is 1234" as usual. A remember-ask whose own fact names an erasure of memory —
  "remember that stored facts about a candidate are deleted after 30 days" — is refused here too,
  because no wording test separates it from the ask above. It loses the recurring-workflow bullet
  and nothing else: the turn's own [in-turn persist](#an-explicit-remember-ask-writes-inside-the-turn) is
  independent of this skip, so the fact can still reach `MEMORY.md`.
  Where the turn raised a purge card, the [purge](#purging-the-one-memory-verb) road records the
  erasure on its own audit trail. Where only the wording matched, the skip appears in the host log
  and in no audit row.
- **Skill proposal** (the same crossing): a workflow that keeps recurring is also a candidate
  for a **skill** — a procedure worth writing down. The cycle drafts a `SKILL.md` and records
  it in the proposal review queue. Where the deployment sets `memory.skillProposalPr`, the same
  draft also opens a **pull request** on the config repo, adding the file under
  `.agents/skills/<name>/SKILL.md` on its own branch. See below.

### The skill proposal, and how a correction reaches the next one

**The merge is the human decision, and the cycle cannot make it.** The cycle cuts a branch, writes
one file and opens the pull request. It never writes to the base branch, and it has no merge
operation at all — a person reads the diff and merges it, or closes it. That is the same decision
`create_skill` puts behind an approval card, on a review surface that shows the whole file.
Nothing is armed while the pull request is open.

Merging is necessary, not sufficient: the file lands where a
[repo-shipped skill](./skills-and-plugins.md#skills-are-scoped-per-surface) lives, so it arms the
way any repo skill does — on the next checkout of a repo a bundle grants. Merging into a repo no
bundle grants arms nothing at all.

**A person's correction on the proposal feeds the next one.** Say "no, do it this way" in a
review or a comment on the proposal, and the next proposal of that same workflow, in that same
**silo**, carries what you wrote, attributed to you, under **Corrections carried forward**. Two
channels that share a silo therefore share the correction. The
correction is never written into a silo and no judge reads it, so it cannot become a durable
memory the agent recites back.

**It is written into the proposed `SKILL.md` itself**, not only into the pull request's
description — it has to be where the person editing the skill is looking. So merging the file
untouched ships that correction as part of a skill the agent then follows: fold it in and delete
the section before you merge. The merge is what bounds it.

**Only an author with standing in the repository counts.** GitHub attests each commenter's
association with the repo, and a correction is taken only from an OWNER, MEMBER or COLLABORATOR.
Be exact about what that buys: OWNER and COLLABORATOR hold access to the repository, while MEMBER
means membership of the owning organisation and implies no merge right at all. The association
is a filter, not the bound — the merge is the bound. A drive-by comment on a public repository,
and any comment written by a machine account, are **refused**. The number refused appears in the
next proposal's description, so a reviewer can see that something was said and go read it.
Whoever wrote it, the text is clamped and its code fences are neutralised before it reaches a
file.

**Closing a proposal declines that draft, not the idea.** The branch is derived from the channel
and the workflow, so if the same workflow recurs in the same place the cycle reopens the same
pull request with a fresh draft — carrying whatever you said when you closed it.

The proposal carries the member's own request line, because that is what a reviewer needs to
judge whether the drafted skill matches the ask — the same ruling that puts a proposal's content
in the review queue rather than the audit log. The audit row stays taint-clean: the repo, the
branch, the pull-request number, the counts, and the workflow signature's digest.

The pull request opens through the **same broker, credential and config repo** the
[access-request](../how-it-works/access-requests.md) and credential-binding flows already use,
so there is nothing extra to configure but the setting. A self-hoster who registered their own
config-PR mechanism gets this loop through it. A mechanism that cannot read a pull request back
carries no corrections and **says so** — the audit row separates "nobody objected" from "we
could not ask".

Since v2, the destructive judgments are made the way they need to be — semantically.
Cheap **structure narrows, cheap inference judges**: the wikilink graph and word-overlap
heuristics select a small, capped set of candidate pairs (near-duplicates, same-subject
bullets, dated facts with a later superseder), and a low-cost model — the `utility`
role, routed per domain like any other model call — confirms or rejects each one. Only judge-confirmed candidates become proposals, so the
review queue stays quiet; a judge that fails or answers garbage on one candidate drops that
candidate, and the safe fixes still apply. A deployment with **no judge registered at all** is
different: the run falls back to the heuristic detectors on their own, and those still propose.
The propose-not-apply gate is unchanged — it remains the safety net under the judge.

### Harness-level learning: the failure digest (Mode 3)

Tidy and Learn are **content-level** — they mine a channel's own memory notes. **Mode 3**
mines the *operator's* production traces instead: once a week, it reads the audited
failure-shaped events every surface already records — seven audited actions: suppressed
uninvited-turn failures, silent bare-stops, rejected webhook deliveries, bypassed spend caps,
failed approval executes, a failed unified-supervisor turn and a failed unified-supervisor
session — clusters them, and asks the same cheap `utility` model to facet the
top few clusters into a short label plus a concrete fix-sketch — falling back to a static
label/sketch when no judge is registered or it abstains on a cluster. The digest posts to
the admin channel (the same channel the access-request flow already notifies). A human
decides which fix sketch, if any, to act on. An empty week is a quiet no-op: nothing
posts, nothing is recorded, and nothing is spent — no model call, no repro, no post.

#### How the clustering works

The digest groups a week's failures by **signature**, not by kind alone. A signature is four
fields read straight off the audited row: the audit action, the **tool** it blames (an
approval kind, a hook id, a gateway name, an event name), the **error class**, and the
**surface**. The error class is the row's error text with its identifiers, numbers, urls and
quoted spans replaced by placeholders, so two failures that differ only by a generation id
or a status number land on one class. The grouping is **embed-free** — no vectors, no index,
no model call. The surface is part of the key on purpose: "this one room is broken" and "the
same error everywhere" are different defects, and the digest names the room.

Clusters rank by **recurrence** first. The audit row carries no money figure, so cost is
proxied by **spread** — the number of distinct days of the week the signature appeared on. A
signature seen on five separate days is a standing leak; five hits in one hour is one
incident. Ties past that break by first-seen order, so the same week always produces the same
digest.

#### The optional last mile

**It ships off.** For the **top** cluster only, the digest can go one step further: attempt a
reproduction, and when it reproduces, open a **draft pull request** carrying that repro. It
is a proposal, not a fix, and a human merges — always.

Four properties hold by construction, not by promise. A fifth — the draft COUNT — holds by
construction within one run and has one narrow exception across an interrupted step; it is stated
last, with the exception in its own words:

- **The arm never merges.** It drives the same config-repo PR port the credential-binding flow
  uses (`ConfigPrProvider`, `packages/core/agent/credentials/config-pr.ts`), and that port has no
  merge method, so no code path in the arm can merge. The pull request opens as a draft on top of
  that. The bound is the **code path, not the credential**: the write token the arm resolves is the
  same repo-write token the credential-binding flow already uses, and a repo-write token can merge
  a pull request. A deployment that needs the stronger property enforces it with branch protection
  on the declared repository.
- **The base branch is never written.** The base is read once, for the sha the head branch is
  cut from. Every write names the head. If the computed head and the configured base were ever
  the same name, the arm refuses outright.
- **The declared repository only.** The repository is a tracked literal in typed code. There is
  no environment variable, and there will not be one: which repository the agent may propose
  against is a trust declaration, and a trust declaration changes by pull request. No declared
  repository means no attempt — the arm never infers one from a cluster, a model or an audited row.
- **Nothing runs unapproved.** The approval gate is consulted before the clone, so a refusal
  costs nothing. With no gate registered the arm refuses: it is fail-closed.
- **One draft per digest RUN, with one exception across a resume.** The arm handles the top cluster and returns. There is no loop,
  and the head branch is derived from the cluster's signature, so a still-recurring failure updates
  the same pull request rather than opening a second. A resume **inside** the short outbound
  dedupe window skips the arm entirely; a resume after it runs the arm again, which re-pays the
  approval call, the clone and the reproduction, and updates the same draft.
  The head branch bounds the pull-request count across an interrupted weekly step **while the
  resumed run ranks the same cluster first**. It is derived from that cluster's signature, and the
  resumed run rebuilds its report over a `now - 7 days` window that has SLID. A slid window can
  break a `count` tie and rank a different cluster first, and the arm then cuts that cluster's
  branch and opens a second draft. The case is narrow, and it is the one the deterministic head
  does not cover.

The repro file's name comes from the transport, so it is checked before it is used: one plain
segment, no path separator, no leading dot. The committed path is always
`<repro directory>/<name>` and nothing else, which is what makes the directory in the config
literal a real bound rather than a suggestion. A transport that names a file any other way is
refused, and nothing is written.

A failure **after** the commit reports differently from a refusal: the digest names the branch that
was written and says no pull request opened. Only a refusal says nothing was written.

The arm records the branch **before** it writes anything else. The moment the head branch exists it
appends its own audit row naming that branch, and the outcome row follows. A run that dies between
the two — a process death, not an error, which the arm already catches — therefore still leaves a
row a reader can act on. That is what makes the resume-duplicate digest line worth following when it
sends the reader to the audit trail.

The append is **best-effort**, like the outcome row beside it: a store that refuses it must never
turn a real pull request into a refusal, so the arm swallows that failure and carries on. The row
therefore SHRINKS the blind window — the few lines between the branch and the append — rather than
closing it. An empty trail is still weaker evidence than a branch listing on the declared repository.

When the reproduction fails, the digest says **"could not reproduce"** in plain words and opens
nothing. That sentence is the product — a digest that quietly skipped would teach the reader
nothing. Every outcome, including a refusal, is recorded on the digest's own audit row.

## One road, one row: every durable write is audited

🔴 **Every durable memory write goes through one function**, `writeMemoryTier` in
`packages/core/agent/memory/write-road.ts`, and that function is the only production caller of a
provider's `writeTier`. A parity test (`npm run test:memory-write-road`) scans the source tree and
fails on any production module that reaches a provider directly.

The contract matters because the row is read as proof. The e2e memory legs gate on a `memory.write`
row, the wake-time delta reminder is built out of those rows, and an auditor asking "did the agent
really save that?" has nothing else to join on. Before the one road, **eight** production roads wrote
durable memory and only **two** of them wrote a row — the session persist and the admin edit. The
other six — the status board, the onboarding marker, the Slack pinned-instruction adoption, the dream
cycle's recurrence enrichment, the dream tidy and the approved purge — all changed a silo silently.
So a missing row meant two things that cannot be told apart: nothing was written, or something was
written through a road with no audit contract.

The road writes **two** actions, and the split is deliberate:

| Action | What it means |
| --- | --- |
| `memory.write` | A named silo's **remembered content changed** — an addition, a rewrite or a removal. This is the row that answers "did anything write this silo?". A reader who needs "a fact was *added*" filters on `detail.road`: `purge` removes and `dream-tidy` rewrites, so a gate that merely counts rows in a window is satisfied by either. |
| `memory.operational_write` | Host bookkeeping on the surface tier — the shared `STATUS.md` board, the `_onboarded` marker. No silo, and not a fact the agent remembers. |

Filing the status board under `memory.write` would answer "did the note reach the silo?" with a
status update, so it takes its own action. Every row carries the same canonical fields: the road that
wrote it, the kind, the tier, the silo and its provider, the file count and the version token.

A write that changes nothing writes no row: the providers answer `null` on a no-op, and an idempotent
persist has nothing to record.

Each road owns its own extra detail, and the road enforces only that a road cannot restate a
canonical field. It is **not** an ids-and-counts filter: the session persist has always carried a
`request` line — the session's first message, trimmed to 200 characters — so a `memory.write` row can
hold a member's own words. Do not read this plane as content-free.

## A reply may not claim a save the host did not make

🔴 **A reply sentence that matches a known completed-durability shape is struck unless the host
recorded a `memory.write` in that turn.** `packages/core/agent/channels/memory-claim-guard.ts` runs at
the four reply doors, beside the connector-provenance footer. The struck sentence is replaced by one
host-voiced line saying no durable write is recorded for the turn; every other sentence, and every
fact the turn produced, goes out unchanged. A `memory.claim_withheld` audit row names the claim by
shape and sentence position — never by its text.

What is enforced is a **set of shapes, not the whole class**. Six are struck today: a completed
storage verb beside a durable-store noun, the same pair in the mirror order, "have remembered", a
claim about the curated memory index, a present-location claim ("it's now in durable notes"), and a
reply that opens with a storage verb. A sentence that claims durability in some other wording posts.
The tests carry the measured fabrication verbatim, so a shape that ships is a shape a test can be
given; nothing here claims the list is closed. A live run proved that: it posted "It's now in durable
notes and the curated memory index" — a claim with no storage verb in it at all — and the first five
shapes walked past, so the guard's own denial posted beside the standing claim. The present-location
shape closes that one. The strike is by sentence, so a sentence carrying both a claim and an answer
would lose the answer too — which is why a completed verb hanging off a stated fact ("the code is X,
recorded in the team memory file") reads as a locative modifier and stands, and why a
present-location claim in a trailing clause ("the code is X, and it's now in durable notes") stands
for the same reason. A claim that opens its own sentence has no answer to lose and is struck.

The guard exists because the rule was already written for the model and did not hold. Two live runs
measured "the fact is saved" with no row behind it, the seat prompt gained an honest-ack rule,
and two live runs then measured the same sentence again. A rule a model must remember is not a
control.

### An explicit remember-ask writes inside the turn

🔴 **When a member asks the agent to remember something, the save runs before the reply is posted.**
Ask "remember this", "save that to memory" or "don't forget the door code", and
`packages/core/agent/memory/write-intent.ts` arms the persist; the door that posts then runs the
ordinary `session-persist` road before the post, so the `memory.write` row exists by the time the
claim guard above reads the turn. The reply can then confirm the save, and the confirmation is true.
Two doors run it: the two `reply` tool variants. They are the only doors that run this flush, and
they are the only doors a seat's words leave by. A delegated write reaches the store inside the turn
by a different road — the settlement flush named below.

A live run measured what the absence of this cost. A member asked, the agent wrote the note, and the
reply said "(No durable memory write is recorded for this turn, so I cannot say the note is stored.)"
— an honest sentence about a save that really did land moments later. Only the session persist records
a write this guard reads as a stored fact, and for a seat's **own** edit it ran at `turn.completed`,
after the reply had left. (The status board stamps its writes with a turn too, but they are
operational rows, so they back no claim that a fact was stored.)

This adds no second write road: it is the same road, the same row and the same audit contract, at an
earlier moment. Three things follow from that, and they are the deliberate bounds:

- **A turn nobody asked pays nothing.** An edit the agent made on its own initiative still persists at
  `turn.completed`, because a persist on every reply would cost a sandbox read and a provider read on
  every turn of every session.
- **A live delegated task holds it closed.** Persisting while a worker may be mid-write would publish
  a torn file to every other session on the silo, so the ask waits for the settlement flush instead.
- **The arm never permits a claim.** The guard reads the host's write ledger, never the ask, so a
  turn that armed the persist and wrote nothing still gets the honest denial.

It is surface-agnostic: the ask is read from the inbound message event and the flush runs at the
posting doors, so Slack, Microsoft Teams, Discord, Linear, GitHub and Notion reach it by one path.

One path is **not** covered, and the bound is worth stating. Linear's *native* mention route ends a
turn by handing a non-silent completion to the framework's own default poster. The product never
handles that post, so the flush does not run there, and a save confirmed on that route still gets the
honest denial. No other seat reaches a room by closing prose. A **single-window** turn's prose is
dropped and re-driven towards the `reply` tool, and a **per-surface** turn's closing prose is dropped
and recorded, so both shapes deliver through the `reply` tool, where the flush runs.

A second door is **not** covered either. `message_thread_seat`'s mirror post — a copy of text another
door already delivered, put into a thread seat — runs no flush, so a claim mirrored there still gets
the honest denial.

What counts as evidence is the host's own observation and nothing else. A **delegated** write lands
inside the turn — the worker edits the tree, the settlement edge flushes it, the row is written
before the seat composes its answer — so an honest delegated ack keeps its sentence byte for byte. A
seat's **own** sandbox edit persists at turn end, after the reply has left, so a seat claiming
completed storage before its own persist has run is claiming something that has not happened. The
honest sentence is still available, and the guard leaves every future and conditional form alone:
"I'll save this", "I'm writing it down now", "that will be stored at the end of the turn".

The direction is one direction. The guard can strike a claim that was true; it can never let through
a claim the host has no write for.

## What the memory plane writes to the audit log

Five more actions sit on this plane. Each carries ids, enums, counts and digests only. None carries
a member's words, a memory line's text, or a correction's prose — the
[audit trail's own rule](../security/audit-and-provenance.md#properties-that-make-the-log-trustworthy)
holds here as everywhere.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `memory.trust_gate` | A session whose binding is **external and non-local** starts, and the trust gate decides what it may read. One row per session, never per wake. | The binding mode, how many reads the plan admits, the plan's reason, and the session id when one exists. 🔴 A session with an internal or local binding writes no row, so an absent row does not mean the gate did not run. |
| `memory.tidy` | The tidy schedule finishes a pass over one silo. | The silo, the provider, the operations it applied (kind, file and summary each), and the provenance the guard reverted. |
| `memory.skill_proposal_pr` | The dream pass attempts a skill-proposal pull request. | The OE-minted scope, the workflow-signature digest, the delivery id, and the pull request number when one opened. The correction loop reads these rows back to find its own prior proposals, so the row is a working record rather than only evidence. |
| `dream.mode3_report` | The dream mode-3 digest is built. | The total failure count, one entry per cluster (its action, count, label and whether it was judged), and the last-mile result. |
| `dream.mode3_last_mile` | The mode-3 last-mile pass finishes. | The repository and the outcome. An opened pull request adds its number, URL and whether it was updated. A failure after the write adds the head and the reason. A branch cut adds the head. |

🔴 **A fully-refused tidy still writes a row.** When the provenance guard reverts every proposed
change, `applied` is an empty list and `provenanceReverted` names what was put back. Without that
row the refusal would exist only in a log line, and the audit trail of a silo whose every change was
refused would read identically to a silo that needed no tidying. An absence must never read as
safety.

## How a plan resolves — the rules behind the composition

**A DM's surface-tier reads and writes are hard-pinned to the database provider.** `surfaceProvider`
(`packages/core/agent/memory/resolve.ts`) answers the database provider whenever the binding's mode is
`dm`, and the deployment's configured provider otherwise. A DM's own tier therefore never lands in git
or Notion, whatever the deployment picked.

**A silo named by two domains has no owning credential.** `siloAccess` answers an owner **only** when
exactly one domain references the silo; two or more answer nothing, and the read falls back to the org
default rather than borrowing an arbitrary domain's credential.

**A domain's `memory` may be a single name or a list.** `memoryRefs`
(`packages/core/agent/memory/domain.ts`) normalises both to an array. Each named silo materialises into
its **own** sandbox directory, and the silos are never merged into one.

**Config load fails loud on a malformed silo.** `assertSilosValid`
(`packages/core/agent/memory/silo.ts`) refuses a silo with no provider — every silo is materialised, so
it must say where — and refuses one that sets **both** `select` and `recursive`, because `select`
supersedes the simple toggle. It also refuses an out-of-vocabulary `select.default`, an invalid rule
mode and an empty rule path. Every problem is collected and reported together.

### How `select` decides what materialises

`normalizeSelection` (`packages/core/agent/memory/selection.ts`) turns the simple toggle into a
selection: **`recursive: false` becomes include-only**, and anything else becomes a recursing default.
A silo that declares `select` keeps it verbatim.

`makeSelector` then resolves each node by **most-specific rule wins**. A rule on the node itself beats
a rule on an ancestor, and the **longest** matching ancestor prefix beats a shorter one; with neither,
the selection's own default governs. An `exclude` mode excludes. A node governed at itself is included;
a node that only inherits needs an ancestor set to `recurse`.

**A rule strictly below a node forces descent to reach it.** Even where the node itself would not
recurse, the walk descends when any rule sits deeper under it, because otherwise a deliberately ticked
deep node could never be reached.

### Grain, keys and names

**Memory resolves at domain grain.** `domainKeyOf` (`packages/core/agent/memory/partition.ts`) reads
the partition's `domainKey` and falls back to its surface key. A Discord thread therefore keys to its
parent channel, not to its own surface key, so one room's memory is one bucket.

**The control plane's partition reaches silo tiers only.** `controlPartition` builds the synthetic
`control/control/control` partition. It names no real platform, workspace or surface, so the workspace
and surface tiers are unreachable from it — fail-closed, and by construction rather than by a check.

**A silo tier is keyed by silo name alone.** `tierRelDir` (`packages/core/agent/memory/layout.ts`)
places a silo at `@silos/<name>`, with no partition segment, so every domain that references that silo
shares exactly one bucket. A workspace tier keys by workspace, and a surface tier by surface.

**Config-supplied names are sanitised.** `safeName` keeps letters, digits, dots, dashes and
underscores, replaces every other run with a single dash, strips leading and trailing dashes and dots,
truncates to **100 characters**, and answers `unnamed` for anything that reduces to nothing.

**Tier version probing never reads file contents.** `tierVersion`
(`packages/core/agent/memory/store.ts`) answers `null` at once when the memory root is not a git
repository; otherwise it asks git for that tier's last commit sha. It is a version probe, not a read.

## What the file layer guarantees

**Trimming a section keeps the newest bullets and hands back the overflow.** `trimSectionToRecent`
(`packages/core/agent/memory/markdown.ts`) finds the named section, counts its bullets, and — when
there are more than the cap — keeps the newest and **returns the oldest as `overflow`** so the caller
can migrate them into the topic file. Nothing is discarded by the trim itself.

**A dangling wikilink still becomes an edge.** `buildGraph` (`packages/core/agent/memory/graph.ts`)
makes a node of every markdown file and an edge of every link. A link that resolves to no file becomes
an edge to the cleaned raw text, marked `resolved: false`. An unresolved link is valid intent, so it is
preserved rather than dropped, and it never throws.

**A silo that failed to materialise is named in the index as missing.** `renderMemoryIndex`
(`packages/core/agent/memory/listing.ts`) takes the failed silo names alongside the successful reads.
Without that, the agent would read absent as empty and answer from partial memory as though it were
whole.

**A read-only tier is locked with `chmod -R a-w`** (`lockCommand`,
`packages/core/agent/memory/readonly.ts`), so an attempted edit fails loud with `EACCES` inside the
same turn rather than succeeding into a copy nobody persists. The matching unlock is `chmod -R u+w`.

**The memory root's unlock is always re-locked.** `withMemoryRootWritable`
(`packages/core/agent/memory/root-fence.ts`) re-locks in a `finally`, and only when the unlock actually
succeeded. A transport error inside the body therefore never leaves the root writable.

**A write into a silo outside the session's plan is refused, never re-routed.** `memoryWriteRefusal`
(`packages/core/agent/memory/write-fence.ts`) names the silo, says whether the session reads it, and
points at the route that could write it. Re-routing would be worse than refusing, because unowned
bytes are dropped silently. A write at the memory index itself is refused too: the index is
host-generated and rebuilt every session.

**An unreadable memory plan fails closed.** `assertMemoryWriteAllowed` refuses the write when the plan
cannot be resolved, rather than letting it through unchecked — a write that cannot be checked may be
one that is silently dropped.

**`RECURRING.md` is host-owned** (`HOST_OWNED_FILES`,
`packages/core/agent/memory/host-owned-files.ts`). A sibling session-end hook writes it directly on the
host, so the sandbox's session-start snapshot never overlays it and it never counts as a conflict. The
host copy always wins.

## Provenance marks on what a turn wrote

When a turn ingested external content, **every bullet absent from that turn's baseline takes a
provenance mark**. `markAddedBullets` (`packages/core/agent/memory/provenance-mark.ts`) compares each
line's digest against the baseline and marks what is new. It skips fenced code blocks, non-bullet
lines, and a bullet that already carries the mark.

**At most four ingestion kinds are named in one mark** (`MAX_MARKED_KINDS`); the rest collapse into a
`+n more` tail, so the mark stays readable however many sources a turn touched.

**The attribution is inserted only.** `recastAsAttributedClaim` splices the attribution after any date
lead and before the statement. **No word of the original bullet is dropped, moved or rewritten.** It
declines outright on a line that is not bullet-shaped, one that already carries the prefix, and one
whose statement is not assertion-shaped.

**A short bullet is a fragment and takes the suffix only.** A statement with fewer than **three**
letter-bearing words (`MIN_ASSERTION_WORDS`) is not assertion-shaped, so it gets the trailing mark
without the in-sentence hedge. Questions, task checkboxes and already-attributed leads decline the same
way.

**A rewrite that loses provenance is reverted per file.** `guardProvenanceMarks` counts the distinct
marked lines before and after. Any file whose rewrite holds **fewer** carriers than the before bytes is
reverted to the before bytes and named in `reverted`. Every other file keeps its rewrite.

**On a merge the survivor inherits the first disclosing source's carriers.** `conserveProvenanceOnMerge`
takes `donorOf`, which is the **first** source carrying either an attribution or a mark — not the
strictest of several. A survivor that already discloses is left alone.

**Baselines store a 12-character SHA-1 of each trimmed line** (`lineDigest`). Trimming before hashing
is what makes re-indenting a file invisible: the same text at a new indent digests the same, so a
reformat never reads as a page of new bullets.

**Deletion audit measures membership, not position.** `removedLineDigests`
(`packages/core/agent/memory/purge-redaction.ts`) builds the set of trimmed non-empty lines the new
content keeps, then records only the host lines missing from that set. A reorder or a reformat
therefore records **no** removed lines.

## The connector, timing and wake seams

**Config load fails when a connector-backed silo out-reaches its domain.**
`assertConnectorMemoryGrants` (`packages/core/agent/memory/connector-memory.ts`) checks every domain
that references a silo with a connector backing. A domain with no resolvable grants at all is a
failure, and so is one whose connector and container grants do not cover what the silo reaches — memory
rides the same route as connector access, so the two must agree at config time.

**A timing row that fails the taint allowlist is dropped with a warning, never written.**
`emitMemorySyncTiming` (`packages/core/agent/memory/sync-timing.ts`) projects the record to names,
paths and counts, and refuses to append anything that does not pass. Fail-closed is the right direction
here, because the payload would otherwise be org data in an audit row.

**The wake delta emits silo names, paths and counts only** (`formatMemoryDelta`,
`packages/core/agent/memory/wake-delta.ts`). It never carries memory-file content, which may itself be
untrusted. The block says outright that these are pointers and that the files on disk are already
refreshed.

**The delta is fail-soft.** `renderMemoryDelta` answers `null` on **any** audit read error, and on a
session with no silos. A delta is advisory, so a missing reminder never breaks a wake.

## What the dream cycle may do by itself

**Three operation kinds auto-apply, and four never do.** `SAFE_KINDS`
(`packages/core/agent/memory/dream/ops.ts`) holds `dedup`, `link-repair` and `salience-reorder`.
`consolidate`, `contradiction`, `supersede` and `stale` are `DESTRUCTIVE_KINDS`: they are
**proposed** and never applied by the cycle itself.

**A freehand pair that states one fact is a `supersede`, and only a judge may raise it.** Two
same-subject bullets with matching polarity, at least one of them undated, are put to the judge with
one question: does the later line state the current value of a fact the earlier line states an older
value of? A confirmed verdict becomes a **proposal**, exactly like every other destructive kind.
There is no threshold behind it and no auto-apply road — the overlap table under
[Writing memory: files, not a verb](#writing-memory-files-not-a-verb) shows the false-positive class
scoring *above* the true class, so only a judge can tell them apart. The zero-LLM path (`tidySilo`)
therefore raises the kind **never**. On approval, `applySupersedeOp`
(`packages/core/agent/memory/dream/supersede-apply.ts`) drives `supersedeUnderSection`: the survivor
takes the outdated line's position and the duplicate is removed. It matches both lines by **exact
bytes** — the ones the human approved — and declines whole if either has drifted.

**`supersede` covers exactly what the `stale` pass cannot see.** That pass asks the same question
with a better signal — the dates — but it reaches a pair only when **both** lines are dated **and**
the older one is already past the 180-day horizon. A pair it will see is left to it, so one question
costs one judge call. Everything else same-subject and same-polarity is a `supersede`: an undated or
half-dated pair, and also a fully dated pair too recent for the horizon.

**A dated bullet older than 180 days is flagged, never deleted.** `detectStale` emits a `stale`
operation naming the bullet's age and the horizon, with the summary "review or archive". The operation
is a proposal like every other destructive kind.

**A survivor inherits a donor's disclosure only on a strict test.** `restatesDonor` requires all three
of matching polarity, containment of **every** donor token, and token overlap at or above **0.9**
(`RESTATEMENT_THRESHOLD`). Each condition can only decline, which is the conservative direction. The
threshold value is deliberately strict and is not yet proven against real judge output.

**Each dream run puts at most 10 candidates before the judge** (`DEFAULT_CANDIDATE_CAP`, from the
`memory.dreamCandidateCap` setting) — one judge call per surviving candidate, which is the per-run
inference budget.

**A stale bullet with no later same-subject superseder is dropped, never judged.** `selectCandidates`
(`packages/core/agent/memory/dream/candidates.ts`) looks for a **later-dated** bullet on the same
subject, by shared wikilink or by word overlap. With none in sight there is nothing to judge, so the
bullet never becomes a candidate at all.

**A failed or unparseable judge verdict drops the candidate quietly.** `tidySiloJudged`
(`packages/core/agent/memory/dream/tidy.ts`) counts a throwing or `null` verdict as `failed` and a
non-confirming one as `rejected`, and proposes neither. Files a human edited are excluded from
candidate selection before the judge is asked anything.

**One skill proposal carries at most eight corrections, newest first** (`MAX_CORRECTIONS`,
`packages/core/agent/memory/dream/correction.ts`). The bound is applied twice: once per pull request as
feedback is harvested, and again over the concatenation when the proposal is read back.

**Only `OWNER`, `MEMBER` or `COLLABORATOR` feedback becomes a correction.** `correctionRefusal` refuses
an empty body, a bot author, and any other author association — and the refusals are counted rather
than silently dropped.

**In-room admin memory reads and control-plane writes are capped at 64 KB per file**
(`MEMORY_WRITE_MAX_BYTES`, `packages/core/agent/control/writes.ts`). The cap is small enough that an
admin's hand-edit is always a deliberate, reviewable change rather than a bulk data dump. The same
policy allows `.md` and `.txt` only, and refuses an underscore-prefixed name, which marks host-internal
bookkeeping.

## Why files, not vectors

Channel knowledge is stored as Markdown and retrieved by agentic search (grep/read),
not vector embeddings. For a bounded corpus this wins on exact-match precision, zero
staleness (no index to rebuild), transparency (every note is human-readable and
editable), and a smaller breach surface (no vector DB to exfiltrate). Vectors are a
deferred seam, opened only if a corpus outgrows what context and grep handle — and
even then over **summaries**, not raw messages.

## What's out of scope

- **No workspace-level or per-channel memory tier.** A single-channel domain covers
  the channel case if you ever need it.
- **No multi-tenant memory** — one org per deployment. Cross-workspace memory, if
  wanted, is just a domain whose channels span workspaces; no special mechanism.
- **Notion page creation and block editing.** Write-back appends to pages that already
  exist (see [above](#opting-a-notion-silo-into-write-back)); it never creates a page,
  edits a block or deletes one. Learned memory that needs full rewrites goes to GitHub or
  the DB.
