# Tools & the roster

Eve discovers tools by **filesystem convention**: one file per tool under the deployer app's
`agent/tools/`, and the tool's *name is the file's basename*. Open Everywhere keeps that convention
but stops asking you to maintain it by hand — those files are **generated**:

| file | tracked | what it is |
|---|---|---|
| `roster.config.ts` | ✅ committed | your declaration: which packages contribute, what this deployment **excludes** (with a reason), which Eve built-ins it takes away |
| `roster.lock.json` | ✅ committed | the expanded, **reviewed** roll-call — one line per contribution, `mounted` or `excluded` |
| `<package>/agent/contributions.ts` | ✅ committed (in the package) | what that package **offers**: name, kind, module, one-line summary |
| `agent/{tools,channels,hooks,schedules,skills,connections}/` | 🚫 gitignored | build output. `npm run oe:build` writes it; never hand-edit a file there |

> **`roster.config.ts` + `roster.lock.json` are your agent's capability roster, and their git diff
> is the review surface for what the agent can do.** A lock line moving from absent to `mounted`
> grants a capability. An `exclude` entry — which the schema forces to carry a reason — takes one
> away. Nothing else in the repo has to change for either.

Contrast that with the seams on the rest of this section's pages: an adapter is chosen by an env
var or per-bundle config and *what* it does is invisible in the choice. A tool is chosen by a named
decision with a reason attached. The rest of this page is how to read and write those decisions.

## Add your own tool

Write the implementation wherever it belongs — your own package, `packages/core`, an
`@open-everywhere/provider-*` bundle — then **offer** it from that package's manifest:

```ts
// @my-org/oe-extras — agent/contributions.ts
export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@my-org/oe-extras",
  contributions: [
    { kind: "tool", name: "summarise_ledger", module: "agent/tools/summarise_ledger.js",
      summary: "Roll up a ledger window into a short report." },
  ],
} as const;
```

…and **decide** about it in the app:

```ts
// roster.config.ts
export default defineRoster({
  packages: { "@my-org/oe-extras": true },   // mount everything it offers
});
```

Then `npx oe build --accept` — which records the decision in `roster.lock.json` — and commit the
lock. `oe build` writes `agent/tools/summarise_ledger.ts` for you.

The `name` is the name the model sees, so it is lower `snake_case` like every other tool, and it
must not collide with a declared subagent's directory name (Eve refuses to build rather than pick a
winner — see
[declared subagents](../capabilities/skills-and-plugins.md#declared-subagents-the-specialist-unit)),
nor with another package's contribution of the same kind (`oe build` fails and names both; the fix
is an explicit exclusion).

The `summary` is not decoration: it is what an upgrade agent quotes when it tells a human what a
newly-shipped tool does and whether they should want it.

**An optional input field is nullable on the wire, and your tool never sees the null.** Some models
send a value for every property in a tool's input schema, whether the property is required or not.
When a field has no null in its type, such a model invents a value for it. So before every model
call, `packages/core/agent/access/nullable-optional-fields.ts` rewrites each tool's model-facing
schema: every property that is not in `required`, and does not already allow null, also accepts
`null`. The same rewrite removes such a `null` before your `inputSchema` validates, so `execute`
receives the field as absent, exactly as it does when the model omits it. A field that you declare
nullable yourself (`.nullable()`) keeps its `null`, because there the null is your tool's own value.
Write `.optional()` for "may be absent"; do not add `.nullable()` to get this behaviour.

Six gates in `npm test` the roster does *not* excuse you from:

