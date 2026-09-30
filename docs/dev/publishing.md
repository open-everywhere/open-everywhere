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

Nine packages publish, in two kinds.

| Kind | Packages | What a consumer does with it |
|---|---|---|
| Library | `@open-everywhere/core`, `@open-everywhere/adapters`, and the six `@open-everywhere/provider-*` bundles | imports it — an enumerated `exports` map that points at `dist/` |
| Bin | `create-open-everywhere` | runs it — `npx create-open-everywhere`, raw `src/**` through the bin's own `tsx` |

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

## A consumer must apply the eve patch, or core refuses to boot

`@open-everywhere/core` runs on a PATCHED `eve`. The tree carries
`patches/eve+<pinned version>.patch`, and `patch-package` applies it on `postinstall` **in this
repository**. The patch holds seven live parts. Every one is a security or correctness control, and
every one fails SILENTLY when the patch is absent — nothing throws, nothing logs, the behaviour is
simply not there. The worst of them is the connector fence: on an unpatched `eve`, every connector
result and every MCP-server-authored tool description reaches the model unfenced.

`eve` is a **peer** dependency, so a consumer installs the registry copy and the patch is not in it.
`patch-package` only WARNS when a patch does not apply, so a cold `npm install` that skipped lifecycle
scripts produces exactly that tree with a green install log. OPE-2168 measured it — in a cold install
tree `grep -rl __oeProjectToolSet node_modules/eve/dist` found **zero** files, against one in this
repository.

**Core therefore refuses to boot on an unpatched `eve`.** Each part plants a runtime marker, and
`agent/access/eve-patch-probe.ts` reads all seven before the first wake is served. A missing marker
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
npm i @open-everywhere/core eve@0.54.3
npx oe-eve-patch
```

The eve version is the pin `@open-everywhere/core` declares as `peerDependencies.eve` — read it there
rather than from this page, which a re-roll can leave behind. The applier refuses any other version.

A consumer who wants it on every install puts it in **their own** manifest, where they can read it:

```json
{ "scripts": { "postinstall": "oe-eve-patch" } }
```

`oe-eve-patch` is safe to run that way. It is idempotent — a second run on a patched tree is a no-op
and exits 0 — it never writes outside the project, and it refuses rather than guesses:

| It refuses when | Because |
|---|---|
| no eve resolves from the project | eve is a peer; the message names `npm i eve@<pin>` |
| the resolved eve is outside the project root | patching there would rewrite bytes the project does not own |
| nothing is installed at `<root>/node_modules/eve` | the patch spells its targets relative to the project root, and patch-package addresses no other path |
| the installed eve is not the pinned version | the hunks derive from other bytes; patch-package would only warn |
| a marker the patch adds is missing afterwards | patch-package reports a failed hunk as a **warning**, so nothing else would say so |

🔴 **Under pnpm and bun the applier detaches each target from the shared store before patching, and
this is not optional.** Both import a package's files from a content store by **hardlink**, so one
inode is shared with every project on the machine that installed that eve — and patch-package rewrites
a target with `writeFileSync(path, …)`, which truncates that inode rather than replacing the directory
entry. Left alone, one consumer running the applier would silently splice OE's tool loop into every
other project's eve. So the applier copies each hardlinked target to a fresh inode and renames it over
the entry first; the store keeps the original bytes. `node-linker=hoisted` does **not** avoid this —
pnpm hardlinks from the store whatever the linker produces. A symlinked `node_modules/eve` is
otherwise fine: it is what pnpm produces, its target is inside the project root, and patch-package
reaches it.

The last refusal row is the one that matters. `--error-on-fail` is not enough on its own:
patch-package's already-applied path is a reverse dry run, which is what makes a second run a no-op,
and neither route reads the bytes afterwards. The applier reads them, and reports one line per patch
part. Two of the five patched files carry no `__oe` marker — `context/dynamic-tool-lifecycle.js` wraps
an existing call and `protocol/message.d.ts` is types-only — so those two rest on patch-package's own
`--error-on-fail` verdict, and the applier prints a line for them saying so.

**Copying the patch by hand still works**, and it is what a consumer who would rather not run our bin
can do: take `patches/eve+<pinned version>.patch` from this repository into their own `patches/`,
add `patch-package` to their `devDependencies`, and add `"postinstall": "patch-package"` to their own
manifest. The applier exists so that is not the only route.

**The refusal is two checks, and between them no path serves a wake on an unpatched `eve`.**

| Check | Where | What it decides |
|---|---|---|
| Boot probe (`access/eve-patch-probe.ts`) | module load | Resolves the `eve` package root, loads the four carrier files, reads the markers. Refuses on any absence. |
| Turn gate (`hooks/eve-patch-gate.ts`) | `turn.started` | Reads the markers only. Running a turn has already evaluated every carrier, so no path is needed. Refuses on any absence. |

The boot probe alone is not enough. A hosted build inlines `eve` and ships no `node_modules/eve`, so
the package root does not resolve and the probe reports `unverifiable` rather than refusing —
refusing at boot would take down every hosted deploy. The turn gate closes that case: a hosted deploy
whose bytes are unpatched fails its first turn instead of serving it. The boot probe is kept because
it fails earlier and more cheaply on a `node_modules` install.

The `test` chain stays the earliest control. `npm run lint:eve-patch` and `npm run test:eve-install`
read the installed bytes before a deploy, and a cloud run executes the chain on the same checkout.
Nothing inside `npm run build` re-checks them, so that is a convention rather than a build-order
guarantee — which is why the turn gate exists. `npm run test:publish-cold-install` is the consumer-side
control: it packs the workspaces, installs them into an empty directory, runs `npx oe-eve-patch` and
asserts every marker the patch adds is absent before and present after.

**This page is not the only place that states the recipe.** Each of the eight library packages
carries it in its README § Install (OPE-2206), and `@open-everywhere/core`'s is the one an npm
consumer reads first. `create-open-everywhere` carries no install recipe: it is run rather
than imported, and its README documents `npx create-open-everywhere` instead.

The publish gate holds the eight READMEs in step, and only those. `scripts/publish-readme.ts` fails a
package README that names an `eve@<version>` other than core's `peerDependencies.eve`, so a pin
re-roll cannot leave one of those pages behind. `npm run test:publish-readme` runs the same rule on
the test chain, and it also asserts that each of the eight § Install sections still RUNS
`npx oe-eve-patch` — a recipe that names the right version but drops the second command is the defect
OPE-2206 closed.

🔴 **This page's own recipe is NOT gated.** No script reads `docs/dev/publishing.md`, so the
`eve@<version>` in § *Applying the patch is the consumer's step* above is hand-written and a re-roll
can leave it behind. Read the pin from core's `peerDependencies.eve`, as that section already says.

## The order of the checks

Run all six. Each answers a different question, and the preview is the only one a human reads.

```bash
npm run build:packages             # every library needs a fresh dist/ before it is packed
npm run lint:publish               # the CLOSED question: does each manifest obey the rules?
npm run test:publish-cold-install  # the CONSUMER question: does a cold install actually work?
npm run test:quickstart            # the STRANGER question: does the scaffolded app install, patch and build?
npm run publish:preview            # the OPEN question: is there anything in these bytes we would regret?
npm publish --workspace <name>     # by hand, one package at a time, after reading the preview
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
(`oe secret`). It bites `create-open-everywhere` hardest, because that package ships no compiled
form at all.

