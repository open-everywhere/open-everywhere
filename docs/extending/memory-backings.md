# Memory backings

A memory **backing** is where a silo's memory durably lives between sessions. It's a
[per-bundle adapter](./adapter-model.md): every silo names its own backing, so one deployment
can run silos on different backings at once. This page is the backing matrix and the seam; the
memory *concept* (silos, domains, materialisation) is in [Memory](../capabilities/memory.md).

## The `MemoryProvider` interface

Core declares one host-side interface, `MemoryProvider`, scoped by `(Partition, Tier)`:

```ts
// packages/core/agent/memory/provider.ts
export interface MemoryProvider {
  readonly id: string; // "git" | "sqlite" | "postgres" | "github" | "notion" | …
  readTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles>;
  ensureTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles>;
  writeTier(p: Partition, tier: Tier, files: MemoryFiles, message: string, silo?: MemorySilo, access?: MemoryAccess): Promise<string | null>;
  deleteTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<void>;
  deleteFile?(p: Partition, tier: Tier, relPath: string, silo?: MemorySilo, access?: MemoryAccess): Promise<string | null>;
  root?(): string;
}
```

**The agent never sees the backing.** A provider is host-side: at session start the memory
hook reads only the resolved domain's files via `readTier` and materialises them into
`/workspace/memory/…` in the sandbox as plain files. No repo checkout, no path, no backend
ever enters the sandbox — so "hide the rest of the store" is automatic. The optional `silo`
argument carries the silo's `container`/`path` for backends whose location isn't derivable
from the partition alone (github needs a repo + subtree; notion needs a page id); the local
backends ignore it.

**The optional `access` argument carries WHOSE CREDENTIAL the call runs under.** It holds the
domain whose `memory` list named the silo — the domain that owns the page tree or repo subtree
behind it. A connector-owned backing turns that domain into a credential id itself, with
`domainCredentialId(access.domain, "<its provider>", "<its role>")`, so core never learns a vendor
string and the next backing that adopts per-domain credentials needs no change in core. First-party
backings (git/sqlite/postgres) ignore it: the deployment is their credential holder.

`access.domain` is ABSENT when no single owning domain is known — the built-in personal DM silo, and
any silo two domains both list. Every backing must read that as **the org default**, never as a
refusal. A binding that names a credential the provider does not carry is the other absence, and
that one fails CLOSED inside the backing.