| Also required | Gate | Why |
|---|---|---|
| An entry in your package's `agent/contributions.ts` — name, kind, module, summary | `lint:contributions` | every entry must resolve to a real module on disk and carry a name legal under Eve's slug grammar; an illegal slug is discovered as an invalid slot rather than mounted, which is a silent capability loss. For **tools and hooks** — the two kinds where a shape predicate is sound — the manifest must also stand 1:1 with the package's directory. The other four kinds are **unguarded**, and the lint reports that rather than implying coverage it does not have |
| A page of `docs/` names your tool in an inline code span | `lint:capability-docs` | an undocumented capability is one nobody can review or explain; coverage is *derived* from the prose, not declared |
| A row in `packages/core/agent/access/consequence.ts` | `lint:consequence` | whether the tool needs approval is a property of the tool, and the tier table is total over the mounted surface |
| A row in the window-gate manifest — **every** tool needs one, gated or ungated | `lint:window-gate` | a standing seat and a one-shot task do not get the same hands, so a new tool may not land without a declared grain posture |
| A row in the work-mount manifest, if your tool does provider **work** | `lint:work-mount` | a work tool's mount comes from the caller's work grant, never from grain or chat topology; a tool a session can see but never use makes the model claim a capability it does not hold |
| A `// principal-gate:` marker on any refusal gate that reads a principal identity | `lint:principal-gate` | two questions read almost identically and mean opposite things; leaving the choice implicit has shipped a dead gate three times |
| `chain: { unattended: unattendedOf(ctx) }` on every `requestApproval` call — including one made through an alias | `lint:principal-gate` (rule 5) | the chain turns `ask` into `deny` on that boolean, so a hand-rolled or omitted one is a security control that fails open |
| The same derivation somewhere in any file that authors an eve `ApprovalPolicy` / `Approval<T>` — **annotate the policy**, because the written type is what the rule matches; an untyped inline `approval:` callback is invisible to it | `lint:principal-gate` (rule 5, shape E) | a `"user-approval"` answer suspends the run with `status:"input_required"` and no timeout, so on an unattended fire it raises a card nobody can click and the fire never settles |

### `// principal-gate:` — which question is your refusal asking?

If your tool refuses a turn because of *who is on it*, you are asking one of exactly two questions,
and they are not interchangeable:

| Marker | Means | Read | A triggered routine fire |
|---|---|---|---|
| `accountability` | somebody **nameable** must exist — an approval card needs an "asked by" line, an audit row needs a subject | `principalIdOf(ctx)` / `binding.principalId` | **satisfies it**, correctly: it binds as its routine's attested creator |
| `presence` | a **human must be here, acting** — nobody is in the room to have decided this | `actingPrincipalIdOf(ctx)` / `actingPrincipalId(binding)` | **never satisfies it** |

Write the marker in a comment directly above the gate, with the reason after it:

```ts
// principal-gate: presence — break-glass is a person's decision, not a schedule's.
if (!actingPrincipalId(binding)) {
  throw new Error("… needs a verified sender on this turn — a triggered routine fire has no acting sender.");
}
```

The lint fails if a gate has no marker, if the marker's reason is missing, or — the rule that
matters — if the marker and the accessor disagree. Declaring `presence` while reading the *bound*
principal is the exact defect this exists to stop: a fire binds as a real person's id, so that
refusal can never fire, and the gate reads as working while doing nothing. Deciding *which* answer
is right for your tool is a judgment the lint deliberately does not make; it only insists the
judgment is made, written down, and consistent with the code.

Not every read is a gate. `requestedBy: principalIdOf(ctx)` on a card is provenance, and a fail-soft
fallback (`if (!principalId) return NO_ROLE`) narrows rather than refuses — neither needs a marker.
The unit is the **refusal**, the point where an identity becomes a permission.

### `chain: { unattended: … }` — does your tool propose an approval?

A tool that calls `requestApproval` must hand the approver chain this turn's attendedness:

```ts
const posted = await requestApproval(
  { org, kind: "skill.delete", args, scopeKey, domain, requestedBy, channelId, postedTo,
    chain: { unattended: unattendedOf(ctx) } },
  approvalPostDeps(venue.platform),
);
```

`unattendedOf(ctx)` (`access/request.ts`) is the approved spelling, and the lint refuses any other.
A caller that holds a `SurfaceBinding` and no ctx — a slash command, say — uses the twin,
`unattendedFrom(binding)` (`identity/binding.ts`). Both are `true` on a routine, webhook or cron
fire and `false` on a live human turn. The
chain reads it and turns `ask` into `deny`, because a card in an empty room is toxic — an
unattended fire gets a fast, audited refusal instead of a pending row nobody will ever click.

