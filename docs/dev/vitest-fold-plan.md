# The vitest fold — plan (OPE-1419)

This repository tracks 688 hand-rolled `*-test.ts` runners. Each runner is
a plain script: it imports the code under test and asserts at module top level through a file-local
helper. How that helper reports a failure splits the tree almost in half — **407 files carry no
`process.exit` at all**, because their helper delegates to `assert`, which throws, while 252 call it
exactly once and 29 more than once (the report's histogram prints all three). A codemod written for
either shape alone covers about half the repository. 683 of the 688 own an npm script that a
package's `test-chain.txt` lists.

Two files match the `*-test.ts` glob and are NOT runners: `agent/model/ab-test.ts` declares this
deployment's champion/challenger model, and `packages/core/agent/model/ab-test.ts` is the A/B
mechanism it imports (`ModelAbTest`, `assertModelAbTestValid`, `decideModelAb`). Neither asserts
anything. The inventory names both in `NOT_RUNNERS` and excludes them, so no total on this page
carries them.

This page plans the fold of those runners into vitest. It states what the fold converts, what it
cannot convert, the mechanical recipe per shape, the slice order, the `package.json` edit each slice
makes, and how the four `OE_PROOF` lines stay byte-exact throughout.

**Nothing here is converted yet.** Stage 0 (this page and
[`scripts/tidy/test-runner-inventory.ts`](../../scripts/tidy/test-runner-inventory.ts)) is the
inventory and the plan. Re-run the script rather than trusting the tables below — it reads each
package's `test-chain.txt` live (OPE-2286), so it cannot go stale the way this prose can. Every count on this page is
a row the script prints — the recipe's residue figures included, under `CODEMOD RESIDUE`. Two kinds
are not: the LINE totals, summed from `--json`, and a handful of figures derived by one subtraction
from a printed row (the 11 read-and-decide files that never convert, the 168 converting `compare`
files, the ~16 non-matcher helpers, the 29 with more than one `process.exit`, and the 58 legs stage
12 keeps). Those say so where they appear.

🔴 **The tables count this branch's own new suite**, `scripts/tidy/test-runner-inventory-test.ts`,
because it is a runner the fold must convert. (Its module, `test-runner-inventory.ts`, is not a
`*-test.ts` file and is not in the fold's scope.) Editing that suite moves the totals, so re-measure
before quoting a number in a slice.

```
npx tsx scripts/tidy/test-runner-inventory.ts          # the report
npx tsx scripts/tidy/test-runner-inventory.ts --json   # the same, machine-readable
```

---

## 🔴 The premise, corrected: the runners already run INSIDE vitest

The ticket reads as though the runners sit outside vitest and a fold would move them in. They do not.
`npm test`'s last leg is `test:suites`, which is one vitest run
([`vitest.chain.config.ts`](../../vitest.chain.config.ts)) over 20 `scripts/chain/shard-NN.spec.ts`
files. Each shard imports its share of the runners and executes each one as a `test()`
([`scripts/chain/_run-shard.ts`](../../scripts/chain/_run-shard.ts)). OPE-703 and OPE-709 built that.

So the fold is not an engine change. It changes two things:

1. **The file shape.** A runner is a top-level script with a local assertion helper. A vitest spec
   declares `test()`/`expect()`. Today one runner is one vitest test, so a red names the FILE and
   stops at the first failing assertion. After the fold, an assertion is an `expect` with vitest's
   own diff — and, because the recipe rewrites to `expect.soft`, the run reports every failure
   **among the rewritten helper sites** rather than only the first. 🔴 **A plain `expect` would NOT
   buy that**: it throws, which aborts the one `test()` callback the recipe builds, leaving the
   reporting exactly as it is today. Measured on this tree: two failing `expect` calls in one
   callback report one failure; two failing `expect.soft` calls report two. The soft form is what
   makes this bullet true, so it is not a stylistic choice inside step 4.
   ⚠️ The gain stops at the helper sites. Step 6 leaves `assert…` calls alone, and a failing
   `assert` throws — so in the **442** converting files that use `node:assert` directly (127 of them
   with three or more such sites, beyond any helper body), the first `assert` failure still hides
   every later soft one. The report prints both rows.
2. **The registry.** 673 npm scripts exist only to tell the shard runner what to run. Vitest finds
   spec files by glob, so those scripts and the shard machinery go.

The chain lists (`test-chain.txt`) themselves do **not** all go — see § Stage 12, which is the part of this
plan most easily got wrong.

Read `_run-shard.ts` before writing any conversion. Its six hygiene items are the exact price of
running scripts inside a shared process, and the fold removes five of them.

---

## The inventory

Measured 2026-09-13. The count includes this page's own inventory suite,
`scripts/tidy/test-runner-inventory-test.ts` — a `<root>` `plain-assert` file
that stage 10 converts with the rest. No sha is quoted deliberately: that file is a runner, so each
commit that edits it moves these totals, and a sha here would be one commit stale by construction.
Re-run the script for the tree in front of you.

| | count |
|---|---|
| hand-rolled `*-test.ts` runners (2 further files match the glob and are not runners) | **688** |
| chain legs `npm test` executes | 731 |
| …of which are `*-test.ts` runners | 683 |
| …of which are lints and generator checks (**not** runners, and they stay) | **48** |
| `*-test.ts` files no leg names | 5 |
| assertion call sites, statement position, over code (not prose) | **44,715** |
| …of them in files the fold converts | 42,993 |
| total lines across all runner files | 285,761 |

The ticket's "601" matches no measurement here. The file count is 688; 645 files define a
boolean-style helper. Both rows are in the report.

### By shape

The shape decides the conversion recipe. A file can carry several signals; the classifier takes the
hardest constraint first, and the report also prints the signals separately so a shape choice never
hides one (a `child-process` file that also binds a socket still shows `bindsSocket`).

| shape | files | lines | converts? |
|---|---|---|---|
| `plain-assert` — asserts in-process against imported modules | 626 | 256,684 | yes, by codemod |
| `child-process` — imports `node:child_process` to exercise a CLI | 41 | 15,713 | yes, by codemod |
| `socket-binding` — binds a socket and serves | 6 | 2,139 | yes, by codemod |
| `subprocess-bound` — cannot run in a vitest process at all | 10 | 9,811 | **no** |
| `indirect` — no leg names it; a leg imports it | 1 | 517 | **no** |
| `off-chain` — no leg names it at all | 4 | 897 | **no** |

**673 files convert. 15 stay as `tsx` scripts** (§ What cannot convert). 11 files bind a socket in
total; 5 of them also spawn a child, so the shape column shows 6 and the `bindsSocket` signal shows
11. **Ten of the 11 owe an `afterAll` close** — the eleventh is off-chain and no slice opens it
(§ `child-process` and `socket-binding`).

### By package

| package | plain-assert | child-process | socket-binding | subprocess-bound |
|---|---|---|---|---|
| `@open-everywhere/core` | 396 / 172,343 | 12 / 5,051 | 4 / 1,374 | 6 / 3,736 |
| `<root>` | 99 / 38,593 | 27 / 10,522 | 2 / 765 | 2 / 5,820 |
| `@open-everywhere/provider-slack` | 34 / 13,706 | — | — | — |
| `@open-everywhere/provider-notion` | 28 / 9,605 | — | — | 1 / 143 |
| `@open-everywhere/provider-linear` | 24 / 8,045 | — | — | 1 / 112 |
| `@open-everywhere/provider-github` | 16 / 5,117 | — | — | — |
| `@open-everywhere/adapters` | 14 / 4,359 | 1 / 68 | — | — |
| `@open-everywhere/provider-teams` | 13 / 4,241 | — | — | — |
| `@open-everywhere/create` | 2 / 675 | 1 / 72 | — | — |

Counts are `files / lines`. The 5 `indirect` and `off-chain` files belong to no package row and are
not in this table. `@open-everywhere/provider-discord` owns no runner: its suites live at the app
tier, and its `test` script is an `echo` that says so.

### Assertion-helper families — the number that sizes the codemod

A file can define more than one. Each family has its **own** rewrite, and a blind one-rule rewrite
inverts the third.

| family | shape | rewrite | files defining it |
|---|---|---|---|
| `boolean` | `ok(cond, label)` | `expect.soft(cond, label).toBe(true)` | 645 |
| `compare` | `eq(actual, expected, label)` | `expect.soft(actual).toEqual(expected)` | **175** |
| `reversed` | `ok(label, cond)` | the arguments **swap** first | **13** |
| none | an accumulator (`fail(msg)`), or no helper | read the file | **14** |

**157 files define more than one family** (150 of them converting — the report prints both), which is
why the column sums past 688, and why the two rewrites cannot be split by file. `packages/adapters/scripts/dream-judge-gateway-test.ts` is the
shape: `function ok(cond: boolean, label: string)` at `:17` and `const eq = (a, b, label)` at `:24`.
`packages/core/scripts/changed-relevant-map-test.ts:5` is the `reversed` shape. The report prints
the exact classification rule so a slice can reproduce these counts.

🔴 **The `compare` bucket is a read-this-file bucket, not a one-rewrite bucket.** The rule's fallback
sweeps in about 16 helpers that are not matchers at all — most of them `check(label, fn)`, a test-block
wrapper, plus `okRow(...)` in `e2e-driver-test.ts` and `check(toolNames, docs, exempt)` in
`capability-docs-test.ts`. The budget is safe-side; the rewrite column is right for the other ~159.

🔴 **The `check(label, fn)` files take a DIFFERENT step 3, and they are the one case where the
recipe's single-callback shape does not apply.** `scripts/deploy-ci-gate-test.ts:38`,
`scripts/ci-changed-paths-test.ts:7` and `packages/core/scripts/work-mount-lint-test.ts:13` are the
shape: a wrapper that takes a label and a callback and runs the callback. The wrapper already IS a test
block, so the conversion is one top-level `test(label, fn)` per `check` call — **not** a `test()`
nested inside step 3's single wrapping callback, which vitest rejects outright. Two consequences a
slice must carry: step 3 does not wrap these files at all, and the verify gate's parity invariant
compares `check(` in the pre-image against `test(` in the post-image for them. That is a named
exception in the gate, not a silent one — left unnamed, invariant 1 false-reds a correct conversion,
because `ASSERT_CALL` counts `check` and does not count `test`.

### Signals

Each is independent of the shape. A token signal is measured with **comments and string literals
blanked** — a runner's prose is dense enough that a bare token search reads it as code. A signal that
reads a specifier or a path (`node:assert`, a bare relative read) keeps the strings, because that is
where a specifier lives.

| signal | files |
|---|---|
| imports `node:assert` | 458 |
| assigns into `process.env` | 349 |
| top-level `await import(...)` | 311 |
| creates a temp directory | 275 |
| binds a socket | 11 |
| touches `globalThis` | 97 |
| reads `process.cwd()` | **7** |
| calls `process.exit(0)` as a **deliberate clean stop** | **7** |
| sets `process.exitCode` instead of throwing | 6 |
| reads `process.argv` itself | 4 |
| has a top-level `export` declaration | 1 |
| reads a bare relative path (`readFileSync("package.json")`) | 1 |
| a chain leg passes it CLI arguments | **0** |

One converting file carries the single top-level `export` declaration — see the edge cases under
§ the codemod.

`process.exit(` occurrences per file: **407 call it never** (their helper delegates to `assert`, which
throws), **252 exactly once** and **29 more than once**. In most of the 252 that one call is the
local helper's own `process.exit(1)`, which the codemod deletes. Five are not, and a slice must read
each: `scripts/memory-eval-fixture-test.ts:31` and `scripts/e2e-engaged-fixture-test.ts:79` call a
deliberate `process.exit(0)`, and `scripts/deploy-merge-fence-test.ts`,
`scripts/release-record-test.ts` and `scripts/upgrade-diff-fence-test.ts` define no helper family at
all, so their single call sits in the body. The 29 need a reader too.

**No runner leg takes CLI arguments.** `ChainLeg.args` exists for lint legs
(`lint:ingestion --check` and friends), which are not runners and are out of this fold's scope.

---

## What per-file isolation replaces

Measured directly on this tree (vitest 4.1.10, `pool: "forks"`, `isolate: true`): two spec files in
one run got **different pids**, a `process.env` value one wrote was `undefined` in the other, and
both saw `cwd` = the repo root.

So each converted spec file gets its own process. Of `_run-shard.ts`'s six hygiene items:

| item | after the fold |
|---|---|
| ① `vi.resetModules()` before the import | replaced — a fresh process has a fresh registry |
| ② `resetProcessGlobals()` | replaced — `globalThis` is fresh too |
| ③ `process.chdir` into the package dir | **NOT replaced** — see below |
| ④ `process.env` snapshot and restore | replaced — the process dies with the file |
| ⑤ `process.exit` stubbed to throw | replaced for the failure exits, **not** for the 7 clean stops |
| ⑥ `process.argv` set to the leg's file and args | replaced — no runner leg takes arguments |

**③ is the one real exposure, and it is one file wide.** Converted specs run with `cwd` = repo root,
not the package directory. Seven files read the cwd: five are root-package files, which already get
the repo root; `packages/core/scripts/docs-test.ts` `chdir`s to a temp dir on purpose and reads the
cwd back (it imports `cwd` from `node:process` and calls it bare, which is why the signal checks both
spellings). Exactly one breaks:
`packages/providers/slack/scripts/slack-web-api-seam-test.ts:10` (`const PKG_ROOT = process.cwd()`).
Fix it in its own slice by resolving from `import.meta.url`, the pattern the four sibling
`*-seam-test.ts` files in the other provider bundles already use.

One file reads a bare relative path: `scripts/release-record-test.ts:136` reads `"package.json"`.
It is a root leg, so the repo-root cwd it already gets is the one it keeps — harmless, and listed so
a slice does not have to rediscover it. `_setup.ts` sets `OE_MEMORY_DIR` explicitly, so the sqlite
default never falls through to cwd either.

### ⑤ has a class the codemod must not treat as a failure

Seven runners call `process.exit(0)` **deliberately**, as a clean stop that avoids hanging on an open
handle (PGlite, a scheduler). Four of the seven are in
files the fold converts, and they are the ones a slice meets:
`scripts/agent-version-seam-test.ts:33`, `scripts/boot-smoke-test.ts:371`,
`scripts/full-kit-boot-order-test.ts:102` and `scripts/e2e-engaged-fixture-test.ts:79`. (The other
three are two `postbuild` bundle tests and `memory-eval-fixture-test.ts`, all of which stay `tsx`
scripts.) Neither blanket rule works on these:
deleting the call leaves the handle open and hangs the vitest worker, and rewriting it to a `throw` turns a
passing suite red. Each of the four gets an explicit disposition in the slice that converts it —
normally closing the handle in an `afterAll` and deleting the exit.

### The fold does not forfeit the OPE-703 speed-up

The sharding exists to amortise `npm run`'s ~0.54 s per-leg spawn. One vitest file per suite means
673 forks instead of 20, so the obvious worry is that the fold undoes that win. Measured A/B on 24
core suites, two passes, same machine, `maxWorkers: 4`:

| shape | pass 1 | pass 2 |
|---|---|---|
| A — 4 shard files × 6 legs (today) | 21.7 s | 20.3 s |
| B — 24 spec files × 1 leg (the fold) | **17.2 s** | **17.8 s** |

File-per-suite is **faster**, by 15–20%. vitest schedules 24 files across four vitest workers more evenly
than four fixed shards can, and the round-robin in `legsForShard` cannot rebalance a slow leg.

Three honest limits on that measurement. It used core suites, which import core by relative path; a
provider suite reaches core through its published entry points, which the config inlines, and that
cost was not measured. Both arms still called `runLegInProcess`, so it measures the file-count
variable only — not the removal of the hygiene items, which can only make B faster. And it is a
one-off harness that this diff does not carry, so it is not reproducible from the repository.

**Re-measure at stage 5**, when the first large core slice lands. If B's advantage inverts on the
full 673, the answer is `maxWorkers`, not a return to sharding.

---

## The conversion recipe, per shape

### `plain-assert` (626 files) — the codemod

Most of these share a skeleton: imports, then a `let passed = 0` counter, then a local assertion
helper, then several hundred statements that set up state and assert, then a closing
``console.log(`<name>: ${n} assertions passed`)``. The residue is small but real, and a codemod that
assumes the skeleton silently leaves it behind: **7** define no helper the classifier recognises
(`unified-turn-policy-test.ts`, `notion-turn-policy-test.ts`, `boot-smoke-test.ts`,
`discord-gateway-turn-policy-test.ts`, `discord-scenario-security-test.ts`,
`full-kit-boot-order-test.ts`, `release-record-test.ts`), **5** have no zero-initialised counter, and
**20** have no `console.log` in their last four non-blank lines.

🔴 **Match the closing log by its PRESENCE, not by its wording** — `a console.log in the last four
non-blank lines` covers **606 of 626**. Neither wording is a superset of the other: 530 files say
`assertions passed`, 475 carry the `✓` glyph, and the two sets cross (67 glyph-without-phrase, 122
phrase-without-glyph). But those crossings are **not** what a wording-only match strands: the
stranded set is every file that HAS a closing log the wording misses — **82** for the phrase, **139**
for the glyph. Step 5 deletes the counter those logs read, so each stranded file reds
`typecheck:all`. The report prints all seven rows, so the figure never has to be re-derived by
subtraction. The **20** files with no closing log at all are the real residue.

The transform, as a TypeScript AST codemod:

1. **Rename** `<name>-test.ts` → `<name>.spec.ts`, in place.
2. **Keep every `import` declaration at top level**, and add `import { expect, test } from "vitest";`.
3. **Move every other top-level statement into one `test()` callback**:
   `test("<the npm script name>", async () => { …the body… });`. The callback is `async` so the 311
   files with a top-level `await import(...)` keep working unchanged — that shape exists to order an
   env assignment before a module loads, and it still does inside an async callback.
4. **Delete each local helper definition and rewrite its call sites, per family** (see the family
   table above), to **`expect.soft`** — see bullet 1 for why the soft form is load-bearing. The
   `boolean` rewrite keeps the label verbatim: vitest's `expect` takes a message as its second
   argument, and a failure then reads `MY-LABEL: expected false to be true`. 🔴 The `reversed`
   family's arguments swap first — 13 files, all of them converting, and a blind `boolean` rewrite
   on them produces
   `expect.soft("label", cond)`, which asserts on the label string and passes for every input.
   ⚠️ Soft assertions keep going after a failure, which changes the RED path, not only its report:
   `ok()`'s `process.exit(1)` used to halt the file. Two consequences. A later step that depends on
   the failed one can cascade into a second, derived error — noise, not a wrong verdict, and a slice
   should report the FIRST failure as the finding. And a side effect past the failure now RUNS: an
   `rmSync`, a second spawn, a server left unclosed. 🔴 That hazard is **not** confined to the
   `child-process` and `socket-binding` shapes — temp-tree state is the `tempFs` signal, which covers
   **270 converting files**, nearly all of them `plain-assert`
   (`packages/core/scripts/approval-judge-test.ts` ends in an `rmSync` and is one). Only **10** bind
   a socket. The report prints both sets; read what follows each assertion in them.
5. **Delete the counter** (`let passed = 0` / `let n = 0`) and the closing log. They exist because
   the script had no reporter; vitest is the reporter. 🔴 **Find the log by PRESENCE — a
   `console.log` in the last four non-blank lines (606 of 626) — never by its wording.** Matching
   `assertions passed` strands **82** files' logs and matching the `✓` glyph strands **139**; the
   counter goes either way, so a stranded log reads a deleted binding and reds `typecheck:all`. The
   report prints all seven rows. **20** files have no closing log at all: that is the residue, and
   the 5 with no counter are the other half of it.
6. **Leave `assert…` call sites alone.** `node:assert/strict` works inside a vitest test. Rewriting
   the 442 converting files' `assert.deepEqual` calls to `expect.soft(...).toEqual(...)` is a second,
   optional pass with its own risk; it is not part of this fold. Bullet 1 above says what that pass
   would buy — and what leaving it undone costs.

Steps 1–3, 5 and 6 are syntactic. **Step 4 is not**, and it is most of the work. Counted over the 673
files the fold converts — not over all 688, because a budget that includes files no slice ever opens
is not a budget: **191 are read-and-decide** (168 carry a `compare` helper whose rewrite is a
different matcher, 13 a `reversed` one, 10 no recognised helper; 11 of the 202 such files never
convert). The edge cases outside step 4, also over converting files only:

- **25 call `process.exit` more than once**, so a call survives the helper's deletion. Each becomes
  `throw new Error(...)` — unless it is one of the deliberate clean stops above. 🔴 Three more
  multi-exit files are `off-chain` and **keep their exits**: `sandbox-live-test.ts`,
  `agent-version-seam-bundle-test.ts` and
  `sandbox-docker-turn-live-test.ts` stay `tsx` scripts, where the exit IS the failure signal.
- **5 set `process.exitCode = 1`** instead of throwing. Same treatment.
- **1 carries a top-level `export`** (`scripts/sandbox-region-test.ts:129`, an `export interface`).
  `export` is illegal inside a function body, so the declaration cannot move into the callback —
  nothing imports it, so leave it at top level or drop the `export`.

### `child-process` (41 files) and `socket-binding` (6 files)

Same codemod. The spawn stays a spawn and the listener stays a listener; only the assertion helper
and the file shape change. One caution: a converted spec must close its server and reap its child.
`isolate: true` gives each file its own process, which dies with the file, so a leaked handle costs a
slow exit rather than a cross-file failure — but vitest warns on a hanging process, and the warning
is noise on every later run. Add an `afterAll` close to all **10 converting** files the `bindsSocket`
signal names, not only the 6 the shape column shows — the other 4 are `child-process` shape. The
signal names 11; the eleventh, `scripts/sandbox-docker-turn-live-test.ts`, is `off-chain` and stays a
`tsx` script, so no slice touches it.

### What cannot convert (15 files)

| files | why | what happens instead |
|---|---|---|
| **9** `subprocess-bound` | They build an import specifier with a substitution. vite rewrites that shape into a lookup over a glob it expands at TRANSFORM time, and a converted `.spec.ts` is transformed by the same vite. The failure differs by file: six build `` `../agent/tools/${name}.js` `` against `.ts` files on disk, so the map comes out empty; `worker-continuation-test.ts:43` and `e2e-driver-test.ts:167` substitute into a path under eve's built `dist`, which really is `.js`; `response-behaviour-scoring-test.ts:101` substitutes a query string, not a filename. The shape is what vite cannot transform, not the `.js`/`.ts` mismatch. | Stay `tsx` scripts, spawned by one surviving spec — what `runLegInSubprocess` does today. |
| **1** `subprocess-bound` — `scripts/memory-eval-fixture-test.ts` | 🔴 A **different** reason, and the one a slice author will get wrong: it has no variable dynamic import at all. It is named in `_legs.ts`'s `ROOT_SUBPROCESS_LEGS` because it respawns itself through `process.execArgv`, which carries tsx's loader flags only when `npx tsx` launched it. A vitest worker has no such flags. | Same — stays a `tsx` script. |
| 1 `indirect` — `packages/core/scripts/wake-origin-fixtures-test.ts` | A **frozen** stored-data compatibility oracle. Its header says it must never change, and the fold is a change. | Stays a `tsx` script. So does its boot wrapper, `scripts/wake-origin-fixtures-boot.ts`: that file is not named `*-test.ts`, so it is one of the **48 non-runner legs** stage 12 keeps, and `test:wake-origin-fixtures` keeps naming it. Converting the wrapper while the oracle stays would leave the leg pointing at a renamed file and red `lint:script-chain`. |
| 1 `off-chain` bundle test — `agent-version-seam-bundle-test.ts` | It runs in `postbuild`, inside the `build` `OE_PROOF` suite, and reads the just-built `.output/server/index.mjs`. Converting it would put vitest in the build path for no gain. | Stays a `tsx` script. |
| 2 `off-chain` live tests — `sandbox-live-test.ts`, `sandbox-docker-turn-live-test.ts` | Opt-in, credentialed, deliberately outside the deterministic tier. | Stay `tsx` scripts. |

The 10 subprocess-bound files are the reason a piece of `scripts/chain/` survives the fold: the spawn
helper, not the shard machinery.

---

## How `OE_PROOF` stays byte-exact

The evidence line is

```
OE_PROOF sha=<head> suite=<name> exit=<code>
```

and `<name>` is one of exactly four npm script names: `typecheck:all`, `test`, `build`,
`test:integration`. **No stage renames any of the four**, so the lines' text is invariant across the
whole fold by construction. `sha` is the run's own head and `exit` is the shell-captured code; the
fold touches neither.

Three ways a stage could still break the proof, and the rule that prevents each:

1. **A converted spec falling into the integration tier's glob.** `vitest.config.ts` includes
   `tests/integration/**/*.test.ts`. Work would move from `suite=test` to `suite=test:integration`
   silently, and both lines would still read `exit=0`.
   🔴 **Converted specs are named `*.spec.ts` and never live under `tests/integration/`.** The
   `.spec.ts` suffix cannot match that glob at all.
2. **A gate silently dropping out of the run.** A `test:<name>` deleted without its spec landing in
   the new glob, or — the far larger hazard — stage 12 deleting a `test-chain.txt` that still lists
   legs the fold never converted. `exit=0` still prints, over a `test` suite that no longer runs
   them. § Stage 12 is written around this; its checked precondition is the guard.
3. **`lint:script-chain` turning red on a half-edited chain.** Deleting `test:<name>` while that package's
   `test-chain.txt` still lists it fails the first leg of `npm test`. That is a correct red — `suite=test exit=1` —
   not a proof-format problem. It is listed so a slice does not misread it as flaky.

The one thing every stage must re-check before it emits its lines: `npm test` runs
`lint:script-chain`, then `lint:e2e-fixtures`, then the provider-discord echo, then `test:suites`.
All four stay in the `test` script for the whole fold.

---

## The per-slice mechanic

Converting one suite is four edits, and **deleting its npm script IS the hand-over**:

1. Rename `packages/core/scripts/approvals-test.ts` → `packages/core/scripts/approvals.spec.ts` and
   codemod the body.
2. Delete `"test:approvals": "NODE_NO_WARNINGS=1 tsx scripts/approvals-test.ts"` from
   `packages/core/package.json`.
3. Delete the `test:approvals` line from that package's `test-chain.txt` (OPE-2286).
4. Nothing else. `_legs.ts` derives the shard's work from `test-chain.txt`, so the shard stops running
   the suite the moment step 3 lands, and the new glob starts running the spec the moment step 1
   does. The two never overlap and never gap.

`coverage.spec.ts` stays green because the script is deleted, not orphaned. `lint:script-chain` stays
green because nothing else names it.

### The one config edit (stage 1, once)

`vitest.chain.config.ts` gains the converted specs' glob beside the shard glob:

```ts
include: [
  "scripts/**/*.spec.ts",                    // the shards, plus converted root specs
  "packages/*/scripts/**/*.spec.ts",         // core, adapters, create
  "packages/providers/*/scripts/**/*.spec.ts",
  "deploy/*/control/**/*.spec.ts",           // deploy/egress-proxy/control
],
```

Every other setting stays. `setupFiles: ["./scripts/chain/_setup.ts"]` in particular: converted specs
need the same `NODE_ENV` deletion and the same per-vitest-worker `OE_MEMORY_DIR` path. `_setup.ts` moves to
a stable home only at stage 12.

### The verify gate

A 99-file codemod diff cannot be read line by line, so it must be machine-checkable — the same bar
[`npm run tidy -- verify`](./tidy.md#the-verify-invariant) sets for the comment work. Stage 1 ships
`scripts/tidy/vitest-fold-verify.ts`, with one invariant per converted file:

1. **Assertion parity.** The count of assertion call sites in the pre-image equals the count in the
   post-image, both measured the way `test-runner-inventory.ts` measures them — over code with
   comments and string literals blanked. An assertion the codemod dropped is the failure mode this
   invariant exists to make impossible.
2. **No `process.exit` survives** in a converted spec. 🔴 **The check reads the code view, not the
   raw text.** **Nine** converting runners carry a `process.exit(` inside a string or a comment,
   where it is the thing under test rather than a call: `agents-codemod-test.ts`,
   `edit-reply-test.ts`, `grants-codemod-test.ts`, `verify-audit-chain-cli-test.ts`,
   `wake-arm-test.ts`, `webhook-declare-test.ts`, `packages/create/scripts/engine-test.ts:318`,
   `suite-lock-run-test.ts:122` and `write-if-changed-test.ts`. A textual check false-reds on all
   nine — and `engine-test.ts` lands in **stage 1**, so the gate meets this on its first run.
3. **The npm script is gone** and the package's `test-chain.txt` no longer names it.
4. **The spec is in the config's include glob**, resolved against the real config.

Run it with `--base <ref>` the way `tidy verify` runs, so it reads the pre-image from git.

🔴 **Parity counting cannot see an inverted rewrite.** A `reversed`-family helper rewritten by the
`boolean` rule yields `expect.soft("label", cond).toBe(true)` — same site count, and it passes for
every input. The gate does not catch it and no counting gate can. The 13 `reversed` files and the 175
`compare` files (168 of them converting) are read by hand, and each slice says in its report which of its files were in those
two sets.

### The RED demo each slice owes

Parity counting proves no assertion was dropped. It does not prove an assertion can still fail. So
each slice picks **one converted suite** — a `compare` or `reversed` one where the slice contains
any — breaks the code under test, watches the converted spec go red, restores from a copy, and
watches it go green. Copy the file aside first; `git checkout <file>` would discard the slice's own
uncommitted work.

---

## Slice order and size

Ordered smallest-blast-radius first, so the recipe is proven on 15 files before it touches 396. The
file counts sum to 673, which is the whole converting set — check that before stage 12. Each
stage is one run: codemod, verify gate, four suites, one RED demo.

| stage | scope | files | lines | package.json edits |
|---|---|---|---|---|
| **1** | The codemod, the verify gate, the config glob, and a pilot: `@open-everywhere/create` plain-assert (2) + `provider-teams` (13) | 15 | 4,916 | delete 15 `test:*`; empty `packages/providers/teams/test-chain.txt` (create keeps `test:cli`, deferred to stage 11) |
| **2** | `provider-github` (16) + `adapters` plain-assert (14) | 30 | 9,476 | delete 30 `test:*` |
| **3** | `provider-linear` (24) + `provider-notion` (28) | 52 | 17,650 | delete 52 `test:*` |
| **4** | `provider-slack` (34), **plus** the `process.cwd()` fix in `slack-web-api-seam-test.ts` | 34 | 13,706 | delete 34 `test:*` |
| **5** | `core` plain-assert, slice 1 of 5 (alphabetical by file) | 80 | 30,268 | delete 80 `test:*` |
| **6** | `core` plain-assert, slice 2 of 5 | 79 | 34,374 | delete 79 `test:*` |
| **7** | `core` plain-assert, slice 3 of 5 | 79 | 35,301 | delete 79 `test:*` |
| **8** | `core` plain-assert, slice 4 of 5 | 79 | 37,249 | delete 79 `test:*` |
| **9** | `core` plain-assert, slice 5 of 5 | 79 | 35,151 | delete 79 `test:*` |
| **10** | `<root>` plain-assert, including this page's own inventory suite | 99 | 38,593 | delete 99 `test:*` |
| **11** | The 41 `child-process` + 6 `socket-binding` files, all packages | 47 | 17,852 | delete 47 `test:*` |
| **12** | Teardown (below) | — | — | see below — **not** "delete every `test:chain`" |

**Stage 5 re-measures the A/B above** on the first large core slice and reports the number. If
file-per-suite has become slower than the shards at that scale, re-measure before changing anything,
and do not restore sharding without a number that justifies it. 🔴 **`maxWorkers` is not free head-
room.** `vitest.chain.config.ts` ⑤ pins it at 4 because the bound is MEMORY, not cores: each fork
imports the agent graph, and the shared build box has 7 GB. Raising it needs a memory measurement on that
box, not a wall-clock one — the same ceiling `OE_IT_CI_MAX_WORKERS` exists for in the integration
tier.

Split the five core slices alphabetically by file path, not by subsystem, into as-even parts —
`floor(n/5)` each with the remainder on the earliest slices. Alphabetical is reproducible from the
inventory and leaves no argument about which slice owns a file; a subsystem split would have to be
re-derived every stage. 🔴 **Re-derive the split, do not copy the row.** The core count moves
whenever `main` lands a core suite: it was 362 files as 73+73+72+72+72 a few merges ago and is 396 as
80+79+79+79+79 now. The rule is stable; the row is a snapshot.

### Stage 12 — teardown, and the 58 legs it must not drop

🔴 **The root `test-chain.txt` is not only a runner registry.** It lists **48 non-runner legs** — every
`lint:*`, `validate:config`, `lint:roster`, `lint:publish-exports`, `lint:invisible-bytes` and the
rest — that this fold never converts and that nothing else runs. Ten more legs are the
`subprocess-bound` runners, which stay `tsx` scripts. Deleting the chains would take all 58 out of
`npm test` while `OE_PROOF suite=test exit=0` kept printing: exactly the hazard § How `OE_PROOF`
stays byte-exact item 2 names.

So the teardown's precondition is **not** "zero `test-chain.txt` lists". It is: every leg that
remains on a `test-chain.txt` is either a non-runner gate or a `subprocess-bound` runner. Check it by running the
inventory script and confirming it reports zero `plain-assert`, `child-process` and `socket-binding`
files with a non-null `script`.

Then:

🔴 **KEEPING A `test:chain` IS NOT KEEPING AN EXECUTOR, AND THIS IS THE STEP THAT GETS IT WRONG.**
The root `test` script runs `lint:script-chain`, `lint:e2e-fixtures`, the provider-discord echo and
`test:suites` — it never runs `npm run test:chain`. The only thing that executes a chain leg is
`runShard`
(`_run-shard.ts:68`), called from the 20 shard specs. So deleting those specs while "keeping
the chain" leaves all 58 surviving legs — the 48 non-runner gates (`lint:invisible-bytes`,
`validate:config`, `lint:roster`, 45 more) and the 10 `subprocess-bound` runners — with nothing to
run them, and `npm test` then prints `suite=test exit=0` over a suite that no longer runs them.
That is § How `OE_PROOF` stays byte-exact item 2, exactly.

- **Keep, and NAME THE EXECUTOR**: one surviving spec, `scripts/suites/legs.spec.ts`, that walks
  every leg that each package's `test-chain.txt` still lists and runs each leg through `runLegInSubprocess` — which is
  `npm run <script>` in its own process. That one file is what keeps the 58 legs in `npm test`.
  It needs `_legs.ts` (to resolve the chain) and `runLegInSubprocess`; move both, plus `_setup.ts`,
  to `scripts/suites/`. Keep `lint:script-chain`, which proves those legs still resolve by name.
  Cost, stated: each of the 58 pays npm's own ~0.54 s spawn, so about 31 s serial — the tax OPE-703
  removed for 673 suites and this step re-accepts for 58, because nothing else can run a lint that
  was never a vitest spec.
- **Delete**: the 20 `shard-NN.spec.ts` files and `runLegInProcess` with its six hygiene items;
  `_process-state.ts`; `argv.spec.ts`. Re-home `sqlite-isolation.spec.ts`'s assertions before
  deleting the file — it pins `ensureShardMemoryDir`, which survives. Keep `coverage.spec.ts`,
  narrowed to the legs that remain.
- **Delete** the four workspace chains that end up empty — each `test-chain.txt` together with its
  `test:chain` script (`lint:script-chain` refuses one without the other) — and their `test` scripts
  with them: teams, github, slack and create. Four packages keep a chain, for two different reasons:
  core, notion and linear each keep a `subprocess-bound` runner (6, 1 and 1); **adapters keeps its
  chain even though every runner it owns converts**, because `coverage.spec.ts` requires a
  `test-chain.txt` from any workspace that defines a `test:*` script, and `test:sandbox-live` — the
  `OFF_CHAIN_BY_DESIGN` live pack — is still defined.
- **Rewrite**, do not annotate, the four places that then state a false rule:
  [`CONTRIBUTING.md`](../../CONTRIBUTING.md)'s "New behaviour needs a test" bullet, AGENTS.md's
  "Adding behaviour = adding a test" paragraph and its `test:suites` / `lint:script-chain` table
  rows, [`docs/extending/testing.md`](../extending/testing.md)'s tier rule, and
  [`docs/extending/provider-bundles.md`](../extending/provider-bundles.md)'s "on the bundle's own
  `test:chain`" clause. The new instruction is one line: add a `*.spec.ts` file beside the code;
  nothing else names it.
- **Delete this page's stage tables** and leave the shape inventory, or delete the page. It is a
  plan, and a finished plan is not documentation.

---

## Findings this inventory turned up, outside the fold

- **`coverage.spec.ts` guards the root package too** (OPE-1470). It walks `workspacePackages()`,
  which excludes the root, so a root `test:*` script that no chain named used to be unguarded. The
  root arm of the gate now reads the root chain's transitive closure (`rootChainScriptNames()`) and
  refuses any root `test:*` script that neither the chain reaches nor `OFF_CHAIN_BY_DESIGN`
  explains. Six are declared off-chain: `test:suites` (the batched runner itself),
  `test:integration` (its own tier),
  `test:e2e-driver` (an argument-taking passthrough), and three live packs — `test:pg-real`,
  `test:docker-smoke`, `test:docker-sandbox-stop-live`. A second assertion runs the other way: a
  script declared off-chain that the chain DOES reach is also a red, so the list cannot rot into a
  rubber stamp.
- **Two npm scripts may not name one runner file** (OPE-1471). `coverage.spec.ts` forbids a
  duplicate leg *name* and a leg in two shards — both key on `(package, script-name)`, so neither
  ever saw a duplicate *file*. `lint:script-chain` now refuses one, over the `test:*` and `lint:*`
  scripts, and it runs first. The scope stops there deliberately: four `--check`-vs-write driver
  pairs and one root passthrough legitimately share a file outside it. 737 runner files are each
  named by exactly one script today.