**`writeTier` is upsert-only, on every backend** — it never removes a file just because a
call omits it (the safety floor against a caller that read a partial subset accidentally
wiping the rest). `deleteFile` is the dedicated, OPTIONAL single-file removal primitive for
a backend that needs to express "remove exactly this file" (today: the control plane's
`memory_delete_file` — see [The control plane](../security/control-plane.md#memory-admin-inspecting-and-editing-org-memory-without-sql)).
`git`/`sqlite`/`postgres` implement it; a backing that doesn't causes that one call to fail
loud rather than silently no-op.

## The backing matrix

| Backing | Where it lives | Notes |
|---|---|---|
| `sqlite` | core | local / tiny self-host DB floor; real `DELETE` erasure, `org_id` at rest |
| `postgres` (Neon) | adapters (`neon`) | hosted/multi-tenant; RLS by `org_id`, pgvector; needs a registered client |
| `git` | core | plain files + git history; the files-first default for local dev |
| `github` | the **github provider bundle** (via the GitHub App plane) | a memory repo reached through the same App that checks out code repos; Contents API |
| `notion` | the **notion provider bundle** | read-only hot-cache by default: a Notion page subtree rendered to markdown on disk; a silo whose author leaves `readOnly` unset also appends back through Notion's block-append API |

DM / personal memory is **hard-pinned** to the DB backing (`sqlite` or `postgres`) by
construction — it can never land in `git` or `notion`. That invariant is structural, not a
guarded override.

### Two classes of backing, and the line between them

The "where it lives" column is not filing: it is the taxonomy.

- **First-party backings** (`sqlite`, `postgres`, `git`) live in **core**. Their "connection"
  is the **deployment identity** — `DATABASE_URL`, the sqlite path, the store root. The
  deployment *is* the credential holder, so there is no grant to check and nothing to declare.
  This is the agent's own writable memory plane.
- **Connector-owned backings** (`github`, `notion`, anything future) live in **their provider
  package**, beside the connector that already reaches that source, and declare an optional
  **memory capability** on it. They ride the domain's connector access; they never hold a
  memory-only credential.

## Connector-owned memory

A connector may declare that it can also back memory. The declaration lives in the provider
package's `register()`, beside its `registerProvider(...)`:

```ts
registerConnectorMemory({
  provider: "github",          // the MemoryProvider id a silo names
  connector: "github",         // the connector grant a domain must hold to use it
  mode: "read-write",          // "materialise" | "read-write" | "skill"
  subject: "app-principal",    // the only permitted value — see below
  containerLabel: 'a repo, "owner/repo"',
  assertContainerGranted: (silo, grants) => /* null, or a problem string */,
});
```

**The three modes** are per-connector, never global — the fork is the connector's to resolve:

| Mode | What it means | Today |
|---|---|---|
| `materialise` | read-only projection: the subtree becomes files, chmod-locked, and the banner routes writes to the connector's own ops. The mode names a connector's DEFAULT posture; a single silo may opt out of it (a Notion silo left writable appends back) | `notion` |
| `read-write` | the files **are** the source of truth; `writeTier` commits through the connector's own scoped credential | `github` |
| `skill` | no files at all — the connector ships skills/scripts for memory-shaped reads (the right shape for a queryable RAG corpus, which cannot be a file tree) | none yet |

### The prefetch invariant

**Memory rides the same route as connector access.** A domain may project exactly what that
domain's connections can read, using those connections, and nothing else. Materialisation *is*
read access, so projecting a subtree the domain's connector plane could not itself `GET` would
make connector read-gating bypassable by silo config — access through a side door with a
different credential.

Two rules, both checked at **config load** and both **fail-loud** (every problem at once, each
naming the config to change):

1. the domain must hold the capability's **connector grant**; and
2. `silo.container` must be inside what that grant reaches — for `github`, the container must
   be in the domain's `repos` grant, the same middle layer every source-control tool enforces
   fail-closed.

First-party silos are skipped by construction: the deployment holds their credential.

### The subject pin

`subject` is the literal type `"app-principal"` — nothing else is expressible, and registration
throws on anything else. With `connectors.userPrincipal` armed a connection can carry
user-subject OAuth tokens; a **shared** domain memory materialised through one person's token
would bake their personal access into a cache every session in that domain then reads.
Materialisation also runs host-side at `session.started`, outside any session, where the
app-principal arm is the only thing resolvable anyway. Same route, narrower subject, by
construction.

## Per-silo choice

A silo names its backing in config-as-code:

```ts
{
  name: "handbook",
  provider: "notion",          // "postgres" | "sqlite" | "git" | "github" | "notion"
  container: "<root-page-id>", // repo (github) | parent page (notion) | db
  readOnly: true,
}
```

Selection is per-silo via `providerById(silo.provider)`, distinct from the env-selected
singleton `getProvider()` — so a deployment can run an own-memory silo on Postgres, a curated
baseline on Notion, and another silo on git, all at once. An unknown or unregistered
`provider` **fails loud** (the fail-closed rule from the [adapter model](./adapter-model.md)),
never silently drops memory.

The Notion backing is read-only by default: it pulls a page subtree (recursively, or a curated
`select`) and renders each page to a markdown file the agent reads; writes go through Notion's
own tools, never silently discarded. A silo whose author leaves `readOnly` unset opts into
APPEND-ONLY write-back: `writeTier` adds the session's new lines to the page a file key names,
through Notion's own block-append API. It needs a SECOND opt-in — the notion `memory` credential
ships `methods: ["GET"]`, so the endpoint fence refuses the append until an operator widens that
entry. Everything the backing cannot express — a read-only silo, a file with no page, an edit above
the tail, a line the codec cannot store unchanged — THROWS, and the refusal discards the whole
tier's write rather than half-applying it. A refusal reaches the host log and the flush summary
only, never the conversation. See
[Notion write-back](../capabilities/memory.md#opting-a-notion-silo-into-write-back).
Its integration token resolves through the
[credential broker](./credential-brokers.md) (`getSecret`), same as every other secret. Both halves
of symmetry now hold: a domain cannot project a Notion space it holds no `notion` connector grant
for (the grant half), and the projection runs under the domain's OWN named integration when it
binds one (the credential half — the `memory` credential role, see
[the Notion runbook](../deploy/surfaces/notion.md)). A domain that binds nothing reads under the org
default. The `github` backing declares no per-domain credential role: its App installation token is
app-principal by construction, minted per repo.

## Adding a backing

1. Implement `MemoryProvider` (the four tier methods + an `id`). Take `access` on the tier
   methods only if the backing reaches a vendor a domain can bind its own credential on.
2. Register it — `registerProvider(myProvider)` for a per-silo backend, or
   `registerPostgres(client)` for a deploy-supplied SQL client.
3. If it reaches an **external source through a connector**, also call
   `registerConnectorMemory(...)` beside it — that is what makes the prefetch invariant apply,
   and what puts the backing in the roster's contribution view. If it is a first-party store
   the deployment itself owns, skip it: there is no grant to check.
4. Reference it by `id` from a silo's `provider`, or select the singleton with
   `OE_MEMORY_PROVIDER`.

Connector-owned backings live in their **provider package** (`packages/providers/<name>/`); the
Neon client lives in `@open-everywhere/adapters`. Either way core stays vendor-SDK-free and
vendor-string-free on the memory plane; a backing you write lives in your own package and
registers through the same barrel.

## On Vercel / Off Vercel

- **On Vercel:** Neon Postgres is the default durable backing (registered via the `neon`
  adapter from `DATABASE_URL`), with RLS isolation and real erasure. Notion and github backings
  layer on per-silo, each riding its own provider bundle's connector grant.
- **Off Vercel:** the `sqlite` and `git` core backings need no vendor wiring at all — a fully
  local or git-native deployment stores memory with nothing extra. Point at your own Postgres
  by registering a `PgClient` for any driver.