Two things follow from that being a **security** control rather than a convenience:

- **Omitting the bag denies.** `requestApproval` defaults `unattended` to `true`. A propose site
  that forgets the line fails loudly on an attended turn, instead of silently carding an autonomous
  one. The lint reads core, your own `agent/` tree and every provider bundle; the default covers
  anything outside them.
- **Do not derive it yourself.** `principalIdOf(ctx) === undefined` looks equivalent and is not: a
  fire binds as its routine's attested creator, so that spelling answers "a human is present" for
  every fire. It type-checks, it reads as ordinary code, and it inverts the control.

A kind that never routes through the chain — a `NON_TOOL_ACTION_KIND` — opts out by saying so:
`// approval-chain: exempt — <why the chain never sees this kind>`. The reason is mandatory.

### A tool that sends into another room

eve 0.85.0 gives a tool `ctx.to(channel, target).send()`, which starts or reaches a session on
another channel. OE pins eve 0.71.0, where the tool context has no `to`. After the bump, a tool calls
`auditedCrossRoomSend` (`packages/core/agent/audit/cross-room-send.ts`) and never `ctx.to(`
directly. The door writes a `channel.cross_room_send` audit row before the send. The row names the
source room and the target, ids only. `npm run lint:eve-auth-paths` refuses `ctx.to` in tool code
under any `agent/` tree: a `.to` on a context-named value, `const { to } = ctx`, and a `{ to }`
parameter of an `execute`. It is a syntax rule, so a context under another name is not seen
(OPE-2686).

**Prefer a skill to a tool.** A tool is a permanent widening of the model's surface, paid for on
every turn in prompt weight and in review burden. A [skill](../capabilities/skills-and-plugins.md)
teaches a procedure over capabilities the agent already has and costs nothing when unused. Add a
tool when there is genuinely no way to express the thing with what is mounted.

## Disable a core tool

Two planes, and the schema keeps them apart because they genuinely are:

```ts
// roster.config.ts
export default defineRoster({
  // Eve's BUILT-INS. Absence KEEPS the built-in; every line here takes capability AWAY.
  framework: {
    disable: {
      bash: "re-provided per session GRAIN by tools/sandbox_tools.ts — task sessions get a shell, standing seats don't",
    },
  },
  // A PACKAGE's contributions. Absence from `exclude` MOUNTS it; a line here takes it away.
  core: {
    exclude: { memory_float: "this deployment does not float memory corrections" },
  },
});
```

Both reasons are **required** by the schema — an empty one fails the build. `oe build` renders the
framework entries into `disableTool()` sentinel files carrying your reason as the file's comment:

```ts
// agent/tools/bash.ts   (GENERATED — do not edit)
import { disableTool } from "eve/tools";

export default disableTool();
```

This is how the shipped app takes away four Eve **framework** tools — `bash`, `read_file`,
`write_file` and `web_fetch`. A framework tool is mounted by Eve itself, not by a
file, so a sentinel is the way to remove one — but not for every slot. Since eve 0.69.0
`compiler/default-tool-policy.js` declares a set of **reserved** slots —
`tools/connection_tools`, `tools/connection_search` and `tools/connection_execute` — and
`assertFrameworkToolPolicy` throws on **any** authored module at one of them: a `disableTool()`
sentinel and an authored replacement alike ("is reserved … cannot be replaced or disabled"). The
declaration and the refusal are one mechanism here, which is what makes the set safe to act on (see
`packages/core/scripts/eve-framework-tools.ts`). So a `framework.disable` entry for any of the three
in `roster.config.ts` would fail `eve build` through the sentinel this section renders. OE's own
roster declares none, so nothing is broken today.