The gate is deliberately outside `npm test`, and the cost is not evenly spread. `attw` checks each
enumerated subpath against the whole graph behind it, so `@open-everywhere/core`'s 706 subpaths over
the agent graph dominate. Measured on a 4 vCPU machine: **the whole gate takes about 21 minutes**, and
core is effectively all of it — every other package's `attw` finishes in two to three seconds. Run the
gate before a publish, and after any change to a `files` allowlist, an `exports` map or a
`.gitignore` — `--only <pkgDir>` narrows it to one package while you iterate.

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

## Versions track milestones, not merges

**One version per milestone.** Not one per batch merge, and not one per pull request.

The reason is that a consumer reads the list of published versions as the history of this project:
the tarballs and their diffs. A version per merge would publish that reader a stream of increments
with no story, and every one of them is permanent.

So: decide a milestone is done, bump all nine packages to the same version together, publish
them together. The sibling dependencies are exact pins (`"@open-everywhere/core": "0.1.0"`), and
`lint:publish` checks each pin against the version that sibling actually publishes. A bump that
misses one manifest therefore reds before a publish can create the mismatch — npm would otherwise
resolve it by nesting the older core under that package, so a consumer runs two cores at once.

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

`create-open-everywhere` is unscoped, because `npm create <name>` resolves `create-<name>` at the
registry root. That name is first-come too, and it is claimed by the first publish.

Every publishable manifest sets `publishConfig.access: public`. A scoped package defaults to
restricted, and a restricted publish on a free account fails rather than shipping privately.

## Provenance waits for the public repo

npm provenance (`npm publish --provenance`) attaches a signed attestation linking a tarball to
the public source commit and the build that produced it. It needs a **public** repository and a
supported CI runner.

Neither holds today: the repository is private, and this repo runs no workflow at all
(see [AGENTS.md](../../AGENTS.md) § Build/test/typecheck). So the first publishes carry no
provenance, and that is the correct state rather than a gap to work around. Revisit it after the
public cut, together with whatever runs the build.

## Before you publish — the checklist

1. On a clean tree at the commit you intend to publish.
2. `npm run build:packages` green.
3. `npm run lint:publish` green — quote the exit code.
4. `npm run publish:preview` — zero BLOCK rows, and **read every REVIEW row**.
5. All nine versions equal, and every sibling pin equal to them.
6. `npm run test:publish-license` green — every package root carries the Apache-2.0 text.
7. `npm run test:publish-cold-install` green — quote the exit code. It packs all nine packages,
   installs them into an empty directory with `eve@<pin>` from the registry, runs `npx oe-eve-patch`
   there, and asserts every marker the committed patch adds is absent before and present after. It
   needs the network and measures in minutes, which is why it is off the test chain; the applier's own
   decisions run on every chain run as `test:eve-patch-applier`. `--keep` leaves the tree on disk.
8. `npm run test:quickstart` green — quote the exit code. It packs all nine packages, installs the
   packed wizard on its own, scaffolds the quickstart app with it, points the app at the tarballs and
   runs `npm install` with lifecycle scripts, so the app's `postinstall` applies the eve patch. It then
   asserts that the eve patch probe reads `patched`, that `oe build --check` fails before `oe build`
   and passes after it, that the app typechecks, and that `eve build` succeeds. It needs the network
   and measures in minutes, so it is off the test chain; the scaffold and the template drift check run
   on every chain run as `create-open-everywhere test:scaffold`. `--keep` leaves the app on disk.
9. `npm publish --workspace <name>` per package. Publish `@open-everywhere/core` first: every
   other package pins it.
10. Install the result somewhere clean and run it, before announcing anything.
