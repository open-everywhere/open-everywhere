# Consuming Open Everywhere as npm packages

You don't have to fork this repo to run Open Everywhere. The runtime ships as eight npm
packages, and your deployment can be a small repo of your own that depends on them: your
config, your `roster.config.ts`, your Vercel project, your data.

This page describes what those packages are, what your repo has to contain, and the three
install-time properties that must hold or the deployment is quietly wrong.

## Start here: scaffold the app

```bash
npx @open-everywhere/create my-agent
```

This is the way in. It copies the quickstart app into `./my-agent`, a new or empty directory, runs
`git init` there (unless git is absent or the directory is already inside a work tree), and prints
the next steps. It never prompts: setup is agent-led (OPE-2233). A directory that holds only `.git`
counts as empty, so `npx @open-everywhere/create .` works inside a fresh clone of an empty
repository. Inside an empty clone named `my-agent`, `npx @open-everywhere/create my-agent` refuses
and prints that `.` command, because it would otherwise make `my-agent/my-agent/` (OPE-2399). On a
Node below 24 the scaffold exits non-zero and writes nothing. The app it writes already holds
everything on this page:

- the eight packages and `@open-everywhere/create`, all pinned to that CLI's own version, and
  `eve` pinned exactly to core's peer pin;
- the root `zod` override (§ 3 below) and `"postinstall": "oe-eve-patch"` (§ 2 below);
- `undici` overrides that lift `eve`'s exact `8.9.0` pin and `guarded-fetch`'s exact `7.29.0` pin
  to patched releases (`eve` itself stays on its pin, and the AI SDK under `eve` keeps undici 7);
- an `allowScripts` entry for `esbuild` and `@mongodb-js/zstd`, the two dependencies with install
  scripts;
- `oe build` as its `prebuild`, `predev`, `prestart` and `pretypecheck`;
- a `roster.config.ts` and a reviewed `roster.lock.json` that mount Slack, Notion and GitHub;
- the minimal agent config under `agent/`, a `.env.example` with variable names only, and a
  `.gitignore` that keeps the generated slot tree and every env file out of git;
- the agent route: `AGENTS.md`, a `.mcp.json` that starts the `open-everywhere-ops` MCP server
  (`scripts/ops-mcp.ts`), and the `quickstart-open-everywhere` skill, so a coding agent opened in
  the app can drive the setup. `npx @open-everywhere/create --check --json` reports the setup steps
  as data, each with a `next` command, judged against the **vercel** route by default
  (`--route docker` for the self-host route; `--host <url>` probes a deployment). The CLI has no
  interactive mode and sends no telemetry: it scaffolds and it reports status.