Through 0.68.x the regime was different and the advice was the opposite: the same module declared a
set of **required** slots, refused a sentinel for `connection_search` by name, and took an authored
no-op **replacement** instead — the declaration and the refusal really were two different bytes then.
🔴 **That route is gone.** The no-op replacement OE used to ship was deleted with it; see
[zero hands](../capabilities/skills-and-plugins.md#declared-subagents-the-specialist-unit)
for what holds the invariant now. Several of the four are then re-provided per **session
grain** by a resolver file, so a task session gets a shell and a standing seat does not (see
[the agent & the loop](../how-it-works/agent-and-loop.md)). For most of these four, the sentinel
makes the per-grain provision authoritative: a dynamic tool can *shadow* a static built-in when
it resolves, but cannot remove it.

`glob`, `grep` and — since eve 0.65 — `ask_question` are Eve framework tools too, but eve mounts them
by default only when a deployment opts in. OE never opts into `glob` or `grep`, so no sentinel is
needed to keep them out (`scripts/window-gate-lint.ts` reads the mount class off the installed eve and
would fail the build if a future eve release moved either back into the default set). `ask_question` is
the one OE **does** opt into, and the opt-in is an ordinary core tool re-exporting eve's own
definition — `packages/core/agent/tools/ask_question.ts`, with a `contributions.ts` row so the roster
plans its shim. Opting in is what makes the name mount at all: without that file no session holds it.

The framework-named `agent` tool is a fifth case, and it is the one name that must carry **no
sentinel at all**. eve's built-in `agent` is this deployment's delegation route, and nothing
re-provides it, so a sentinel would leave every seat with no delegation verb. A dynamic `agent`
is not the answer either: it does not shadow the built-in the way the other four are shadowed —
eve **throws** ("Dynamic tool \"agent\" collides with a runtime-visible subagent") because the
built-in declares dispatch handling (`behavior.handling.kind === "dispatch"`, the descriptor eve
0.47.7 replaced the retired `runtimeAction` property with), and the model call dies. So the gate on
`agent` is neither a
sentinel nor a mount predicate; it is subtraction at the per-model-call projection seam, and
`window-gate-lint` refuses both a sentinel and a kit key for the name.

🔴 **Decline by exclusion, never by deletion.** Deleting the generated file does nothing — the next
`oe build` writes it straight back. And an exclusion always carries WHY, so six months later nobody
has to guess whether a refusal was deliberate or an oversight.

## The roster is not the directory listing

The trap, stated plainly: **a file being present does not mean a tool is mounted.** Four of this
app's generated tool files are sentinels under the shipped default (five when native delegation
is disarmed), so a bare listing over-counts capabilities. Since the tree is build output, the
*edits worth reviewing* live in the lock and the config instead:

| Edit in the diff | What it is |
|---|---|
| a new `"tool/x": "mounted"` line in `roster.lock.json` | capability **gain** |
| `"tool/x": "mounted"` → `"excluded"` (plus an `exclude` reason in the config) | capability loss |
| an entry removed from `framework.disable` | capability **gain** — Eve's built-in comes back |
| a lock line disappearing entirely | the contribution VANISHED from its package; `oe build` reds until a human looks |

Each of those is a one-line edit to a committed file, and each one changes what the model can do.
The checks below exist to make sure none of them can pass unnoticed — and, just as important, that
no capability can arrive *without* one of them.

## Two checks over the roster

### `npm run lint:roster` — one gate, five properties

`npm run lint:roster` is `oe build --check`. It asserts, in one command:

1. `roster.config.ts` is valid and every exclusion carries a non-empty reason;
2. every `exclude`/`note` key names a **real** contribution in that package's manifest — a typo is a
   hard red, which the old file-per-tool tree could not express at all (you cannot mistype an absent
   file, but you can absolutely mistype a config key and silently mount the thing you meant to
   decline);
3. `roster.lock.json` is complete and in agreement — nothing **UNREVIEWED** (a contribution the lock
   has never seen) and nothing **VANISHED** (a lock line the package no longer offers);
4. the on-disk tree byte-equals the plan, catching both a hand-edit and a stale build;
5. `scripts/goldens/roster-plan.txt` matches — one sorted line per planned path with its
   classification. That golden is what keeps "the roster's git diff is the review surface" true for
   a tree that is no longer committed.

