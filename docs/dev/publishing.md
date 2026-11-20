# Publishing to npm

How an Open Everywhere version reaches the public registry, and the checks that run first.

This page is for the maintainer who publishes. A consumer who deploys the repository follows
[the quick start](../introduction/quick-start.md) instead. The one consumer recipe that lives here is
§ *The eve patch reaches a consumer by one explicit command*: it belongs with the packaging decision
that produced it. It is no longer the only copy — every library README states the same recipe in
§ Install (OPE-2206), and a consumer reads that one on the npm page.

> **The tarballs are the release surface.** A published version is permanent and diffable by
> anyone. Treat every publish as a public, irreversible act.

## What ships

Eleven packages publish, in two kinds.

| Kind | Packages | What a consumer does with it |
|---|---|---|
| Library | `@open-everywhere/core`, `@open-everywhere/adapters`, and the eight `@open-everywhere/provider-*` bundles | imports it — an enumerated `exports` map that points at `dist/` |
| Bin | `@open-everywhere/create` | runs it — `npx @open-everywhere/create`, raw `src/**` through the bin's own `tsx` |

`scripts/publish-exports-generate.ts` holds both lists. The publish gate and the publish preview
read them, so a package added there is packed, linted and previewed with no other edit.

The kind says how a consumer reaches the package, not whether it has a `bin`. A library can ship one
too: `@open-everywhere/core` ships `oe` and `oe-eve-patch`. The publish gate checks every `bin` target
the same way whichever kind declares it.

The repository root (`open-everywhere` itself) never publishes. It is the deployer app — a
template a fork copies, not a dependency.

**Every package root carries its own copy of the Apache-2.0 `LICENSE`.** npm includes a licence
file only from the package's own root, and the text at the repository root never ships, so each
publishable package holds a byte-identical copy beside its `NOTICE` — the file that `NOTICE` tells
the reader to see, and the copy Apache-2.0 §4(a) asks for. The copies are a licence arm of the
publish gate (`scripts/publish-license.ts`): a package root with no `LICENSE`, a copy that differs
from the repository grant, a `files` allowlist that omits it, or a tarball that does not carry it
each fail `npm run lint:publish`. The cheap half of the same rule runs on the test chain
(`npm run test:publish-license`), so a deleted copy reds in seconds rather than at publish time.

## A consumer must apply the eve patch