The app's own `README.md` is one screen: it hands setup to the coding agent and names the two
supported routes (Vercel and Docker). The ordered step list lives in ONE place —
[Setup steps](./setup-steps.md), generated from the setup engine's own step list, which
`--check` reports and the app's skill walks. `npm run
test:quickstart` (`scripts/quickstart-test.ts`) proves the path from the packed tarballs: it
scaffolds with the packed CLI, installs, and asserts that the eve patch probe reads `patched`,
that `oe build --check` passes after `oe build`, that the ops MCP server lists its tools, that the
app typechecks, and that `eve build` succeeds. The rest of this page explains what the scaffold wrote and why.

## The packages

| Package | What it is |
| --- | --- |
| `@open-everywhere/core` | The portable runtime — access and approvals, identity, memory, spend, routines, webhooks, connectors, the audit chain, and the `oe` roster build. |
| `@open-everywhere/adapters` | The reference Vercel-hosted backends: AI Gateway models and pricing, Sandbox, Neon, OpenTelemetry, AWS and Okta. |
| `@open-everywhere/provider-slack` · `-teams` · `-discord` · `-github` · `-linear` · `-notion` | One per surface. Take only the ones you use. |

All eight are **ESM-only** and versioned in lockstep — the eve pin, the shipped patch, and the
contribution manifests move together, so a mixed set is not a supported configuration. Take the
same version of everything.

### ESM-only is a decision, not an oversight

There is no CommonJS build. Eve and the AI SDK are ESM-only themselves, and Node ≥ 22.12 can
`require()` an ES module anyway. `@arethetypeswrong/cli` reports `CJSResolvesToESM` against the
default profile for exactly this reason; the repo's publish gate runs it under the `esm-only`
profile, which is how that choice is stated in machine-readable form rather than suppressed.

### Compiled output, plus the sources

Each package ships compiled ESM and `.d.ts` under `dist/`, **and** the original `.ts` sources
beside it. The sources are there to be read — this codebase's comments carry most of its
reasoning — and the declaration maps point at them, so go-to-definition lands on the real file.
That holds for `agent/**`. Core's `oe` CLI is the exception: it ships compiled under
`dist/scripts/`, and its `scripts/*.ts` sources stay in the repository, so its maps point at files
the tarball does not carry.

The compiled output is not a nicety. Node refuses to type-strip anything whose realpath is
inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `eve build`
*evaluates* your authored agent modules before it bundles them — so a package that shipped raw
TypeScript would fail your **build**, not merely your runtime.

## What your repo contains

- `package.json` — the OE packages you want, plus `eve` (see the pin below).
- `roster.config.ts` + `roster.lock.json` — which contributions you mount, and the recorded
  review of them. Both are committed; they are the source of truth and the review surface.
- Your own agent config — settings, bundles, identity, memory domains, model policy, budgets.
- `agent/` — the eve agent root. Most of it is `oe build` output (the tool/channel/hook slot
  files are generated from `roster.config.ts` and gitignored); see
  [core/app separation](../core-app-separation.md).

`oe build` runs as your `prebuild`, so `npm run build` regenerates the slot tree and then hands
off to `eve build`. Nothing about the package install changes how that pipeline works.

## Three install-time properties that must hold

### 1. The eve version is an exact peer dependency

Every OE package declares `eve` as an **exact** `peerDependency`, never a regular dependency.
That is deliberate: identical exact ranges hoist to one copy, and one copy is the only safe
arrangement — a second, nested eve would be an *unpatched* eve, and the untrusted-content
projection hook would silently stop applying to it. npm ≥ 7 hard-fails such a conflict with
`ERESOLVE`, which is the behaviour we want.

> **The peer pin is a tripwire, and it only trips on npm.** pnpm (`autoInstallPeers=true`,
> `strictPeerDependencies=false`) and Yarn Berry downgrade a peer mismatch to a warning and
> install anyway. If you use either, the pin is a hint, not a guarantee and nothing downstream
> re-checks it — pin `eve` yourself and verify that exactly one copy resolves.

### 2. Nothing runs on install, and no eve-integrity check runs at build either

Published OE packages contain **no `postinstall`, and no lifecycle scripts at all**. pnpm 10+
ignores lifecycle scripts by default, and a package that did meaningful work during install
would trip every supply-chain scanner in your CI. So no OE integrity check can live there.

`oe build` runs as your `prebuild`, `predev` and `prestart`, and it does gate a build: it refuses
an out-of-date roster lock and an unresolvable package specifier. 🔴 **It does not verify the eve
install.** Its one read of the installed eve degrades silently to `undefined` on any failure
(`packages/core/scripts/oe-cli.ts:45-52`), so a second nested copy of eve, an unpatched copy, or a
peer-version mismatch does not red your build. The gates that would catch those are **repo-side
tests** a consumer never runs — `npm run test:eve-install` (from `packages/core`) and
`scripts/publish-lint.ts`'s peer-dependency assertion. On a consumer tree, one resolved and pinned
copy of `eve` is your own responsibility.

Two things a consumer DOES get, and neither is an install hook. `npx oe-eve-patch` — a bin
`@open-everywhere/core` ships beside the packed patch — applies the patch on demand, refuses an eve
that is not the pinned version, and verifies the patched bytes afterwards rather than trusting its
own apply step. It applies the patch itself, so core carries no patch tool in its runtime
dependencies (OPE-2398). And core **refuses to boot, then refuses the first turn**, on an eve whose
patch markers are absent (`agent/access/eve-patch-probe.ts`, `agent/hooks/eve-patch-gate.ts`). So an
unpatched tree fails loudly instead of serving wakes with the connector fence inert.
[Publishing](../dev/publishing.md) carries the recipe and what each refusal means.

### 3. The root `zod` must be ONE version

The rule exists because of an incident (OPE-1751). Through eve 0.65, eve rehydrated every MCP tool
`inputSchema` with the zod it bundles in its own `dist`, and the AI SDK then converted that schema
back with the **root-resolved** zod. The two instances split one traversal: the caller builds the
context, and the schema owns the per-node processors. On the 4.4.3-root / 4.5.4-eve pair it threw
`TypeError: Cannot read properties of undefined (reading 'push')` inside the model-call
preparation, so **every session that mounted a connector tool with an `allOf` failed its turn**.
Both versions installed, typechecked and built cleanly, so nothing else saw the skew.

**On eve 0.71.0 the tool path no longer meets the two instances** (re-derived at OPE-2247 and
OPE-2321). eve 0.66.0 and later pass a tool schema as JSON Schema only. eve 0.71.0's `toInputSchema`
wraps it in eve's own standard schema and calls no `z.fromJSONSchema`. So the tool path builds no
schema with eve's bundled zod for the root zod to process. eve 0.69.0 also ships that bundle as
compiled bytes with no version in them, so "root zod equals eve's zod" is no longer readable.

**The rule stays, and it is weaker than the one it replaced.** The proof covers eve's own tool path
only. Nobody has yet run the retirement test OPE-1751 asks for: an `allOf` connector schema that
round-trips cleanly with a root zod that differs from eve's. So this repository still pins ONE zod
**exactly**: an exact version in every `package.json` that declares zod, plus a root `overrides.zod`
entry. `ai`, `@ai-sdk/*` and `@modelcontextprotocol/sdk` declare zod as a peer **range** that
already admits the pinned version, so they need no override. The override exists for the two
packages that pin zod **exactly** — `@agent-browser/eve` (4.4.3) and `@vercel/cli-config`
(4.1.11). Without it npm installs a nested copy for each of them, and a nested copy is a second
instance.

Two repo-side gates hold the rule. `npm run test:eve-install` asserts that no eve module outside
`dist/src/compiled/` calls `fromJSONSchema` and that the root zod is a v4. It reds if eve goes back
to rehydrating with its bundled zod, and the version-equality rule must then come back.
`npm run test:zod-seam` drives the real crossing through eve's `toInputSchema` and the AI SDK's
`asSchema()`. On a consumer tree, run `npm ls zod` and confirm it prints one version and exits 0.

## Verifying an install

`eve build` bundles the OE packages into your deployment output — no bare `@open-everywhere/*`
specifier survives into `.output/server/`, so the hosted functions do not need them at runtime.
If you want to confirm it on your own deployment:

```bash
npm run build
grep -r '@open-everywhere' .output/server/ --include='*.mjs' | grep -E 'from *"@open-everywhere'
```

That should print nothing. (Matches inside string literals and doc text are expected — the
packages quote their own module paths in comments.)

## Upgrading

Run `npx oe upgrade` from the app root. It bumps every `@open-everywhere/*` package together and
pins `eve` to the target core's declared peer. Then it installs and runs the config codemods the
release notes name. Last, it runs `oe build --accept`, `npm run typecheck` and `npm run build`.
`npx oe upgrade --plan` prints the plan and writes nothing. Review the `roster.lock.json` diff before you deploy.
`UPGRADING.md` in `@open-everywhere/core` holds the release notes the command reads.

One honest caveat about the `roster.lock.json` diff: the lock compares **contribution keys**, not versions. A
version bump that changes an existing capability's behaviour without adding or removing a
contribution produces *no* lock diff — only a new or vanished capability turns the lock red.
Read the release notes as well as the lock.

**The lockfile.** Before the install, `oe upgrade` drops the `package-lock.json` entries of `eve`,
of every `@open-everywhere/*` package and of every package that peers on one of them. npm then
resolves that set again from the new pins, and every other locked entry stays as it was. Without
the edit, an install across an `eve` peer change exits ERESOLVE: the lockfile still holds the old
packages, each with its exact old `eve` peer, and deleting `node_modules` does not help. A core at
0.2.1 or earlier does not make the edit. If its install stops with ERESOLVE, run
`rm package-lock.json && npm install`, then run `npx oe upgrade` again: it resumes. Read the
lockfile diff before you commit it.

**The template drift report.** `oe upgrade` and `--plan` compare every scaffolded file with the
target release's `@open-everywhere/create` template. The app owns its scaffolded files, so an
upgrade changes none of them. Each report line says what to do:

| Line | Meaning |
| --- | --- |
| `DELETE` line | a release up to the target removed this file from the template, and the app still has it. Delete it. For example, eve 0.69 and later refuse `agent/instrumentation.ts` at build. |
| `SYNC` line | a template-owned file differs from the target's copy, or the app does not have it. Read the diff, then copy the target's file. |
| `config` line | the app's own config-as-code differs. Merge the template's change only if you want it. |
| `app-owned` line | the app's `.oe-template-ignore` names the file. The report asks nothing for it. |

To mark a file as removed or owned on purpose, name it in `.oe-template-ignore` at the app root:
one app-relative path per line, a trailing `/` for a directory, and `#` for a comment. The report
prints nothing for an ignored file that the app does not have. It prints one `app-owned` line for
an ignored file that the app has, and that line never counts as a SYNC or a DELETE. A core at 0.2.1
or earlier prints no `DELETE` line and reads no ignore list.

**Rehearse an unpublished release.** `npx oe upgrade --from <dir>` reads the target from the
`npm pack` tarballs in `<dir>`, not from the registry. It reads the target version and the `eve`
peer from the core tarball, and the template from the `@open-everywhere/create` tarball. It pins
each `@open-everywhere/*` package to `file:<its tarball>`, then runs the same seven steps. `--plan`
and `--to` work with it. To pack a release checkout, run
`npm run build:packages && npm pack --workspaces --pack-destination <dir>` in it. The command
refuses when the app pins a package that `<dir>` holds no tarball for, because the set moves
together. The check covers only the packages the app pins. When a tarball depends on a package
the app does not pin (`@open-everywhere/create` depends on `@open-everywhere/provider-slack`), npm
reads that package from the registry, and the install fails on the unpublished version. The
scaffolded app pins all nine packages. The `file:` pins are for the rehearsal only: do not commit
`package.json` or the lockfile after the run. `eve` and every other dependency still come from the registry. A core at 0.3.0 or
earlier has no `--from`.

**An app that was bumped by hand in the past** has never seen the report. Run
`npx oe upgrade --plan` once to see its template drift, even when it is already on the newest
release. The report prints in that case too.

**An app below 0.1.4 has no `oe upgrade`.** The subcommand first shipped in 0.1.4, and the
installed core ships no release record. Install the target core beside the app, in its gitignored
`.open-everywhere/` directory, and run that core's `oe` from the app root:

```sh
npm install --prefix .open-everywhere/bootstrap @open-everywhere/core@0.1.4 tsx@4
node .open-everywhere/bootstrap/node_modules/@open-everywhere/core/bin/oe.js upgrade --to 0.1.4
```

Put the newest release in place of `0.1.4`. The section "An app below 0.1.4" in `UPGRADING.md`
carries the same block with the newest release filled in. The run renames the retired
`create-open-everywhere` dependency to `@open-everywhere/create`, and reads the target's own
release record after the install. If the run stops at any step, run the second command again: it
resumes. After a green run, delete `.open-everywhere/bootstrap`. From then on, `npx oe upgrade` is
the command.

**The `npx` one-liner, from the first release after 0.1.5.** Up to 0.1.5, the `oe` bin registers
`tsx`. Core declares `tsx` only as a development dependency, and `npx -p` installs core into its own
cache, where no `tsx` resolves. So `npx -p @open-everywhere/core@<version> oe upgrade` fails with
0.1.5 or earlier as the target. Since OPE-2296 the bin runs compiled JavaScript
(`dist/scripts/oe-cli.js`) and needs no `tsx`. With the first release after 0.1.5, or a later one,
as the target, this is the bootstrap too:

```sh
npx -p @open-everywhere/core@<version> oe upgrade --plan
npx -p @open-everywhere/core@<version> oe upgrade --to <version>
```

With no `tsx`, `oe build` loads the app's `roster.config.ts` through Node's own type stripping, so
that file must use erasable syntax only, as its header says.

`scripts/oe-upgrade-packed-test.ts` runs the second prefix command above, as `UPGRADING.md` renders
it, against an app shaped like a 0.1.3 scaffold, and it starts the compiled bin from the npx-cache
layout. `scripts/oe-bin-packed-test.ts` runs `oe upgrade --plan` from a packed core with no `tsx`
on its resolution path, and shows that the old `tsx` shim fails in the same layout. Neither test
runs `npm install` against the public registry. Leg 7 of `scripts/oe-upgrade-packed-test.ts` runs
the real `npm install` against a local registry of stand-in packages. It proves that a bare
install over a 0.1.4-shape lockfile exits ERESOLVE across the eve peer change, and that the packed
core's `oe upgrade` takes the same app to the new set with its lockfile in place. Leg 8 serves no
`@open-everywhere/*` package at the target, and the packed core's `oe upgrade --from <dir>` takes a
0.1.4-shape app to the packed target set with the real `npm install`.