Two failure shapes are worth naming because they are the ones you will meet:

- **UNREVIEWED** — `npm update` shipped a package version with a new tool. The build **fails** and
  quotes the tool's own summary. Decide about it in `roster.config.ts` (mount it by doing nothing,
  or add an `exclude` with a reason), then `npx oe build --accept` and commit the lock diff.
- **MISDIRECTED is gone.** A file named `reply.ts` re-exporting `read_thread` used to be a real
  hazard; one name now drives both the filename and the specifier, so it is impossible by
  construction rather than caught by a lint.

🔴 **There is no bypass flag,** and that is deliberate: a security patch that also adds a tool reds
the deploy until a human runs `--accept`. An escape hatch under time pressure becomes the default
path within a week.

### The config diff — direction, not just delta

The config diff posted on a PR (see [config as code](../how-it-works/config-as-code.md)) carries a
`mounted` section with one row per roster entry, valued by the mounted-or-declined classification —
**projected from `roster.lock.json`**, not read off disk. (That matters: the diff builds its base
snapshot in a git worktree of the base ref, where the generated tree does not exist at all. The lock
is committed, so it is always there.) What a before→after pair cannot say is which *direction* a row
moved, so the report also raises a `tool-roster-capability-gain` finding naming every tool that
became mounted — because "a line changed in a JSON file" and "the model can now call this" should
not look the same in a review.

Both checks and the snapshot's classifier share one vocabulary,
`packages/core/agent/scaffold/tool-roster.ts`. Two classifiers for "is this mounted or declined" is
how the gate and the report would come to disagree.

## Why the tree is generated, and gitignored

Two clean states, and deliberately no third:

1. **The tree is build output.** `oe build` owns each slot directory *wholesale* — it creates what
   is missing, rewrites what differs, and **deletes anything that is not in the plan**. There is no
   cache and no incremental mode: the whole plan is about 150 tiny files and writes in
   sub-100ms, and staleness is the failure this design exists to rule out. The plan is
   `scripts/goldens/roster-plan.txt`, one line per path — 149 today. A smuggled file in
   `agent/tools/` cannot survive a build.
2. **"Commit the generated tree" is not a supported mode.** A tracked copy would be a second,
   hand-editable roster — build magic *and* a big repo *and* the temptation to edit the output.
   `npm run oe:build -- --show` prints the whole tree, with contents, without writing anything.

🔴 **Eve does not error on an empty `agent/tools/`** — it mounts nothing and boots green. A
`git clean -xdf`, a forgotten build or a build-command override would therefore ship a hands-free
agent that looks healthy. Three things guard it: the `pre{build,test,typecheck}` hooks, an explicit
CI step, and — the only one that runs on the *artefact* rather than on intent —
`oe build --against-summary .eve/agent-summary.json` in the deploy chain, which asserts the tree Eve
actually resolved carries every statically-mounted name the plan expects.

The upgrade path that follows is worth stating on its own: after bumping a package, `npm test` goes
red with a list of contributions it has gained, each with its summary. Read them, then mount each
one by doing nothing or decline it with a reason, and `npx oe build --accept`. There is no third
answer, and the lock diff that resolves it is the record of the decision.

## Where else tools are enumerated

Four places read the mounted tool surface, for four different questions. They are not
interchangeable, and each one names the others:

| Reader | Question | Notes |
|---|---|---|
| `roster.lock.json` (+ `packages/core/agent/scaffold/roster-plan.ts`) | is each contribution mounted or excluded? | the committed roll-call; `lint:roster` and the config snapshot both read it |
| `scripts/read-mounted-tools.ts` | what is every tool **name** the model can see? | unions app files, Eve framework tools and declared subagents; drives `lint:consequence` and `lint:capability-docs` |
| `scripts/config-snapshot-build.ts` (`mounted` section) | what did the roster look like at this revision? | the diffable projection, from the lock; classification per entry |
| the session's own resolution at runtime | which of those does *this* grain get? | `lint:window-gate` plus the access resolver decide; a mounted tool is not always a reachable one |

