# Skills & plugins

How you teach the agent to *do* something: a **skill** wraps a script with prose and
reference material; a **plugin** bundles skills, connectors, and sub-agents into one
grantable capability unit.

A skill is the agent-facing unit of know-how — exactly the shape Claude Code skills
take. A plugin is the *coupling* unit: it grants an integration's know-how **and** its
teeth (credentials, egress) to a surface together. Plugins, connectors, and repo-shipped
skills are added at **build time**, through code and deploy, never installed at runtime by
the agent — with one deliberate exception: a bare, domain-scoped **skill** *can* be
authored at runtime, in-thread, by any member of the domain (no teeth of its own — see
[Runtime domain skills](#runtime-domain-skills)).

## Skills: prose + reference + scripts

A skill is a packaged directory (`SKILL.md` plus siblings) or a flat Markdown file:

- **Prose** — the `SKILL.md` body: what this skill is for, when to use it, the workflow.
  Loaded progressively, so the agent reads the detail only when the skill is relevant.
- **Reference** — `references/` files the agent reads on demand.
- **Scripts** — `scripts/` the agent runs. The script is also the **reduction stage**:
  it does the work and returns a small result, so a bulk API response never lands in
  context (unlike an MCP tool whose full output is pulled in).

The credential a script needs is **injected at the egress firewall**, not handed to the
skill. The skill `curl`s a plain URL; the firewall stamps the auth header on the way
out. So a skill carries the "which endpoint, when" and the firewall carries the secret —
the script never holds a token. See
[Credentials & the two planes](../security/credentials-and-planes.md).

This is why a skill-wraps-script REST integration is the lighter path than a generated
tool surface — covered from the integration angle in
[Connectors & providers](./connectors-and-providers.md).

## Skills are scoped per surface

Skills are deliberately **not** static files that auto-load for every session — that
would defeat per-surface scoping. Instead a session sees only the skills its access
bundle grants.

A dynamic resolver runs at `session.started` and re-runs at `turn.started` (so a
mid-session re-tag picks up edited bundles), resolves the bundle's granted skills, and
exposes only those to the model. This is the **visibility** half. The **teeth** half is
enforced underneath: a skill's scripts can only reach the hosts and credentials the
bundle granted (the egress firewall + the connector gate), so an ungranted skill is both
hidden *and* defanged. An empty grant means the session sees no plugin skills — any
base, authored skills still apply.

Two more sources merge into the same resolved set, in precedence order (narrowest wins on
a bare-name collision): bundle-**granted** skills beat runtime-authored **domain** skills
beat repo-**discovered** skills.

One addition rides the same resolver: skills **shipped inside a checked-out repo**
(`.agents/skills/`, else `.claude/skills/`) are merged in for the session, namespaced
`<repoSlug>--<skill>` so they can never shadow a granted skill. They arm only for repos
a bundle granted — details in [Source control](./source-control.md).

## Runtime domain skills

The one deliberate exception to "skills are added at build time" (see below): any member
of a [memory domain](../how-it-works/access-and-scoping.md#domains-the-channel-grouping-unit)
can author a **domain skill** directly, in-thread, with no code and no deploy — `create_skill`,
`list_skills`, and `delete_skill` are agent tools, not a config file. "Anyone does
everything": no admin or role is needed — any domain member may **propose**. But because a
skill is a procedure the agent loads and follows (and deleting one removes a guardrail),
`create_skill` and `delete_skill` **post an approval card**: the change lands only when a
human in the domain clicks confirm (a member-tier injection gate — being able to click means
being in the channel — not an admin gate). Every create/update/delete is **audited** with
both the proposing and the confirming principal.

**A triggered routine fire can propose neither.** Both tools need a *person acting on the turn*,
and an unattended fire has none — it binds as the creator it is attributed to, which is a name for
the audit row, not somebody in the room. So a nightly routine that tries to author or delete a
skill is refused, by design: an armed skill is standing instruction text every later turn of the
domain follows, and it arms on a single click against a body the fire wrote — with a real person's
name on the card asking for it. Routines can still *say* a skill is needed in the channel; a person
then proposes it. (This is the same fence [`edit_routine` and its siblings](proactivity-and-routines.md)
carry, for the same reason.)

**The approved body is kept, not just the approval.** An edit is an upsert over the live row,
so without a record the next approved change would destroy the exact markdown the previous
approver read — leaving an audit that knows *who* approved a change but not *what they agreed
to*. Every write therefore also appends the body, its author, its approver and the id of the
card that armed it to an **append-only revision log** (`domain_skill_revisions`, insert-and-
select-only under `FORCE ROW LEVEL SECURITY` on Postgres — see
[Database & operational store](../extending/database.md)). Deleting a skill leaves its
revisions standing, and nothing prunes them: they are bounded by human approvals, not traffic.

A domain skill is a bare-named (no repo-style namespace — the domain is already the
disambiguating scope), model-facing markdown package, stored in the operational store (not
files — small, structured, read every turn). It's capped at 32KB per skill (the same size
repo skills are truncated to) and at `skills.domainSkillCap` skills per domain (default 50).
Authored-in-domain content **arms from your next turn** — skills resolve at
`session.started` and re-resolve at `turn.started`, the same seam that already picks up a
mid-session repo checkout.

Domain skills resolve for the channel's own explicit domain, or the `org` pseudo-domain for
an internal, unassigned channel — the same single-hop rule memory/model-routing/status-verbs
use. They're deliberately refused from a **DM** (would arm across every DM session — a
cross-user context leak), a **group chat** (execution-only, no memory domain), and an
**externally-shared or unconfirmed channel** (untrusted). A DM session still *sees* the
org's domain skills through normal resolution; it just can't author one.

**Skills are context, not access — this doesn't change with runtime authoring.** A newly
authored domain skill can only reach whatever hosts/credentials the channel's *access
bundle* already grants (the egress firewall + connector gate enforce that underneath,
unconditionally on where the skill's prose came from). Anyone-in-the-domain governs *what
the agent knows how to do*; it was never a path to granting *what the agent can reach* —
that stays code + PR, per the credential story in
[Credentials & the two planes](../security/credentials-and-planes.md).

`skills.domainSkillCap` and the size/precedence rules are in the
[configuration reference](../deploy/configuration-reference.md).

## The agent proposes a skill: the learn loop's pull request

A third way a skill arrives, and the only one nobody asks for. When a workflow keeps recurring,
the [dream cycle's learn mode](memory.md#the-skill-proposal-and-how-a-correction-reaches-the-next-one)
drafts a `SKILL.md` for it. Where the deployment has a config repo (`accessRequests.configRepo`),
that draft opens a **pull request** on it, adding the file under `.agents/skills/<name>/SKILL.md` —
so it arms the way any [repo-shipped skill](#skills-are-scoped-per-surface) does, on the next
checkout of a granted repo. `memory.skillProposalPr` ships on. With no config repo, the draft stays in
the review queue and nothing errors. A config repo in dry-run mode (`dryRun: true` in
`agent/access/access-requests.ts`) opens no pull request either. Set it to `false` to keep every
draft in the queue only.

**Merging is the approval.** The cycle writes one branch and one file, never the base branch, and
it cannot merge — the same "a skill is a procedure the agent follows, so a human reads it first"
rule the approval card enforces for `create_skill`, on a surface that shows the whole diff. A
review or a comment on the proposal is read back as a **correction** and carried into the next
proposal, and only an author with standing in the repository can write one.

## Declared subagents: the specialist unit

A **skill** changes what the agent knows in the session it already has. A **declared
subagent** hands the work to a *different* session with its own prompt, its own model, and
its own tool surface. 🔴 The result is PROSE on this pin — see *The result was typed…* below. Reach
for one only when the clean
context is the point; if an optional procedure would do, a skill is the lighter choice.

A subagent lives in one directory under the deployer app:

```text
agent/subagents/<name>/
├── agent.ts            # required: description + model (NOT outputSchema — see below)
├── instructions.md     # its own prompt (nothing is inherited)
├── tools/              # its own tools — Open Everywhere ships these as disable sentinels
└── hooks/spend.ts      # its own spend hook (hooks are not inherited either)
```

The directory name **is** the tool name the agent sees — bare and unprefixed, in the same
namespace as everything in `agent/tools/`. So it is lower `snake_case` like every other
tool, and it may not collide with one (Eve refuses to build rather than pick a winner).

**Nothing is inherited.** Eve treats the subagent's directory as its own agent root: an
empty slot falls back to the *framework* default, never to the root agent's version. That
cuts both ways, and the second way is the one that matters — a subagent with no `tools/`
directory gets Eve's built-in `bash`, `web_fetch` and `web_search`, and since hooks aren't
inherited either, the [egress firewall](../security/credentials-and-planes.md) isn't there
behind them. Nor is the host-side `web_fetch` allow-list fence: that is a wrapper the app
applies where *it* mounts the tool, so a framework built-in reached this way carries neither
of the two things that bound reach elsewhere. Open Everywhere's convention is therefore
**zero hands**: every framework tool eve mounts by default is disabled by an explicit
`disableTool()` sentinel. The connector slots are the exception, and they changed hands at eve
0.69.0: `connection_search`, `connection_execute` and `connection_tools` are now RESERVED, so an app
may not author anything there — not a sentinel and not the no-op replacement this subagent used to
carry. They mount nothing anyway for a subagent that declares no connections of its own, because eve
builds a connection registry only for a node that declares some — static or dynamic, both of which
are modules under `connections/`. Either way the subagent holds no
tool, and everything it needs arrives in the message it was called with. A subagent that holds no tool cannot widen access, whatever an
injected instruction inside the material it was handed tells it to do. `scripts/subagents-lint.ts`
pins which slot takes which treatment and pins the spend hook too — without it a delegated child's
tokens never reach the ledger or the monthly cap. `scripts/subagent-zero-hands-test.ts` pins the rest:
that every file in `tools/` is a `disableTool()` sentinel importing nothing but `eve/tools`, that a
sentinel exists for every slot eve mounts by default, that nothing is authored at a reserved slot, and
that eve still scopes its connection registry to the active node.

> 🔴 **Both gates hold the sentinel-per-slot rule, deliberately** — `subagents-lint` against the
> declared-subagent rules, and the zero-hands test's clause 6 against this subagent's real tree. On the
> eve 0.69.0 re-roll the lint was dead, because the shared mount-set reader expected a declaration eve
> had removed; OPE-2254 re-derived it, and `lint:window-gate`, `lint:consequence`,
> `lint:capability-docs` and `test:tool-roster` came back with it.

**The result was typed, and on this pin it is prose.** 🔴 `agent.ts` used to declare an
`outputSchema`, and eve applied it whenever the subagent ran as a task and the caller passed no schema
of its own — so an ordinary call returned a structured verdict. By eve 0.69.0 all three parts of
that road were gone: `mode` and `outputSchema` went at 0.67.0, `execution/workflow-steps.js` is gone, and `outputSchema` is no
longer a `defineAgent` field, so authoring one is a typecheck error. A schema is now REQUESTED PER
TURN by the caller, and the caller of a declared subagent is the parent model, which no authored code
reaches. **Do not author one**; the lint refuses it so the failure names a cause.

The contracts stay in `packages/core/agent/subagents/contracts.ts` (they're spine, not per-deploy
config) and remain the stated result shape every consumer is written against — but nothing enforces
them at the subagent boundary today. OPE-2250 re-derives the enforcement on eve's native task surface.
What is unchanged is the CONSUMER-side treatment: `post_pr_walkthrough` takes the verdict as a tool
input and `approvals/review-surface.ts` collapses every string to one line inside a block labelled as
a model opinion. The typed contract was never what made a verdict safe to render. Design the shapes to
**fail closed** anyway: give the verdict field the value that means "I could not confirm this" and no
third value to hide in.

The generic `agent` delegation verb takes no caller schema at all: Open Everywhere strips the field.
An unmet schema fails the child's whole turn, and the parent is then handed an error class instead of
the answer —
so a worker's refusal, the thing the seat most needs to relay, is exactly what such a schema
destroys. Delegated work reports back in prose — and on this pin so does a declared subagent, because
the field it used to declare no longer exists. A shape you can rely on waits for OPE-2250 to re-derive
one on eve's native task surface.

One ships in the box:

| Subagent | What it does |
| --- | --- |
| `fresh_eyes_review` | Independent second pass over a proposed change. Findings with severity, plus approve/block. Blocks when no actual change was supplied. |

It is also a row in the two fail-closed manifests — a
[consequence tier](../security/security-model.md) in `packages/core/agent/access/consequence.ts` and a
grain posture in `packages/core/agent/access/window-gate-manifest.ts`. A new subagent that declares
neither fails the `test` chain, exactly like a new tool would. It currently sits at the open/always-
available tier *because* it holds no tools; giving a subagent real hands is a posture
change that has to move those rows first. (A conversational seat reaches it through a
worker, like every other doing-verb — its caller is the worker authoring a change.)

## Plugins: the capability unit

A **plugin** is a Claude Code / Cowork-format package — an open, cross-agent standard,
not Claude-only. It bundles four kinds of component:

| Plugin component | Becomes (Eve-native) |
| --- | --- |
| Skills | Skill-content registry entries (`agent/plugins/generated/<slug>.ts`) — **not** `agent/skills/` files; see below |
| Slash commands | Skill-content registry entries (an autonomous agent doesn't type `/foo`) |
| MCP connectors | Eve connections (`agent/connections/<ns>.ts`) — HTTP/SSE only |
| Sub-agents | Eve sub-agents (`agent/subagents/<ns>/`) — see [Declared subagents](#declared-subagents-the-specialist-unit) |

A bundle grants a plugin **by name**. That name is an alias that expands — via the
plugin registry — into the connectors, skills, and sub-agents the plugin actually
unlocks. Granting the plugin grants the whole integration (its know-how and its teeth)
to a surface as one coupling unit. A plugin's `instructions`, statusline, settings, and
output-styles are *not* components and are not extracted — the bundle's own
`instructions` field is owner-authored and separate.

Extracted skills land as **data** in the skill-content registry, in the exact shape
["Skills are scoped per surface"](#skills-are-scoped-per-surface) describes for
hand-authored entries — never as a static `agent/skills/<ns>/SKILL.md` file. That path
is Eve's own skill-discovery directory: anything placed there loads for **every**
session, unconditionally, which would bypass the bundle/plugin grant scoping this whole
section exists to provide.

## How a plugin is added: build-time extraction

Open Everywhere **adopts the plugin format and extracts each part into an Eve-native
artifact**, rather than hosting plugins as a black box. The flow:

1. `npm run plugin:extract --workspace @open-everywhere/core` reads a plugin directory into a
   parsed model, then produces an **extraction plan** — a list of files to write (skills,
   connections, sub-agents)
   plus a report of anything that needs a human. The plan is pure; it generates
   config-as-code.
2. The generated files land in your repo as **reviewable, pinned, PR'd** artifacts — the
   skill bodies in a content registry, and a **plugin registry** mapping each plugin name
   to its extracted connectors/skills/sub-agents (the table the resolver expands grants
   against).
3. You commit and **deploy**. The capability now exists in the build.

Two consequences worth stating plainly:

- **No runtime install of a plugin, connector, or repo-shipped skill.** The agent cannot
  install a *plugin* into a live session, and a cloned repo's checked-in `.mcp.json` is
  never loaded — connections come only from the bundle. Adding one of these is a code
  change that goes through review and deploy. This is the capability-definition-vs-configuration
  boundary: *defining* a new capability is code+deploy; *configuring* who can use it
  (grants, scopes) is the runtime control plane. See
  [Config-as-code](../how-it-works/config-as-code.md). The one deliberate exception is a
  bare **domain skill** — prose only, no code, no teeth of its own — which any domain
  member *can* author at runtime; see [Runtime domain skills](#runtime-domain-skills) above.
- **Some components can't be hosted.** The extractor's report flags components that need
  human action — for example a **stdio** MCP server (one launched as a local command
  rather than an HTTP/SSE URL), which Eve can't host. Those are surfaced, not silently
  dropped.

## On Vercel / off Vercel

The build-time model is identical everywhere: skills and plugins are part of your
deployed build, not a runtime registry. On Vercel that build is `vercel deploy`; self-host
runs the same `eve build` output. There is no separate "skill store" to operate on any
platform. The seam where richer runtime-install models *could* live (vetted bundles behind
the existing extraction boundary) is intentionally left unopened — added only on demand.
