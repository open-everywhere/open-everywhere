# Core concepts

**The vocabulary, defined once. Each term links to the page that covers it in depth — this is
the page to bounce back to whenever a word is unclear.**

The terms cluster into three groups: where the agent *talks* (surfaces, the loop), what it's
*allowed to reach* (domains, bundles, grants, scopes, narrowest-wins, the two principals), and
what it *knows and can do* (silos, connectors, skills, routines). The seam machinery
(adapters, brokers) cuts across all three.

## Where the agent talks

**Surface** — a platform the agent listens on. Six ship today, each an extracted provider bundle
under `packages/providers/`: Slack, Microsoft Teams, Discord, Linear, Notion and GitHub. All six
are places the agent talks — every bundle registers an identity mapper, a post arm and a read
adapter. Linear, Notion and GitHub *also* carry the **work-surface** plane: event ingress, work
search, and actions on the vendor's own objects (an issue, a page). A work surface is a plane a
surface may add, not a separate species. Each inbound message is translated by a
small per-platform *mapper* into one platform-agnostic `SurfaceBinding` (org, platform,
workspace, surface, mode, visibility, trust), so the
rest of the system never sees a platform-specific field. Adding a surface is one mapper plus one
visibility/trust decision. See **[Surfaces](../extending/surfaces.md)** and
**[surface setup](../deploy/surfaces/)**.

**The loop** — the agent runtime itself, provided by Eve: model dispatch, tools, turns, and the
approval primitive. *Which* actions are consequential enough to pause for a human is Open
Everywhere's own governance layer — the lint-pinned [consequence registry](../security/security-model.md#4-approval-gates-are-governance-not-a-crutch),
not a per-tool judgement. Per-event behaviour is injected
at dispatch time rather than baked into the base prompt. See
**[The agent & the loop](../how-it-works/agent-and-loop.md)**.

## What the agent is allowed to reach