### When a live session re-derives its roster

A window-gated tool decides whether it mounts on a `session.started` arm
(`packages/core/agent/access/window-gated.ts`). That arm is **not** a once-per-session arm. Eve
stamps every durable session with a runtime revision — the deployment id of the process that runs
the turn. A turn taken under a revision the session has not seen re-runs every session-scoped
resolver and rewrites the session's durable tool metadata.

🔴 **A deploy does not reach a standing seat that way.** A durable session is one workflow run, and
a workflow run is pinned to the deployment that created it. The seat's turns keep executing the
minting deployment's bundle, so the revision they stamp never changes and the resolvers never re-run
in that session. What reaches a standing seat is the rotation:
`packages/core/agent/channels/runtime-rotation.ts` retires the generation on the first wake whose
running code fingerprint — or the seat's own domain fingerprint — differs from the pair the seat was
last served with, and the fresh generation is minted on the current deployment with the current
roster. A redeploy that changes no code rotates nothing, so the roster a standing seat holds tracks
the CODE it runs rather than the deployment it was minted on. A delegated worker does not escape the pin either: it starts from inside the parent's turn
step, so it inherits the parent's deployment and is current only once the parent has rotated.

Two limits are worth stating, because they are the cases the refresh does not cover:

- A session that never takes another turn keeps the old metadata. It also never calls a tool, so
  nothing acts on the stale roster.
- The roster is not the whole seat. An `eve` version bump can strand a durable session outright,
  which is a different failure with the same remedy — the rotation keys on the eve build **and** the
  deployment, so a bump and a ship both retire the generation once.

`packages/core/scripts/window-gated-test.ts` §6 drives eve's own lifecycle functions to hold this, so an eve
upgrade that drops the refresh fails the tree instead of the deployment.

Static enumeration has a floor worth knowing about: connector operations and the injected browser
family are named at runtime, and no file scan can produce them. A connector operation is not a
mounted tool: the agent calls it through `connection_execute` by its `connection` and `tool`, and
the gates read it as `<connection>__<operation>`. They are separate planes with their own gates —
[connectors](./connectors.md) and [browser QA](../capabilities/browser-qa.md).

## Every mounted name must be documented — and the one escape hatch

`lint:capability-docs` is total and fail-closed over the mounted tool surface: every name the build
mounts must be named as an inline code span somewhere under `docs/`, or the build reds. A tool being
obscure, internal-sounding or newly landed is not a reason to skip it — write the sentence.

The one escape hatch is `UNDOCUMENTED_TOOLS` (`packages/core/agent/docs/capability-map.ts`): a table
of mounted names that are deliberately **not capabilities**, each carried with its written reason.

🔴 **It stays honest in both directions, so the table can only shrink as the manual grows.** An
exemption for a name that is no longer mounted is **stale** and fails. An exemption for a tool some
page documents anyway is **redundant** and fails. So an exemption can never silently absorb real
coverage, and writing a manual sentence about an exempt name means deleting its row in the same
commit.

Two kinds of entry are legitimate. The first is a **resolver file** — a module that mounts a family of
tools and nothing under its own name, where each tool it provides is documented separately. The second
is a tool behind a runtime flag that is still off; 🔴 that kind **dies the day the flag goes on**, and
it is not self-invalidating, because the check cannot read the flag. Flipping the flag therefore has to
delete the row and write the page in the same change.

## Declared subagents — the rules the lint enforces

A **declared subagent** is a directory under `agent/subagents/<name>`. eve turns each one into a tool
the parent model can call. `checkDeclaredSubagents`
(`packages/core/agent/subagents/declared.ts`) is the lint over them, and every rule below reds the
build rather than degrading at runtime.

