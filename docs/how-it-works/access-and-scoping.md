# Access & scoping

This is the page that explains what Open Everywhere actually *is*. Eve gives you an agent;
Open Everywhere gives you a **governed** agent — one whose reach in any given session is
*computed deterministically* from declarative grants, not configured ad hoc and hoped
over. The scoping resolver is the keystone of the fixed spine.

The promise, in one line: **an app-layer fence over workspace-wide credentials, the secret never
touches the agent, and the boundary is enforced in several places, not trusted.** The fence is your
own `domain` roster and claim below — narrower, in general, than whatever the underlying vendor
lets the credential see. It is not the vendor's own membership list. That check (a Slack bot must be
invited to a channel, for instance) is a separate, real boundary on some surfaces and absent on
others; see
[Security model § Cross-domain isolation](../security/security-model.md#cross-domain-isolation-within-one-org)
for which is true where.

## The unit: the bundle

Capabilities don't attach to a channel directly. They're grouped into a named **bundle**,
and the bundle is **bound** to a scope. Decoupling the definition from the binding is what
makes a bundle a reusable capability group: define the "Notion + GitHub" basket once, bind
it to ten teams without copy-paste.

A bundle (`defineBundle`, `packages/core/agent/access/bundle.ts`) can grant:

| Field | Grants |
|---|---|
| `connections` | **Egress plane** — a static credential, the hosts it may reach, the only hosts it's sent to. Injected at the firewall; the secret never enters the sandbox. |
| `connectors` | **Connector plane** — a host-side Eve (MCP) connection, by name, and the credential this scope reaches it as (`{ name, credential }`; the old `contentOrigin` field is deprecated and ignored). The model calls its tools; auth resolves host-side. |
| `connectorOps` | **Connector-op plane** — raise the consequence tier of named operations on a granted connector. Raise-only: there is no field that means "open". |
| `repos` | GitHub repositories the agent may clone and work in. Written as `"owner/name"`, or as `{ repo, capabilities }` to opt one repo into a named capability set — see [Source control](../capabilities/source-control.md#per-binding-capability-sets). |
| `domains` | A credential-*less* egress allowlist — hosts reachable without a credential. |
| `plugins` | A capability package (skills + connectors + subagents) granted by name. |
| `optInTools` | Native tools that ship **off**, switched on by name from a closed list (`packages/core/agent/access/opt-in-tools.ts`). An unknown name fails config load. Today the list is `search_slack_public` ([public-channel search](../deploy/surfaces/slack.md#public-channel-search)). |
| `instructions` | Standing rules (Owner-authored) that outrank channel memory. |

> **The work plane is not here.** Working with a tracker from another surface — filing, closing,
> reassigning — is granted on the memory **domain**, not on a bundle: the domain declares the
> provider's work credential in its `credentials` field, and that declaration *is* the grant. The
> grant and the credential it rides are one line, so they cannot drift apart. Chat presence is
> never a precondition: most tools a domain works with are not chat surfaces. See
> [Linear § Working from another surface](../deploy/surfaces/linear.md#working-from-another-surface-the-linear-work-grant).

> **A word-overlap to watch.** A bundle's `domains` field is an *egress allowlist*
> (credential-less hosts). A **domain** *scope* (below) is a *grouping of channels*. Same
> word, different concepts — the code carries both because each mirrors a real Claude
> Tag-era field. When this page says "domain" unqualified, it means the channel grouping.

Where the secret lives and how each plane is enforced is the subject of
[Credentials & the two planes](../security/credentials-and-planes.md). Here we care about
*scoping*: who gets which bundle.

## The binding and the scope hierarchy

A **binding** (`defineBinding`) attaches a bundle, by name, to a **scope**. There are four
scope levels, ordered by specificity:

```
org  <  tenant  <  domain  <  surface
```

- **`org`** — the root; matches every request. Carries no address.
- **`tenant`** — one vendor tenant, written **platform-qualified**: `platform/<tenant-id>`
  (`slack/T0123ABC`, `discord/1300000000000000100`, `github/acme`). This is the tier every
  vendor has its own word for — Slack workspace ≈ Notion workspace ≈ Linear organization ≈
  Discord guild ≈ GitHub owner.
- **`domain`** — matches every surface in a declared memory domain, by its **bare name**
  (`"payments"`). Deliberately *not* tenant-qualified: a domain is a curated grouping that
  routinely spans several vendors at once, so one grant stays one binding.
- **`surface`** — one container, written **platform-qualified**:
  `platform/<tenant-id>/<container-id>` — the same fully-qualified surface key memory
  domains list. The container is generic: a Slack or Discord channel, a GitHub repo, a
  Linear team, a Notion page, a Teams channel.

Plus two levels off the ladder, which are the **DM universe** — they never co-resolve with
the four above, and they are ordered `group < principal` between themselves:

- **`group`** — a named set of *humans* (a [person-group](#person-groups-grouping-people-not-rooms)),
  by its **bare name** (`"payments-team"`), for exactly the reason a domain's is bare: a set
  of people spans platforms. A bundle bound here applies in **each member's own DM**.
- **`principal`** — one person's own scope, the narrowest level a **DM** resolves against.
  Written **qualified**: `platform/<principal-id>` (`discord/300000000000000104`) — plus the
  **workspace** rung on a tenant-scoped platform, `platform/<tenant-id>/<principal-id>`
  (`slack/T0AB1CD2E/U0123ABC`), because a Slack member id is issued per workspace. A `principal`
  address may instead be a link-set reference, `linkSet:<link-set-id>`, which names one **human**
  across every account they confirmed. The two forms are disjoint: a key carries a `/`, a
  reference never does. See [the two universes](#the-two-universes--service-vs-user).

> **Write the qualified key, not the bare id.** `tenant`, `surface` and `principal` scopes
> take `platform/…` keys, and a bare vendor id is rejected at config load. Bare ids were the
> old form; they matched by string equality across six vendors' id namespaces — and one of
> those namespaces (a GitHub owner login) is user-chosen. The platform is part of the address.
> It matters most on `principal`, where the address selects a *person's own credentials*:
> A Discord snowflake is a plain digit string, and two platforms' ids can be identical, so a bare id there
> could resolve one person's personal connectors in a stranger's DM on another platform.
>
> **On Slack the workspace is part of the address too.** A Slack member id is issued *per
> workspace*, so `slack/U0123ABC` names one person in one workspace and somebody else in
> another. A principal key there is `slack/<team-id>/<member-id>`, and the two-segment form is
> rejected at config load with the exact replacement string to paste. Platforms whose person ids
> are vendor-global (Discord, Teams, GitHub, Linear, Notion) keep the two-segment form: the rung
> is a **per-platform fact, not a uniform shape**. A Discord DM carries no guild at all, so a
> uniform three segments would key the same human differently in a DM than in a channel.

One bundle, many bindings: bind `payments-tools` to the `payments` domain; bind a shared
`notion-readonly` basket at `org`.

## The resolver: deterministic, narrowest-wins

The resolver (`resolveAccess`, `packages/core/agent/access/resolver.ts`) is a **pure function**: given a
request — `(mode, platform, workspace, channel, domains, principal)` — plus the declared
bundles and bindings, it returns the **effective access** for that one session. Same inputs,
same output, every time. No I/O, no surprises. You can preview exactly what any scope can
reach before you ship it.

It applies the bundles whose scope matches the request, then combines them by two rules:

1. **Matching scopes stack as a union.** Reachable hosts, repos, connectors, plugins, and
   instruction layers accumulate. Policy treats an explicit domain as one static capability
   boundary: its member surfaces may not carry direct surface bindings, even when the domain uses
   separate sessions. Surface bindings remain available for channels/pages that belong to no
   domain.

2. **Credentials resolve narrowest-wins, with NO fallback.** For the same connection id,
   `surface` beats `domain` beats `tenant` beats `org`. The surface rung applies to standalone
   channels under the policy above. The selection is single-valued —
   a tighter binding cleanly *shadows* a broader one, and on an auth failure the agent does
   **not** silently retry some other credential. This is what lets ten domains reach one
   provider with ten different keys: each domain's narrower binding wins for its own channels.

Instructions concatenate `org → tenant → domain → surface`, verbatim, with later
(narrower) layers outranking earlier ones. In a DM the two personal levels concatenate the
same way, `group → principal`, so your own standing rules outrank your team's.

## Person-groups: grouping *people*, not rooms

A **domain** groups surfaces. A **person-group** (`defineGroup`, `agent/identity/groups.ts`)
groups humans — the answer to "this set of people gets these skills, MCPs and connections in
their DMs" without one binding per person per platform.

```ts
// agent/identity/groups.ts
defineGroup({
  name: "payments-team",                 // the id every binding references — immutable
  title: "Payments",                     // display only
  members: [
    "slack/T0AB1CD2E/U0123ABC",          // one ACCOUNT, workspace-qualified on Slack
    { linkSet: "1f0c…" },                // one HUMAN — all their confirmed accounts
  ],
})

// agent/access/bundles.ts
defineBinding({ bundle: "payments-tools", scope: { level: "group", group: "payments-team" } })
```

Two things about a group are load-bearing:

- **A group grants people, never rooms.** A `group` binding resolves **only in DM mode**,
  exactly like `principal`. There is deliberately no way to say "this channel's bundle
  applies only to members of group X" — that would be a per-wake access dimension the
  resolver does not have. Channels keep surface/domain scoping.
- **An individual binding beats a group one.** `group` sits between the container ladder and
  `principal`, so for the same connection id a person's own `principal` binding shadows the
  group's — "the team shares this key, except Ada, whose own binding names hers". Additive
  fields (repos, connectors, plugins, hosts) union across both.
- **A group binding can be narrowed to one platform's DMs.** `scope: { level: "group", group,
  platform: "slack" }` resolves only in a DM on Slack. The narrowing only subtracts, and only a
  `group` binding takes it: config load refuses `platform` at any other level. A declared
  [personal-surface MCP server](../extending/connectors.md#a-chat-platforms-own-server-on-the-persons-sign-in)
  is the shipped user — "search Slack as you" belongs in a Slack DM, not in a Discord one.

A member is written either way, and the difference matters:

| Member form | Means | Needs |
|---|---|---|
| `"slack/T0AB1CD2E/U0123ABC"` | one account, in one workspace on one platform | nothing — this is the **no-database floor** |
| `{ linkSet: "…" }` | one human, expanded to every account they have **confirmed** | [identity links](./identity.md#cross-platform-identity-linking) |

A link-set member only ever contributes accounts the person **confirmed** — a `suggested`
row written by directory sync never widens access, and a suspended or revoked link-set stops
contributing immediately. A bare, unqualified member id (`"U0123ABC"`) is rejected at config
load — as is a Slack key missing its workspace rung (`"slack/U0123ABC"`), for the same reason one
rung down — as is an empty group, a duplicate member, and a binding naming a group nobody declared.
Being in several groups at once is normal and expected.

> **Runtime status: `{ linkSet }` group members are live, and confirmed-only (C2.3).** Both
> principal-key members (`"slack/T0AB1CD2E/U0123ABC"`) and `{ linkSet }` members now resolve at runtime. The
> DM credential gate (`grantedConnectors` / `boundConnectorCredential`, `packages/core/agent/access/connector-scope.ts`)
> resolves through the awaitable expander (`resolveAccessForWithGroups`, `packages/core/agent/access/group-request.ts`),
> so a link-set-backed group grant reaches every **confirmed** account of the set in that person's own
> DM. Only `confirmed` links in `active` sets count: a directory **suggestion** grants nothing, and a
> suspended/revoked set stops granting eagerly. The read is DM-only and fail-closed (a store outage
> degrades to the config-direct grant, never widens); a channel/mpim session resolves nothing from a
> group or `principal` binding, as before.

**The built-in group `oe:everyone`** (OPE-2414) is the one group nobody declares and nobody
lists. It holds every **internal** person. The resolver matches it in a DM only for a caller with an
acting principal whose DM trust is `internal`, and never in a channel, a group DM or a fire. It is
how a server declared in `agent/access/mcp-servers.ts` reaches every internal person's DM as that
person ([Connectors](../extending/connectors.md#declare-an-mcp-server-in-your-app)).

🔴 **An external account is not in `oe:everyone`** (OPE-2415). The posture is "internal lax,
external locked". The resolver reads the DM's own trust verdict, which asks whether the partner is
an internal member and fails closed to `external` ([DM partner trust](./identity.md#dm-partner-trust)).
So a Slack Connect user, a Slack guest and an account from an undeclared workspace stay out. A
lookup that failed also stays out, with one exception: a workspace or Grid `trust: "internal"`
declaration, or `identity.blanketTrust: "internal"`, raises a DM partner whose lookup failed. That
partner is then in `oe:everyone`. Discord has no workspace membership, so a Discord DM is internal
only where the deployment vouches it: a `trust: "internal"` entry on `discord/<userId>` in
`agent/identity/surfaces.ts` (a DM's workspace is the caller's own user id, so a guild entry does
not cover it), or `identity.blanketTrust: "internal"`. Without one, a Discord user who shares a
server with the bot is external. A request that carries `oe:everyone` in its `groups` does not make the caller a
member: only the trust verdict does.

**To grant an external person on purpose**, name them. List their account in a declared group and
bind that group (for a declared MCP server, name the group in `people: { groups: [...] }`), or bind
the bundle at `principal` scope to their key. A declared group and a `principal` binding match
whatever the caller's trust, so the grant is a reviewed line in Git, never a side effect of a wide
default. A declared group may not take the name `oe:everyone`, a `group` binding may name it without
a registry entry, and the broad-grant lint calls a credentialed `oe:everyone` binding broad, so it
needs `allowBroad`. `access_preview` and `scripts/access-preview.ts` answer a DM ask as an external
caller unless the ask sets `callerTrust: "internal"` (`--caller-trust internal`).

**Both personal levels are self-serve-able.** The [access-request](./access-requests.md) flow
reaches `principal` and `group` scopes as well as channels: a person can ask for a connector in
their **own** DM (self-only, from that DM), and an **org admin** can ask for one on behalf of a
declared group — same closed vocabulary, same deterministic codemod, same bot-PR whose merge is
the approval. A broad group (a link-set member, or 8+ members) must state a reason, which is
recorded on the binding as the `allowBroad` acknowledgement `npm run lint:access` insists on.

**IdP groups sync as a proposal, never as a fact.** With a directory adapter wired, the
`directory_groups_plan` control verb diffs Okta's group memberships against a machine-owned
overlay (`agent/identity/groups.generated.ts`, groups named `directory:<idp-group>` so they
can never collide with hand-written ones). By default it returns the next file for a human to
commit; with `deliver: true` it **opens a bot-PR** that writes it — the same merge-is-the-approval
delivery the grants overlay uses, so nothing applies until an admin merges and the config redeploys.
Either way it stays a reviewed diff: a membership widens capability, so it never applies itself. The
optional setting `directory.groupAllowlist` restricts *which* IdP groups sync (empty = all), so a small
team need not carry every Okta group in the overlay. Narrowing still lands fast by another route — a
deprovisioned person's link-set is suspended eagerly by directory sync, which stops their group
access before the diff is even opened.

## Domains: the channel-grouping unit

A **domain** ties together the channels that share one memory — *where* that memory lives (a
[memory silo](../capabilities/memory.md)) and *what* those channels can do (an access
bundle). It sits between `tenant` and `surface` in the specificity ladder — but it is *not*
contained by a tenant: a domain is a curated grouping and its channels may span several
vendor tenants, which is why a `domain` scope is written as a bare name. It's the intended
way to grant capability to a *team's* set of channels at once.

```ts
defineDomain({
  name: "payments",
  reach: ["slack/T_CO/C_PAY", "slack/T_CO/C_PAY_EMEA"],    // fully-qualified
  memory: "payments-silo",
})
```

The domain names no bundle — the binding below (`scope: { level: "domain", domain:
"payments" }`) is what hands `payments-tools` to those channels. Grants only ever point
*at* a scope, never out from one, so `bindings` stays the single list to read.

A hard rule keeps resolution unambiguous: **a channel belongs to at most one domain**
(enforced at config load). So a fact written in a channel has exactly one home, and
resolving a channel's domain is a single hop.

### Reach: exact keys and containers

Enumerating every surface stops scaling the moment a tenant has more of them than a human
wants to list — and it can never cover the repo, team or page created tomorrow. So a domain
says what it reaches in one list, whose entries take three shapes:

```ts
defineDomain({
  name: "platform",
  reach: ["github/acme"],               // a CONTAINER — every repo under this owner
})

defineDomain({
  name: "payments",
  reach: ["github/acme/billing"],       // an EXACT key — this repo, exactly
})
```

- **An exact key** — `platform/<tenant>/<surface>`. These are the enumerable half: everything
  that needs to *list* a domain's surfaces reads them — where an approval card gets posted, a
  domain's `reportChannel`, a governance venue's audience, the cross-surface window's source
  set.
- **A container** — never enumerated, because the answer is unbounded. That is the point. Two
  forms:
  - `platform/<tenant>` — the whole tenant. Every repo under `acme`.
  - `platform/<tenant>/<prefix>*` — a **same-level glob** over that tenant's surfaces, e.g.
    `github/acme/payments-*`. Strictly narrower than the tenant, and just as cheap: the
    surface key already carries the segment being matched, so it is one string comparison.

**Most specific wins.** The matching entry that denotes the narrowest set takes the key. In the
example above `github/acme/billing` is in `payments` and every *other* repo under `acme` is in
`platform`. An exact key beats a container; a longer container beats a shorter one; any surface
entry beats the whole tenant. So a surface still resolves to at most one domain — one when some
entry matches it, none when none does — an explicitly-listed surface can never be annexed by a
broader glob, and handing a slice of one
domain's tenant to another domain is written by writing the narrower entry — nothing else.

#### Exclusions always win

`exclude` carves surfaces back out of this domain's reach, and it beats reach every time:

```ts
defineDomain({
  name: "payments",
  reach:   ["github/acme/payments-*"],       // every payments repo…
  exclude: ["github/acme/payments-secrets"], // …except this one
})
```

An excluded surface is not in that domain, full stop. If no other domain reaches it, it lands
in no domain at all and falls through to the `org` pseudo-domain like any unrouted surface —
and the routing provenance says so (`excluded:payments:github/acme/payments-secrets`), so
"carved out deliberately" never looks like "nobody configured it".

That carve-out is now `exclude`'s whole job. Handing a slice to *another* domain needs no
exclusion: the receiving domain writes the narrower entry and wins it.

Exclusion entries are three segments: an exact surface key, or the same single-trailing-`*`
glob. A whole-tenant exclusion is refused (it would either cancel the domain's reach or mean
nothing), as is an exclusion that matches none of this domain's own entries — a dead exclusion
reads like a carve-out while granting everything it was meant to withhold. An exclusion that
cancels the **whole** of a reach entry is refused for the mirror reason: that pair is dead config,
because the reach can then never admit anything.

#### Worked example: 500 repos, two of them sensitive

The choice used to be "list 500 repos" or "take the whole org". Now:

```ts
defineDomain({
  name: "platform",
  reach:   ["github/acme"],             // the whole org…
  memory:  "platform-silo",
})

defineDomain({
  name: "payments",
  reach:   ["github/acme/payments-*"],        // …minus the payments repos, which are their own
  exclude: ["github/acme/payments-secrets"],  // …except this one, which is nobody's
  memory:  "payments-silo",
})
```

Nobody typed 500 repo names, `payments-secrets` is in no domain and inherits no bundle, and a
repo created tomorrow lands in the right one of the two automatically. Note the shape of the
hand-over: `platform` says nothing about the payments repos, and needs to say nothing — the
narrower entry wins them on its own.

Config load refuses every ambiguous shape, loudly: **two entries in different domains that
reach exactly the same keys** (nothing can order them — unless one of the two domains excludes the
whole overlap, which orders them again), a room a domain names outright that
routes somewhere else or nowhere (a room in NO domain is normal — one a domain named and lost is not), and an entry with more than three segments (a "this
database's rows" key needs an ancestor lookup, which routing deliberately does not do —
routing is a pure function of the key and the config, with no I/O anywhere in it).

The pattern language is deliberately one trailing `*` and nothing more — no `**`, no
mid-string `*`, no regex, and never in the platform or tenant segment. "At most one domain per
surface" is only true *by construction* while the validator can decide whether two entries
overlap, and a richer syntax would make that question undecidable — trading a usability
problem for an exclusivity hole.

> **A container is a capability grant.** A domain-scoped binding matches by *membership*, so
> landing in a domain confers whatever bundles are bound to it —
> `reach: ["github/acme"]` on a domain holding a credential hands that credential to every
> future repo under `acme`. That is a legibility requirement — the entry is deployer config, in
> code, behind a PR, exactly like the exact keys beside it — and **not** a confidentiality
> mechanism. Routing decides where a thing *lands*; if you need genuine isolation, use separate
> integrations and credentials, which the source system enforces.
>
> Which is why the glob and the exclusion are worth reaching for: every unnecessary segment of
> tenant breadth is unnecessary **capability** breadth. `github/acme/payments-*` confers the
> bundle on strictly fewer surfaces than `github/acme` does, so narrowing the entry is a real
> reduction in blast radius, not just tidier config. It is still unbounded, though — it admits
> repos created tomorrow — so a credentialed domain binding onto a glob still trips the
> broad-grant lint and still needs `allowBroad: "<reason>"`.

#### An asymmetry worth knowing: a container does not widen every surface's read fence the same way

`reach` decides **routing** — which domain a surface belongs to — the same way on every
platform. It does not decide the per-tool **read fence** the same way, and the gap is real and
worth stating plainly.

Notion's read fence (`read_notion_page`, `read_notion_comments`) checks both a caller's and a
target's routing through the full rule above, so `reach: ["notion/<workspace>"]` genuinely
opens every page in that workspace to the domain that holds it — including pages nobody
enumerated. That is deliberate: it is what a container is *for* on a surface where routing has
no separate concept of "the surfaces I may read" apart from "the surfaces that are mine".
Linear's fence works the same way.

Slack, Discord and Teams do not. Their read fences build the readable-channel set from a
domain's EXACT entries alone — `allowedChannelIds` (Slack), `allowedSurfaceIdsFrom`
(Discord's generic gate) and its Teams equivalent all read `domainRoster(domain)`, never its
containers. So a chat domain that reaches a whole tenant still routes every channel in that
tenant into the domain (routing keys off the same rule as Notion's), but a session there can
only **read** the channels named outright plus its own current channel — not every channel the
container reaches. A workspace-wide chat container is therefore a capability grant (whatever
bundle is bound to that domain applies to the whole tenant) without being a workspace-wide
*read* grant, which is the opposite of how the
same container behaves on Notion or Linear.

The asymmetry exists because Slack/Discord/Teams already have a real, vendor-enforced first
boundary — bot channel membership — so widening the read fence to match the claim was never
needed to reach "every channel in the tenant"; on Notion and Linear there is no such vendor
boundary underneath one deployment-wide key, so the fence itself has to do that job. See
[Security model § Cross-domain isolation](../security/security-model.md#cross-domain-isolation-within-one-org)
for the full per-surface picture.

### Criteria pseudo-domains: `org`, `public`, `dm`

Three special domains are selected by a session's **trust and mode** rather than by an
explicit channel list — declared with `match` instead of `reach`. They get the same
toolkit as a normal domain (silos, `includeOrg`) and can be named by a `domain`-scoped
binding like any other domain:

- **`match: "org"`** — internal channels that aren't in any explicit domain (the sensible
  org-wide default).
- **`match: "public"`** — externally-shared / guest channels, and external DM partners. The
  trust gate routes here instead of returning nothing, so external surfaces get a read-only,
  deliberately-curated baseline and *never* an internal domain's memory.
- **`match: "dm"`** — the shared read layer an *internal* DM partner gets on top of their
  always-present per-user store.

There is at most one domain per `match` value, and a domain has `reach` **xor** `match`.

## Roles: who's an admin

Scoping (above) governs what a *surface* can reach. A separate, narrower question is who
may call the tools that read or change **runtime state for other people's surfaces** —
spend caps, connector revokes, cancelling someone else's routine, org-wide reports. That's
RBAC, and it's config-as-code too: no roles table, two tiers, both **platform-qualified
principal keys** listed on a `Domain`'s `admins` field
(`packages/core/agent/access/roles.ts`). An entry takes the same shape a `principal` scope does —
`platform/<principal-id>`, or `platform/<tenant-id>/<principal-id>` on Slack, whose member ids are
issued per workspace:

```ts
defineDomain({ name: "org", match: "org", admins: ["slack/T0AB1CD2E/U0EXUSER002", "discord/300000000000000104"] }),
defineDomain({ name: "payments", reach: [...], admins: ["slack/T0AB1CD2E/U_LEAD"] }), // this domain's admins
```

On a Slack Enterprise Grid one member id serves every workspace under the Grid, so an entry can
name the Grid instead: `slack/E<grid-id>/<member-id>` admits that person in every workspace whose
delivery names that Grid (OPE-2400, [Slack § Admin keys on a Grid](../deploy/surfaces/slack.md#admin-keys-on-a-grid)).

One roster still covers one human across several surfaces — it just names the surface each
id belongs to. That qualifier is what stops a Discord snowflake being matched by an
identical id on another platform; a bare entry is refused at config load, because every matcher builds
`platform/<id>` from the wake's own surface and a bare entry could never match.

- **Org admin** — listed on the `org` pseudo-domain's `admins`. Covers every scope in the
  deployment.
- **Domain admin** — listed on an *explicit* domain's `admins`. Covers only that domain's
  channels. **Does not inherit** from the org list — an explicit domain's admins are its own
  list, the same non-inheriting precedent `nameDropWake` sets (a deliberate per-domain
  opt-in, not a tuning default). The one exception is direction, not layering: an **org
  admin is also a domain admin everywhere**, so a workspace-wide operator is listed once,
  not per domain.
- **Anyone in the domain** — the pre-existing, coarser default this whole page has been
  describing: plain channel membership, no admin listing needed. Several operations are
  deliberately tiered here rather than to an admin: routine create/list/cancel, and
  authoring a [runtime domain skill](../capabilities/skills-and-plugins.md#runtime-domain-skills).
  "Membership is the ACL" was always the posture; RBAC adds two *narrower* tiers on top of
  it for specific state-changing/org-wide operations, it doesn't replace it.

Fail-closed throughout: no verified sender on the turn, an unresolvable channel binding, or
no domains configured at all collapse to "not an admin" — never the reverse.

| Operation | Tier |
|---|---|
| Routine create/list/cancel; domain-skill create/update/delete (Slack-native tools) | Anyone in the surface/domain |
| `session_cost` (your own conversation) | Anyone |
| `spend_report` / `usage_report`, `scope: "domain"` | Anyone in that domain |
| `spend_report` / `usage_report`, `scope: "org"` | Org admin |
| Control-plane writes (`set_spend_limit`, `revoke_connector`, `cancel_routine`, …) and `overrides_list` | Org admin, or a `domain:<name>` role covering the scope |
| Same admin mutations, approved via an in-chat card (`set_spend_limit`, `clear_spend_limit`, `revoke_connector`, `clear_connector_override`) | Org admin, or a domain admin covering the frozen scope — same roster, checked from the click's platform identity |
| …except a spend cap at `level: "domain"` or `level: "user"` | **Org admin only** — a domain's leads don't own its budget, and a per-person allowance is a decision about somebody with no seat in the deciding room |
| `purge_memory`, approved via an in-chat card | Anyone in the surface/domain — same tier that can already edit the silo |
| `memory_admin_list` / `memory_admin_read` | **Two fences.** ROLE: an org admin covers every eligible silo, a domain admin only the silo(s) their own domain(s) reference — checked against every domain, not the calling channel's. VENUE: the org-wide view answers only in the governance channel or a DM with the asker; any other channel is narrowed to that channel's own domain, or redirected |

The middle row uses a **third** way of checking the same roster: the in-chat approval click
resolves the clicker from the platform's own signed payload rather than an OIDC claim, but it's
checked against the identical `Domain.admins` list. Which surfaces can host such a card is a
**capability**, not a fixed list — a bundle that registers a card renderer/poster/click route gets
one, which today means Slack and Discord. The bottom row is a member-tier mutation,
not an admin one — no roster covers it. See
[The control plane: In-Slack approvals](../security/control-plane.md#in-slack-approvals) for
the propose → card → click mechanics.

"Being able to click is already being in the channel" was the whole of the member tier's
argument, and it is worth being precise about how far it reaches. It holds against the threat
the tier was built for — injected text can't press a button — and it is why a member-tier card
is deliberately **self-approvable**: the click gates the model's proposal, not the person.
One thing constrains the card before anyone can click it, and it is a different question from all
of the above: not *who may decide*, but *who is in the room when the card appears*. A card states
exactly what would execute, so a proposal into a channel Slack positively reports as **externally
shared** is refused before the card is posted — no pending row is minted and nothing is rendered,
so the action is never disclosed to the other org in the first place. Refusing the later *click*
could not have achieved this: by then the card is already in the room. That gate is **tier-blind**,
unlike everything else in this section — posting happens before any tier is consulted, and the
member-tier `memory.purge` card shows verbatim memory bullets, so scoping it to admin actions
would have missed the worst case. It is inert wherever membership can't be read, and the refusal
explains itself without naming the action.

Against a *human* who shouldn't be there it needs help, so two things now constrain the clicker
directly — both of them on Slack, and both inert elsewhere rather than refusing. On Slack the
click must come from the room the card was posted into; the check reads the room off the
interactive payload, so a surface that supplies none (Discord, and the headless control plane)
never runs it, because "we couldn't ask" must not silently disable approvals. And where the
platform can report channel membership (Slack today), a member-tier click from a channel it positively
reports as **externally shared** is refused — the card stays pending for someone inside the org,
and the refusal is audited. Where membership can't be read the check stays inert rather than
refusing, so surfaces with no membership API keep working exactly as before. That catches
externally-shared channels and **not** a guest in an ordinary internal private channel, which
needs a per-member lookup Open Everywhere doesn't yet request the scope for. Approving a webhook
create or rotate is stricter still: the click mints a live signing secret and destroys the one in
use, so it requires a channel whose membership actually resolved, not merely one with no guest
observed. The secret itself is revealed to the person who **asked** for the rotation, never to the
approver — the stricter bar is about who may decide a mint that destructive, and the room is what
bounds who could have clicked.

The last-but-two row uses a **separate**, OIDC-authenticated mapping onto the same roster: the
remote control plane grants roles by `(issuer, subject)` claim, and an email/subject claim
isn't Slack channel membership — so "anyone in the domain" isn't expressible there. It has
its own convention, `domain:<name>` via the setting `control.adminRoleRules`, layered on the *same*
`Domain.admins` list. See [The control plane](../security/control-plane.md#auth-and-roles)
for that half — this page and that one describe two of the three doors onto one roster, not
different rosters.

### Asking the agent who its admins are

Anyone can ask the agent, in chat, "who are your admins?", "am I an admin?", "are you connected to
GitHub?" or "what can I change from chat?". The agent answers from its live setup, never from memory
(OPE-2492). Two reads carry it, and neither adds a verb to the seat:

- **The seat's own instructions** carry the admin lists (the `org` list and this room's domain
  admins), whether GitHub is connected, and whether a setup change from chat can work today, with the
  one step that fixes it (`status/agent-setup.ts` `renderSeatSetupSection`). The seat compares the
  message's author with the list and answers in one message: "You're an admin", "You're an admin for
  the payments team", or "You're not an admin here", with the admins' names. When it cannot name the
  author, it says it cannot tell. The list is the one every admin gate reads. The block never names
  the deployment's own repository, and it reads only config and the environment, so it is the same
  on every turn. The gate itself checks the verified
  person who asked, so on a turn that serves several people at once, the card or the tool is the final
  word, not the sentence.
- **`agent_version`'s `setup` field**, a worker read, answers the same questions for the person who
  asked, with the same verdict every admin gate computes (`resolveRole`): a domain admin's standing,
  each chat app and whether it is installed, the services and repositories this room may use, what an
  admin can do from chat now (the runtime controls, and the config changes that become a pull request
  on the deployment's own repository), and each gap with its one step — for example "changing my
  setup from chat needs the GitHub app on `acme/agent-config`, and I can't find it installed for acme", with the
  app's install page. When the agent cannot tell who sent a message, it says so; it never guesses
  "not an admin", and a domain admin who asks somewhere else reads "You're not an admin here. You're
  an admin for <domain>." The repository and the deployment settings behind a gap are returned only
  when the person who asked is an admin. That checks the asker, not the room: when an admin asks in a
  shared channel, everyone there reads the reply. "Installed" means the GitHub app has an
  installation for the repository's owner; it does not prove the installation covers that one
  repository.
- **The deployment's own address (OPE-2669).** The seat's instructions carry the deployment's web
  address and its one OAuth callback URL (`status/public-url.ts`), and `agent_version`'s `publicUrl`
  field carries the same two values for a worker. Both come from the resolver the OAuth sign-in
  flow itself sends as its redirect URI: `OE_PUBLIC_BASE_URL`, then `VERCEL_PROJECT_PRODUCTION_URL`,
  then `VERCEL_URL`. So the URL a person gives an identity-provider admin is the URL the flow sends.
  Every OAuth service, Notion included, uses this one callback. A service that registered itself
  (`discovery-dcr-pkce`) before the address changed keeps the callback it registered with, so the old
  host must still route to the deployment (see Connectors and providers). When no address resolves, the agent
  says so and names `OE_PUBLIC_BASE_URL`. The agent names the address only when the binding's trust
  is internal. That trust fails closed. In an externally shared room, or a DM whose partner is not
  verified, the agent says it gives the address in a DM or an internal channel. The seat of a
  unified window that serves several surfaces never names the address, because its deliveries differ
  in trust: it says it gives the address in a DM. A worker that seat starts answers from the trust of
  the delivery that started it, and replies to that delivery's thread. One
  limit: on Slack a channel's trust is its external-sharing verdict, not a check of each member. A
  guest who is a member of an internal channel is not detected, so that guest can read the address.
  The address is not a secret.

Neither read changes anything. They never add an admin: the roster is config and changes by pull
request. On a fresh install the `org` admins list is empty, and the agent says that no admins are set
up yet.

## Standing is personal; exercise is situated

Holding a role isn't the same as being somewhere the role's output may be *heard*. An output is
sensitive **relative to a room**: it is sensitive there iff its scope exceeds the room's scope.
Org-grain output (org-wide spend, org-wide usage) is therefore fine in a governance channel — a
private domain flagged `governance: true` whose membership the agent re-verifies as
uniformly-admin before every sensitive render — and fine in the asking admin's own DM, but never
in `#general`, even when an org admin asks for it there.

So the org-scope rows in the table above are gated **twice**: the role check, and then a venue
check. When the venue is wrong the agent does not refuse and does not partially render (partial
disclosure is still disclosure) — it **redirects and fulfils**:

- **A governance channel is configured** → the agent delivers the answer there, mentioning the
  asker, and replies in the original room with only a pointer ("I've posted it in #oe-admin").
- **No governance channel is configured** (a flat, admin-less workspace) and the org has opted
  into `governanceDelivery: "dm-fallback"` on its `org` pseudo-domain → the agent **delivers the
  answer to the asking admin's DM** and replies in the room with only "I've sent you a DM". The
  substance never enters the room's transcript, and never enters the model's context on that turn
  — the agent posts it and is left holding a pointer.
- Anything ambiguous fails closed: an unverifiable role, a chat platform with no DM capability
  (Slack needs the `im:write` scope), or a DM that doesn't send all end in a refusal. There is no
  path on which org-scope output falls back to the asking room.

Both the redirect and the DM delivery are audited (`governance.redirected`,
`governance.dm_delivered`) — for a *read*, the audit row is the witness, which is why viewing in a
DM is allowed while *doing* from a DM still is not. `governanceDelivery` is deliberately one
org-wide knob in config-as-code, not per-tool configuration: the venue carries the policy. Absent,
it defaults to `"channel"` — the venue check engages only once a governance domain exists.

## The two universes — service vs. user

Cutting across the scope hierarchy is a second, **structural** axis: which *identity* the
agent acts as.

- **The service / app universe** — channels and domains. The agent acts as one shared
  service identity, gated by the channel's bundle.
- **The user universe — DMs only.** A DM resolves against the *caller's own* scope: only
  a `principal`-level binding naming that caller, plus any `group`-level binding whose
  [person-group](#person-groups-grouping-people-not-rooms) they belong to — never an
  org/tenant/domain/surface bundle. Service bundles grant **nothing** in a DM, a
  `principal` or `group` binding grants nothing in a channel, and a user-principal
  (personal OAuth) credential is *refused* on any service-level binding by construction.

So a channel can never borrow your personal credentials. This is the "two connector
universes" rule — see [Identity](./identity.md).

**The one designed exception: the member plane** (`connectors.memberPlane`, default **off**).
A domain may declare that its rooms admit *the asker's own* connector credential, by naming
the connector's member role in its own `credentials` (the same field the work grant uses).
It is a narrow arm, not a relaxed resolver — every one of these must hold:

- **both** flags are armed — `connectors.memberPlane` and `connectors.opTiering`. The second is
  load-bearing: the read-only rule below is enforced inside the per-op policy, and without the flag
  the connection falls back to the framework's own blanket approval, which knows nothing about the
  member plane — so the refusal never runs at all;
- the caller's domain declared that exact `(connector, credential)` pair — absence is a refusal,
  never the org default;
- exactly **one verified person** woke this turn. A turn several people woke, or a system
  wake, refuses. This is what makes "somebody else cannot use your credential" structural:
  the token is minted for *that* asker's own OAuth subject, so a different person's ask
  reaches a different vault row, and a person with no grant is asked to connect their account;
- everybody whose words are in the conversation is vouched as a member — no author was positively
  refuted, **and** you declared the room `internal` in `agent/identity/surfaces.ts`. A refutation is
  positive-only, so a platform that cannot answer refutes nobody; your declaration is the vouch
  instead. An undeclared room means "nobody here is vouched", and a deployment that has declared
  nothing internal has no member plane anywhere until it declares something. The declaration counts
  at any rung you wrote it on — the room, its container, its group, the whole workspace — but it
  never promotes a room the platform positively reports as external. A group DM reaches this gate
  too. Nobody declares its own per-conversation key, but any rung above it vouches it — the tenant
  rung included — so a workspace-wide declaration admits the plane there. The refutation leg reaches
  a group DM too: a guest or an outside person who **writes** there stamps that wake as a non-member wake, through
  the same per-author probe a channel uses. Presence stamps nothing — no roster is read;
- the operation is a **read**. A write would carry your name at the provider, so it is refused
  outside a DM.

**A DM is a different path, not an exception to this one.** The member plane governs shared rooms;
your own DM resolves your own credential without it, and a **write there is admitted** on the
ordinary approval card. The asker, the person who clicks Approve and the name the provider records
are all you, so the objection above does not arise. Updating your own Notion page from your own DM
is a normal, approved action.

The approval seam **proves** that DM rather than assuming it: it reads the same is-DM predicate the
credential mint reads, and it refuses a personal-credential write on any surface that does not
positively resolve as a DM — an unreadable surface included. It refuses too when the person the turn
serves and the person whose DM it is are not the same.

There is no per-thread mount and nothing to revoke per room: you disconnect your account and
the credential stops resolving everywhere on the next turn.

## The broad-grant lint

`org` and `tenant` scopes reach **every** surface beneath them — including surfaces
created later and broadly-joinable public ones (the de-facto wildcard footgun). So binding a
credential, connector, repo, provider, or plugin at `org`/`tenant` scope raises a
`broad grant:` warning at preview time — the blast radius is visible *before* you ship.

A `domain` or `surface` scope is an explicit, curated grouping — the intended way to grant
capability — so neither is flagged. A `principal` scope is one person's own and isn't broad
either. The lint is purely additive: it warns, it never changes resolution.

`npm run lint:access` is the stricter, gated half of the same idea: it **fails the build** on a
credentialed bundle bound broadly unless the binding carries an explicit
`allowBroad: "<reason>"`. Three things count as broad there, and the last two are widths a
binding's own address cannot show:

- an `org` or `tenant` scope;
- a `domain` scope whose domain reaches a whole tenant with a container entry (so it reaches surfaces
  nobody enumerated, including ones created tomorrow);
- a `group` scope whose group holds a `{ linkSet }` member — whose expansion into DMs is
  decided at resolve time and grows whenever that person links another account — or holds 8+
  members. A small, fully-enumerated group is the curated case and is not flagged.

The recommended posture: **start at `domain` scope, drop to `surface` for the sensitive
stuff, and reserve `org` for genuinely-everyone reads** (a read-only knowledge base).

## Network-access levels: the environment, apart from credentials

Everything above is about **credentials** — which hosts a scope may reach *with a specific
secret*, or reach at all because a bundle named them. There is a second, separate question a
bundle never answers: how much of the *general internet* may a scope's sandboxed compute reach
— a plain `curl`, a `pip install`, cloning a repo the agent was never granted, browsing a page
nobody's credential is attached to?

Claude Tag names this second axis **Environment**, and pins a level to it per scope,
independently of any bundle: "Trusted access" (a curated default of package registries +
developer hosts), "No access", or "Full access". Open Everywhere's `defineNetworkAccess`
(`packages/core/agent/access/network-access.ts`) is that same axis:

```ts
// agent/access/network-access.ts
defineNetworkAccess({ scope: { level: "surface", surface: "slack/T_CO/C_CODING" }, level: "trusted" }),
```

**Three levels, all ADDITIVE — never a restriction:**

| Level | Adds |
|---|---|
| `"trusted"` | The curated set: every package-registry host (`PACKAGE_REGISTRY_HOSTS` — npm, jsr, PyPI, crates.io, the Go module proxy) plus `github.com`, the one developer host this codebase already treats as belonging to that set. See `TRUSTED_ACCESS_HOSTS` in `network-access.ts` for the exact, current list. |
| `"none"` | Nothing. This is the default, and it is today's behaviour, unchanged — a scope with no networkAccess binding compiles byte-identically to before this axis existed. |
| `"full"` | An unrestricted catch-all (`"*"`, no credential), on top of whatever the scope's bundles already grant. Mirrors Tag's own gated allow-all escape hatch — a reviewable scope-level pin instead of a `*` buried in a bundle's host list. |

A level can only ever **add** bare, credential-less reach — it can never take away a
credentialed host a bundle already opened, and a bundle's own credentialed rule for a host
always keeps its own narrowing (method/path/transform) even under `"full"`.

**A `"full"` pin at `org` or `tenant` scope prints a boot-time warning** (`assertNetworkAccessValid`,
`network-access.ts`) — it opens unrestricted egress for every surface under that scope, including
future ones, which is worth a reviewer's attention. The warning never fails a gate and never blocks
boot: it is WARN ONLY, by deliberate ruling, unlike the credentialed-bundle broad-grant lint below.
A `"full"` pin at `domain`/`surface` scope stays silent (narrow scope is the whole point), and so
does a `"trusted"` pin at any scope (a curated, reviewed host list — lower blast radius).

**Resolution is the same narrowest-wins, org-default-otherwise doctrine as everything else on
this page**, restricted to the container ladder (`org < tenant < domain < surface` — no
`group`/`principal`; Tag's own Environment object is org-scoped, never per-account, "because
channel sessions run with no user account attached"). A scope that pins a level overrides one
it would otherwise inherit; an unpinned scope inherits the nearest wider pin; a scope no pin
reaches at all resolves `"none"`.

**This is a legibility/config-shape addition, not a second enforcement path.** The resolved
level feeds straight into the existing firewall compiler (`compileNetworkPolicy`,
`access/egress.ts`) as one more additive input, right beside the credentialed/credential-less
hosts a bundle already contributes — see
[Credentials & the two planes § The host can change the policy](../security/credentials-and-planes.md#the-host-can-change-the-policy-the-agent-cant)
for that compiler's full contract. It replaces the old pattern of hand-copying
`PACKAGE_REGISTRY_HOSTS` onto a bundle's `domains` list (still valid, and what `"trusted"`
compiles to under the hood) with a named, reviewable scope-level pin.

## Worked example — one bundle, two channels, no leak

A payments team wants the agent, in their `#payments` channel, to read their Notion runbook
and open PRs on one repo — nothing else, nowhere else.

```ts
// access/bundles.ts
defineBundle({
  name: "payments-tools",
  // host-side; gated per surface. `credential` names the identity this scope reaches it as.
  connectors: [{ name: "notion", credential: "team-readonly" }],
  connections: [{ id: "gh", credentialType: "github-app",
                  secretRef: "GH_PAYMENTS", allowedWebsites: ["api.github.com"] }],
})

defineBinding({
  bundle: "payments-tools",
  // A domain scope is the domain's BARE name — no tenant qualifier, because a domain is
  // a cross-platform grouping. (A `tenant`/`surface` scope instead takes the qualified
  // key: { level: "surface", surface: "slack/T_CO/C_PAY" }.)
  scope: { level: "domain", domain: "payments" },
})
```

Now compare two channels:

- **In `#payments`** (a member of the `payments` domain): the binding's scope *matches*, so
  `payments-tools` enters the resolved set. The agent reaches Notion (gated to this surface)
  and GitHub (the one repo, the credential injected at the firewall). ✅
- **In `#random`** (not in the `payments` domain): the binding's scope does **not** match,
  so `payments-tools` never enters the resolved set. Notion isn't granted, `api.github.com`
  isn't reachable, the `GH_PAYMENTS` secret is never selected. The agent in `#random` simply
  *has no way* to touch the payments team's tools. ✅
- **In a DM** with anyone: a DM resolves against the *caller's own* scope — neither the
  Notion connector nor the GitHub credential applies. ✅

**Why the grant in `#payments` can't leak to `#random` is not policy text — it's the data
model.** The grant is bound to a *scope*, and scope membership is checked by a pure
function. `#random` isn't a member of the `payments` domain, so the bundle is never even
*applied* for that request, so none of its grants can appear in `#random`'s effective
access. There is nothing to leak.

## Capability sets — what a binding opts into

**Repository capability names are closed in code.** `repoCapabilityProblems`
(`packages/core/agent/access/repo-capabilities.ts`) refuses a `capabilities` value that is not an
array, an entry that is not a non-empty string, and a name outside the known set — listing the known
names in every refusal. **An empty list is refused too**, because it expands nothing: the two honest
spellings are a bare repository string for the default job sets, or a named capability. The mapping
from a name to a vendor family is left to the mint, so this module holds names only.

**Resource capability names work the same way, each acting on exactly one resource type.**
`resourceCapabilityProblems` (`packages/core/agent/access/resource-capabilities.ts`) refuses the same
malformed shapes and refuses an empty list, naming the default set for that resource type as the
alternative to omitting the key. A capability name narrows what the model may call; it is never a
static vendor token.

**A per-surface tool mounts for a platform only when that platform is one of the window's sources.**
`sourceScopedMount` (`packages/core/agent/access/source-scoped-mount.ts`) asks the window's resolved
source list. A config that will not load answers `false` — no mount, and never a throw out of a
resolver. When no window stamp and no parseable window token are available, the source list falls back
to the turn's single origin platform, and to the empty list when even that is unresolvable.

**A conversational seat is told what a worker can do by capability, not by tool name.**
`renderWorkerCapabilityIndex` (`packages/core/agent/access/worker-capabilities.ts`) renders one block
naming the kinds of work a worker can take on and the verbs a worker holds there that this seat does
not. Everything but the grouping is derived from the window-gate manifest, so the block cannot claim a
verb the manifest does not mount. It renders nothing at all for a seat whose memory recall route is not
a delegating route (`agent` or `work`), and nothing when no group has a present verb. The block also tells the seat not to
pre-empt a gate it does not hold. The seat must not refuse an ask on its own judgement of the person's
standing, or on its own forecast of what a gated act will do. The verb's gate and the approval plane
decide.

**A delegated worker's toolset identity is claimed once and de-duplicated on the roster.**
`claimWorkerToolsetEvidence` (`packages/core/agent/access/worker-toolset-state.ts`) answers `mount` the
first time a roster key is seen and `changed` when the key moves, and `null` when the key is unchanged
or when there is no session context. A lost claim costs an audit-trail row and never a control.

**A turn may not mark a wake answered while a worker it dispatched still owes that wake an answer.**
`pendingDelegationOwing` (`packages/core/agent/access/pending-delegation-signal.ts`) answers the first
task id still owing this wake. Every reader fails soft: no turn id, no session context and a turn-id
mismatch all answer `undefined`. There is a deliberately wake-free reader for a per-surface door that
holds one conversation and carries no wake id — it must never be pointed at a unified door, where the
first pending dispatch can belong to a sibling conversation.

**Delegation has one deployment-wide gate, and every consumer reads it live.** `oneshotAgentEnabled`
(`packages/core/agent/access/delegation-flag.ts`) reads the `delegation.oneshotAgent` setting at each
point of use rather than caching it. A module-level constant would capture the shipped default and
never move, because imports are evaluated before the deployment's overrides are registered. There is
**no environment override** for this flag — less delegation is a reviewed diff in the deployment's own
settings — so what the live read buys is that a deploy which disarms delegation reaches already-standing
seats without waiting for them to rotate.

**The machine-owned config overlays have one module grammar.** `wrapOverlayModule`
(`packages/core/agent/access/overlay-module.ts`) emits a generated header, `export default`, the
canonical data and a fixed suffix — so a module's bytes are a pure function of its parsed structure and
a drift lint can re-emit them. The matching unwrap **refuses** a file whose prefix or suffix does not
match, which is exactly the case where something outside the data was touched. The header is checked
for SHAPE, not for bytes (OPE-2217): it must open with the fixed banner line and hold only `//` lines,
none of which may contain a `\r`, U+2028 or U+2029 line terminator (each would end the comment early
and run the rest of the line). The round-trip compares the bytes after the header, so a release that
changes the header words does not refuse an existing app's overlays. The check and the re-emit ship in
core (`packages/core/agent/scaffold/overlay-check.ts`) as `oe overlays check|normalize`, and
`oe build --check` runs the check.

**A read gets an age, not two timestamps.** `ageAtRead` (`packages/core/agent/access/dated-read.ts`)
renders the gap between an item's own time and the time the read ran, in minutes, hours or days, so the
model reads a contrast. It answers `undefined` for a missing or unparseable time on either side, and
for an item dated **after** the read — a negative age is never rendered as a positive one.

**A tool that keeps returning the identical result gets a nudge, never a block.** `noteToolResultLoop`
(`packages/core/agent/access/loop-breaker.ts`) counts identical tool-source and result-body pairs
inside one turn. At **three** it appends an advisory warning, and at **five** a stop-now directive. It
only ever appends text to the result: the result itself is never withheld. With no session context it
tracks nothing and appends nothing, and the counters reset at each turn start. A worker that parks
on `ask_question` and resumes on the answer stays in the same turn, so its count carries across the
answer. Each write stores a fresh map, because eve's step delta drops an in-place change to a stored
`Map`. The loop breaker runs inside the result controls
(`packages/core/agent/access/result-controls.ts`), with the result cap and the reducer arm. That step
knows nothing of the untrusted-content envelope, so the three controls do not depend on it.

## Work destinations — where a work verb may land

A **work platform** is a surface the agent files work on rather than talks in — a ticketing system, a
repository host. `registerWorkPlatform` (`packages/core/agent/channels/work-registry.ts`) is how a
bundle declares one. Registration is **additive and idempotent**: a re-registration keeps the first
non-undefined role, so no two bundles can race, and load order cannot change what a grant means.

`grantedWorkPlatforms` (`work-destinations.ts`) resolves the destinations a caller actually holds. It
starts from the caller's work domain, and **a caller with no resolvable domain holds no work grant at
all** — the list is empty, never a default destination. It then keeps only the registered platforms
whose role the domain grants.

`grantedRepos` answers the same way: an unreadable config, or a context with no resolvable identity,
yields an **empty** repository grant. An empty list is a refusal, not a fallback.

## Proposing a ticket state change

`set_state` (`packages/core/agent/tools/set_state.ts`) proposes a ticket's new status — a Linear
workflow state, or a GitHub issue or pull-request state. It is entity-gated, so it refuses cleanly on
a chat or Notion surface.

**The entity is bound to the asking session.** The tool resolves the current turn's own entity unless
the caller names one, and the entity gate decides whether this session may act on it. Only the
**approval card's venue** may move, and only to a card-capable channel inside the same domain. When
the card lands elsewhere, the tool's `message` field names that channel and the model must relay it.

**Nothing mutates until a human confirms.** The tool freezes the arguments — org, scope key, platform,
entity id — into a pending action and posts an approval card. The posted card **is** the reply. The
call also requires a verified sender: with no resolved principal id there is no requester to show on
the card, so the tool refuses.

**One domain-config read is threaded through both gates.** `safeDomains` loads the domains once,
fail-soft to an empty list, and the same value reaches the entity gate and the approval-venue walk.
The two therefore cannot disagree about which domains exist.

## A grant is a boundary, enforced in several places

The grant isn't a hint the agent is trusted to honour. It's enforced:

1. **Config-as-code** — the grant is a reviewed, version-controlled change
   ([Config-as-code](./config-as-code.md)).
2. **The resolver** — computes the authoritative effective access for the surface, deterministically.
3. **A per-surface hard gate** — every connector's `getToken` re-resolves the *calling*
   surface and refuses (terminally, fail-closed) if that surface wasn't granted it.
4. **The egress firewall** — only granted hosts are reachable, and the credential is
   injected at the boundary so the agent never holds it.
5. **The broad-grant lint** — surfaces over-broad bindings before they ship.
6. **Break-glass revoke** — a runtime override can *remove* a granted **connector** without a
   deploy: the credential resolver overlays the override on every call, so it takes effect on the
   agent's next connector operation (narrow-only; widening is exclusively a reviewed PR). It is the
   connector plane only — an AWS role grant, a repo grant or an egress host has no runtime narrow
   and changes by deploy. See [The control plane](../security/control-plane.md) and
   [What revoke actually reaches](../security/revocation-latency.md) for the per-plane latencies.

Widening has an ergonomic in-channel path that keeps the merge as the gate — the agent
turns an ask into a machine-checked delta and a bot-PR an admin merges. See
[Access requests](./access-requests.md).

For the wider trust story this sits inside, see the
[Security model](../security/security-model.md). For the vocabulary used here, the
[glossary](../introduction/core-concepts.md).