**Scope** — the level a bundle is bound at. Four rungs of increasing specificity —
`org` → `tenant` → `domain` → `surface` — plus two **off-ladder** personal levels, `group` and
`principal`. `org` is the root and matches every request; `tenant` and `surface` take
platform-qualified keys (`slack/T0123ABC`, `slack/T0123ABC/C0123ABC`); `domain` and `group` take
bare names. `group` (a named set of humans) and `principal` (one person's own scope) resolve
**only in the DM universe** — they never match a channel, and a service bundle grants nothing in
a DM. See **[the glossary's scope ladder](../glossary.md#5-scope)** and
**[Access & scoping](../how-it-works/access-and-scoping.md)**.

**Bundle** — the scoping unit: a named, reusable set of grants. The fields are `connections`
(egress), `connectors` and `connectorOps` (the connector plane), `repos` and `resourceGrants`
(work sources and named containers), `domains` (credential-less egress hosts), `plugins`,
`awsRoles`, `approvers`, `preApprovalRules`, and `instructions`. A bundle is defined *once* and
bound to *many* scopes, which is what lets the same Notion+GitHub basket attach to ten teams
without copy-paste. Capabilities don't attach to a scope directly — they're grouped into a
bundle, and the bundle binds to the scope. See
**[Access & scoping](../how-it-works/access-and-scoping.md)**.

**Grant** — one capability handed to a bundle: a credentialed egress connection, a host-side
connector, a repo, a named container on a surface, a credential-less reachable host, a plugin, an
AWS role, an approver-chain element, a pre-approval rule, or a standing instruction. Grants are
additive for capabilities (a narrower scope *adds*) and single-valued for credentials (a narrower
scope *replaces*). See **[Access & scoping](../how-it-works/access-and-scoping.md)**.

**Domain** — the channel-grouping unit, narrower than a workspace and wider than one channel. A
domain ties together the channels that share one brain and *where* that brain lives (a memory silo,
by name). *What* those channels can do is not a field on the domain — a **binding** names the
domain (`{ level: "domain", domain: "payments" }`), so grants stay in one reviewed list. A channel
belongs to **at most one** domain (enforced at config load), so a newly-written fact has exactly
one home.
"Pseudo-domains" (`org`, `public`, `dm`) match by the session's trust/mode rather than an explicit
channel list. Note: the `domains` *field* on a bundle is unrelated — that's a credential-less
egress allowlist, an unfortunate word collision. See **[Memory](../capabilities/memory.md)** and
**[Access & scoping](../how-it-works/access-and-scoping.md)**.

**Narrowest-wins** — the resolution rule for credentials: for the same connection id, `surface`
beats `domain` beats `tenant` beats `org`, single-valued, **with no fallback** — on a 401/403
the agent does not retry a wider bundle. Capabilities (repos, plugins, instructions, egress
hosts, connectors) instead take the additive *union* across the chain. Combined with default-deny
egress, this is the heart of the governance. Use the ladder's own words here: "channel" and
"workspace" are the vendors' names for a `surface` and a `tenant`, and mixing the two vocabularies
is how a wrong claim survives review. See
**[Access & scoping](../how-it-works/access-and-scoping.md)**.

**Role (RBAC)** — who's an admin, config-as-code, no roles table: **org admin** (listed on the
`org` pseudo-domain's `admins`, covers everything) or **domain admin** (listed on an explicit
domain's `admins`, covers only that domain — doesn't inherit from org, though an org admin is
also a domain admin everywhere). A separate, coarser tier, **anyone in the domain** (plain
channel membership), governs specific operations like routine create/list/cancel and domain-skill
authoring — RBAC narrows *on top of* that pre-existing posture, it doesn't replace it. See
**[Access & scoping](../how-it-works/access-and-scoping.md#roles-whos-an-admin)**.

**App-principal vs user-principal** — the two identity universes. On a **channel/domain**, the
agent acts under a shared **app** (service) principal — channel work never authenticates in a
personal context. In a **DM**, it acts under the caller's own **user** principal (interactive
OAuth, personal connectors), fenced to that DM. A personal (user-principal) credential resolves
only in DMs, never on a channel binding. The agent acts on its own principal for *authority* and
attributes-to-human for *audit*. See **[Identity](../how-it-works/identity.md)**.

## What the agent knows and can do

**Silo** — a named, reusable durable backing for a domain's memory: where learned facts
physically live. `provider` is required (`sqlite`, `postgres`, `git`, `github` or `notion`);
`container` and `path` narrow it and are provider-specific. A silo is self-describing (it
carries a description and, for read-only sources, the skill that teaches how to update it) and is
defined once, referenced by name from one or more domains — a shared silo means one brain. Every
silo is *materialised* to on-disk files the agent reads with file tools; an external source read
live is a connector, not a silo. See **[Memory](../capabilities/memory.md)** and
**[Memory backings](../extending/memory-backings.md)**.

**Connector** — a host-side integration (an Eve MCP/OpenAPI connection), addressed by its Eve
connection slug: the model calls the connection's tools and Eve attaches the token *host-side*, so
the call never enters the sandbox and the model never sees the token. A bundle grants one with the
single grant grammar `{name, credential, contentOrigin}`. `credential` is **mandatory** and has no
default — it names which configured identity this scope reaches the connector as, so N domains
reach one vendor with N different keys (narrowest-wins). A bare slug is not valid config. The
connector self-scopes and refuses an ungranted surface before any credential resolves. See
**[Connectors & providers](../capabilities/connectors-and-providers.md)**.

🔴 **"Provider" names nothing on the access plane.** The access plane once carried a second noun
beside the connection slug, and two nouns for one thing grew two grant grammars; OPE-591 deleted
it. Today "provider" means a **provider package** (`packages/providers/*`), a **memory** provider
(a silo's backing), a **model** provider, or an **OAuth** provider — never a connector. The
credential-scoped path *is* the connector grant above. See
**[the glossary's ruling](../glossary.md#6-connector-catalogue-grant--and-the-one-meaning-provider-keeps)**.

**Skill / plugin** — packaged know-how. A **skill** wraps a script or API as prose + reference +
scripts with egress-injected credentials (progressive disclosure beats dumping an OpenAPI spec
into context). A **plugin** is a Claude-Code-format capability package (skills + connectors +
subagents) granted to a bundle by name — the coupling unit that hands a whole integration's
know-how *and* its teeth to a surface together. Plugins, connectors, and repo-shipped skills are
added at build time (code + deploy), not installed at runtime — the one exception is a bare
**domain skill**: any member of a memory domain can propose one in-thread (`create_skill`), no
code or deploy — it arms when a human in the domain approves the card, from the next turn,
audited, with the approved body retained. A skill (of any tier) is never a path to new
*access* — only the credential/egress a channel's bundle already grants. See
**[Skills & plugins](../capabilities/skills-and-plugins.md)**.

**Routine** — durable, surface-owned proactive work: a scheduled task (posting every run, or only when the observed state changed) or an event-triggered one
created in-thread, with spend caps and self-disabling on repeated failure. This is the
reactive→proactive shift. See **[Proactivity & routines](../capabilities/proactivity-and-routines.md)**.

## The seam machinery

**Adapter** — a swappable implementation behind a shared interface. The model, surfaces, memory
backing, credential broker, sandbox, connectors, source-control backend, operational database,
control-plane identity, scheduler, and the hosting platform itself are all adapters. Selection is
**fail-closed** (the selected adapter must work — no silent fallback), and `env` is just a core
adapter, not a privileged built-in. This is the swappable-seams half of the product. See
**[The adapter model](../extending/adapter-model.md)**.

**Broker** — the credential adapter: a `CredentialBroker` whose one required method is
`getSecret(ref, authorizationDetails?)`. A broker that *mints* short-lived credentials may also
implement the optional `getSecretWithLifetime`, which then becomes the one resolution path.
The `env` broker (core) reads an environment variable; the `db` broker (core) resolves
chat-pasted keys encrypted at rest; a vendor vault (KMS/Vault) registers the same way. The `ref`
namespace is broker-specific (an env var name vs a vault path). OAuth token minting lives on a
separate seam — the connector plane's own-rolled user-auth-flow, not `getSecret`. See
**[Credential brokers](../extending/credential-brokers.md)** and
**[Credentials & the two planes](../security/credentials-and-planes.md)**.
