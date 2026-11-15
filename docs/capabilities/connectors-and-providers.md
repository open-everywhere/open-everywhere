# Connectors & credentials

How the agent reaches an external service — Notion, Linear, GitHub — and how a single
integration can be scoped to many teams with many keys, all enforced rather than
trusted.

A **connector** is the unit you connect: one host-side MCP connection
(`agent/connections/<slug>.ts`), with a **credential catalogue** listing the identities you
have configured against it. A **bundle** grants
`connectors: [{ name, credential, contentOrigin }]` to a scope. The resolver binds the named
credential to each surface, **narrowest-wins**, so ten domains can reach one connector with ten
different keys.

> **One grant grammar, and `credential` is mandatory.** There is no second list and no default
> resolution. A connector with exactly one configured credential still names it. Explicit beats
> convenient: the identity is on the line you are reading, and `npm run lint:connections` fails a
> grant naming a credential the connector does not configure.
>
> The word **provider** no longer names anything here. It means a *provider package*
> (`packages/providers/*`) and nothing else.

This page is the *concept*. For the credential-plane mechanics (where the secret
lives, why the agent never sees it) see
[Credentials & the two planes](../security/credentials-and-planes.md). For *how to add
a new connector* see [Connectors](../extending/connectors.md).

## The credential catalogue

One catalogue per connector, keyed by the connection slug. It carries the **credentials** you
have defined against it (each a fixed key or an OAuth home, with an id you choose) and an
**allowlist** of which credential types that connection accepts.

```ts
defineConnectorCredentials({
  connector: "notion",                                // the host-side MCP connection slug
  allows: ["api-key", "service-oauth", "user-oauth"], // which credential types this connection accepts
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "db:notion:team-key", broker: "db" },
  ],
})
```

That is the deployment's own Notion catalogue, cut down to one row. The allowlist is exactly the
shipped one. The real catalogue configures **three** api-key credentials — `team-key` for the work
surface, `channel-key` for channel plumbing and `memory` for the memory backing, each with its own
endpoint fence — plus one `user-oauth` credential and one `service-oauth` credential. An OAuth
credential carries a `home:` in place of `secretRef`: `home` names an OAuth home, and `secretRef`
names a key the broker resolves.

A bundle grants the connector, and names which of its credentials this scope reaches it as:

```ts
connectors: [{ name: "notion", credential: "team-key", contentOrigin: "external" }]
```

When the resolver expands that grant it checks the allowlist (does the connection
accept this credential type?) and the universe gate (below), then binds that credential
**to this surface**. The UX this enables: pick "Notion", see its credentials, attach
"Notion → team-key" to a domain — with credentials the connection doesn't accept
greyed out. A grant whose credential does not resolve contributes **nothing at all** — not the
connector without its identity — and emits a warning rather than throwing: **fail-closed by
omission**.