**The directory name IS the model-visible tool name**, so it must be lower snake_case
(`SUBAGENT_NAME_RE`). eve accepts any directory name, but the lowered tool sits in one namespace
beside `read_file` and `open_pull_request`, and a stray dash there reads as a different vocabulary.
Plugin-extracted directories are machine-owned and namespaced, so this rule governs hand-authored ones
only. A name that collides with an existing tool is refused too — eve rejects the build rather than
picking a winner.

**Seven directory slots are supported**: `tools`, `skills`, `hooks`, `connections`, `sandbox`, `lib`
and `subagents` (`SUPPORTED_SUBAGENT_DIRS`). A `schedules` directory fails the build, because
schedules are root-only and eve refuses a subagent that declares them.

**Zero hands is the posture, and it is enforced slot by slot.** For every framework tool, the
subagent must carry its own file under `tools/`. An absent file falls back to eve's **framework
default**, not to the root's narrowed version, and the root's egress and spend hooks are not inherited
either — so the tool would mount **unfenced**. An optional slot must export the `disableTool()`
sentinel. 🔴 Do **not** author anything at `connection_search`, `connection_execute` or
`connection_tools`: eve 0.69.0 and later RESERVE those slots and throw on any module there, sentinel or
replacement. (Through eve 0.68.x a required slot took a no-op replacement instead, because eve threw
on a sentinel there; that route no longer exists.) Deleting an ordinary slot's file is never the fix
either: it re-mounts the framework default. An **authored** tool in that directory is refused as well, because a subagent
session carries no surface binding and any tool there would have to invent or trust a scope.

**A missing `hooks/spend.ts` is a lint failure.** Hooks are not inherited from the root, so a
delegated child's model calls would never reach the ledger or the monthly cap. The file re-exports the
core spend hook.

**`agent.ts` must declare a `description`**, and `instructions.md` must exist. The description is what
the parent reads to decide whether to delegate.

🔴 **It must NOT declare an `outputSchema`, and the lint refuses one.** eve 0.67.0 removed the field
from `defineAgent`, so authoring it is a typecheck error against `never` that names no cause — the
lint exists to name it. The task-mode default that used to apply an authored schema went with `mode`
(0.67.0) and `execution/workflow-steps.js`, so a declared subagent's result is prose until OPE-2250
re-derives the typed verdict on eve's native task surface. The contracts stay in
`packages/core/agent/subagents/contracts.ts` for that work. A subagent inherits no instructions from the
root — that is eve's isolation boundary — so without its own file it would run on the framework
default prompt.

### The shipped review contract

`FRESH_EYES_REVIEW_OUTPUT` (`packages/core/agent/subagents/contracts.ts`) is the typed result the
review subagent returns. Two of its fields carry the policy:

- `evidenceSeen` states whether the caller actually included the change — the diff, the patch or the
  file contents. The subagent's own instructions require `block` whenever it is false, because silence
  about a change the reviewer never saw must not read as approval. 🔴 **The schema records the field;
  it does not enforce the pairing.** There is no refinement and no caller that rejects an `approve`
  carrying `evidenceSeen: false`, so read the field as the thing that makes such a verdict visible
  rather than impossible.
- `recommendation` is `approve` or `block`, and its own description asks for `block` on any `critical`
  or `high` finding.

Findings use one closed five-rung severity scale — `critical`, `high`, `medium`, `low`, `nit`
(`REVIEW_SEVERITY`). `nit` is deliberately on the same scale, so a reviewer can approve while still
recording the small things. Categories are a closed set too, so findings group across reviews.

## See also

- [Skills & plugins](../capabilities/skills-and-plugins.md) — the lighter alternative, and the
  declared-subagent unit, whose `tools/` directory is still **authored** (a subagent's empty slot
  falls back to the framework default, not to the root roster's decision, so its sentinels are pinned
  file-by-file — by `test:subagent-zero-hands` on this pin, because `lint:subagents` cannot run
  there; OPE-2254)
- [Core/app separation](../core-app-separation.md) — why the app tree is thin re-exports at all
- [Provider bundles](./provider-bundles.md) — mounting a tool that lives in a vendor bundle
- [Access & scoping](../how-it-works/access-and-scoping.md) — mounted is not the same as permitted