`@open-everywhere/core` runs on a PATCHED `eve`. The tree carries
`patches/eve+<pinned version>.patch`, and `patch-package` applies it on `postinstall` **in this
repository**. On the eve 1.0.0-rc.18 pin (the `eve-v1` branch, OPE-2691) the patch holds ONE part:
part 10 (OPE-2276). It changes only eve's CLI-side evaluation of authored files (`eve build`,
`eve dev`, `eve eval`), so the deployed server never runs it. The patch carries NO runtime part on the
rc. Part 10 stays on the rc (OPE-2705). Eve 1.0.0-rc.18 evaluates the authored files outside an
extension mount as one code-split graph, when that graph builds. On that path a shared module runs once
per compile with or without the part. An extension-mounted file, or every file after a failed graph
build, still gets its own bundle. Without part 10, the graph inlines the `@open-everywhere` packages,
and `eve build` exits 13 (Node's unsettled top-level await) before it writes a build. The cause inside
the inlined graph is not proven. With part 10 the packages stay external, and the build completes. Parts 1 and 4 lived in `harness/tool-loop.js`, which eve 1.0.0-rc.18 does not ship. Part 1, the
untrusted output projection (OPE-73), is not carried onto the rc: the connector fence returns as
OE-owned deferred tools on eve's public API (OPE-2690), and the per-wake seat cuts return as
`defineDynamic` files (OPE-2697, done: `agent/access/seat-cut.ts`). 🔴 **Part 1 was the only caller of the eve 0.x toolset
projection, so every control that projection carried needed an eve 1.x home.** The projection is deleted (OPE-2750). The connector and MCP result
fence is the first control, and it has its home. Its eve 1.x home is built: OE-owned deferred connector tools whose
`toModelOutput` applies the fence (`agent/connections/connector-tools.ts`, OPE-2690). Every connection
mounts them through the connector mount (`agent/connections/connector-mount.ts`, OPE-2749). Unit
tests prove the mount (`npm run test:connector-mount`). The end-to-end proof is the board-row-1 integration spec (`tests/integration/connectors/connector-result-fence.test.ts`), which runs once core builds on eve 1.x. The approved-card replay (OPE-2388) is back in each connector tool, keyed on the connector op
(`npm run test:connector-replay`). The task-continuation provenance fence
(`agent/access/worker-continuation.ts`) judges every call with a non-blank `taskId` to a tool whose
name has no `__`, except `work` and `cancel_work`: eve's `agent`, a named subagent, and any app tool
with a `taskId` input. On eve 1.x the root agent's `approval` policy runs it
(`taskContinuationApproval` in `agent/agent.ts`), because eve asks that policy before each of those
calls runs (OPE-2767). An app whose own `agent/agent.ts` does not set that policy runs with no
continuation fence. The work-session `eve__task_cancel` fence (`agent/access/work-cancel-fence.ts`)
has no tool seam on eve 1.x: eve keeps the root policy off its `frameworkAction` task tools, and no
file can take a reserved `eve__` name. So `resolvePrimaryModel` wraps the model of a work-session
wake, and the wrapper makes each unredeemed `eve__task_cancel` call invalid against eve's own schema
for the tool (OPE-2778). An app whose own `agent/agent.ts` resolves its model another way runs with
no work-session cancel fence. The nullable-optional
rewrite (OPE-2068), the outbound sensitive-data filter (OPE-2665) and the test-run fence (OPE-2515) are
back for the tools the seat cut keeps (`agent/access/authored-tool-transforms.ts`). A connector op
passes through the seat cut too. The cut applies the outbound filter and the test-run fence at
`execute`, in front of the connector tool's own checks (`npm run test:connector-mount` §14). The nullable-optional
rewrite does not apply to its plain JSON Schema.
`ask_question`, the eve framework tools outside the roster and a declared subagent's own
tool slots stay unfiltered (security model § 7).
The seat cuts are back for every roster tool shim, but not for `agent`, `ask_question`,
`web_search` or the reserved `eve__*` names, which no file can withhold (see the **seat cut** in the
glossary), and those slots get none of the three transforms either. So a routine test run fences
the writes of every roster tool shim except `ask_question`, and the connector-auth seam still refuses its connector writes. `eve-v1` does not land on `main` until each
of these controls is back on eve's public API or is dropped by a ruling. A green board does not prove
that. The glossary **seat cut** entry names what the returned seat cut still cannot reach. Part 4, the compaction
event contract (OPE-697), is retired (OPE-2704). eve v1 opens a compaction's context change only when it is about to call the
summary model. A blocking failure on `context.started` can still stop that call, and the change then
settles `failed`. Before a model call, eve compacts only past the trigger, so a pre-call pass under the trigger
publishes no context event. A manual compaction has no trigger. On a non-empty history it
summarizes, unless the fixed part is over the limit, and that failure opens no change and publishes
no context event. A pass that summarizes settles its change with `context.settled` (outcome `completed` or `failed`), and eve
rewrites the history only when the result differs from the input. Parts 5 and 6 are retired (OPE-2252, OPE-2251). Part 7,
the per-hop `web_fetch` redirect fence (OPE-1568), was dropped (OPE-2688).

`eve` is a **peer** dependency, so a consumer installs the registry copy and the patch is not in it.
`patch-package` only WARNS when a patch does not apply, so a cold `npm install` that skipped lifecycle
scripts produces exactly that tree with a green install log. OPE-2168 measured it — in a cold install
tree `grep -rl __oeProjectToolSet node_modules/eve/dist` found **zero** files, against one in this
repository at the time (eve 0.71.0). On eve 1.0.0-rc.18 this repository holds zero too, because part 1
is not carried.

**Core therefore refuses to boot on an unpatched `eve` when the patch carries a runtime part.** Each
live runtime part plants a runtime marker, and `agent/access/eve-patch-probe.ts` reads every marker
before the first wake is served. On the rc the probe's table is empty, so it refuses nothing. Part 10
plants no marker, because a slow build is no reason to refuse a wake. A missing marker
throws at module load. The message names the missing part, what that part silently costs, the pinned
`eve` version and the fix. The refusal is fail-closed by design: no setting and no environment
variable turns it into a warning.

### Applying the patch is the consumer's step — and core ships both the patch and the applier

`@open-everywhere/core` declares **no** `preinstall`, `install`, `postinstall`, `prepublish` or
`prepare` script, and `lint:publish` refuses one. Rewriting a dependency's bytes at install time is
exactly what a consumer has to be able to refuse, and
[consuming as packages](../deploy/consuming-as-packages.md) records that as a deliberate supply-chain
property. So the patch travels **in the tarball** and a consumer applies it with one explicit command:

```bash
npm i @open-everywhere/core eve@1.0.0-rc.18
npx oe-eve-patch
```

The eve version is the pin `@open-everywhere/core` declares as `peerDependencies.eve` — read it there
rather than from this page, which a re-roll can leave behind. The applier refuses any other version.

A consumer who wants it on every install puts it in **their own** manifest, where they can read it:

```json
{ "scripts": { "postinstall": "oe-eve-patch" } }
```

`oe-eve-patch` is safe to run that way. It is idempotent — a second run on a patched tree is a no-op
and exits 0 — it never patches bytes outside the project, and it refuses rather than guesses:

| It refuses when | Because |
|---|---|
| no eve resolves from the project | eve is a peer; the message names `npm i eve@<pin>` |
| the resolved eve is outside the project root | patching there would rewrite bytes the project does not own |
| nothing is installed at `<root>/node_modules/eve` | the patch spells its targets relative to the project root |
| the installed eve is not the pinned version | the hunks derive from other bytes; a patch tool would only warn |
| a hunk does not apply, forward or in reverse | the applier writes nothing, and names the file and the hunk |
| a marker the patch adds is missing afterwards | the bytes are the evidence, not the apply step's own verdict |

**The applier needs no patch tool (OPE-2398).** `applyEvePatch` in
`packages/core/agent/publish/eve-patch-pack.ts` applies the patch itself. Core used to declare
`patch-package` as a runtime dependency for this step, so every app installed its dependency chain,
and `npm audit` on a fresh app reported a high `braces` advisory through it. The patch only modifies
existing text files, so a small applier does the job. It applies every hunk in memory before it
writes a file, so a hunk that does not apply leaves eve as it was. A hunk applies only where its
lines match the file exactly, within 20 lines of the line its header names, which is the window
patch-package used. `packages/core/scripts/eve-patch-applier-test.ts` proves that its output is
byte-identical to patch-package's on the real patch. This repository still applies its own
`patches/` with patch-package on `postinstall`, as a root devDependency that no app installs.

**An eve that holds an older OE patch is restored, not refused (OPE-2294).** A release can re-roll
the patch while the eve pin stays the same: on the 0.1 line, 0.1.5 added part 10 to `eve+0.54.3.patch`. `npm install`
then keeps the eve that holds the old patch, because its version still matches the pin, and
the new patch does not apply over the old one. When that apply fails and eve already
carries an `__oe` symbol, the applier runs `npm pack eve@<pin>`. npm reads the tarball from its cache,
or from the registry when the cache does not hold it, and checks its integrity hash. The applier
copies back every eve file whose bytes differ from the tarball, prints each path, then applies the
patch again. The restore also discards any other change to those files, whatever made it. A failed
fetch, unpack or copy leaves eve unchanged. A failed rename (a file that Windows holds open) can
leave eve partly restored, and the refusal says so. The fetch writes only to npm's cache and a
temporary directory. When the applier cannot restore eve, it exits 1 and prints the recovery
commands. They delete `node_modules/eve` with a `node -e` call, which runs in every shell, and then
run the install of the package manager that ran the applier. When the apply fails and eve carries
no `__oe` symbol, something else changed eve, and the applier refuses as before.
`scripts/eve-patch-upgrade-packed-test.ts` drives both routes against a packed core and a real eve
that holds the newest released OE patch for the current pin (on the 0.54.3 pin, the verbatim 0.1.4
patch). When no release shipped a patch for the pin, no app can hold an older OE patch on that eve
version. The leg then drives neither route: it says so and passes, so the restore route and the
refusal route have no test on that pin.

🔴 **Under pnpm and bun the applier never writes a target in place, and this is not optional.** Both
import a package's files from a content store by **hardlink**, so one inode is shared with every
project on the machine that installed that eve. A `writeFileSync(path, …)` on a target truncates that
inode rather than replacing the directory entry. Left alone, one consumer running the applier would
silently splice OE's tool loop into every other project's eve. So the applier writes each patched file
to a fresh inode and renames it over the entry; the store keeps the original bytes, and the applier
says how many files it detached. `node-linker=hoisted` does **not** avoid this — pnpm hardlinks from
the store whatever the linker produces. A symlinked `node_modules/eve` is otherwise fine: it is what
pnpm produces, its target is inside the project root, and the applier writes there.

The last refusal row is the one that matters. The apply step's own verdict is not enough: its
already-applied route is a reverse match, which is what makes a second run a no-op, and neither route
reads the bytes afterwards. The applier reads them, and reports one line per patch part. On eve
1.0.0-rc.18 the patch changes one file, `dist/src/internal/authored-package-boundary.js`. That file
carries the part 10 header and its `__oe` helpers.

**Copying the patch by hand still works**, and it is what a consumer who would rather not run our bin
can do: take `patches/eve+<pinned version>.patch` from this repository into their own `patches/`,
add `patch-package` to their `devDependencies`, and add `"postinstall": "patch-package"` to their own
manifest. That route puts patch-package's dependency chain, `braces` included, back in their tree as a
devDependency. The applier exists so that is not the only route.

**The refusal is two checks, and between them no path serves a wake on an `eve` that lacks a
declared runtime part.** On eve 1.0.0-rc.18 `EVE_PATCH_PARTS` is empty, so both checks pass an empty
marker bag and refuse nothing. Part 10 is CLI-side only and gets no boot marker, and
`test:eve-install` checks its bytes at test time instead. `test:eve-patch-refusal-mechanism`
pins that empty table, and it proves both checks still refuse when a part is declared.

| Check | Where | What it decides |
|---|---|---|
| Boot probe (`access/eve-patch-probe.ts`) | module load | Resolves the `eve` package root, loads the carrier file of each declared part, reads the markers. Refuses on any absence. With no declared part, it passes. |
| Turn gate (`hooks/eve-patch-gate.ts`) | `turn.started` | Reads the markers only. Running a turn has already evaluated every carrier, so no path is needed. Refuses on any absence. With no declared part, it passes. |

Once a part is declared, the boot probe alone is not enough. A hosted build inlines `eve` and ships no
`node_modules/eve`, so the package root does not resolve and the probe reports `unverifiable` rather
than refusing — refusing at boot would take down every hosted deploy. The turn gate closes that case:
a hosted deploy whose bytes lack a declared part's marker fails its first turn instead of serving it.
On eve 1.0.0-rc.18 no part is declared, so neither check refuses, and a deploy without the patch
serves its turns. The boot probe is kept because it fails earlier and more cheaply on a
`node_modules` install.

The `test` chain stays the earliest control. `npm run lint:eve-patch` and `npm run test:eve-install`
read the installed bytes before a deploy, and a cloud run executes the chain on the same checkout.
Nothing inside `npm run build` re-checks them, so that is a convention rather than a build-order
guarantee — which is why the turn gate exists. `npm run test:publish-cold-install` is the consumer-side
control: it packs the workspaces, installs them into an empty directory, runs `npx oe-eve-patch` and
asserts every marker the patch adds is absent before and present after.

**This page is not the only place that states the recipe.** Each of the ten library packages
carries it in its README § Install (OPE-2206), and `@open-everywhere/core`'s is the one an npm
consumer reads first. `@open-everywhere/create` carries no install recipe: it is run rather
than imported, and its README documents `npx @open-everywhere/create` instead.

The publish gate holds the ten READMEs in step, and only those. `scripts/publish-readme.ts` fails a
package README that names an `eve@<version>` other than core's `peerDependencies.eve`, so a pin
re-roll cannot leave one of those pages behind. `npm run test:publish-readme` runs the same rule on
the test chain, and it also asserts that each of the ten § Install sections still RUNS
`npx oe-eve-patch` — a recipe that names the right version but drops the second command is the defect
OPE-2206 closed.

🔴 **This page's own recipe is NOT gated.** No script reads `docs/dev/publishing.md`, so the
`eve@<version>` in § *Applying the patch is the consumer's step* above is hand-written and a re-roll
can leave it behind. Read the pin from core's `peerDependencies.eve`, as that section already says.

## The order of the checks

Run all six before the version bump. Each answers a different question, and the preview is the only
one a human reads. Then the tag publishes: see [Publishing through the workflow](#publishing-through-the-workflow).

```bash
npm run build:packages             # every library needs a fresh dist/ before it is packed
npm run lint:publish               # the CLOSED question: does each manifest obey the rules?
npm run test:publish-cold-install  # the CONSUMER question: does a cold install actually work?
npm run test:quickstart            # the STRANGER question: does the scaffolded app install, patch and build?
npm run test:upgrade-rehearsal     # the OPERATOR question: does an app on the previous release upgrade, build and boot?
npm run publish:preview            # the OPEN question: is there anything in these bytes we would regret?
# then the bump lands on main, the release process pushes v<version>, and the workflow publishes
```

### `lint:publish` — the gate

`scripts/publish-lint.ts` packs each package and runs `publint` and
`@arethetypeswrong/cli` over the tarball, plus the repo-specific assertions those two cannot
know about: the `files` allowlist, the eve peer pin, a `NOTICE` and a `LICENSE` at the package
root, a README whose every `eve@<version>` is core's peer pin, sibling pins that match the version
each sibling publishes, no consumer-run lifecycle
script, and — for every module that ships as raw TypeScript — that each path it reaches resolves
*inside the tarball*, both the ones it imports and the ones it reads at runtime through
`new URL(…, import.meta.url)`. Every `bin` target gets the same treatment, whatever kind of package
declares it: a shebang, and each relative path it imports or reads resolving inside the tarball.

It also joins the eve applier to the patch it applies. A package that declares the `oe-eve-patch` bin
must carry `patches` in its `files` allowlist, that directory must hold **exactly one** patch file
named for the eve peer pin, that file must be byte-identical to the repository's own
`patches/eve+<pin>.patch`, and the tarball must carry it. A second patch there would be applied to a
consumer's tree; a filename naming another version makes the applier a silent no-op. After a patch
re-roll or a pin bump, re-sync the copy with `cp patches/eve+<pin>.patch packages/core/patches/`.

🔴 **The tarball is the unit under test, not the working tree.** The workspace resolves every
specifier through a symlink, so a module the allowlist drops stays green in every other gate and
dies with `ERR_MODULE_NOT_FOUND` on a consumer's first run. That bug shipped once already
(`oe secret`). It bites `@open-everywhere/create` hardest, because that package ships no compiled
form at all.

The gate is deliberately outside `npm test`, and the cost is not evenly spread. `attw` builds a
TypeScript program for each enumerated subpath under four resolution kinds, so
`@open-everywhere/core`'s ~950 subpaths dominate. Stock attw spends about 3.5 seconds on each, and the
gate took about 66 minutes (OPE-2620). `scripts/attw-cache-preload.mjs` removes two costs that grow
with the package's size, and **the whole gate now takes about 1.5 minutes** on a 4 vCPU machine. The
preload changes attw's speed, not its answer: `npm run test:attw-cache-preload` runs attw with and
without it, on a clean tarball and on a planted defect, and requires byte-identical output. publint
and attw both read the tarball the gate packed, so the gate's own assertions, publint and attw read
the same bytes. Run the gate before a publish, and after any change to a `files` allowlist, an
`exports` map or a `.gitignore` — `--only <pkgDir>` narrows it to one package while you iterate.

### `publish:preview` — the control step

`scripts/publish-preview.ts` packs every package into a scratch directory, unpacks each tarball
and reports what the registry would receive. It publishes nothing and contacts no registry.

It prints, per package: the packed and unpacked size, the file count, where the bytes go by
top-level directory, the ten largest files, and every string that must never ship. It writes the
complete per-file listing and the unpacked tree to disk, and names both paths — stdout carries
the rollup, because a full listing of the core tarball is thousands of lines and nobody reads
that.

Findings come in two severities, and the split is the honest part:

- **BLOCK** — a shape that is a secret or a private-tree path however it got there: a credential,
  a PEM key, a signed JWT, a dotenv assignment carrying a value, an internal design-record directory, `.claude/`, a
  local store. A hit exits 1.
- **REVIEW** — a shape nothing can tell from a synthetic one by inspection, chiefly a live
  workspace or channel id (`T0EXAMPLE`) against a documentation example (`T0123ABC`). The
  scanner does not guess. It lists each one, grouped by value with its file and line, and exits
  0. **These rows are the ones you actually have to read.** `--strict` promotes them to blocking
  for a run that wants one number.

🔴 **No matched value is ever printed in full.** Each match prints as its first three characters
and its length — enough to find it in the unpacked tree, never enough to use. A preview that
echoed the credential it found would have leaked it into a terminal and a transcript.

```bash
npm run publish:preview                        # every package, into a fresh scratch directory
npm run publish:preview -- --out ./preview     # keep the output somewhere you chose
npm run publish:preview -- --only packages/create
npm run publish:preview -- --strict            # REVIEW rows fail the run too
```

### Rehearse the upgrade before you publish

`oe upgrade --from <dir>` takes the release packed in `<dir>`, not the release on the registry. So
you can prove the upgrade on a real app with the command a consumer runs, before npm holds
the release. Pack the release commit, then run the command in a scratch copy of an app on the
previous release:

```bash
npm run build:packages
npm pack --workspaces --pack-destination /tmp/oe-release     # in this repository's checkout
npx oe upgrade --plan --from /tmp/oe-release                  # in the app: the plan, nothing written
npx oe upgrade --from /tmp/oe-release                         # in the app: the seven steps
```

`npm run test:upgrade-rehearsal` (`scripts/upgrade-rehearsal-test.ts`) runs this rehearsal as a
script, so it does not depend on a scratch app that somebody kept. It scaffolds a new app with the
PREVIOUS published `@open-everywhere/create` (the highest published core below this tree's version,
or `--previous <version>`). It installs that app from the registry and proves the baseline green.
Then it packs this tree and runs `npx oe upgrade --from <dir>` in the app, with the app's own `oe`.
After the upgrade it runs the checks a deploy runs:

| Check | What a red means |
| --- | --- |
| Every dependency in `package.json` has a `package-lock.json` entry, and `npm ci` exits 0 | The deploy install refuses the committed lockfile |
| `oe build --check` | `roster.lock.json` lacks a roster name that the release offers |
| `npm run typecheck` | App code uses an export that the release removed |
| `npm run build` (`oe build`, then `eve build`) | The deploy build fails |
| The boot probe: every module under `agent/` loads, the agent definition is present, and no two channels declare one route | The deployed function dies at cold start |

The 0.7.0 release found two misses on a test deployment that no gate had found. The lockfile lacked
`@open-everywhere/provider-google-chat`, and `roster.lock.json` lacked `tool/look_up`. The first
two rows are the checks that refuse these two states. Each of these two rows has a negative control
in the script: it puts the miss into the upgraded app and shows that the check goes red. The boot
probe has a negative control too.

🔴 The rehearsal is green on 0.7.0. On the documented path, neither miss happens: `oe upgrade`
re-pins only the packages that the app declares and adds none, and it always runs
`oe build --accept`. The test deployment reached both states by hand steps: a dependency added with no
install, and no `--accept`. So the rehearsal goes red when the documented path itself leaves a
lockfile gap or an unreviewed roster name. On a hand-edited app, the same two checks catch the miss
at deploy time: `npm ci`, then `oe build --check`.

The script needs the network (the previous release, third-party packages, and the model catalogue
that `eve build` reads), so it is off the test chain. Off Vercel, the app's `eve build` provisions
its sandbox template on the app's `sandbox.selfHostBackend`. An app scaffolded before that setting
was declared in the template takes the `docker` default, so the script then needs a running Docker
daemon, and it refuses early without one.
`--keep` leaves the app on disk.

The run pins each `@open-everywhere/*` package to `file:<its tarball>`, so do not commit the app's
`package.json` or lockfile. `eve` still comes from the registry. Leg 8 of
`scripts/oe-upgrade-packed-test.ts` proves the rehearsal with the real npm against a registry that
does not hold the target. [Consuming as packages](../deploy/consuming-as-packages.md#upgrading)
says what the command does.

🔴 The rehearsal boots no operational store, so it does not prove a new table or its grants. The
release record does that part, below.

### Write the upgrade step in the pull request, not at the release

A pull request that changes what an upgrading host must do writes the step into the NEXT release's
entry in `packages/core/upgrading.json`. That entry's version is above the version core's
`package.json` holds. `UPGRADING.md` heads it "not released yet", and its bootstrap block still names
the newest released version. The release pull request keeps the entry, checks the version and sets
the date.

`npm run test:upgrade-surface` (`scripts/upgrade-surface-test.ts`, on the test chain) refuses a tree
where one of these names has no step (OPE-2533):

| A pull request adds | One line of an entry names it, in backticks, and carries |
| --- | --- |
| A table in `OPERATIONAL_TABLES` (`agent/operational/store.ts`) | The owner boot and `runtimeRoleGrantsSql`, in the same line |
| A roster name in the template's `roster.lock.json` | `oe build --accept` |
| A Slack scope or bot event in the app manifest | A re-applied Slack manifest |
| A route that a package's channel mounts, named `METHOD /path` (`POST /a2a/jsonrpc`) | "Update an edge allowlist …" |
| A schedule that a package contributes, named by its short name (`cover-recap`) | "Update a cron budget …" |

An env name of the deployment contract (`DEPLOYMENT_CONTRACT` in `agent/ops/contract.ts`) has a
different step (OPE-2541). The entry's `env.added` holds it, or a manual step names it in backticks.
`oe upgrade` tells every operator to set each `env.added` name before the next deploy. So put a name
there only when every host needs it. A name for one route, or one of two alternatives, goes in a
manual step that says when to set it. A breaking line or the summary alone does not count. An env
name outside the contract (a surface's own bundle names, a tuning value) has no check.

The route and schedule lists come from every package's `agent/contributions.ts`, not only the
template's lock. An app that selects a provider the template leaves out mounts its routes too. The
test reads each route off the channel's own `defineChannel` object, as the deploy census does.

`scripts/upgrade-surface-baseline.json` holds the names that shipped by 0.7.0 with no such entry. It
is shrink-only: a retired name leaves it. The test pins each list's size, so a new name cannot enter
it unseen.

## Versions track milestones, not merges

**One minor version per milestone.** Not one per batch of merges, and not one per pull request. A
green ship that needs no upgrade notes can also take a patch version: see
[A patch bump is one command](#a-patch-bump-is-one-command) (OPE-2627).

The reason is that a consumer reads the list of published versions as the history of this project:
the tarballs and their diffs. A version per merge would publish that reader a stream of increments
with no story, and every one of them is permanent.

So: decide a milestone is done, bump all eleven packages to the same version together, publish
them together. The sibling dependencies are exact pins (`"@open-everywhere/core": "0.1.0"`), and
`lint:publish` checks each pin against the version that sibling actually publishes. A bump that
misses one manifest therefore reds before a publish can create the mismatch — npm would otherwise
resolve it by nesting the older core under that package, so a consumer runs two cores at once.

### A patch bump is one command

`npm run release:patch` bumps all eleven packages from `x.y.z` to `x.y.(z+1)` in one commit
(OPE-2628). It writes what the 0.8.0 bump wrote by hand: the manifests and their sibling
pins, the lock's workspace entries, `CORE_PACKAGE_VERSION`, the contract page, the roster lock's
version lines, and a dated release-record entry with every list empty. Then the generators write the
deploy embed and `UPGRADING.md`. The same tree and the same date give the same file bytes.

It refuses a release that needs upgrade notes: a draft entry above core's version that carries any
line, and a red `test:upgrade-surface`. Such a release is a manual bump. It takes over an empty draft
for the next patch, and refuses an empty draft for any other version. It also refuses packages out of lockstep and a version literal that drifted.
With a commit, it also refuses a dirty tree and a generator that writes a file outside the bump.
`--dry-run` prints the plan, `--no-commit` writes without a commit, and `--date` sets the record's
date. `npm run test:release-patch` drives each refusal.

## The 72-hour window

npm allows an unpublish within **72 hours** of a version being published, and only while nothing
else depends on it. After that the version is permanent.

The window is a mistake-correction path, not a workflow:

- Unpublishing a version **burns that version number forever.** npm never lets it be republished,
  so `0.1.0` pulled at hour 10 means the next attempt is `0.1.1`.
- Anyone who installed inside the window keeps their copy, and their lockfile now names a version
  the registry does not serve.
- A secret that was published is already spent. **Rotate it; do not rely on the unpublish.** The
  preview exists so this decision never has to be made.

`npm deprecate` is the usual answer instead: it leaves the version installable, and attaches a
message to it.

## Names to claim

Claim both before the first publish. The npm scope and the GitHub org must match, or the
`repository` field in every manifest points at a repository that is not ours.

| Where | Name | Why now |
|---|---|---|
| npm | the `@open-everywhere` scope | every library publishes under it; a scope is first-come |
| GitHub | the `open-everywhere` org | every manifest's `repository.url` already names `github.com/open-everywhere/open-everywhere` |

All eleven packages publish under that one scope, the scaffolder included (OPE-2234). `npm create`
reaches a scoped package through its own mapping, so the scaffolder needs no second name at the
registry root:

| What a user types | What npm resolves |
|---|---|
| `npm create @open-everywhere my-agent` | `@open-everywhere/create` |
| `npx @open-everywhere/create my-agent` | the same package, run directly |

`npm init` maps a bare `@scope` to `@scope/create`, exactly as it maps `foo` to `create-foo`
(`lib/commands/init.js`). The package declares ONE bin, so `npm exec` runs it whatever that bin is
named — `getBinFromManifest` takes the single entry before it looks for one matching the package
name. The bin therefore stays `create-open-everywhere`, which is also the command the scaffolded
app's `check` script runs.

**The unscoped name is retired, not reused.** `create-open-everywhere` holds the releases up to and
including 0.1.3. Those tarballs are permanent, so the name keeps pointing at them. After the first
scoped publish, deprecate it so an old install is told where the package went:

```bash
npm deprecate create-open-everywhere "Renamed to @open-everywhere/create — run: npm create @open-everywhere"
```

Deprecating is the maintainer's step and it is not part of any gate. `oe upgrade` carries the other
half: it RENAMES a `create-open-everywhere` dependency to `@open-everywhere/create` rather than
bumping it, so an app scaffolded at 0.1.3 or earlier does not stay pinned to the retired name.

Every publishable manifest sets `publishConfig.access: public`. A scoped package defaults to
restricted, and a restricted publish on a free account fails rather than shipping privately.

## Publishing through the workflow

The workflow `.github/workflows/npm-publish.yml` publishes through **npm trusted publishing**
(OPE-2538). npm trusts that one workflow file in the repository
`open-everywhere/open-everywhere`. When the workflow runs, GitHub gives the job a signed,
short-lived identity token. npm checks it and issues a publish credential for that run only. No npm
token exists anywhere, and each version gets signed provenance that names the commit and the
workflow.

🔴 **Until the trusted publishers are configured on npm, the hand publish stays the path.** Until
then, every tag the release process pushes gives a red `npm-publish` run, and that red run is
expected. The maintainer then publishes the release by hand: `npm publish --workspace <name>` per
package, core first, after the checklist below. npm attaches provenance only to a public
repository, so the workflow also refuses a private repository and publishes nothing.

### What starts it, and what never does

- **A pushed tag `v<version>`** in `open-everywhere/open-everywhere`. The release process pushes the
  tag, and a GitHub Release, when core's version changes.
- **A manual run from `main` that names an existing tag.** Use it to finish a release whose run
  failed part-way.
- **Nothing else.** A branch push, a pull request, a fork, another repository or a manual run from
  another branch never publishes. Each job is guarded on `github.repository`, so in a fork or any
  other repository both jobs are skipped. `scripts/release-publish.ts` checks the same rules again
  before it publishes anything.

### What it does

Two jobs, so that no dependency's install script runs while the identity token exists.

1. **`pack`** holds no identity token. It checks out the tag, runs `npm ci` (which builds every
   `dist/`), runs `npm run publish:preview` (a BLOCK row stops the release), then runs
   `scripts/release-plan.ts`. That script refuses a tag that is not `v` + core's version, and a
   checkout whose HEAD is not the tag's commit. It packs every publishable package in dependency
   order with `--ignore-scripts`, so the tarballs come from the same `dist/` that the preview
   scanned, and writes `plan.json` with each tarball's sha512.
2. **`publish`** holds `id-token: write`. It runs no `npm ci` and no dependency code: only three
   first-party actions (checkout, setup-node, download-artifact), each pinned to a full commit sha,
   then npm and the script. Node 24 runs
   `scripts/release-publish.ts` directly, and that script imports only `node:` modules. It checks
   the run context, the npm version and every tarball's sha512. Then, in the plan's order, it asks
   the registry for each `name@version`. It skips a version npm holds and publishes the rest with
   `npm publish <tarball> --provenance --access public --ignore-scripts`. It first checks that its
   own checkout is the commit that `pack` packed, so a tag moved between the two jobs publishes
   nothing. It refuses the whole run,
   before the first publish, when a version it must publish is lower than the registry's `latest`
   dist-tag, because `npm publish` would move `latest` backwards. Publish such a version by hand
   with an explicit `--tag`.

🔴 **The split does not make the bytes trustworthy.** A compromised dependency in `pack` can still
change the tarballs and `plan.json` before the upload, and `publish` then ships them with valid
provenance. The sha512 check proves only that the artifact did not change between the two jobs.
The split keeps the identity token away from dependency code, nothing more.

It is not CI. It runs no test suite: run the checks above before the bump. A re-run with the same
tag publishes only what the registry does not hold, so a failure part-way is finished by a manual
run. Runs for one tag never overlap, and runs for two tags never cancel each other. `npm run test:release-publish` proves the rules offline, including the workflow file's
triggers, guards and permissions.

The workflow sets no schedule of its own. It publishes as soon as the
tag arrives, and a manual run publishes when you start it.

### npm's rules (read from docs.npmjs.com on 2026-10-19)

- npm CLI **11.5.1** or later and Node **22.14.0** or later. The workflow uses the latest Node 24, and
  the script refuses an npm older than 11.5.1.
- The job needs `permissions: id-token: write`.
- **GitHub-hosted runners only.** npm does not accept a self-hosted runner.
- The trusted-publisher fields are case-sensitive and must match exactly. npm checks them only at
  publish time, not when you save them.
- `repository.url` in each `package.json` must match the GitHub repository exactly. The test
  checks this for all eleven packages.
- **Provenance needs a public repository and a public package.** npm generates no provenance for a
  private repository. The workflow passes `--provenance` explicitly, so a private repository
  fails the publish instead of shipping without provenance, and the script refuses one first.
- A new trusted-publisher configuration **expires unless its first publish succeeds within 2 days.**
  Configure the packages only when a tag is ready to publish.
- Each package has at most 10 trusted publishers. A configuration cannot be edited: delete it and
  create a new one.
- For a `workflow_dispatch` or `workflow_call` run, npm checks the name of the calling workflow. The
  manual run starts this same file, so the name matches.
- **Tokens.** npm revoked every classic token on 2025-12-09. A granular token with write access
  needs two-factor authentication unless it bypasses it, and lives at most 90 days. `npm login` now
  gives a two-hour session. Trusted publishing replaces all of these for a release.

### Set up each package once (the maintainer, signed in to npmjs.com)

Every package already exists on npm, which trusted publishing requires. For each package, open its
**Settings** page on npmjs.com, find **Trusted Publisher**, choose **GitHub Actions**, and enter:

| Field | Value |
|---|---|
| Organization or user | `open-everywhere` |
| Repository | `open-everywhere` |
| Workflow filename | `npm-publish.yml` |
| Environment name | *(leave empty)* |

The eleven packages: `@open-everywhere/core`, `@open-everywhere/adapters`,
`@open-everywhere/provider-discord`, `@open-everywhere/provider-email`,
`@open-everywhere/provider-github`, `@open-everywhere/provider-google-chat`,
`@open-everywhere/provider-linear`, `@open-everywhere/provider-notion`,
`@open-everywhere/provider-slack`, `@open-everywhere/provider-teams` and `@open-everywhere/create`.

The CLI does the same from npm 11.15.0, with two-factor authentication on the first call:

```bash
npm trust github @open-everywhere/core --repo open-everywhere/open-everywhere --file npm-publish.yml --allow-publish
```

After the first release publishes through the workflow, lock each package down: **Settings →
Publishing access → Require two-factor authentication and disallow tokens.** Trusted publishing
still works, because it uses no token.

🔴 **Do not rename the workflow file.** npm trusts it by its file name. A rename stops every
publish until each package's trusted publisher is deleted and created again.

## Before you publish — the checklist

1. On a clean tree at the commit you intend to publish.
2. `npm run build:packages` green.
3. `npm run lint:publish` green — quote the exit code.
4. `npm run publish:preview` — zero BLOCK rows, and **read every REVIEW row**.
5. All eleven versions equal, and every sibling pin equal to them.
6. `npm run test:publish-license` green — every package root carries the Apache-2.0 text.
7. `npm run test:publish-cold-install` green — quote the exit code. It packs all eleven packages,
   installs them into an empty directory with `eve@<pin>` from the registry, runs `npx oe-eve-patch`
   there, and asserts every marker the committed patch adds is absent before and present after. It
   needs the network and measures in minutes, which is why it is off the test chain; the applier's own
   decisions run on every chain run as `test:eve-patch-applier`. `--keep` leaves the tree on disk.
8. `npm run test:quickstart` green — quote the exit code. It packs all eleven packages, installs the
   packed wizard on its own, scaffolds the quickstart app with it, points the app at the tarballs and
   runs `npm install` with lifecycle scripts, so the app's `postinstall` applies the eve patch. It then
   asserts that the eve patch probe reads `patched`, that `oe build --check` fails before `oe build`
   and passes after it, that the app typechecks, and that `eve build` succeeds with no Docker daemon.
   On eve 1.0.0-rc.18 no patch part is declared, so the probe reads `patched` on any eve, and that
   one assertion proves nothing about the patch bytes. The applier's per-part byte report is the check.
   It needs the network and measures in minutes, so it is off the test chain; the scaffold and the
   template drift checks run on every chain run as `@open-everywhere/create test:scaffold` and
   `lint:template-paths`. To put it in the proof run, set it explicitly:
   `OE_PROOF_QUICKSTART=1 bash scripts/proof-gates-parallel.sh <fresh log dir>` prints a fourth
   line, `suite=test:quickstart` (OPE-2354). Without the variable, the script prints no such line. `--keep` leaves the app on disk.
9. A template file that this release deletes is named in `removedFiles` of the release's entry in
   `packages/core/upgrading.json`, so `oe upgrade --plan` tells an upgraded app to delete it.
   `npm run lint:template-paths` refuses the tree otherwise (OPE-2354). A behaviour that this
   release turns on without a config change goes in `newDefaults` of the same entry: one line per
   new default, naming the setting that turns it off, or saying that no setting does. The target's
   own `oe upgrade --plan` prints each line as a `DEFAULT` line before the install (OPE-2517). No gate checks this list, so the release author
   owns it.
10. `npm run test:upgrade-rehearsal` green — quote the exit code in the ship ticket, before the
    ship is posted. It scaffolds an app on the previous published release, upgrades it to the packed
    tree with `npx oe upgrade --from <dir>`, then runs `npm ci`, `oe build --check`,
    `npm run typecheck`, `npm run build` and a boot probe in the app. See
    [Rehearse the upgrade before you publish](#rehearse-the-upgrade-before-you-publish). To put it in
    the proof run, set `OE_PROOF_UPGRADE_REHEARSAL=1` on `scripts/proof-gates-parallel.sh`. The
    script then prints a `suite=test:upgrade-rehearsal` line.
11. Slack's live validator accepts the app manifest — quote the exit code (OPE-2502). Every `npm test`
    already checks each manifest variant against Slack's published JSON schema
    (`test:slack-manifest-schema`). The schema does not list Slack's scope or event names, so a
    misspelt scope passes it. Slack's `apps.manifest.validate` checks those. It needs an **app
    configuration token**: open <https://api.slack.com/apps>, find *Your App Configuration Tokens*,
    and generate one for the dev workspace. Then pipe it in on standard input:
    `pbpaste | npm run slack:manifest-validate-live --workspace @open-everywhere/provider-slack`.
    The script reads the token from standard input only, never prints it, and creates no app. It
    sends the same manifests the schema test checks. Exit 1 means Slack refused a manifest, and the
    script prints each error with its JSON pointer. Exit 2 means the check could not run: the token
    is missing or refused, the network or proxy failed, Slack rate-limited it twice, or Slack
    answered with an error that is not about the manifest. Exit 2 says
    nothing about the manifest, so run it again.
12. Land the version bump on `main`. The release process pushes `v<version>`. Once the trusted
    publishers are configured, the workflow publishes every package in dependency order, core first,
    and nobody publishes by hand. Until then, the workflow run fails, so publish by hand:
    `npm publish --workspace <name>` per package, core first. See
    [Publishing through the workflow](#publishing-through-the-workflow).
13. Install the result somewhere clean and run it, before announcing anything.