`contentOrigin` is the third field and it is required on every operator-authored grant. It says
who writes the bytes the connector returns; see [Declaring a connector's content
origin](#declaring-a-connectors-content-origin) below.

## The credential axis: who the agent acts as

There are three credential shapes, distinguished by **principal** — *who the agent acts
as* — which is the single most important thing for trust:

| Type | Principal | Universe | Secret source |
| --- | --- | --- | --- |
| `api-key` | **app** (one shared service identity) | channels & domains | a fixed key, by ref |
| `service-oauth` | **app** | channels & domains | own-rolled OAuth flow (vault) |
| `user-oauth` | **user** (the calling human's own grant) | **DMs only** | the user's own OAuth |

The principal is the **universe gate**, and it is structural, not advisory. An *app*
credential is one shared service identity — Notion-as-the-team, GitHub-as-the-bot — and
it's what runs in channels and domains. A *user* credential is the calling human's own
grant, obtained by an interactive browser consent, and it exists only in that person's
DMs. The resolver **refuses** to attach a user-principal credential to any
channel/domain binding, so a personal Notion login can never leak into a shared
channel — and is never even offered when an admin scopes a domain. The **member plane** is the one
exception: it admits a `<connector>/<credential>` pair a domain named itself. It ships off
(`connectors.memberPlane: false`), and the section below describes it.

Identity per surface is covered in full in [Identity](../how-it-works/identity.md).

## Tight scoping: one integration, N keys

> "I set up 10 domains and want them all to reach Notion. One credential for all, or 10
> tightly-scoped keys?"

**Both, and you choose per integration — that's the point.** A credential is *defined
once* and *bound to many scopes*; the binding scope is where you tune blast radius.

- **One shared key.** Define one Notion credential, bind it to all 10 domains. One
  secret to rotate; every domain reaches Notion as the same service identity. Right
  when the key's own permissions are already the boundary you want.
- **Ten tightly-scoped keys.** Mint 10 Notion integration keys, each scoped at the
  vendor to just that team's pages; define them as 10 credentials; bind one per domain.
  Domain A literally cannot read domain B's pages — the boundary is enforced **at the
  vendor**, not just in config.
- **Mix freely.** A read-only key org-wide, a read-write key on the one domain that
  curates the knowledge base.

Resolution is **narrowest-wins with no fallback**: a credential bound at surface scope
overrides one bound at domain scope, which overrides tenant, which overrides org, for
the same connection — a tighter binding cleanly shadows a broader one.

**Recommended posture:** start with one service credential bound at *domain* scope.
Never bind at org or tenant scope — that reaches every current and future surface
beneath it, and the resolver emits a `broad grant:` warning if you try. Drop to
per-domain scoped keys when a domain handles something the others shouldn't see. A
well-scoped API key is usually *narrower than a user principal anyway*, which is why
fixed-key service credentials are the sensible default and per-key scoping does the
real work. See [Access & scoping](../how-it-works/access-and-scoping.md).

## Chat surface vs work surface

A provider is **two surfaces**, and they take **two credentials**.

- The **chat surface** is the egress/ingress route for conversation. It carries the minimum a
  conversation needs — reply, edit a reply, react, and read the room it was woken in. Its
  credential should be scoped at the vendor to exactly that: the channels, the comment pages, the
  issues the agent talks in.
- The **work surface** is the provider's own work tools, under a **domain grant**, on a **separate**
  credential. A domain declares it; a domain that does not, does not have it.

The reason is blunt: a chat integration that can also create tickets, edit pages or open pull
requests is a hole no amount of tool hygiene closes. The conversation route should be able to
converse, and nothing else.

**Capability comes from the domain, not from the wake surface.** A Slack conversation in a domain
that holds a Notion work grant can read that domain's Notion pages. The same Slack conversation in a
domain that holds none cannot — and neither can a Notion conversation there, beyond the page it was
woken on. This is what lets the natural cross-surface flow work inside a delegation: read the spec
on Notion, write the doc, open the pull request on GitHub.

Declare a work grant on the domain, naming the provider's work role and the credential it runs
under:

```ts
defineDomain({
  name: "payments",
  reach: ["slack/T…/C…", "notion/<workspace>/<page>"],
  credentials: [{ connector: "notion", credential: "team-key", use: "payments-notion-key" }],
});
```

Three rules, and they differ from the plumbing credentials above:

- **Absence is a refusal.** No declaration ⇒ no grant ⇒ the work tools never mount. For the
  chat/plumbing roles, absence means "use the deployment default" instead; the work role is the one
  place where saying nothing means *no*.
- **One mount rule, pinned by `npm run lint:work-mount`.** Every work tool decides whether it mounts from the caller's work
  grant, read through one module (`packages/core/agent/access/work-grant.ts`) — never from the
  session's grain and never from chat topology alone. A tool that runs *only* on the work credential
  mounts on the grant alone; a tool that also has a chat-plane path (reading the page or the issue
  the agent was woken on) mounts on the grant **or** on the provider being one of the window's own
  chat sources. A third class is the **intersection**: `read_work_channel` and `read_work_thread`
  mount on the grant **and** on the provider being one of the window's own chat sources, so a grant
  on a surface the domain receives no wakes from mounts nothing. A delegated worker is the one
  exception to the grant half: it mounts both verbs on its own origin platform with no grant,
  because they read only the room and thread its job came from (OPE-2491). On a window where only
  Slack holds the grant, a Discord-woken worker still reads its Discord thread. `lint:work-mount`
  fails a work tool
  that fits none of the three, and fails a new work tool that is not classified at all.
- **Work tools are the worker's.** A conversational seat delegates; the delegated worker mounts the
  work tools. The seat's own vocabulary stays the uniform chat API.
- **Open Everywhere ships the seam, you scope the keys.** Nothing here makes a vendor honour the
  split — it makes the split legible, per domain, in a reviewed diff. Mint the second integration
  and share it narrowly.
- **A work grant is not a connection grant.** They are two planes. A connection is what
  `connection_search` finds and what the channel's connector allowlist governs. A work grant runs on
  the provider's own tools and no connection allowlist covers it. The session prompt states both
  together, so an empty connection list never reads as a withdrawal of a work grant.

**GitHub declares the same grant as a repo list.** Its work tools obey every rule above — absence is
a refusal, the tools are the worker's, chat presence is never a precondition — but the declaration is
`bundle.repos` in your access bundle, not a `credentials` row on the domain. The reason is the
credential: a Notion or Linear work token is workspace-scoped, so the credential's reach is the
boundary, while one GitHub App installation covers many repos and the repo list is how you narrow
below it. A session granted no repo mounts no GitHub work tool. See
[Source control](source-control.md#two-level-scope-installation-universe--bundle-repos).

### A chat surface can be a work surface too

Slack, Discord and Teams are chat surfaces whose **work** half is the conversation itself. A
delegated worker mounts `read_work_channel` and `read_work_thread` — the read of the conversation
the task was delegated from, with no per-turn read budget. **It needs no work grant for this read**
(OPE-2491). The room and thread its job came from are the container its seat could read, so the
worker reads them on the seat's own access: the same read adapter, the same domain allowlist, the
same external-participant policy and the same untrusted-output fence. The page size is the seat's.
The container comes from the worker's dispatch binding. This holds on Slack, Discord, Teams,
GitHub, Notion and Linear; an email worker still needs a grant, because the email adapter takes the
thread from the live auth. A conversational seat never holds the two verbs, and a non-delegated
session still mounts them only on the grant. See
[the agent loop](../how-it-works/agent-and-loop.md) for the stamp limit at execute.

The work grant is the road to anything **beyond** that origin container: each work tool that names
another container checks it.

**Notion and Linear hold the same two verbs too, alongside their entity work.** A Notion page or a
Linear issue is addressable — a caller can name it, so it is also a work DESTINATION — but it is
ALSO the conversation a worker was delegated from. A delegated worker mounts `read_work_channel` /
`read_work_thread` on a Notion- or Linear-origin turn exactly as it would on Slack, with no grant,
reading the page's top-level comments / the issue's comment roots as the "channel" and one
discussion / one comment thread as the "thread". The work role your domain declares for the entity
tools (Notion's `team-key`, Linear's `workspace`) is what reaches any OTHER page or issue.

A chat surface's work role is declared like any other work grant:

```ts
defineDomain({
  name: "payments",
  reach: ["slack/T…/C…"],
  credentials: [{ connector: "slack", credential: "work-token", use: "chat-token" }],
});
```

The work role is `work-token` on all three. `use` names the credential the role runs under, and it
may never repeat the role id — so a deployment with one Slack app points it at `chat-token`, and a
deployment that mints a second, read-scoped app names that one instead.

The catalogue stamps each credential with the home of its secret. The Slack and Discord bot tokens
are operator secrets, so both ids say `broker: "db"` with the surface's own name
(`secretRef: "SLACK_BOT_TOKEN"`): the row that `npx oe secret set SLACK_BOT_TOKEN` writes. The
surface reads its token through its own path, so the stamp moves no call. It does decide what
`npm run deploy:census` asks for: a domain that declares a Slack or Discord work grant makes that row
required. A Slack token that only `/setup` stored lives under a different name, so the census
reports the row missing until the token is also stored as the operator secret.

Two limits, stated plainly:

- **The read is still container-fenced.** These verbs take no target. They read the container the
  task was delegated from, which is what a worker needs and is not a browse of the workspace.
- **A grant on a surface this domain receives no wakes from does nothing.** The container comes from
  the turn, so there is nothing to read; the verbs do not mount for it. A worker whose origin is
  not a source of its window mounts neither verb either.

**GitHub is the fourth, and it declares its grant differently.** An issue or PR thread is a
conversation too, so a worker delegated from one holds the same two verbs, with no grant. What
GitHub does not hold is a `Domain.credentials` row: its work grant is the access bundle's `repos:`
list, for the reason above — one App installation covers many repos and the list is how you narrow
below it. The vendor read still needs a GitHub credential, as the seat's own read does. On GitHub the
container is the issue-or-PR conversation and the thread is one PR review thread.

Per provider: [Notion](../deploy/surfaces/notion.md#step-4-optional--notion-as-a-work-surface),
[GitHub](../deploy/surfaces/github.md#reading-the-conversation).

## The connector-decision rule

For any integration, three ways to wire it, in default order:

1. **API-key M2M connection (the default).** A scoped service key injected at the
   egress firewall (REST) or handed to a host-side connection. A well-scoped key is
   usually narrower than a user principal, which kills the blast-radius argument for
   user auth. Reach for this first.
2. **MCP org-principal (the exception).** Use the vendor's curated, agent-shaped MCP
   tool set when you want agent-native features or a tight, lazily-discovered tool
   surface. The app acts on its own service identity; actions attribute to the human
   for audit.
3. **User-principal (fenced to DMs).** The calling human's own OAuth grant, available
   only in their DMs. Never on a channel or domain.

## A reply names what it read

**A reply that drew on a connector records what it read, and the host writes that record — not
the model.** Every connector op emits an `action.result` event, and the same hook that writes the
`connector.op` audit row records READ ops on a turn-local ledger. The reply choke point reads that
ledger and writes one compact **sources line** onto the reply's `reply.provenance` audit row, as
`detail.sources`:

```
notion, linear
```

**The room does not see this line.** Until OPE-2487 the host appended it to the reply as a footer
(`Sources read this turn: notion, linear`). An ordinary reader took it for machinery, and it never
shaped what the model wrote, because the host adds it after the answer exists. The fix for a model
that invents its sources is the read tools themselves, not a printed receipt. So every reply now
reaches the room as the model wrote it, and a person who wants the sources asks: "what did you read
for that?" The agent's voice section tells it to answer that question by name. That answer is the
**model's own account** of its tool calls and its worker's report — nothing reads this row back
into a turn — so it is not the host-checked receipt the footer was. Only an operator reading the
row gets that.

The line is absent on a turn that read nothing. It counts a connector once however many times the
turn read it, and it ignores writes (a created page announces itself) and failed ops (nothing was
read). Below, "the footer" means this recorded line.

**Numbered source links, in a 1:1 conversation (OPE-2520).** The line above names SYSTEMS, and no
room reads it. A **source link** names a RECORD the person can open: `[1] Launch checklist`, the link
on the title. The host adds them under an answer on Slack and Teams, drawn by the surface itself (a
Slack context line, Teams citations), and only where all of these hold:

- the reply lands in a 1:1 conversation between the app and one person (a Slack `D…` DM, a Teams
  personal chat) — the post arm declares which conversations are 1:1;
- a first-party read tool fetched the record for this conversation, and knew its title and its
  `https:` url: `read_notion_page`, `read_notion_comments`, `read_linear_issue`,
  `read_github_issue`, `check_pr_status`, `get_pr_feedback` or `walk_pr`, on the seat or on a worker for it (the
  delegation settle carries the citation, as it carries the read). A GitHub issue and a GitHub pull
  request are two record kinds, so a surface that says the kind in words says the right one.
  `read_notion_comments` cites the page only when it reads the whole page. A `block` drill-in names
  `notion` and cites nothing, because it never opens the page;
- the reach rule below holds for that read, so a turn that served two conversations never cites one
  conversation's read in the other.

A shared room gets no links: a turn can read a record and leave it out of the answer, and its title
would then reach people the answer did not address. A connector op's read names no record, so it
gives no link. At most five links show, in read order. The title is flattened onto one line with no
link grammar, and the url must be `https:` with no link grammar either. The title and the url live in
process memory for the turn, never on the ledger. A worker's read carries them to the seat on the
short-lived delegated-reads row, which the settle spends, and the spent form keeps no title and no
url. The `reply.provenance` row records only how many
links the reply showed (`detail.links`). See the
[Slack](../deploy/surfaces/slack.md#sources-and-thumbs-on-an-answer) and
[Teams](../deploy/surfaces/teams.md#sources-thumbs-and-the-ai-label) pages for what each surface draws.

**The model does not write it, and cannot pass its own list off as one.** That is the point. A
model asked to list its own sources may not know them and may invent them, and an invented
source list is worse than none, because it reads as a receipt. The ledger is unforgeable
because only the host writes it — and the old footer's shape stays reserved: the choke point
strikes any line of the model's own text whose first content is `Sources read this turn:`, on
every reply. With no host footer beside it, a forged one would be the only receipt in the room, so
the strip matters more now, not less. The strip skips leading whitespace and
markdown decoration (`*`, `_`, `>`, `-`, `#`) first, so a bolded or quoted forgery goes the
same way as a bare one. It is a whole-line rule: a sentence that mentions the phrase mid-line
is ordinary prose and passes through.

**A delegated read is named too.** No conversational seat may call a connector itself — the ops are
worker-only — so the ordinary shape of a connector answer is a read the seat handed to a worker. The
worker runs in its own session and the ledger is per-session, so the seat used to answer with no
footer at all. It no longer does: when the delegation settles, the worker's reads move onto the
seat's own turn, and the seat's reply names them exactly as it names a read it made itself. The
settlement records what moved in a `delegation.provenance_carried` row, whose `outcome` says
`carried`, `not-completed` (the worker died before it answered) or `wake-unprovable` (the settling
turn's address names another conversation, so the sources are withheld rather than named in the
wrong room). The carriage joins worker to seat through the task-to-call join row, which every
deployment writes whatever `taint.mode` says (OPE-2712). So the move needs one thing: the seat must
answer on the turn the settlement woke it. The worker's **taint** verdict never travels that way — it rides its own
marker, and the two planes share nothing.

**A borrowed read is named too.** A credential-grant call arrives under the reserved
`grant__<owner>_<connector>__…` namespace, which the connector hook skips, so the **mount** records
it instead: the grant row's connection, and the **pinned target** the owner approved. The footer
then reads `notion (Launch checklist)`. The name comes off the grant row and never out of the
vendor's bytes, so a reply that presents a lent tool's answer as some other page is contradicted by
a host-written record. Since OPE-2487 that record is on the row, not in the message, so **only an
operator reading the row sees the correction.** A person who asks what was read gets the model's
own answer, which the host does not check. The guard against a misattributed lent read is therefore
operator-only now. A grant whose row holds no
recoverable target label names the connection alone. The grant plane's own `grant.*` rows are
unchanged, and still name both principals.

**A missing footer does not mean the turn read nothing.** The footer is a positive signal only,
and three routes reach a source without filling the ledger. Do not read a bare reply as
"consulted nothing":

- a **delegated** read whose settlement the seat could not place in a room, or whose dispatch has
  no join row — the carriage joins worker to seat through that row. Every deployment writes it,
  whatever `taint.mode` says (OPE-2712). The row is missing when the best-effort write at dispatch
  failed, when its six-hour TTL lapsed before the settle (a continuation does not refresh it), or
  when a taint-off deployment dispatched the task before that change;
- a **cross-turn edit**, since the ledger is turn-stamped;

The direction is deliberate and it runs one way: the footer can fail to name a source the turn
really read; it can never name one the turn did not.

**A source the room may not see is counted, never named.** Naming a source discloses that it
exists. So a connector is named only where the host can prove the reply lands in the room the
read was scoped to. Everything else is counted by kind:
`notion, 1 in another domain`.

The proof depends on the seat. A **per-surface** seat holds one conversation, so equal partition
surface keys prove it. A **unified** seat holds several conversations under one partition, and all
of them resolve the same surface key, so there the proof is the **wake** instead: each read is
recorded under the wake the turn was working for, and a reply names only the reads recorded under
the wake it answers.

One conversation can carry **two** wake ids, and a delegated read is recorded under both. When a
worker's research settles onto the seat, the host mints that task its own wake and the settling turn
answers under it — while the seat replies under the wake the turn was delivered with. Both name the
same room, so a read carried at that settlement records the delivered wake as a **second** address
beside the minted one, and a reply under either address names it. The host admits the second address
only after it reads both wake rows back and proves they resolve to the **same conversation**; a stamp
it cannot place there is withheld, and so is one it cannot read at all. Without that widening the two
ends name two different ids for one room and a delegated read is never named — which is what a reply
footer did before it.

A residual stays, and it is stated rather than hidden. It needs a turn woken by **two or more
conversations at once**, and on such a turn it is open throughout. Before the turn answers anything,
a read is recorded under the conversation the framework's delivery named last. After the turn answers
one conversation, that choice is fixed for the rest of the turn, so a later read is recorded under it
whichever conversation it served — and a second message to that conversation, or an edit of the first
one, can then name it there. What the residual can disclose is the connection name alone, in a room
that already learns "1 in another domain" without it, and both conversations sit inside one window
the operator vouched for. A turn woken by a single conversation has no residual at all.

**The footer can name the record, under one narrow rule.** A record name tells a room that such a
record exists, so the rule takes two proofs and refuses without both:

1. the reply lands in the room the read was scoped to — the reach rule above, unchanged;
2. the record's id **already appeared in that room**. The host proves this from its own wake stamps:
   the record must be the one the turn arrived on — the Linear issue the comment sits on, the Notion
   page the comment sits in.

A room whose own subject is that record already holds its id, so the name discloses nothing new. A
page the agent went and fetched fails the second proof, and the footer then names the connection
alone. The line stays one plain line:

```
linear (Rollout plan), notion
```

Only the **first-party read tools** reach this — `read_notion_page` and `read_linear_issue`, which
know what they read because they fetched it. A connector op cannot: the framework hands the host
untyped JSON from a remote server, so naming the record would mean guessing at keys in somebody
else's content. Those two tools also return the record's **title and link on their own output**,
which is what the model sees. The footer carries the name only, never the link.

**A borrowed read answers the second proof off the grant row instead.** Its record is the target the
grant **pins**, named by the label the requester wrote when they asked and the owner approved on
their card. Nothing is inferred from a wake stamp, because the grant answers the question: a row is
spendable only in the session it was minted for, or in the domain its owner tapped, so every room
the record can reach is a room whose seat may spend that grant. The grant-use notice posts the same
label into the room on every call, but that post is best-effort — a surface with no mid-turn post arm
leaves a `grant.undisclosed` row instead — so the footer can be the first place a reader sees it.
The first proof, the reach rule, is unchanged and still applies. Two grants carry no record at all:
one whose row holds no recoverable label, and one that does not pin its tool's target.

**The line has a length budget, and a record name is the first thing dropped.** A title is arbitrary
prose somebody typed into a page header. When the line would run long, the host drops record names —
the last one first — until the line fits. It never drops a connection name, an overflow count or an
other-domain count.

**A title is untrusted text, and the host neutralises it before it writes it.** Anyone who can rename
a page or an issue chooses those bytes. The host flattens the title onto one line and takes out the
characters that carry the footer's own grammar — the brackets and the comma — so a title cannot add a
second line, spell a second source name into the list, or escape its brackets and continue as
host-written prose. A title that carries the footer's marker is dropped, and the line then names the
connection alone.

**The record outlives the render.** Each landed reply and each edit writes a
`reply.provenance` audit row carrying the full list — including the sources the footer
withheld from that room — plus how many it withheld. A row that names sources and reports a
non-zero `withheld` is how an operator reads back which of a turn's sources a room was not
shown. A reply whose
ledger is empty writes no row, so the four routes above have none either. Read the rows with
`readAudit({ action: "reply.provenance" })`. The row names which connection and which op verb,
never an op argument. **One field holds op output:** `detail.sources` (OPE-2487) is the line a
room used to read, so it can carry a **record title** — a Linear issue's or Notion page's title,
written by whoever wrote that record — where both disclosure proofs below held, flattened onto one
line and capped at 160 characters. The audit log keeps it as long as it keeps the row. A title that
fails either proof is never stored. The row is the durable answer to "what did this reply actually
draw on".

## MCP vs REST — when to use which

Both transports reach the same vendor. They differ in **whose credential they carry**,
and that is what picks one.

- **REST (a skill wrapping a script) is the DOMAIN's road.** It carries the
  organisation's own integration key, which the egress firewall injects by host at the
  network boundary, and every member of the domain shares it. A **skill** carries "which
  endpoint, when", and the script it wraps is also the reduction stage, so a bulk
  response never hits context. The whole API is on this road, not just a long tail.
- **A connector (host-side MCP) acts as the subject on its grant.** A `user-oauth` grant
  carries one person's own account and reaches what that person can see, as that person.
  A `workspace-oauth` grant carries the organisation's account through the org consent
  ("Connect org account"). It is the vendor's curated, agent-shaped tool set — cheap,
  lazily discovered.

A vendor can have both, and holding one is no reason to avoid the other. Pick the road
by whose account the work belongs to. The REST skill stays the domain's primary road. A
bound `workspace-oauth` connector is a second organisation road, and work the domain owns
can go over either. Work the domain owns never goes over a `user-oauth` connector, because
that connector acts as the person rather than as the organisation.

An operator chooses whether to bind a `workspace-oauth` grant. The REST skill is the
domain road whether or not one is bound.

REST is deliberately *not* modelled as a connector transport: it is the egress plane. No
spec, no generated tools, no second tool surface. (An earlier "REST-via-OpenAPI"
transport that auto-generated tools from a spec was removed — it advertised a second
tool surface and spent context on every operation's result. A script from a skill is the
lighter path.) See [Skills & plugins](./skills-and-plugins.md).

## MCP vs A2A — tools or another agent

MCP and REST both give the agent a vendor's **tools and data**: the agent's own model decides each
operation. **A2A** gives the agent **another agent**: a focused enterprise agent (Agentforce,
ServiceNow, Workday, Copilot Studio and similar) takes a whole task in plain language, works on it in
its own system, and reports back. An admin declares each such agent in `agent/access/a2a-agents.ts`.
`delegate_to_agent` hands it a task after an approval card, with the asker's identity attached, and
`check_agent_task` follows a task that runs longer than one call. The answer is untrusted, like any
connector result. The other direction ships dark: with the `a2a.inbound` setting on and a caller
declared in `agent/access/a2a-inbound.ts`, another organisation's agent can call this one through its
published agent card, and each call runs as one unattended job bound external in the caller's own
surface of its declared domain. See [A2A agents](../extending/a2a-agents.md).

## How a connector reaches the agent — and how you connect one

Two tools bracket the connector plane, and neither of them is the connector itself.

`connection_search` is how the agent finds a connector's *operations* — a read of the
connected catalogues, nothing more. `connection_execute` runs one operation, named by its
`connection` and `tool` (for example connection `notion` and tool `search`). The operations are
not tools of their own, so they never appear as a fixed list anywhere. The framework re-keys each
call to its `<connection>__<op>` name (`notion__search`, `linear__create_issue`, …), and every OE
gate reads that name. Each operation is tiered by its verb when it is called (reads run, writes
draw an approval) under `connectors.opTiering`, which ships on — see the note below — and each call is
audited individually.

### Raising an operation's tier

The verb classifier is the default, not the last word. It reads `search`/`get`/`list` as
**read**, a recognised mutation as **write**, an irreversible one as **destructive** — and
anything it doesn't recognise as **destructive**, so a novel verb fails closed rather than
sailing through. A `read` runs with no prompt. A `write` and a `destructive` op each need one
approval **per call**, for exactly the input the card showed (OPE-2363): a click keeps no grant for
a later call. The approval is a person's click, or an approval-judge allow under a pre-approval rule
the deployment wrote ([pre-approval rules](../how-it-works/pre-approval-rules.md)). A judge allow is
never cached for a connector op, so an identical later call is judged again.

**Every approval here is an OE card, never a wait** (OPE-2340). A call that needs a person is
refused with "an approval card is posted", and the card goes into the room. Nothing holds a turn
on it, so the room and every other job of the conversation carry on. When a member approves, the
agent calls the operation again and it runs. The card shows the operation, its connection and its
input, rendered as data.

**This ladder needs `connectors.opTiering`, and that setting ships ON.** Turned off, the verb
is not read: every call needs a card, a read included, and a destructive op takes the same card as
a write. Set `connectors: { opTiering: false, userPrincipal: false }` in your deployment's
`agent/settings/settings.ts` only if you want that blanket grain. The boot refuses `opTiering: false`
while `userPrincipal` is on, and `userPrincipal` ships on.

**The server's own tool annotations are a second tier source** (2026-10-10). An MCP server can
declare, per tool, `readOnlyHint` and `destructiveHint` (MCP spec `ToolAnnotations`). For a
connection the deployment registered in its own code (or a plugin an admin installed), the
connector seam reads them from the framework's MCP client
(`packages/core/agent/connections/connector-tool-hints.ts`):

- `readOnlyHint: true` reads as **read**, `destructiveHint: true` as **destructive**, and both
  explicitly `false` as **write**. `readOnlyHint: false` alone names no tier.
- When the verb classifier recognises **no** verb in the name, the hint decides. So a read with an
  unusual name runs with no card when its server says it is read-only.
- When the classifier **does** recognise a verb and the hint disagrees, the **stricter** of the
  two wins. A server cannot open a `delete_page` by calling it read-only, and a server that calls a
  `search` destructive makes it draw a card per call.
- With no hint and no recognised verb, the op stays **destructive** (fail-closed).

🔴 **What this trusts.** The MCP spec calls annotations untrusted unless they come from a trusted
server. Here the trust decision is the deployer's own registration of the connection. A server
you registered can open an op whose name the classifier does not recognise by declaring it
read-only, so register only servers whose annotations you accept. A `connectorOps` raise still
applies on top of a hint (below), so you can hold any op at a card whatever its server declares.
A person's lent tool (`grant__…`) never takes hints. When the catalogue cannot be read within
three seconds, the op has no hints and the classifier alone decides. That keeps an unrecognised
name at **destructive**, but it drops a raise the server declared on a recognised name, so a
`search` its server calls destructive runs as a read on that call. The framework caches the
catalogue after its first read, so this affects a cold first call only. A `connectorOps` raise
holds whatever the catalogue does. The `connector.op` audit row
carries `opTierHint` when the server declared a tier, and `opTierHintDecided: true` when that
hint moved the tier.

It reads the **operation** half of the name and nothing else. A connection slug can itself
contain `__` — a plugin-minted connector is named `<plugin>__<server>` — so the operation is
the last `__`-separated segment. Only that segment can put an op in the `read` tier. A word in
the connection slug can still raise the tier, and never lowers it, so a slug that happens to
spell `search` cannot open an operation the classifier does not recognise.

A bundle can move an operation *up* that ladder:

```ts
defineBundle({
  name: "finance-notion",
  connectors: [{ name: "notion", credential: "team-key", contentOrigin: "internal" }],
  connectorOps: [{
    connector: "notion",
    gated: ["search"],          // this workspace is sensitive: even reads draw an approval
    destructive: ["trash_bulk"], // the vendor's own name for an irreversible op
  }],
})
```

Op names match case-insensitively, treat `-` and `_` as the same character, tolerate a
redundant vendor prefix (`create_pages` matches `notion__notion-create-pages`), and accept
`"*"` for every op of the connector.

**The declaration is raise-only, and there are two independent reasons it cannot widen
access.** First, the vocabulary has no word for it: the only fields are `gated` and
`destructive`, and there is no `open`/`read` counterpart to write. Second, the runtime joins the
declaration onto the tier the tiering arm settled, taking the **stricter** of the two — so
naming an already-destructive op under `gated` is a no-op, not a demotion. Raising the tier
of an operation is therefore always safe to do and never a way to unlock one. (A registered
tiering arm is the one rung that may *lower* a verdict, and it can never lower one below `write`.)

Two bounds worth knowing. A declaration applies **deployment-wide**, not per bound scope:
the pre-execution seam the framework exposes for an injected connector op is synchronous
and carries no caller identity, so scoping the raise there would depend on framework
internals rather than on your config. Since a raise only ever *adds* an approval, the cost
of that breadth is friction, never exposure. And this plane sets an operation's
**consequence** tier — it never changes *who may approve*; approver standing is a property
of the action kind, decided in code and reviewed in a diff.

### Declaring who authors a connector's content

Every connector grant must say who writes the bytes the connection hands back:

```ts
defineBundle({
  name: "finance-notion",
  connectors: [
    // our own workspace: org membership gates who types in it
    { name: "notion", credential: "team-key", contentOrigin: "internal" },
    // a public intake form — strangers author every row
    { name: "acme-forms", credential: "forms-key", contentOrigin: "external" },
  ],
})
```

`contentOrigin` is `"internal"` or `"external"`, and it feeds exactly one consumer: the
source-tier table that decides whether reading from a source marks the turn as having
ingested untrusted content. `"internal"` means the bound connection reaches only content org
members authored; `"external"` means anyone can author into it.

**It is a question about authorship, not about authentication.** An authenticated,
org-owned, VPN-only support desk is a system you trust completely, and its ticket bodies are
still typed by strangers — that connector is `"external"`. The name deliberately does not
say "trusted": nothing here is about how the connection is reached.

That table is **enforced** for the connector-discovery list, so the word has an effect there: an
`"internal"` connector's rows are still fenced as data but no longer mark the turn, which changes
what a later approval card discloses. A declared `"external"` connector, and an undeclared one, both
still mark it.

**The word also applies to an operation's own result.** Since eve 0.69.0 the model reaches every
operation through one `connection_execute` verb. OE reads each call's `{connection, tool}` target
(`access/untrusted-projection.ts`, `declaredContentOriginForExecuteTarget` in
`access/connector-content-origin-state.ts`), and the connection's declared `contentOrigin` for that
tool then applies to the result. So an `"internal"` declaration leaves the turn clean, and a declared
`"external"` connector, or an undeclared one, marks it.

`connection_search` belongs to no one connection, so its name matches no declaration. Its
**result** answers instead: each discovered tool answers with its own connection's declaration
for that tool, and the result is as trusted as its least-trusted tool. A search that finds only
tools on `"internal"` connections leaves the turn clean. One tool from an `"external"` or an
undeclared connection marks it. This matters on an MCP connection, where an operation mounts
only after the search finds it: a search that always marked the turn would taint every fire
that reaches the operation.

#### Per-tool overrides

One MCP server often mounts dozens of tools where only *one* reaches outside content. Rather
than under-declaring that tool or over-declaring the rest, give the connection a default and
name the exceptions:

```ts
connectors: [
  {
    name: "helpdesk",
    credential: "desk-key",
    contentOrigin: {
      default: "internal",                  // schemas, queues, agent rosters — all ours
      except: { search_tickets: "external" }, // …but ticket bodies are typed by customers
    },
  },
]
```

`except` keys are **bare tool names** — the tool as the MCP server names it, *without* the
`helpdesk__` prefix Eve mounts it under. Writing the qualified name is a config error rather
than a silent no-match. An exception only ever applies to its own connection, so a
`search` override on one connector never touches a `search` tool on another. It works in
both directions: `{ default: "external", except: { our_runbook: "internal" } }` is the
mirror case.

Three properties are worth stating plainly, because each of them is a deliberate choice:

- **It is required, and still never inferred.** Open Everywhere will not guess an origin for
  you — omitting the field is a config error naming the connection and both accepted shapes,
  not a default. A defaulted `"external"` would be indistinguishable from a considered one,
  and a defaulted `"internal"` would be a security hole with a convenience story. The one
  exception: connectors written by an **access request** or an **agent-creation** codemod,
  whose vocabularies write `{ name, credential }` and refuse a `contentOrigin` precisely so that
  no *assertion* on those paths is model-authored. Those grants declare no origin and stay on
  the fail-closed default. They still name their credential — that was the requester's choice at
  propose time, not an assertion the codemod invented.
- **Silence is not `"external"`.** A connector that reaches a session undeclared — through a
  plugin or one of those codemod overlays — resolves the table's fail-closed
  default (untrusted), but the verdict is marked *assumed*, which is how the log can tell
  "this deployment never declared" apart from "this deployment declared external". Both read
  as untrusted; only one of them is a claim.
- **It grants nothing.** A `contentOrigin: "internal"` declaration cannot widen access, reach
  a credential, or lift an approval. Every gate in *[A grant is a boundary, not a
  hint](#a-grant-is-a-boundary-not-a-hint)* below applies unchanged.

A connector granted through a **plugin** carries no declaration — that vocabulary is a bare slug
list with no field for one — so those grants stay on the fail-closed default. And two bundles
bound to the same scope that declare *different* origins for the same connection are
contradicting each other rather than overriding each other (an Eve connection is one global
instance): that resolves to a flat `"external"` and warns. Two per-tool declarations count as
the same claim only when they answer identically for every tool.

`connector` is the tool the agent uses to hand *you* the connect options for a connector — a
Block Kit card on Slack, links elsewhere. It stores no secret and grants nothing by itself.
The consequential half happens host-side **at the click**, where your standing is
re-verified before an org-level OAuth URL is minted or an API-key intake is opened; the
model is never in that loop. Options you personally couldn't use are simply left off the
card rather than shown and then refused.

## A grant is a boundary, not a hint

Granting a connector is enforced at eight layers:

1. **Config-as-code grant.** A bundle grants a connector, naming the credential it is reached
   as, bound to a scope. Versioned in git, changed by reviewed PR. See
   [Config-as-code](../how-it-works/config-as-code.md).
2. **Break-glass halt.** `assertConnectorGranted` resolves the halt state **first**, before it
   looks at the grant. A halt covering this scope refuses the call fail-closed, with its own
   `halted` reason so the refusal never reads as "that connector is not granted". No connector op
   routes through the approver chain, so this wall is the only place a halt reaches one.
3. **Per-surface hard gate.** Every connection's `getToken` calls
   `assertConnectorGranted(name)` *first* — it resolves the calling surface and refuses,
   terminal and fail-closed, if that surface wasn't granted this connector. An ungranted
   or unresolvable surface never reaches a credential. This is built into the credential
   builders, so an author can't forget it.
4. **DM-only context wall (v1, shipped off).** The framework gives *every* session that
   has connections `connection_search` and `connection_execute`, and each call names one
   operation (`notion` / `search`, …) — standing channel watchers included — so the same `getToken` gate also requires the calling
   surface to resolve a *positively-DM* context when it is armed. Armed, connector operations outside a DM seat
   (or a task worker spawned from one) are refused fail-closed before any token exists,
   and every verdict is audited (`connector.use` / `connector.refused`). **The shipped posture
   leaves this wall down:** `connectors.dmOnly` ships `false` and `connectors.opTiering` ships
   `true`, so a channel reaches a connector exactly when a domain or bundle grants it, and the
   tiering branch holds its writes behind an approval. The wall bites only with
   `connectors: { dmOnly: true, opTiering: false, userPrincipal: false }`.
5. **Disclosure gate.** The grant check runs `assertConnectorDisclosure` **last**, so the cheaper
   grant and DM checks refuse first. It judges the room, never the person who asked. Only a Slack
   bundle registers a member supplier, so the audience-floor leg refuses only on an
   externally-shared Slack channel (or while a Slack roster read has failed). The DM-only wall ships
   down, so on the shipped posture that leg sees every granted channel turn.
6. **Broad-grant lint.** Binding at org or tenant scope emits a warning at preview
   time — broad blast radius is visible before you ship.
7. **Break-glass revoke.** A control-plane override can *remove* a connector from a
   surface at runtime (narrow-only — it can never *add* access; widening is exclusively
   a reviewed PR). Plus a per-connection approval gate for human-in-the-loop. See
   [The control plane](../security/control-plane.md).
8. **Per-operation consequence tier.** Every call is classified read / write /
   destructive by its verb, and a bundle may raise (never lower) named operations with
   `connectorOps` — see [Raising an operation's tier](#raising-an-operations-tier).

## Worked example

A payments team wants the agent, in their `#payments` channel, to read their Notion
runbook (read-only) and open PRs on one repo; nothing else, nowhere else:

```ts
defineBundle({
  name: "payments-tools",
  // Notion: a connector grant — { name: "notion", credential: "team-key", contentOrigin: "external" }
  //   (host-side MCP connection, read-only key, gated per surface)
  // GitHub: an egress connection to api.github.com, token scoped to one repo
  // Every connection names its home broker: an absent `broker` fails the secret read closed.
  connections: [{ id: "gh", credentialType: "github-app", broker: "env",
                  secretRef: "GH_PAYMENTS", allowedWebsites: ["api.github.com"] }],
})
// NB: a domain scope takes the domain's BARE name — domains are cross-platform, so no
//     tenant qualifier. (A surface scope takes the qualified key: "slack/T_CO/C_PAY".)
defineBinding({ bundle: "payments-tools",
  scope: { level: "domain", domain: "payments" } })
```

- In `#payments`: the firewall lets GitHub through (one repo). The Notion grant
  resolves, and on the shipped posture the channel's host-side connector *operations* run under
  the per-op tier: reads run, writes get a card. A deployment that sets
  `connectors: { dmOnly: true, opTiering: false, userPrincipal: false }` refuses those operations from a channel seat,
  and the channel then reaches Notion by the egress/skill routes instead.
- In any other channel: the hard gate refuses Notion; the firewall blocks GitHub.
- In a DM: neither applies — a DM resolves against the caller's *own* credentials, and a
  **write** with them is admitted on the ordinary approval card (the read/write/destructive
  tiering still applies). The member plane below is the shared-room arm; a DM never enters it.
- In `#payments`, with the **member plane** armed and declared: the *asker's own* Notion
  credential resolves, for reads, keyed to the one verified person who asked on that turn.
  See [Access and scoping](../how-it-works/access-and-scoping.md) for every gate;
  `connectors.memberPlane` ships off.

That's the whole promise: **an app-layer fence over workspace-wide credentials, the secret never
touches the agent, and the boundary is enforced in six places, not trusted.**

## Credential grants — lending one vendor tool, fixed to named arguments

The member plane serves the **asker's own** credential. A **credential grant** serves
**somebody else's**, and only after that person approves it in their own DM.

A grant is one row: an owner's credential, ONE vendor MCP tool, the arguments that tool is
fixed to, one scope, one mode (`once` / this conversation / until an expiry). The owner reads
a code-rendered card in their DM. It is written as product copy and carries **no host
identifier**: it names the person who asked and the room they asked from by NAME, says what the
tool DOES in one clause ("read a Notion page"), shows the target label and every argument the
grant fixes, quotes the stated purpose, and offers four buttons. It never shows the vendor's tool
id, the mounted tool name, a platform id or a raw timestamp — those are machine strings, and a
consent card is the one message that has to be readable by the person deciding. What the
requester pinned is a different matter and stays in full, uuids included: those values are the
grant's reach, and the owner is the review of them.
Approving mounts one tool for that one chat, named `grant__<owner>_<connector>__<tool>_<target>`
— the target label is in the name so two grants of one tool say what they differ about. It mounts
on the chat's **workers**, never on its seat (OPE-2023): the seat reaches a lent Notion page the
same way it reaches the org connector, by delegating. The resolver that mounts it is `grant_tools`,
which mounts nothing under its own name and nothing at all for a chat holding no grant.

Pressing Approve is when the owner's own **live connection** is read. Their account has to be
connected first — if it is not, they get a link and the request stays open. Then the tool they
are lending is looked up in what their connection actually publishes, under their own token,
and its argument schema is snapshotted onto the row. A tool their account does not publish,
or a fixed argument that tool does not take, closes the request and tells both sides: the
owner said yes, and it could not be honoured.

What the grant buys, and what it does not:

- The tool exists **only where the owner's answer bound it**, and only on a **delegated worker**
  of that conversation. The conversational seat never carries one: it delegates, and the worker it
  spawns holds the lent tool beside the org connector's tools. The credential itself moves to
  neither — the broker spends it host-side and the borrow transport is its only holder, so what a
  worker gains is the RESULT of one pinned, frozen-argument call on one vendor tool.
  A worker of ANOTHER conversation carries nothing: a worker proves which conversation it was
  spawned from by its host-set parent linkage and continuation token, which the model cannot write.
- **An unattended fire does not hold it either.** A scheduled
  [durable job](proactivity-and-routines.md#durable-jobs-persistent-multi-step-work) wakes on its
  own timer with nobody in the room, and so does every other triggered fire — a cron routine, a
  webhook run. A grant spends one person's credential on another person's
  ask, and it audits under both names — so a wake with no requester present holds no granted tool,
  whatever vendor tool it lends. The moment a person addresses that thread the wake is escalated, and
  the grants bound to **that session** are spendable again. Escalation does not summon the domain's
  standing grants: an addressed thread is still a thread, so it keeps the exact-session rule and the
  borrowed tool does not appear. **A withheld grant leaves a
  row.** The mount writes at most one `grant.mount_withheld` audit row per **process** per session **per
  gate**, and only where the key it withheld holds a live standing grant, naming the grants it
  refused, the gate that refused them and the seat's grain — because a seat that was refused reads
  exactly like a domain that holds no grant, and an operator needs to tell the control working from a
  declaration missing.
- The granted tool sheds from a DELEGATING seat exactly as `post_message` and `dm_person` do: the
  seat routes the work to a worker, and the worker is where the tool is. Until OPE-2023 it was the
  one qualified family the lean roster carved in by shape, because no worker could hold one; that
  carve-in is gone (`packages/core/agent/access/lean-seat.ts`). Everything else about the borrow is
  unchanged: the schema is still baked, the tier still rides the grant row, the broker still
  re-checks the row on every call, and the room still gets its notice.
- The mount runs at `session.started` **and at `turn.started`**, so an approved grant is
  callable by the **next worker** that the chat that asked for it hands work to. The seat itself
  never holds the tool (OPE-2023). No deploy, no rotation and no new session. The cost is one grant read per turn on a delegated worker — two where the worker's
  root seat resolves a domain-grained key, because the standing rows bound to that room are a second
  read. A conversational seat pays neither: the resolver refuses it before any store call.
- Every argument the grant fixed is **pinned and visible** in the tool's input schema — the
  vendor's own schema, with that argument narrowed to its one allowed value (JSON Schema
  `const`) and required. `read_page(id: "12345")`. The model supplies it; an **MCP-layer
  fence** validates the outgoing call against the grant row and refuses anything else before
  the call reaches the vendor. The definition therefore says what the tool does rather than
  hiding it, and nothing between the model and the fence rewrites the arguments.
- **A pinned tool's description SAYS what it is pinned to, and names the other road.** The `const`
  above tells the model which value the fence admits. It does not say that this tool answers about
  that one target and no other, and on its own it names nowhere else to go — so a seat holding one
  pinned Notion page called the lent tool for a different page and then presented the pinned page's
  body as the page it was asked about. The host-authored description therefore carries the pin in
  words: *"PINNED TO ONE TARGET: this tool reads exactly the Notion page "Launch checklist", and
  nothing else. Use this organisation's own Notion connector for any other Notion page."* The target
  is the requester's own label — what the owner approved, and what the room's grant-use notice also
  says. **The sentence is spent only where the pin is real.** Freezing *an* argument is not pinning
  the *target*: the schema pins the frozen keys and leaves every other property free, so a grant that
  froze a filter and left the page id open still lets the model choose what to read. The host
  therefore claims a pin only for a reviewed (connector, tool) pair whose every target argument is
  frozen, and says nothing about one otherwise — including a grant that fixes no arguments, which
  still says out loud that nothing is pinned.
- **The reply's record names the page the lent tool actually fetched.** A granted read records its
  pinned target on the turn's provenance ledger, so the reply's `reply.provenance` row reads
  `notion (Launch checklist)` — see
  [*A reply names what it read*](#a-reply-names-what-it-read) above. The name is
  the grant's own pinned target, never a title read out of the vendor's bytes, so a wrong
  attribution in the model's prose is set against a host-written record. Since OPE-2487 only an
  operator reading the row sees that record; a person who asks gets the model's own, unchecked
  answer. The reach rule is unchanged: a reply the host cannot place in the room the read was scoped to
  names nothing. Three things keep the line honest, and each of them **under-reports**: a call the
  vendor answered with an error records nothing, because nothing was read; a grant whose tier is not
  `read` records nothing; and a grant that pins no target, or whose row holds no recoverable label,
  names the connection alone.
- Every call writes one audit row naming **both** people — the requester who drove it and
  the owner whose credential paid for it.
- Every **result** the vendor returns reaches the model inside the **untrusted-content
  envelope** — the same fence a channel read or a Notion read carries. The fence **names the
  origin**: the vendor tool, the owner whose credential fetched the bytes, the connector and the
  target. A granted read always **marks the turn** as having read external content, because
  no reviewed config declares a trust tier for a lent vendor tool, and silence never reads as an
  assurance. A refusal is fenced but does not mark the turn: the broker sent nothing, so there
  are no vendor bytes in it.
- **The tool's input schema is the one exception, and it sits OUTSIDE that envelope.** The
  schema the mounted tool offers is the vendor's own, read from the owner's live connection at
  approve time and snapshotted onto the grant row. Its property `description` strings are
  therefore **vendor-authored bytes in a tool definition** — a higher-trust position than a
  tool result, and one the untrusted-content envelope never wraps. Today that reach belongs to
  the vendor that publishes the MCP server. It becomes a question worth deciding before any
  connector whose published tool list is shaped by tenant content, where a schema description
  could carry text the model reads as instruction. What the pin still holds: the tool's name,
  its host-authored description line, and the `const` on every frozen argument are all
  host-controlled, and the fence validates the outgoing call against the grant row — so a
  schema description cannot change **which** call is admitted. What it can reach is the
  model's reading, including its choice of any argument the grant left free.
- Every call also posts a host-authored "acting as `<owner>`" line **into the room**, beside
  whatever the model chooses to say. The model cannot write that line and cannot suppress it:
  the host posts it itself, after the vendor call, through the ordinary post arm. The line
  names the **requester** as the actor — a granted act is the requester's act performed with
  the owner's reach, so it is never posted under the owner's name.
- **The port that carries that line is first-write-wins.** Core arms it where the granted tools
  mount, and a second registration throws, so a provider bundle can no longer replace the arm
  and stop the disclosure while granted calls keep running. When the line does not reach the
  room anyway, the call writes a `grant.undisclosed` audit row whose gate names the reason:
  `no_room_context` (the call ran outside the mount's room wrap), `no_post_arm` (the surface
  takes no mid-turn post — GitHub today), `post_failed` (the post was attempted and threw), and
  two port-level backstops, `port_unarmed` and `arm_threw`. The call itself still succeeds: it
  has already run and the credential is already spent, so the row is the evidence, not a
  refusal. **Read the row in one direction only:** it is evidence a room was left out, and its
  absence does not prove the opposite. `grant.used` is written before the vendor call, and a
  call whose transport throws exits on the refusal path without ever reaching the notice arm —
  so it leaves `grant.used`, no `grant.undisclosed`, and a room that saw nothing. See
  [Credentials & the two planes](../security/credentials-and-planes.md).
- **The owner can end a live grant at any time, from their own direct messages.** They ask the
  agent there and it lists what they are lending — what each grant can do, how long is left, and
  the reason they were given when they approved it — and they name a number to end. **The number is
  what the person says; the grant's own id is what ends it.** The listing hands the agent an id for
  each number it printed, and `end` carries those ids. That is what makes an id-named `end` safe to
  repeat: a step redelivered by a retry names a row that is already revoked, so it ends nothing, where
  a position would have named whichever grant had moved up into it. **`end all` is the one arm this
  does not cover** — it names no row, so a redelivery re-reads the live list and would end a grant
  approved in between. That is why the agent must never reach for `all` as a shortcut for one grant.
  The verb is
  `revoke_credential_grant`, and it is **DM-only and self-only**: it takes no owner argument, so
  the acting principal's own key is the query key and nobody can read or end another person's
  grants with it. It needs no approval card, for the reason `unlink_identity` needs none — a
  person must never need somebody else's permission to stop lending their own credential. The
  revoke writes a `grant.revoked` audit row and tells **both** sides: the owner reads what ended,
  and the borrowing conversation gets a host-authored notice. That second notice is
  **best-effort** — a conversation on a surface with no mid-turn post arm pinned no address to
  answer, so it cannot be reached — and it never undoes the revoke. The owner's confirmation
  therefore names the rooms it could not reach rather than claiming all of them were told.
  **What ends is the grant, not the tool.** The mount projects rows that EXIST and the broker refuses on STATE, so the borrowed
  tool may still appear in the tool list of that conversation's workers and every call on it is refused — the
  room's notice says exactly that, so a seat does not read the refusal as a fault.
- The **first successful** call on a grant DMs the owner, in the same 1:1 the approval card
  lives in. Later calls on a live grant do not DM again: the notice is how the owner learns their
  credential is in use, and that DM is where they end the grant — it is not a pager. The send
  result is recorded as a `grant.notified` audit row — one per
  grant whose notice was **attempted**, naming the owner and saying whether the DM went out
  (`sent` or `failed`). A grant whose owner could never be reached at all — no ask row, or a
  platform this deployment cannot DM — writes no such row, deliberately: that case is not
  bounded by the once-per-grant latch, so a row per call would be the pager again. What proves
  it instead is **absence**: every granted call writes `grant.used`, so a `grant.used` with no
  `grant.notified` for the same grant is a grant whose owner was never told.
- **A one-shot grant is spent by the attempt, not by the answer — but an attempt that never
  left the process gives the grant back.** The host burns a `once` grant **before** it calls
  the vendor, because a burn taken afterwards cannot tell a delivered call from a lost one.
  So the owner's "one single call" is one *dispatched* call. The single exception is a request
  the host can prove never went out — an argument the call fence refused, say: that refund
  restores the approval, and the owner's DM still waits for a call that really runs.
  **Refunds are capped at 3 per grant row per turn**, so one approval admits at most four
  vendor sessions inside a turn — the first burn plus three restorations. The fourth refund is
  refused and the row stays spent. The count lives **on the grant row itself, beside the burn
  it bounds**, so it is exactly as durable as that burn: a turn that crashes mid-step and is
  redelivered comes back with its refunds *and* its count intact, and the bound holds across
  the replay. **The allowance also rolls forward only.** The row records which turn it counted,
  as that turn's own eve ordinal, and only a strictly later turn rolls the count. So a
  redelivered turn that lands *after* a later turn has already run counts against the allowance
  already on the row, and two turns alternating on one row buy no second allowance between
  them. The host enforces that itself rather than assuming it: the agent framework promises
  nothing about a session running one turn at a time, so the bound may not rest on one. A grant
  row that already counted refunds *before* this became true keeps that one allowance for the
  rest of its life — the upgrade only ever narrows a live grant, never widens it. The
  residual worth saying plainly: a refunded call has already opened an
  authenticated session in the vendor's own log — what did not happen is the **action** the
  owner approved.
- A revoked, expired or spent grant's tool **stays mounted and refuses**, naming which one
  it was. A tool that vanished mid-plan would leave the model re-planning around an absence.
- **A grant is spendable only where a person is present.** A scheduled job wake that nobody
  addressed holds no granted tool at all — the model never sees one. If such a call reaches
  the broker anyway, it refuses `unattended_wake` before it judges the grant itself. A grant
  is approved by an owner, into a chat, for a requester's ask; on an unattended wake there
  is no requester to record and nobody to read the "acting as `<owner>`" line. The grant
  stays valid and is spendable the next time somebody addresses the conversation.
- **The reviewed connector list decides at the moment that spends, not only when the grant
  is minted.** A grant row outlives the list that admitted it, so the broker asks again
  before it resolves a transport: a row whose connector the deployment no longer admits
  refuses `connector_delisted`, before any burn and before any transport is dialled. The
  refusal says the deployment will not send the call and that the row itself is unchanged,
  because both are true — removing a connector from the list revokes nothing.

#### What a grant is bound to, per mode

The mode the owner taps decides the binding, and the two bindings are different in kind.

- **`once` and `this conversation`** bind to the **asking chat** — the eve session the ask was
  raised in. That session ends, and the grant is unreachable. Nothing migrates it.
- **A standing grant binds to the room's OWNER and to the ROOM'S OWN CONVERSATION**, not to
  the session. The scope it carries is read from the domain an operator **explicitly declared this
  room into** — so the grant outlives every seat rotation inside its expiry. This is what makes a
  30-day tap worth 30 days. Before
  it, a standing grant carried the asking session's id, and a seat rotation orphaned it: a redeploy, a
  12-hour quiet gap or a turn/token backstop each ended a consent the owner had given for a month,
  and an unattended run then needed a fresh tap.

🔴 **THE 30-DAY ARM EXISTS ONLY WHERE A CONVERSATION-STABLE KEY DOES.** The owner's card renders the
30-day button for an ask that carries a room key or a domain key, and **for no other ask**. Every
refusal listed further down this page — a direct message, a room in no declared domain, a thread
seat, an unattended fire, a domain name containing `::` — therefore withholds the button as well as
the key. Such a card offers three answers (`once`, `this conversation`, `Decline`), and it states in
one line that the long arm is not on offer and why. Two further rungs hold the same rule:

- **The mint refuses rather than narrows.** A `standing` tap that reaches the approve path on a
  keyless ask is refused by name, the `grant.card_click` audit row records
  `reason: standing_unavailable`, and **nothing is bound** — not a narrower row, no row. The ask
  stays pending, so the owner can still answer one of the arms the card did offer.
- **The lent tool states the honest span.** A `standing` row whose scope key is one eve session's —
  a row minted before this rule existed — describes itself to the model as lasting *for as long as
  this conversation lasts*, never as a number of days.

Before this, all three surfaces carried on regardless. The card offered the button, the mint bound
the row to the **asking session**, and the clock still stamped the full 30 days. The row became
unreachable at that seat's next rotation — 7 days, a 12-hour quiet gap, a turn or token backstop, or
any deploy that changes the eve build — with nobody told, and the audit trail showed a live,
unexpired, unrevoked grant that nobody could spend for another 29 days.

🔴 **The key has two shapes, and whether the room is SEATED decides which.** A seated room's own
conversation is the domain's standing seat; an unseated room's is its own wake. Seating is what
`window.topology` arms, and it ships **armed**, so every room the bot is in on a fresh self-hosted
deployment is seated (each in its own `solo` seat, unless a deployer declares a `unified` domain):

| The room | Its own conversation | The scope key |
|---|---|---|
| **unseated** — `window.topology` off, and any room no seat domain reaches | every wake in that room, threads included; nothing stamps a grain | `oe-grant-room::<domain name>::<platform>/<workspace>/<room>` |
| **seated** | the domain's `standing` seat, shared by the rooms of that domain | `oe-grant-domain::<domain name>` |

🔴 **Either key is reached by the room's WORKERS, never by its seat** (OPE-2023). The seat holds no
lent tool at all, so "the room's own conversation" is what a worker's grant lookup resolves on the
conversation's behalf — it reads the grain the host stamped on the SEAT, which eve copies into every
worker it spawns. An unseated room stamps no grain, and a worker of one is read as that room's own
`native` conversation for exactly that reason.

The room key is **strictly narrower** than the domain key: one room, where the domain key reaches
every room declared into that domain. It is the **room** and not the room's main conversation — an
unseated deployment stamps no grain, and a thread's key is its parent room's, so nothing there could
tell a thread from the room and the key claims no boundary it cannot keep. A domain name that contains
`::` is refused a room key outright — the key packs a pair, and a pair that cannot be read back is not
a key — and such a room keeps the exact-session rule.

🔴 **A `native` wake in a SEATED room mints nothing.** Two things produce one: a routing regression,
and the runtime privacy floor standing the seat down — a room just judged to need its seat stood down,
typically because an outsider is present. Both keep the exact-session rule, so the room key belongs to
rooms that have no seat by design rather than to rooms that lost one.

🔴 **The DOMAIN key names a CONVERSATION, not a domain's whole traffic.** A tapped card is one
person's consent given in one conversation, so on a seated room the domain key is admitted on exactly
one shape of seat: an **attended** turn at the domain's `standing` grain. Two kinds of seat carry the
domain's name and are refused anyway, and both were live leaks before this narrowing:

- **A thread seat.** A Discord or Slack thread, and a Notion page comment, resolve their parent
  channel's domain key — so before this, a grant tapped in a room was spendable by any thread of any
  room in the group. Measured in a live e2e run: a grant tapped in a Discord room of
  `e2e-unified` was spent two hours later by a Notion-comment seat of the same domain, on an ordinary
  organisation read that had its own credential. **The room key closes that same leak by KEY rather
  than by grain**: the Discord room and the Notion page are two rooms, so they hold two different room
  keys and neither reaches the other's grant.
- **A triggered fire.** Every fire — cron routine, webhook run, durable job wake — lands on the
  thread grain, so on a seated room it is refused by the bullet above even before the attendance gate.
  On an **unseated** room nothing stamps a grain, so the two gates no longer hold independently there
  and attendance is the whole of it. That floor needs no stamp: its third arm reads eve's own schedule
  auth slot — the authenticator, principal id and principal type, never the attribute bag — which is
  the arm written for the measured case of a fire arriving with its whole bag gone.

Neither keeps a broader consent instead. A refused seat falls back to the **exact-session rule** — it
reaches the grants issued to its own session and no others — which is the pre-OPE-1950 behaviour and
the only honest answer, because there is no narrower key for it to hold. 🔴 **That fallback governs
what a seat READS, never what it may MINT.** A refused seat is offered no 30-day arm at all, per the
rule above: `once` and `this conversation` are the honest answers there, and a standing row bound to
a session is not one of them.

The narrowing is unchanged in every other axis, and neither key arm reaches any of them. A standing
grant still names **one organisation, one owner, one connector, one vendor tool and one set of
frozen arguments**, every one of them on the row itself. It is not a grant to the domain or to the
room: it is the same one grant, reachable from the room's own conversation over time rather than from
one session of it.
A `once` or `session` row can never be reached this way even if its scope were spelled like a room's
or a domain's — the lookup tests the **mode**, not the shape of the string.

**The binding comes from the room's declared DOMAIN MEMBERSHIP**, not from the shape of its agent
seat. A room an operator has **explicitly declared** into a domain — by a `reach` entry or a roster —
binds a standing grant to that domain on an armed deployment, and to that room on the shipped
default. **The `org` catch-all does not count.** A room that reaches a domain only
through that pseudo-domain has no declared domain of its own, and binding a standing grant there
would make it spendable in every room of the deployment. Such a room, and a room in no domain at all,
keep the exact-session rule. That is the honest answer rather than a fallback.

🔴 **It does not depend on the standing-window capability.** An earlier revision keyed the binding on
the `channel_session` registry row the room's standing seat rotates under, which reads well and is
wrong: that row exists only where `window: { topology: true }` is declared, and even then is
per-channel under the `solo` window mode. The 30-day promise would have held on one armed
deployment and nowhere else. Domain membership is the thing a room has regardless, so it is what the
binding is read from — and on both topologies, which is why the shipped default keeps the survival
rather than the exact-session rule.

**A direct message binds nothing.** A domain's `reach` can be workspace-grain, which matches a DM's
address as readily as a channel's — so a standing grant approved in a DM would otherwise be spendable
from every room of the domain. A DM, a group DM, and any conversation the platform did not positively
classify all keep the exact-session rule instead.

**Existing standing grants are not migrated.** A grant minted before this change carries a session
id and stays bound to it; it lapses on its own expiry and a fresh ask replaces it. Nothing rewrites
a consent row after the fact, and a backfill would re-scope a decision its owner made about one
conversation. What such a row no longer does is **claim a span it cannot keep**: its lent tool reads
as lasting for as long as that conversation lasts, per the rule at the top of this section.

**Revoking still ends it everywhere, at once.** The domain read admits only grants that are active,
unexpired and unrevoked, so the moment the owner ends a standing grant from their own DM it stops
mounting — in the seat that asked and in every generation after it.

🔴 **What a grant does not narrow: the credential itself.** The schema and the mount are a
routing and honesty control. The owner's card is the injection control. **The vendor's own
ACL is the reach control** — a granted "read one page" tool is only as narrow as the
vendor's own sharing rules under that credential.

Today grants admit **read operations only**, decided by the same connector-op classifier the
owner's own DM uses for that vendor tool. A granted write records the *owner's* name at the
vendor on an act the *requester* drove, which is a separate decision. A domain opts in by
naming the connector on its `credentialGrants` field, with no fallback to an org default.

### Asking for one — the ask, the card, and the answer

`request_credential_grant` is the verb that raises an ask, and it is the only thing that
writes a pending row. ONE seat holds it: a **delegated worker** (OPE-2023). A conversational
seat holds none — it talks and it delegates, so "use my own Notion account" is a job it hands
to a task, and the task asks with a full kit and a fresh context. A session that is nobody's
child, such as a scheduled fire's own session, holds nothing at all. A fire's delegated child
does hold it, and is then refused: an unattended fire names no asker, and the ask requires
exactly one verified requester. A worker holds it only in a domain whose own
`credentialGrants` field names the connector.

A worker-raised ask is scoped to the **root seat's** chat, never to the worker's own
one-shot session, which ends before the owner ever clicks. The card says so: it names the
agent as the asker, then states who the ask is for, that a background task raised it, and
that a grant reaches the conversation rather than the task. The owner decides exactly as
before, and the granted tool then mounts on the workers of that conversation — so the task
that asked is gone by then, and the next task the conversation spawns is the one that spends.

🔴 **A person's word starts the ask. Nothing else does.** The rule lives in the seat prompt. Both
the standing seat and a delegated worker read it, and the verb's own description repeats it. When
**both** hold, the agent raises the ask: the person asks in words to act with their own account and
names it with an account word — "lend it my Notion account", "use my own login" — and no road
already bound to the conversation answers the ask. A road that acts as the org never answers an ask
to act with the person's own account. It looks for the verb, and where the verb is
absent it hands the job to a task. In every other case it may only **suggest** the road: name what
the org's own road could not reach, say that a person can lend their own access, once, and stop. A
possessive about content — "my pages", "my workspace", "my Notion" — names no account, so it is a
content ask and never a lend ask. A connector nobody has bound here, and a call refused with `not
granted to this surface`, are reasons to suggest — never to raise an ask nobody asked for. This is a
prompt rule, not a gate: no code refuses an unasked ask, and `detail.explicit` on a `grant.asked`
row is how an operator measures whether the rule is holding.

🔴 **The ROAD is the question before any tool is chosen, and the org's own road goes first.** The
same seat-prompt rule states the precedence, on every turn — including a turn where nobody ever lent
a tool. An ask about the page, the room or the thread the seat is in goes on the org's own road, and
so does an ask about the org's content in general. That road is the team's own access — the REST
skill and the org's own connector. A connector already bound to the conversation is on that road
too, and a direct message's own binding counts: an ask for "the pages in my Notion workspace" in a
DM whose session binds the Notion connector is answered from that connector. The connector bound
to the conversation is the org's road for that conversation, whatever account it acts as, for a read
and for a write. The agent uses it for org work there and lets the approval gate decide. It never
refuses that connector because of the account it acts as. A standing or thread seat holds neither verb
(`WORKER_ONLY_TOOLS_STANDING` in `access/worker-capability-index.generated.ts`), so the rule tells
it to **hand the job to a task** rather than to say it cannot reach the content — the same hand-over
the paragraph above already describes for the ask itself. The hand-off carries the person's words
and names no road and no account that the person did not name: a brief that said "use the org's
Notion connection" once made a worker refuse a DM-bound write as "the user's own account". One thing
overrides the precedence, and the acting-identity gate below already enforces that one: when the
**person** **names an account** to act with, in their own words and in an account word, the agent
honours it or says no, and never answers on the org's integration instead. A seat's brief, a system
note or an earlier turn is not the person naming an account. A lent tool is taken only where **both** hold: the person asking is the one who lent it and
asked to act with their own account, and the ask is about the resource the tool is pinned to. A lent
tool's bytes are never presented as another page's body, and an honest provenance record does not
licence that — the record names where the bytes came from, it does not make them an answer to a
different question.

🔴 **The rule has to reach the WORKER, and that is where the choice now sits.** The defect it
answers was a standing seat calling a lent tool, and since OPE-2023 no standing seat holds one:
`resolveGrantMount` mounts a `grant__…` tool on the workers spawned from the conversation the grant
was lent to. A worker holds the lent tool AND the org road's verbs, so it is the shape that can take
either road. The precedence lives in one constant that both personas interpolate, so it reaches the
worker; the seat's own half is to hand the job over.

This precedence is prose the model reads, and **no code enforces it**. The mounted tool's own
description carries a pin sentence that already names the org's connector as the road for any other
target (`grantPinnedTargetSentence`), and the model reads it while it is still choosing. That
sentence is not this rule: it exists only where a grant is **mounted**, and only for a reviewed,
target-pinned pair (`grantTargetIsPinned`), so a turn with no lent tool reads nothing; and it speaks
from inside one tool, which makes the org road the fallback for "any other page" rather than the
first road for org work. Neither refuses a call: a turn that takes the wrong road is contradicted by
the reply's `reply.provenance` row and by the `grant.used` audit row, not stopped. Since OPE-2487
neither is in the room, so only an operator reading those rows sees the contradiction.

The verb grants nothing. It names one person, one connector, the arguments to fix and a human
label for the target, sends one card, and **finishes**. A turn never waits for the owner —
waiting on a human in another conversation is an unbounded stall — so the model says in the
room that the ask went out and carries on.

The **vendor tool is optional, and the caller normally omits it**. The one route to a
connector's own tool names is to list that connector's tools, and **that listing is refused**:
the calling conversation is not granted the connector, which is the whole reason for the ask.
So an ask that names no tool takes the connector's reviewed default tool, and **this page is
where the default is written down**: `notion` → `notion-fetch`. The owner reads that name on
the card and can decline it. A caller that has already seen the vendor's own name still gives
it and wins. A connector with no reviewed default tool is refused rather than given an invented name.

What bounds the ask, each one enforced rather than written:

- The **domain** must name the connector on its own `credentialGrants` field. There is no org
  default, and that field speaks for this plane alone — it cannot arm the member plane too.
- The turn must name **exactly one verified requester**. A turn several people woke, or a
  scheduled fire, has nobody to record as having asked.
- The **connector must be one this deployment admits a grant role for**. The vendor TOOL is
  not checked here — nothing at ask time holds a token that could read the owner's catalogue —
  so it is checked against their live connection when they approve. That is also why the field
  is optional: a name nothing at ask time can read is a name the asker cannot be required to
  supply.
- **One live ask per (requester, owner, tool, target).** A second ask while one is
  pending answers "already asked" and sends nothing. This is what stops a model that
  re-plans on a refusal from paging a person on every retry.
- A pending ask **expires on its own short TTL**, which is not the grant's. A late click
  loses the approve compare-and-set; it is not caught by a screen state.
- A turn that has already **read external content may not ask at all**. The purpose line is
  the one thing the owner reads to decide, and fetched content must never author it.

The owner's card arrives in **their own direct messages**, never in the requesting room.
Consent must not be socially observed: a card in a shared room makes a person's "no" a
public act in front of colleagues, which is a pressure to say yes. Every field on the card
comes from the row, and the one model-authored field — the stated purpose — renders as
quoted, escaped data. The four answers are **buttons**: once, this conversation, a standing
grant with an expiry, or decline. The mode is a click, never a field the model filled in.

The card **hides no reach**. Every argument the grant fixes is listed, value by value, with a
marker on any value too long to show in full and a steer to decline when the list is cut. Where
this tree has no reviewed plain-English description of the vendor tool, the card says so and
steers to decline rather than falling back to the tool's id — an id tells the reader nothing the
generic phrase does not.

A tap goes straight to core. The clicker is the **surface's own verified interaction
envelope**, never a field in the payload body, and the ask's owner is compared against it:
a card meant for somebody else is refused, and "not yours" and "no longer open" are
deliberately one answer so the button cannot confirm that an ask id belongs to somebody.
The owner gets a private answer telling them exactly what the room can now do, and for how
long — a duration and a clock time, never an instant.
**Slack and Discord both route the tap today.** A surface with no component plane (Teams)
delivers the card's text alone and never fakes a button. **No surface parses a typed
answer** — a reply in words reaches nobody, so an unanswered ask simply lapses and nothing
is granted. The card's own copy says exactly that, and it never claims a tap worked.

**A tap the click route resolves writes at most one `grant.card_click` audit row, and a failed
one says why.** Read the row in one direction only: it is evidence of a tap, and its absence
does not prove there was none. Two gaps are deliberate. The write is **best effort** — a row
that cannot be written is retried once, then counted and dropped rather than failing the
owner's tap. And a half-understood payload of ours — one that parses as a grant card but names
no user or no channel — is answered and dropped at the surface door, before the route that
audits. The
row carries the ask id, the button the owner pressed, the clicker's own id and the outcome —
`approved`, `declined`, `not-yours`, `gone` or `failed`. It never carries the stated purpose,
which is model-authored text, and never a credential. A `failed` row additionally carries
`reason`, a closed host-authored enum, so a reader learns what the owner learned rather than
having to ask them to read their own screen:

| `reason` | what happened |
| --- | --- |
| `consent_required` | The owner's own account is not connected yet. The row also carries `linkDelivered`, saying whether the connect link reached their DM. The ask stays pending. |
| `catalogue_unreachable` | The owner's connection could not be read — a timeout, a refused response, a connector this deployment cannot resolve. The ask stays pending. |
| `owner_unresolvable` | This deployment cannot name the owner's own credential row, so nothing could ever be spent under the grant. The ask stays pending, and an operator fixes this rather than another tap. |
| `tool_absent` | The owner's connection publishes no tool the ask names. The ask is closed and both sides are told. |
| `frozen_args_unknown` | The ask freezes arguments the vendor's tool does not declare. The ask is closed and both sides are told. |
| `mint_refused` | The tree changed between the card and the tap, so the approve-time mint verdict refused. This one is decided AFTER the approve compare-and-set, so the ask is spent and no grant exists: a second tap answers `gone`, and the request has to be raised again. |
| `click_threw` | The click route itself threw, so no approve verdict exists to name. |

The first six are the same values the owner's private answer is written from, so the row and
the sentence cannot say two different things. A tap that throws still leaves a row: an
unaudited tap would read in the log exactly like a tap that never happened.

Whatever the owner decides is **posted back into the conversation that asked** — the room
learns the answer where the ask was raised, rather than by trying a tool and finding out.
An approval names the tool the chat now holds — that notice is read by the seat, so it carries the
mounted name; a decline says only that the answer was no.
A person's reason for refusing their own credential is theirs.

### A Notion read never answers "use my own account" with the team integration

A member can say which account to act with, and the agent must honour it or say that it
cannot. The two **acting identities** are the ones the credential plane already names:
`install`, the integration the deployment configured, and `human-acting`, the member's own
connector account. They do not see the same pages — the integration sees what it was shared,
and a person sees what they may read — so answering "read this with my own Notion account"
on the install key answers as the org while the member reads it as their own view. They
cannot tell from the answer.

The control is code at the seam where the credential is chosen, not an instruction in a
prompt. The gate has four answers:

- The requester **named no account** — the install identity, exactly as before.
- They named **their own** and this chat holds a live personal grant — `human-acting` is
  required. No vendor read tool can spend it, so the refusal names the `grant__…` tool that
  can.
- They named **their own** and no grant is held — **refused**. The refusal names
  `request_credential_grant` where the domain admits a grant, says plainly that there is no
  consent flow to start where it does not, and in both cases says the shared integration is
  used only if the member agrees to it.
- They named **both their own account and the team's** in one sentence — **refused**, with
  the question put back to them. Which they meant cannot be read off the sentence, and both
  guesses are wrong in a way they cannot see from the answer.

There is no fifth answer, and no arm that runs under `install` once an account was named.
Every decision writes one `connector.acting_identity` audit row naming the connector, the
identity required, the identity run, the reason and the tool — the ordinary read included, so
the trail can answer "which account read this page". The row records **that** an ask was
recognised and never what it said: the audit record has no delete path, so a member's own
words must not enter it.

**A connector tool is not the only road to a vendor, and the other road writes the same row.**
A delegated worker can reach Notion through the sandbox REST skill, where the egress firewall
stamps the team key and no tool call reaches the gate at all. That road is refused on the
access plane instead: the connections holding the vendor's credential are withheld from the
session's reach, so the key is never stamped. The worker's own firewall pass then writes the
same `connector.acting_identity` row, from the same decision, with the **route** in place of a
tool name (`egress:<connection>`, comma-joined where there is more than one). The delegated
worker's road therefore joins the tool road in that trail. Two bounds hold, and the credentials
page below states both exactly: a SEAT's own ask turn writes only the egress-plane row, and a
delegating seat's worker is failed — with the gate's own refusal as its message, which reaches the
seat in the settlement report, with a line telling it to say the words in the room. See
[Credentials & planes](../security/credentials-and-planes.md#an-own-account-ask-is-refused-on-this-plane-not-answered)
for what the withholding covers and where its bounds are.

**The ask leaves its own row, before any read.** `connector.acting_identity` is written per
gated connector read, so a seat that answers "I cannot act as you" **without reading** reaches
no gated read and writes none. That refusal is the correct outcome, and without a second row it
looked exactly like a turn that never happened. So the delivery where the grammar recognises the
ask writes one `connector.own_account_ask` row naming the connector, the identity the ask
requires, what the turn must do next, and whether a delegated worker inherits the ask. It
carries no member words either. An auditor joins the two: this row says a person asked, and the
acting-identity rows say which credential each read then chose.

**Which reads are gated.** On **Notion**, every call site in the bundle that resolves the
deployment's own Notion credential and returns Notion content: `read_notion_page`,
`read_notion_comments`, `notion_search`, the generic `read_channel` / `read_thread` pair's
Notion arm, and the federated `search` tool's Notion arm. Gating some and not others would
move the defect one verb along.

Two Notion reads sit **outside** the gate, both for the same reason — no requester turn stands
behind them, so there is no ask to honour. The first is the memory backing: an org-default subtree
pull. The second is the **seat catch-up fetch**
(`packages/providers/notion/agent/channels/notion-catch-up.ts`), which sweeps the seat's own page
for comments since its last wake. It fires from a webhook route with no turn, over the container
the wake itself already admitted, and `lint:own-account-gate` cannot catch it: that lint reds only
when a connector has *no* gated call site at all.

On **GitHub**, the tree holds NINE reads and EIGHT of them call the seam: the
bundle's conversation reads — `read_channel` / `read_thread` and the worker's
`read_work_channel` / `read_work_thread`, all four admitted through one `admitContainer` —
plus core's `check_pr_status`, `get_pr_feedback`, `read_github_issue`, `walk_pr`,
`subscribe_pr`, `checkout_repo` and the GitHub arm of `search`. The seam lives in core
(`agent/scm/github-acting-identity.ts`) because all but one of those call sites do: the SCM
plane stays in core by doctrine, and a seam inside the bundle could not reach them. GitHub's
write verbs stay outside, under the write residual below.

**The NINTH read is the reaction-feedback poll, and it is ungated by decision**
(`packages/providers/github/agent/channels/github-reaction-feedback.ts`). It reads the
reactions on a comment the agent itself posted, so it is an INGRESS with no requester turn
behind it — the same shape as the memory backing above, and there is no own-account ask to
honour. It is named here rather than left to the scan because the scan cannot see it: the §9
arm of `packages/core/scripts/github-acting-identity-test.ts` matches every `resolve*Token`
that a module under `agent/scm/` exports, plus `agent/scm/app.ts`'s own mint method, and this
poll mints through the bundle's own `installationTokenFor`
(`channels/github-post-arm.ts`) instead. The same §9 arm
DERIVES that blind-spot set — it walks the bundle for the mint, subtracts the minting module
itself, and refuses unless the result equals the set it declares — so a second module that
starts minting this way reds there rather than passing in silence, and the count above moves
with it.

**That NINE is the gated set plus the scan's blind spot — it is not every read in the
tree.** Two more reads resolve an installation token and are ungated by decision, both
INGRESS: the standing seat's since-last-wake catch-up
(`packages/providers/github/agent/channels/github-catch-up.ts`) and a routine's entity
re-fetch (`packages/core/agent/routines/github-entity-read.ts`). Neither has a requester turn
behind it, so neither has an own-account ask to honour, and the container each reads is the
one the wake or the routine already named — there is no requester-named repository a personal
credential could answer differently. Both are recorded in `UNGATED_BY_DECISION` in
`packages/core/scripts/github-acting-identity-test.ts`, which is where the §9 arm forces a new
installation-token read to be gated or named with its reason.

**A lint holds the floor as the connector set grows — and it is a floor, not the whole
claim.** The own-account **ask producer** derives its vendors from the shared registry
(`ownAccountAskVendors()`, `connections/own-account-vendors.ts`) — the connectors that admit a
credential grant, plus the connectors that declare a `human-acting` credential family — so a
connector added to either list is recognised in a member's words the same day, and a delegated
worker adopts the stamp for it. The registry also holds each vendor's spoken aliases, so a
word the gate recognises at a call site is a word the producer recognises too.
`npm run lint:own-account-gate`
reds when such a connector has **no** gated call site at all. It cannot tell whether *every*
read site for that connector is gated — the enumeration above stays a review obligation, and
the "gating some and not others" hazard is still the author's to avoid. Every gated call site
declares the connector it covers in an `own-account-gate:` marker, because the connector
reaches the gate as a value and cannot be read from the source.

The lint also reads a **second** reviewed list: the connectors that declare
`humanActing.supported` **and** hold a credential in the `human-acting` family. A gate for one
of those is legitimate even where no borrow route exists — the deployment has declared a
personal credential family there, so the gate has a decided reason to refuse. GitHub above is
that shape. Both halves are required: `humanActing.supported` on its own is a *vendor* fact
that an author is asked to record for any vendor they research, and a gate exempted by a
research note is the stale join again under another name. What the lint still reds is a gate
naming a connector **neither** list recognises.

**What is not gated — read this before trusting the heading.** The control covers Notion
**reads through the provider bundle**, plus every GitHub read, and nothing else. These routes
stay on the install identity, and a member's own-account ask does not change them:

- **The egress firewall.** A shell `curl` to the vendor's API under a `connections` grant
  chooses no acting identity per call, so this gate does not see it. That path is bound by
  config at session start, and narrowing it per turn is a change to the access plane rather
  than to a tool. This is the route the 2026-09-07 trace actually took, so the measured
  incident is **not** closed by this gate alone.
- **Notion writes.** `notion-post-arm.ts` and `notion-message-ops.ts` resolve the deployment
  credential ungated. A write asked for "as me" still runs as the integration.
- **Ingress and the memory backing.** A webhook delivery and the org-default subtree pull
  have no requester turn behind them, so there is no ask to honour.
- **GitHub's writes.** `open_pull_request`, `post_pr_walkthrough` and the issue-write verbs
  resolve the same App installation token to write. "Which account may ACT" is a different
  decision from "which account may answer", and this seam does not make it. The general write
  residual above covers them.
- **The GitHub arm of `search`, as a SENTENCE rather than as a substitution.** That arm is
  gated like the rest, so an own-account ask returns no GitHub results. But the federating
  `search` tool catches a per-connector failure and reports it as a named absence, so the
  refusal reaches the model as information inside that tool's untrusted-fenced output rather
  than as an instruction it will follow.

The residual matters for the reason this control is code rather than a prompt: after the gate
refuses, the model still holds a working team-credential path to the same vendor. What stops
it there is the refusal sentence, which is an instruction — the weaker thing this section
exists to replace.

The ask is recognised from the **requester's own visible words** — the one `trigger="true"`
message of the wake, never the whole envelope, whose backscroll carries other authors'
bodies — through the same capture fence the approval judge reads. A delegation child's brief,
a triggered fire's payload and every tainted spawn are refused there, so a page's own text
can never ask for a person's credential. The recognised fact then rides a host-set auth
attribute into the workers the seat delegates to, because a worker has no requester words of
its own and a worker is where the substitution happens. A worker adopts the stamp only from
its own seat, and only for the vendor it asked about. The producer writes a stamp for every
connector on either list — the credential-grant connectors and the human-acting ones — so this leg
reaches Notion and GitHub alike. Only when the catalogue read throws does the producer fall back to
the credential-grant half on its own, and it clears no stamp on that degraded pass.

The grammar is deliberately narrow. It wants a contiguous possessive phrase — `my own
<noun>`, `my personal <noun>`, or `my <vendor> <noun>` — and that phrase must be **bound to
the vendor**, not merely share a sentence with its name: either the vendor's own name sits
inside the phrase, or the phrase names no account holder of its own and sits within three
words of it. Sharing a sentence is not binding — "read the Q3 page in Notion while I check my
own GitHub account" names a GitHub account, and reading it as a Notion ask would refuse every
Notion read that turn and file the refusal under the wrong vendor.

Bare `my <noun>` is not enough either: "my account manager" and "my accounts payable process"
are ordinary business language, and refusing them would be a broken tool. A missed ask leaves
the shipped behaviour standing; a false one refuses a read nobody asked to personalise.

### Which credential a granted call actually spends

The broker names the vendor tool the grant lends. A **registered borrow transport** drives
it, and core registers one generic transport for every connector the deployment admits
grants for — a provider package registers nothing here. The broker resolves the **owner's
OAuth vault subject** and hands it to that transport, which mints the owner's token against
it. That subject is derived by the same composer the owner's own authorization wrote
through, so a granted call reaches the row that consent created and no other.

Two refusals name this seam, and a granted tool stays mounted through both:

- `no_transport` — this deployment holds no way to send the call: the connector has no
  connection, or no registered borrow transport, or the row names a path nothing serves.
  The grant itself is still valid, and nothing is burned.
- `owner_unresolvable` — the row does not name the owner in a form this deployment can
  resolve a credential for. There is no fallback: a granted call never spends the
  requester's credential and never spends the deployment's own integration key.

🔴 **A granted Notion call spends the owner's ordinary MCP credential — there is no second
one.** Notion declares exactly one per-user credential, `user-oauth`, homed at the managed
MCP connector. It carries two paths: the owner's own DM, and a grant that lends one of the
owner's MCP tools to another chat. Its endpoint rule names `mcp.notion.com` and nothing
else.

🔴 **Do not give it a rule naming `api.notion.com`, and do not declare a second per-user
credential to get one.** Notion runs two disjoint OAuth token families: the managed MCP
connector mints tokens hosted MCP accepts and `api.notion.com` rejects; a standard OAuth
connector mints the reverse. A rule naming both hosts would pass the fence and then send an
MCP-family token to REST, which Notion answers 401 — under a named person. And a second
entry would not be additive: `offerableCredential` returns the FIRST credential of a type in
catalogue order, so declaring a second credential of an existing type makes it unreachable
rather than offerable.

**No granted Notion call reaches `api.notion.com` at all (OPE-1136).** Personal lending
borrows a vendor MCP tool, so the request is an MCP `tools/call` under the owner's MCP
token, bounded by the MCP call fence rather than by a URL rule. There is one lending path
and it is this one.

### The org's own Notion MCP credential

Notion also declares **one** `service-oauth` credential, `workspace-oauth`. It exists so an
**unattended routine** can reach Notion without touching anybody's DM credential. A routine fires
on a channel, the DM-only universe gate refuses `user-oauth` there, and that refusal is the point —
a routine that spent a person's own DM credential would reach into their vault row with nobody
present.

🔴 **Say what the app subject buys, and no more.** It buys one thing, and it is a storage fact:
OE holds the token in a vault row keyed to **no principal**, so a routine spends it without
reading any person's row. It does **not** buy a vendor-side org identity. OE composes a
byte-identical authorization request for both subjects — the subject is OE's own vault key, not a
grant type Notion is told about. Notion issues the same MCP-family token it issues on the DM path,
authorized by the admin who consented and bounded by **that person's** access in the workspace
they picked. So an unattended write under this credential carries the consenting admin's Notion
reach. Narrowing it is a choice that admin makes at Notion's consent screen; no catalogue field
here can express it.

It shares `user-oauth`'s OAuth home ref, `mcp.notion.com/notion-mcp`, and that is deliberate.
One provider entry describes one authorization server and one resource, and both credentials
target hosted `mcp.notion.com`. The vault keys a token by **provider ref and subject**, so the
two credentials read different rows — the org's row is keyed to no principal, the person's row
is keyed to their qualified vault subject. One registered client, two rows, no shared token.

Its endpoint rule names `mcp.notion.com` and nothing else, for the same reason `user-oauth`'s
does: the token is MCP-family, and `api.notion.com` answers it 401. **No Notion credential in
this catalogue names both hosts.**

**A grant alone mints nothing.** An **org admin** clicks "Connect org account" on the
connector card and consents at Notion; only then does a token exist. Until then the mint raises
user-auth-required and the connector op refuses. The grant declares the permission, the consent
creates the credential, and the two are separate acts by design:

| | Who starts it | Where the token lands | Who may spend it |
| --- | --- | --- | --- |
| `user-oauth` | The person, in their own DM | The vault row for their qualified subject | That person, in their DM — and a grant that lends one of their MCP tools |
| `workspace-oauth` | An **org** admin, from the connector card | The vault's **app** row for this connector — one row per deployment, with no org or domain qualification | Any surface whose bundle grants `notion` as `workspace-oauth` — including an unattended routine |

Two controls bound the org route, and **neither is sufficient alone**:

- **Who may ask.** `resolveConnectorOptions` omits every app-principal option for a non-admin, and
  every org-subject **mint** option for a non-**org**-admin (omission gate 2b), so neither a member
  nor a domain admin sees the button. That is presentation, not the control: the click handler
  resolves the credential from the catalogue without consulting standing. The control is the Slack
  click handler's **host-side** re-derivation of standing, from the payload facts and the live
  domains config rather than from the card. Both gates read one predicate,
  `unqualifiedAppRowMintHome`, so the offer and the click cannot diverge. A forged click by a member
  or by a domain admin mints nothing, and that refusal is what a forged click actually meets.
- **Who may complete.** `completeAuthorization` checks **no principal**: whoever opens an
  authorization URL binds the row it writes. So the URL is delivered ephemerally to the
  clicker on Slack, and on a surface with no buttons it mints **only in a DM** — that surface's
  connect text is host-posted into the room, and an org URL in a shared room would let any reader
  bind their own Notion workspace as the credential every routine then spends. The completion is
  audited (`connector.credential_bound`), and that row names **no principal** — the route has none to
  name, and the only id in reach on a user subject is the vault subject, which is a vault key rather
  than a principal id. The row says a credential was bound, never by whom. Who *asked* is on the
  record already, as the `connector.oauth_url_issued` row the click wrote.

🔴 **The binding is last-write-wins, and the ledger witnesses the swap — it does not prevent it.**
`storeToken` writes the app row unconditionally; there is no "already bound" check. So a second org
admin who consents with a different Notion workspace **replaces** the credential every routine
spends. The completion writes a `connector.credential_bound` row, and a serial second consent
carries `rebound: true`, so the swap is on the record; the first admin is still told nothing. Re-consent is therefore a deliberate
act to schedule, not a safe retry.

🔴 **The app row is deployment-wide, which is why the mint takes an ORG admin.** The row carries no
org and no domain, so one consent binds the credential that every domain granting `workspace-oauth`
will spend. A domain admin's standing is too narrow for that reach and the mint refuses it. Only
`e2e-connector-fixture` grants the credential today, so nothing is conflated live — but a second
grant makes that one row a shared identity, which is a decision to take deliberately rather than
discover. A domain-scoped app row is a separate design, not a smaller version of this one.

A grant row that names no vendor tool is not a borrow, and the broker fails it closed —
`no_lent_tool`, before any burn.

### The three `oe-oauth` dialects

`oe-oauth` is the built-in user-authorization flow. Each connector declares its own sign-in in
its connection module, next to its URL, with `declareConnectionSignIn(homeRef, { mode, … })` from
core `agent/connections/connection-sign-in.ts`. The key is the OAuth home ref of the credential,
for example `mcp.notion.com/notion-mcp`. The declaration states which dialect its authorization
server speaks. The mode is never inferred from which fields an entry carries: a declaration that
looks confidential but declares no mode is refused, because guessing would silently change how the
deployment authenticates. (The provider map was the `OE_OAUTH_CONFIG` variable until OPE-2411.)

| Mode | For | How the client exists | How it authenticates |
| --- | --- | --- | --- |
| `discovery-dcr-pkce` (default) | Hosted MCP servers that publish RFC 8414 metadata | The adapter registers itself (RFC 7591) | PKCE, public client, no secret |
| `static-confidential` | Vendors with no discovery and no registration, such as Notion's REST OAuth | A human creates it in the vendor's portal | HTTP Basic over a client id and a client secret |
| `xaa` | Apps paired with your Okta org through Cross App Access (ID-JAG) | An Okta admin pairs OE with the app; the app issues OE a client | The person signs in to Okta once; each mint is two HTTP Basic token calls |

A `static-confidential` declaration never holds the secret itself. It names a `clientSecretRef`,
and the adapter reads that ref through the credential broker at the moment of each token
call — so the secret lives encrypted in the credential store and nowhere else. A literal
`clientSecret` in the declaration is refused outright.

Every mode sends the same callback, `https://<deployment address>/oauth/v1/callback`. The address is
`OE_PUBLIC_BASE_URL` when it is set, else the Vercel production domain, else this deployment's own
generated host (OPE-2669). A `discovery-dcr-pkce` client registers once, with the callback of that
moment, and is never registered again. If the address changes later (an operator sets
`OE_PUBLIC_BASE_URL`, or a custom domain changes the Vercel production domain), that client keeps
sending the callback it registered with, because the provider accepts no other. The old host must
still route to the deployment. Nobody registers a callback by hand for this mode.

### Cross App Access (`xaa`): a personal connection with no per-app consent

**It ships dark.** Nothing in this section runs until a connection declares `mode: "xaa"`, which
needs an Okta org that an admin has set up as below. A deployment that declares no `xaa` sign-in
behaves exactly as before.

Okta's Cross App Access (XAA) implements the IETF draft *Identity Assertion JWT Authorization
Grant* (ID-JAG, `draft-ietf-oauth-identity-assertion-authz-grant-04`). The Okta admin pairs OE with
each app once, in the Okta console, and revokes it there. A person then gets a working personal
connection to every paired app with no consent screen at the app.

**What the person does.** They sign in to Okta through OE **once** — not once per app. OE needs a
token from that person to exchange, so this one sign-in cannot be skipped. If the person already
has an open Okta session, the sign-in usually completes with no prompt. The first time any `xaa`
connection needs them, the agent sends the ordinary "connect your account" link, and it points at
Okta. After that, every `xaa` connection that names the same Okta client reuses the same sign-in.

**What a mint does.** Each app token costs two calls:

1. **Leg 1, at Okta** (RFC 8693 token exchange). OE presents the person's Okta refresh token and
   asks for an ID-JAG for the app's authorization server (`audience`). OE authenticates as its own
   Okta client.
2. **Leg 2, at the app** (RFC 7523 JWT bearer grant). OE presents the ID-JAG and gets the app's
   access token. OE authenticates with the client the APP issued it. The app checks that the
   ID-JAG names that client.

OE caches the app token for its lifetime and never mints per call. Okta caps ID-JAGs at 250 per
person, per app, per month without the *Okta for AI Agents* add-on, and an hourly re-mint over a
working month stays under that cap. The cache is single-flight across processes. OE never stores a
refresh token from the app: the draft says the app should not return one, and a re-mint is the
only refresh path.

**Whose sign-in counts.** The sign-in link is a capability URL, and the Okta refresh token it
yields mints tokens for every `xaa` app. So the completion verifies the Okta id token (signature
against Okta's JWKS, issuer, audience, expiry and the sign-in's nonce). It then admits the sign-in
only when the Okta user id (`sub`) is a **confirmed `okta` account on the requester's link-set**.
This is the same rule as the AWS Identity Center link: a join on the account id, never on an email,
and a refusal by default. A refused sign-in stores nothing, spends the link and writes one
`connector.xaa.link_refused` audit row that names the requester. When the refusal comes from the
binding, the row also names the Okta account that signed in. An id token that does not verify
names nobody, so its row carries the failed check instead.

OE checks the binding again at **each mint** (once per token lifetime), not only at sign-in. An
operator who revokes the person's `okta` link, or suspends their link-set, stops the minting at the
next mint: OE deletes the stored Okta grant, and the person's next sign-in is refused until they
are linked again. A cached app token still serves until it expires. When the identity-link plane
cannot be read, the mint is refused with a retryable error and the Okta grant is kept. Each refusal
row carries a `stage`: `sign-in` for a refused sign-in, `mint` for a refused re-check at a mint. At
`mint`, the `reason` tells the two cases apart: the link is gone and the grant was deleted, or the
link plane could not be read and the grant was kept.
The Okta directory arm proposes each person's own `okta` account (see
[Identity](../how-it-works/identity.md#pre-populating-links-from-an-idp-okta)), but only while an
`xaa` sign-in names that Okta org.

**Revocation.** The Okta admin revokes by one of these acts: deactivate the OE agent, unassign the
person or group, or remove the app's resource connection. The next mint then fails:

| Where it fails | Error | What the person sees |
| --- | --- | --- |
| Leg 1 refuses on policy (`access_denied`, `unauthorized_client`, `invalid_target`) | `oe_oauth_access_removed` | The reason, and **no** sign-in link: a new sign-in cannot restore an admin's revocation. |
| Leg 1 says the Okta grant is dead (`invalid_grant`) | needs re-consent | A new Okta sign-in link. Okta refuses that sign-in if the admin unassigned the person. |
| Leg 2 refuses (`invalid_grant`, `access_denied`, `unauthorized_client`) | `oe_oauth_access_removed` | The reason, and no sign-in link. |

An app token that OE already holds stays valid until it expires (up to one hour in Okta's
example). The draft defines no push revocation. A person's offboarding purge deletes their app
tokens and their Okta grant, and revokes the Okta refresh token at Okta first. When the `xaa`
declaration is already gone, the purge still deletes the Okta grant, but it cannot revoke the
refresh token at Okta, because no client is left to authenticate with.

**The declaration.** On a declared MCP server (`agent/access/mcp-servers.ts`), the server's `url`
is the resource both legs name:

```ts
{
  name: "datadog",
  url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  description: "Datadog: query metrics, logs and monitors.",
  signIn: {
    mode: "xaa",
    idpIssuer: "https://acme.okta.com",            // the Okta ORG authorization server, not /oauth2/default
    idpClientId: "0oa…",                           // OE's OIDC app in Okta
    idpClientSecretRef: "db:okta:oe-client-secret",
    audience: "https://app.datadoghq.com",         // the app's authorization server issuer
    resourceTokenEndpoint: "https://app.datadoghq.com/oauth2/v1/token",
    resourceClientId: "…",                         // the client id the APP issued to OE
    resourceClientSecretRef: "db:datadog:xaa-client-secret",
    scopes: ["mcp:read"],
  },
}
```

Both secrets are credential-store REFS (`oe secret set <ref>`), each with an optional broker
(`idpClientSecretBroker`, `resourceClientSecretBroker`, default `db`). A literal secret is refused,
and every endpoint must be `https`. The values above are placeholders, not a tested Datadog
configuration. An `xaa` connection acts only as a person: it has no service account, so a bundle
that grants its `workspace-oauth` credential gets a refusal at mint time.

**Set it up in Okta.** A super admin does these steps in the Okta Admin Console (from Okta's
agent-to-app guide):

1. Create a custom **OIDC web app** for OE. Grant types: authorization code and refresh token.
   Scopes: `openid` and `offline_access`. Redirect URI: OE's one OAuth callback,
   `https://<deployment address>/oauth/v1/callback`. The address is `OE_PUBLIC_BASE_URL` when it is
   set, else the Vercel production domain. Ask the agent for "your OAuth callback URL" in a DM or an
   internal channel, and it gives the full value. Store its client secret with
   `oe secret set <idpClientSecretRef>`.
2. On that app, open **Machine Assignments → Resources → Register AI agent**. Okta creates the
   agent in the STAGED state. Give it the same client credentials.
3. Make sure the target app is an XAA-enabled Okta Integration Network app, or configure a custom
   one under **Machine Assignments → Callers → Cross App Access (XAA)**.
4. On the agent, open **Resource connections → Add resource connection**. Set the resource
   identifier, the client id that the APP issued to OE, and the scope policy.
5. Assign people or groups to the OE OIDC app, then activate the agent.
6. In OE: link each person's Okta account (the directory sync proposes it), store the app's client
   secret with `oe secret set <resourceClientSecretRef>`, and declare the connection.

**Test it without a paid tenant.** The free [xaa.dev](https://xaa.dev) playground has a simulated
IdP, a resource authorization server and a resource MCP server, so it can run both legs. It is a
hosted beta, so it is a manual check, never a gate.

**What is not proven.** The gate tests run both legs against in-process fakes that enforce the
protocol (`packages/adapters/scripts/oe-oauth-xaa-test.ts`). No run has exercised a live Okta org
or a live app yet. These points are open:

- Today the apps admit named partner agents only (Datadog's preview names Claude as its only
  agent). A self-hosted deployment is a new client each time, and no vendor documents a
  self-service way to register one. Until an app admits OE's client, leg 2 refuses.
- OE authenticates to Okta with HTTP Basic (`client_secret_basic`). Okta's guide shows
  `client_secret_post`; Okta normally accepts both, but this is not proven against a live org.
  `private_key_jwt` is not built.
- The leg-1 error codes for each Okta revocation act are not documented. The table above is OE's
  mapping, not Okta's statement.
- OE presents the person's Okta refresh token as the leg-1 subject token and keeps it. If the OE app
  in Okta rotates refresh tokens on use, and Okta treats the exchange as a use, the stored token
  goes stale and the person must sign in again. This is not proven either way.
- The MCP extension `io.modelcontextprotocol/enterprise-managed-authorization` is not declared in
  the client capabilities. A server that requires the declaration refuses OE.

### After you consent: what resumes, and what does not

Asking a person for consent interrupts a request. They asked for something, the connector
had no grant for their account, and the agent replied with an authorization link instead of
an answer. The plane's job is to give them that answer back.

**While the turn is still running**, nothing is lost: the framework resumes the paused turn
the moment consent lands, and a per-turn memo self-heals so the retry mints for real.

**After the turn has ended** — the common case, because opening a link and signing in takes
longer than a turn — the detour is recorded. At the moment the link is minted, the agent
writes down where the request came from: the surface, the room, the thread, the id of the
session it paused, and the person the link was minted for. That record rides the
authorization as opaque carriage, is stored beside the pending-authorization row, and comes
back when your browser returns. It carries conversation addresses only — no token, no link,
no authorization code.

What the return hop then does:

| The return lands and… | What happens |
| --- | --- |
| the request was a **work-session job** that stopped for this sign-in, and the window is still open | The job **resumes on its own** (OPE-2462). The agent posts one line into that same conversation ("Your Notion account is connected. I'm picking up your request now.") and wakes the conversation's seat to run the same job again. The seat posts no hand-off; its next words are the answer to what you asked. |
| any other request, and the window is still open | The agent **posts one line into that same conversation** saying the connection is live and asking you to reply there. Your reply picks the request up. |
| the window has already closed | The agent asks you to **make the request again**. It never picks the old one up silently. |
| the surface stated no reply address when you asked | **Nothing is said**, in the conversation or on the return page. With no address to write down, no record was kept — ask again and the request runs. |

**Why a work-session job can resume on its own, and a seat's own turn cannot.** A job the seat
forwarded to the work session has a request row: the room, the seat, the frozen binding and the
verified requester the original ask carried. When the job settles `needs-sign-in`, the work session
files that request under the detour id the sign-in link carries
(`packages/core/agent/channels/work-sign-in-note.ts`). The return hop takes that filing once and wakes
the seat under the request row's own authority (`packages/core/agent/channels/work-sign-in-resume.ts`),
so the job runs again for the same person, in the same room. The sign-in link must have been minted for
the job's verified requester, on the same platform and workspace. 🔴 The callback authenticates nobody,
so the check reads the consent record, not the person who opened the link: a person who forwards their
private link lets whoever opens it bind an account to them, and the job then resumes as theirs. A
sign-in that lands before the work session files the job is not lost: the job's worker left a pending
mark under the detour id, the return hop leaves a signed-in mark, and the work session resumes the job
as soon as it files it, after the same requester check. A job the seat cancelled is never filed, and its
marks are cleared, so a later sign-in gets the "reply here" line. One limit stays: a sign-in that lands
before a cancel has already been told "picking up", and the cancel then wins. The line says "I'm picking up your
request now" only when the job resumed or is marked to resume — otherwise the line asks you to reply.
With no consent detour recorded (no reply address), nothing can resume the job, and the sign-in card
says "tell me here" instead of promising the pick-up.

A seat's OWN turn (the per-user link in a DM, outside the work session) has no such row. Waking the
seat from the browser's return would carry no acting person, and minting a personal token needs one,
so a self-woken retry would fail closed. There, your own next message carries the identity the mint
needs. The line lands wherever you asked, DMs included.

**Consent grants a credential, not a permission.** When you do carry on, the request runs
every gate the original would have run — the connector grant, the operation's approval tier,
and the audit row per call. Nothing is pre-approved by the fact that you consented. The
audit trail records the detour and the return hop as two rows sharing one id, so "who
consented, and what ran afterwards" is one query.

Two things carry no record and therefore resume nothing: a connect **card click** (you
started that yourself — no request was interrupted) and an authorization started by hand.

## What this plane writes to the audit log

Three families of row cover connecting a vendor, taking a credential in, and lending one.

### Connecting a vendor

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `connector.card_posted` | The `connector` tool posts a connect card into a room. | The connector name and the option labels it offered. |
| `connector.oauth_url_issued` | One OAuth authorization URL is minted. | The connector and the **subject type** the URL was minted for. One row per URL actually minted. 🔴 It never carries the URL. |
| `connector.dashboard_link_issued` | A service-OAuth click resolves to a vendor dashboard link instead of a mint. A credential that declares a `dashboardUrl` takes this route; one that declares an OAuth home and no dashboard URL mints instead, and writes `connector.oauth_url_issued` with subject `app`. | The connector, and `configured` — `false` when the connector declares no dashboard URL. The row is written either way, so an unconfigured connector is a stated fact rather than a missing row. |
| `connector.credential_bound` | A consent completion BINDS the credential — the OAuth callback route, after the token lands in the vault. | The connector, the **subject type** (`app` or `user`), and `rebound` — `true` when the bind replaced an existing row for that subject. `rebound` is read just before the write and takes no cross-process lock, so two simultaneous completions can both report `false`; a serial second consent — the case the row exists for — always reports `true`. 🔴 It never carries token material, and it names no principal on either subject type: the callback authenticates nobody. |
| `connector.consent_detour` | A session pauses and sends a person to a consent detour. | The detour id, the connector, the detour's expiry, and the paused session. |
| `connector.consent_resume` | That detour comes back. | The same detour id and connector, plus the **verdict** (`resumed` when the host woke the seat to run the job again, `offer` when it asked the person to reply, `expired`) and whether the line was delivered to the conversation. The two halves of one detour join on `detourId`. |

The disclosure gate writes no row when it allows a connector read. A refusal writes
`connector.refused`, the established refusal action, so it lands in the stream an operator already
watches. An older log can still hold `connector.entitlement_check` rows: the removed
`requestorEntitlementChecks` flag wrote one per allowed directly-addressed read while it was `true`,
and no code writes the name now.

### Taking a credential in

**`credential.intake_requested`** — one single-use, time-limited intake row is minted. The audit row
carries the intake id, the credential ref, the connector, the domain when one is named, and the
requester. There is no value to record yet, and the row never carries one later either.

The action is **surface-neutral**: the Slack native-modal button and the one-shot web page build on
the identical row and the identical audit write, so neither front door has a record the other lacks.

**`credential.binding_opened`** — the binding pull request is staged. The row carries the pull
request number and URL, and whether it was updated or reopened rather than created.

### Lending one — the credential-grant rows

A grant ask has four terminal shapes, and each writes its own row. All four carry ids, enums and
principal keys. None carries a credential value.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `grant.asked` | A seat asks an owner to lend a vendor credential. | The ask id, the connector, the owner, the requester's principal key, the requested mode, the resource, the scope key, the tool name, the **purpose** the model wrote, and `explicit`. |
| `grant.granted` | The owner approves. | The ask id, the new grant id, the connector, the mode, the expiry, the owner, the requester, the resource, the scope key and the tier. Nothing else records an approval, which is the failure direction that must not exist. |
| `grant.declined` | The owner declines. | The ask id and `reason: "declined"`, and nothing more. The room hears "no" without hearing why: a person's reason for refusing their own credential is theirs. |
| `grant.expired` | The sweep expires a pending ask on its TTL. | The ask id, the connector, the owner, the resource, the verb, `cause: "ttl"`, whether the card was updated, and what became of the requester's notice as a closed enum. |

🔴 **The purpose on a `grant.asked` row is model-authored text, and it is bounded rather than
trusted.** It is stripped of quote characters and newlines, then capped at 200 characters. It is
recorded and shown as quoted data, and it must never read as host copy.

🔴 **`detail.explicit` on a `grant.asked` row measures the prompt rule, and gates nothing.** It is
`true` when the person's own delivered words asked for this borrow, read deterministically through
the own-account grammar the seat already runs over each delivery — never from a model claim, and
never from a sentence the row stores. A delegated worker answers from the same words, because the
seat's reading is carried to it. No card, no budget and no refusal reads the field.

🔴 **Know the floor before you read the rate.** The grammar wants a vendor word beside an **account
noun**: `my notion account`, `my own notion.so login`. The seat prompt's lend trigger needs an
account word too, so its vendor-bearing example ("lend it my Notion account") reads `true`, and a
possessive about content ("my Notion workspace") reads `false` in both places. The prompt's
vendor-less examples ("use my own login") carry no vendor word, so they read `false`. `false`
therefore means "no recognised ask in the person's words", and that class includes some of the
rule's own example wordings. Read the field as a rate with that floor, never as a verdict on one row, and
never on its own as evidence that the prompt rule is failing.

🔴 **`grant.expired` is stamped on a marker partition**, with `grant` as the platform and `sweep` as
the workspace. The ask row carries no requester partition to reuse, so the sweep names its own
instead of borrowing one that would be wrong.

🔴 **The lapse notices cover only the orgs in `schedules.sweepOrgs`.** The daily sweep sends the
requester's lapse notice, rewrites the owner's card to expired and writes `grant.expired`. It walks
only the orgs that the setting `schedules.sweepOrgs` names (shipped: `["default"]`; it was
`OE_TIDY_ORGS` until OPE-2411). A lapsed ask grants
nothing in ANY org, because every read and every approve checks the clock on the row. But in an
org the setting does not list, the owner's card keeps a live Approve button, the requester gets no
lapse notice, and no `grant.expired` row is written. A Decline click does not check the clock, so a
Decline on such a lapsed ask still records `declined` and tells the requester. A multi-tenant deployment must list every org
in `schedules.sweepOrgs` — see the [configuration reference](../deploy/configuration-reference.md#approvals).

## Reaching AWS (host-side, identity-bound)

AWS is a third path, distinct from both planes above: the agent runs the `aws` CLI
**host-side** (in the framework process, never the sandbox) under a short-lived, IAM
role it is granted — there is **no long-lived AWS secret** anywhere. A bundle grants a
scope one or more roles via `awsRoles`:

```ts
defineBundle({
  name: "payments-aws",
  awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-payments",
               region: "eu-west-2",
               // REQUIRED: which commands, host-side + as an STS session policy.
               // Unrestricted must be spelled explicitly: allow: ["*"].
               allow: ["logs:Describe*", "logs:StartQuery", "logs:GetQueryResults",
                       "dynamodb:Query"] }],
})
defineBinding({ bundle: "payments-aws",
  scope: { level: "domain", domain: "payments" } })
```

Now the `#payments` channel can use `aws` (e.g. read CloudWatch Logs Insights, query
DynamoDB). The channel's conversational seat doesn't run the CLI itself — it hands the ask
to a worker, which holds the tool; a granted routine fire, or a seat with no worker to
route through, calls it directly. Wherever it runs, the same grant check applies against
the same scope. When it runs, Open Everywhere resolves **which identity to act as** from the
*verified* principal, mints short-lived credentials by federating the deployment's own
OIDC identity into STS (`AssumeRoleWithWebIdentity`), and injects them into that one CLI
invocation. Two identity modes:

- **`identity: "domain"` (default)** — the channel domain's **service role**. A routine
  fire runs legitimately under it (its own identity is attributed; it borrows no human's
  authority).
- **`identity: "me"` (attended DM only)** — the sender's **own AWS SSO identity**, so
  CloudTrail records the person and least privilege is *their* real access. The first time
  a person uses it, Open Everywhere posts a one-time personal AWS sign-in link (IAM Identity
  Center, auth-code + PKCE). That link is a **capability URL**: whoever holds it can open it.
  So the completion binds the token to the human who **actually signed in**, never to whoever
  asked. It reads the `sub` of the sign-in's OIDC id-token and admits the link only when that
  account is a **confirmed `aws` account on the requester's link-set** — the same identity-link
  plane that states which accounts are one person. Any other sign-in is refused, the opened link
  is spent, and an `aws.sso.link_refused` audit row names the requester and the signer.

  It refuses **by default**. A requester the link plane holds no `aws` account for is refused
  too; it never falls back to binding whoever happened to sign in. So a deployment must link
  its people's Identity Center accounts before `identity: "me"` works at all, and the link
  flow must request the `openid` scope (see the setting `aws.ssoScopes`) — without an id-token nothing
  can name the signer, and every completion refuses.

  **How an `aws` account gets linked, and what its id must be.** The link plane's only in-tree
  writer for a platform the agent cannot post to is the [directory sync](../how-it-works/identity.md):
  a directory provider arm returns the person's Identity Center account as a `DirectoryAccount`
  with `platform: "aws"`, which lands as a `suggested` row the person ratifies in their own DM —
  or which auto-confirms when the arm grades it `attested` and the operator set
  `directory.autoConfirm: "attested"`. There is no challenge route: an Identity Center account
  can neither post a code nor answer a consent in a DM. 🔴 **The row's `nativeId` must be the
  Identity Center *user id*** — the exact value the sign-in's id-token carries as `sub`. The join
  matches on that and on nothing else, so an arm that writes a display name, an email or another
  system's id links nobody, and every completion refuses. Confirm the value a directory arm emits
  against one real sign-in before arming auto-confirm. After a link succeeds, the tool mints role
  credentials as that person via `GetRoleCredentials` — so the call succeeds only if they are
  genuinely entitled to the granted role, *and* stays bounded by the reviewed grant. Three
  fences guard this path: a routine fire can never assume a human's SSO identity, a shared
  channel has no personal identity, and a sign-in the requester has not confirmed as their own
  links nothing.

The **role's IAM policy is the blast radius**; *which* domain may assume *which* role is
the reviewed-git bundle grant. Every grant **must** carry an `allow` list — the host-side
narrowing of which commands the scope may run on top of the IAM role. Unrestricted access is
spelled `allow: ["*"]`, explicitly: an omitted narrowing and a deliberate decision not to
narrow must never be indistinguishable in a review, so an absent or empty `allow` is a config
error, and at runtime it *refuses* rather than passing through. Entries use glob + IAM-native
action grammar — a bare service (`"logs"`), `service:action` with globs (`"logs:Describe*"`,
`"s3:GetObject"`), or the CLI spelling (`"logs:start-query"`), matched case-insensitively;
high-level `s3` commands fan out to their enumerated IAM action sets (`s3 cp` must be allowed
`s3:GetObject`, `s3:PutObject` *and* `s3:ListBucket`). On the domain-role mint path the same
list is also compiled into an **STS session policy** on `AssumeRoleWithWebIdentity`, so the
narrowing is AWS-enforced at mint time where the mint path supports it (the per-user SSO path
has no session-policy parameter — the host-side screen is the uniform layer on both).

Two screens hold **unconditionally, even under `allow: ["*"]`**: the whole argv is refused if
it carries a redirect/host-read option (`--endpoint-url`, `--ca-bundle`, `--no-verify-ssl`,
`--profile`, `--outfile`, any `file://` value) — an `--endpoint-url` would ship the signed
request, session token included, to a host of the model's choosing — and the CLI's
credential-echo paths (`configure export-credentials`, `configure list`, `--debug`) are
refused by name, because they print the minted credentials to output the model reads. The
child process runs with a deny-by-default environment (`AWS_CONFIG_FILE` pinned to
`/dev/null`, no ambient identity, no inherited secrets, IMDS disabled), so the honest claim
is: **the CLI cannot echo its own credentials and cannot redirect signed requests** — a
property of these fences, not a hope. The credential never enters the sandbox, and the tool
is inert until an operator both wires the AWS adapter and binds an `awsRoles` grant — every
step default-deny. The full rationale (Vercel vs self-host substrates, why host-side beats an
egress-signing proxy, the per-user SSO path) is in the design note
`review/design/aws-access-plan.md`.

**What comes back is untrusted data, and it is redacted first.** Both CLI streams are
wrapped in the [untrusted-content envelope](../how-it-works/agent-and-loop.md#trusted-dispatch-vs-untrusted-surface-data)
before the model reads them, with the host-derived scaffold (exit code, the role actually
assumed, the identity mode) left outside so the agent can still tell which stream is which.
An AWS account is a **substrate, not an authoring surface** — nothing gates who writes a
CloudWatch log line, a DynamoDB item, an SQS message body or an S3 object, so the fact that
your org owns the account says nothing about who wrote the bytes.

Ahead of the fence, two conservative redaction rules run over both streams:

- **The credentials this call minted**, struck by exact match. This is what keeps "the CLI
  cannot echo its own credentials" true against *accidental* echo as well as deliberate —
  S3, for one, prints the caller's access key id inside its own `AccessDenied` error body,
  which the CLI writes to stderr.
- **Two high-confidence third-party shapes**: an AWS access key id (`AKIA…`/`ASIA…` plus its
  16 characters, bounded by non-alphanumerics), and a *labelled* secret-access-key or
  session-token assignment (`aws_secret_access_key = …`, `AWS_SESSION_TOKEN=…`,
  `"SecretAccessKey": "…"`) whose value is long enough to be real. Nothing else is guessed
  at — no generic "looks like a secret" heuristic — because a false positive silently
  corrupts data you deliberately granted access to.

Redaction is never silent: the removed value is replaced by a named marker, a note *outside*
the envelope tells the model that Open Everywhere (not AWS) removed something, and the
`aws.exec` audit row carries a **count** of what was struck — never the value. One accepted
cost, stated rather than discovered: if you grant `secretsmanager:GetSecretValue` over a
secret that holds an AWS key pair, the agent will see it redacted.
