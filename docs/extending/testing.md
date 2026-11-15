# Testing — which tier a new test belongs to

Open Everywhere has three test tiers. Each answers a different question, and the right tier for a
new test follows from what the test must prove.

| Tier | Runner | Cost | What it proves |
|---|---|---|---|
| **Script tests** (`npm test`) | `tsx scripts/<name>-test.ts`, plain assertions, non-zero exit | ~1–2 s per leg, run on a worker pool | One module's behaviour, driven directly. No booted host. |
| **Integration** (`npm run test:integration`) | vitest, `tests/integration/**` | ~20–60 s per file (a built agent boots in the fork) | A behaviour across the REAL host: real ingress, real session, real toolset assembly, real approval plane, real audit — with a scripted model, no inference, no credentials, no docker. |
| **Live e2e** (`e2e:driver` in `@open-everywhere/core`, `e2e:stack` at the root) | the core e2e pack against a deployment | minutes, real spend | The deployed instance, real vendors, real models. |

## Choose the tier

- **Default to a script test.** If the behaviour is one module's — a resolver, a gate, a codec —
  drive the module directly. It is the cheapest tier and the whole `npm test` chain stays fast.
- **Write an integration test when the claim spans seams.** The tell: the words "when the turn
  actually runs" appear in the claim. Toolset assembly, delegation, provenance carriage, approval-chain
  audit rows, the reply choke point — a script test can only fake the context around these, and a
  faked context is how a green suite hides a dead event handler. (The tier's first sample test
  found exactly that: a delegation hook listening on an event eve never delivers to hooks.)
- **Live e2e is for the deployment, not the code.** Vendor contracts, model behaviour, the deployed
  config. Do not reach for it to test logic — it is the most expensive and least deterministic tier.

## Beside the ladder: soak tests

A soak test is a long, model-judged run against a live deployment. Its
tooling is not in this repo. Its LLM verdicts never gate. A machinery defect it exposes comes
back as a script or integration test that does gate. The `soak.capture` setting and the
`/control/v1/session/<id>/model-calls` route it reads are product, and they ship here.

## Writing a script test

A script test is a plain `tsx` module. It does all its work at top level, asserts as it goes, and
exits non-zero on the first failure. Two steps put a new one on the gate:

1. Add `"test:<name>": "NODE_NO_WARNINGS=1 tsx scripts/<name>-test.ts"` to the package's
   `package.json`.
2. Append one line, `test:<name>`, to that package's `test-chain.txt` (beside its `package.json`).

That is all. `npm test` picks the suite up from `test-chain.txt` — no other list names it. Never edit
the `test:chain` script itself: it is a fixed command that runs `scripts/chain/run-chain.ts` over the
list.

**Why a list file (OPE-2286).** `test:chain` used to be one `&&` line that named every leg. Two
branches that each added a leg conflicted on that line, and each conflict cost a merge and a full
re-prove. Now each leg is one line, and `.gitattributes` gives every `test-chain.txt` the built-in
`merge=union` driver. When two branches each append a line at the same place, `git merge` keeps both
lines instead of a conflict. Union has two failure shapes, and a gate refuses each one:

- **A duplicate.** Two branches add the same leg at different places, and the merge keeps both
  lines. `lint:script-chain` refuses the duplicate before any suite runs. (The same line at the same
  place merges to one line.)
- **A leg that comes back.** One side deleted a leg, and the merge keeps it. `lint:script-chain`
  refuses it when its script is gone. When the script stays and the leg is declared off-chain, the
  `scripts/chain/coverage.spec.ts` parity arms refuse it inside `test:suites`.

**Driving the behaviour settings from a test.** `resetSettingsForTest()` drops the registered
overrides back to the shipped defaults, so a fresh test never inherits another's posture.
`overrideSettingsForTest(patch)` patches them mid-process, for a test that must hold one flag while
varying another. Both are bootstrap seams: runtime code always reads the resolved values through
`getSettings()`, and a test that reaches for the schema directly is reading a different store from the
one the running agent resolves through.

**How the tier runs.** Each package keeps its chain as `test-chain.txt`, and `npm run test:chain`
walks it serially, one `npm run` at a time, and stops at the first red. `npm test` does not: its
last leg, `test:suites`, hands every package's chain to ONE vitest run
(`vitest.chain.config.ts`, `scripts/chain/`) which spreads the ~360 workspace suites over a pool of
forked workers. Batching cut the deterministic gate from 619 s to 166 s (measured 2026-08-17,
OPE-703); most of what it removed was `npm run` process spawn, at ~0.54 s a leg.

The root package keeps its own `test-chain.txt` the same way (~90 legs — config lints, roster,
boot, deploy-ops, per-surface script tests). `npm test` used to walk those serially before ever
reaching `test:suites`; now `test:suites` batches them too, alongside the workspace legs, ~454
suites total (measured 2026-08-18, OPE-709). The root `test` script keeps only `lint:script-chain`
(the fail-fast resolver, which must run before the batched pool exists) and the provider-discord
`test --workspace` echo outside the batched pool — everything else routes through the root
`test-chain.txt`. A root-level script test joins the same way a workspace one does: add
`"test:<name>"` to the root `package.json`, then append one line, `test:<name>`, to the root
`test-chain.txt`.

**Every suite still runs alone.** `npm run test:<name> --workspace <pkg>` is unchanged, and it is
the right way to reproduce a red — the batched runner names each failure by package and script for
exactly that reason.

**Write the suite so it does not care what ran before it.** A shard runs many suites in one
process. The runner gives each one a fresh module registry, a clean `globalThis` registration
plane, its package as cwd, and a restored `process.env`. It does NOT undo a file the previous suite
wrote outside a temp dir, or a fixture it left in a shared database. A suite that passes alone and
fails in a shard has an order dependence — that is a real defect in the suite, not a batching
problem.

**Remove a temp dir that holds a store with `removeTempDir` (OPE-2212).** The SQLite stores keep
their database file open for the life of the process. Linux deletes an open file, but Windows does
not: a suite that points `OE_SQLITE_PATH` into its temp dir and then calls `rmSync` on that dir
fails with `EPERM` after its assertions pass. Call `await removeTempDir(dir)` from
`packages/core/scripts/_temp-dir.ts` instead. On Windows it closes each store handle that is open
inside `dir` and then removes `dir` with retries. On every other host it is the same `rmSync` call.
A root suite imports the same file. The adapters, GitHub and Teams packages carry their own copy in
`scripts/_temp-dir.ts`, because the boundary lock lets them reach core only through the
adapter-api barrel.

**Spawn npm, npx and tsx through `scripts/npm-command.ts` (OPE-2212).** On Windows `npm` and `npx`
are `.cmd` shims and `node_modules/.bin/tsx` is a shell script, and Node spawns neither without a
shell. `npmCommand`, `npxCommand` and `tsxCommand` return the plain command off Windows and the
tool's own JS entry, run with the current Node, on Windows.

**Grade a child's output only when the child finished (OPE-2509).** A child killed at its `timeout`,
by an OOM kill or by its `maxBuffer` leaves cut output. `tsx`, `npm` and `sh` relay the kill as exit
137 or 143 with no signal, so a `status ?? 1` fold hands the cut output to an "exits non-zero" assert,
and the next assert reports a missing row as a wrong answer. Read every spawn result through
`finishedRun(result, label)` from `scripts/npm-command.ts`: it returns the code and output of a run
that ended, and it throws `IncompleteChildRun`, with the output so far, for a run that did not. Pass
it a `spawnSync` result or the error an `execFileSync` threw. `test:npm-command` reds a chain leg that
still folds a missing exit code into a number. On the other side, a script that prints a report and
then exits on purpose exits through `exitAfterFlush` (`packages/core/scripts/exit-after-flush.ts`). A
bare `process.exit` drops every write the kernel buffer could not take yet, so a slow reader loses
the report's tail.

**Two root legs skip on Windows only (OPE-2287).** On native Windows a Node/libuv defect aborts a
spawned child at `process.exit` with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
src\win\async.c:94`. `test:deploy` and `test:egress-proxy-boot` spawn such children, so on win32
each leg prints a `⏭ SKIP` line that names the defect and the ticket, and then stops. On every other
platform both legs run and gate. `scripts/win32-exit-abort.ts` holds the predicate, and
`test:win32-exit-abort` proves that it answers `null` off win32 and that only these two legs call
it. No product exit path changed. Delete the skip when a fixed Node ships.

**And write it so it does not care what the HOST exported (OPE-1120).** A suite that reads an
environment variable it did not set answers to the machine, not to the code — green on a laptop, red
in a cloud sandbox, or the reverse. Two suites in this chain were doing exactly that: one asserted
the direct egress path while `resolveEgressRoute` read the ambient proxy variables, and one drove a
scenario body that read `E2E_UNIX_ARMED` at run time. Both cost a whole proof run in diagnosis
before anyone looked at the code.

`npm run lint:ambient-env` now gates that. For every name a chain-leg suite reads, one of three
things must hold: the name is one of the two reviewed pass-throughs (`PATH`, `NODE_OPTIONS`); or the
suite PINS it — a `process.env.X = …` or a `delete process.env.X` somewhere in the file, so the
value under test is the suite's own; or the (file, name) pair is declared in
`scripts/ambient-env-manifest.ts` with a reason. Reading `process.env` as a whole value is gated the
same way, though a SPREAD of it is exempt wherever it appears, because that is how a suite builds a
child process's environment. 🔴 `process.env.X ??= "…"` is a DEFAULT, not a pin: it keeps whatever
the host set, and the lint says so. Pin without ceremony — the runner restores the environment
around every leg, so a pin cannot reach a shard-mate.
`packages/core/scripts/host-egress-proxy-test.ts` is the model. To check one suite while you write
it: `npx tsx scripts/ambient-env-lint.ts --only <file>`.

The lint's own header names what it does not check — a conditional pin, a spread handed to the code
under test, a pass-through a suite branches on. Read it before you add a declaration.

**The shared database is per WORKER, not global (OPE-983).** `_setup.ts` gives every forked worker
its own `OE_MEMORY_DIR` before any leg runs, keyed on vitest's own worker id. A suite that leaves
both `OE_SQLITE_PATH` and `OE_MEMORY_DIR` unset still shares its sqlite file with the other suites
the SAME worker runs — the order-dependence risk above still applies — but never with a suite
running in one of the other three concurrent workers.

## Writing an integration test

Start from `tests/integration/tasks/child-binding-inheritance.test.ts` — it is the worked example — and
`tests/integration/harness.ts`, which owns boot and every seam. The short version:

- `await bootAgent()` boots the BUILT agent (`.output/server/index.mjs`) **in-process** in this
  test file's own forked process. A **separate prepare step** builds that target —
  `npm run test:integration:prepare` (`tests/integration/prepare.ts`) — and `npm run test:integration`
  runs it for you, once, before the first shard. It does four things: `oe:build`, `eve build`, the
  just-bash sandbox prewarm (`eve build` cannot mint that template, because backend selection happens
  at serve time, and a cold tree's turns die on `SandboxTemplateNotProvisionedError` without it) and
  the migrated PGlite template mint. `OE_IT_SKIP_BUILD=1` tells the step not to rebuild a tree that is
  already built, and it refuses loudly when an artefact is missing. `globalSetup` builds NOTHING since
  OPE-2235: it sweeps, hands the forks their environment and publishes the PGlite template. A bare
  `vitest run <file>` on a tree that was never prepared is refused by name, with the remedy.
- **There is ONE built target.** There used to be a second, `.output-rollown` — the same app with
  `delegation.nativeSubagent` disarmed — because that was the only way to reach OE's own roll-own
  delegation regime at this tier: half the disarm was a generated sentinel, which no runtime override
  can supply. That regime is deleted, so the second `eve build` and its sandbox prewarm are gone with
  it, and every test boots `.output`.
- **The model is a script.** `registerScript({ parent: [...], child: [...] })` says what the
  "model" does step by step — tool calls and terminal text — and records every request it
  receives: the tools offered (`tools`, names only, and `toolDefinitions`, the full offered shape
  with description and input schema), the prompt messages, the tool results. Assert on the INPUTS
  (what reached the model) before any outcome; a stubbed output cannot hide a degraded prompt
  from a recorded-request assertion. Read `toolDefinitions` when the claim is about the bytes a
  provider serializes — the prompt-prefix gate
  (`tests/integration/liveness/prompt-prefix-stability.test.ts`) compares it, because a re-worded
  description costs the prompt cache exactly as much as a new tool name does.
- 🔴 **A SEAT THAT FORWARDS ENDS ITS TURN, AND THE JOB'S RESULT IS A NEW TURN OF THE SEAT**
  (OPE-2338, OPE-2350). Every conversation seat forwards a job with `work`, and `work` returns a
  receipt at once, so the seat's dispatch turn ends there. The work session starts the worker with
  eve's `agent`. It needs no script: `agent/model/scripted-resolve.ts`'s `defaultWorkStepModel`
  serves its steps. The worker answers from the `child` arm of the dispatch script, which is
  registered under `ANY_SESSION`. The result comes back as a **result wake**: a new turn of the
  seat's own session, whose one trigger message has the id `work-result-<taskId>`. So a test arms the
  result-wake script on the SEAT's own session id with `armSettlement(dispatched, script)`, then
  waits for that turn with `consumeSettlement({ armed, dispatched, taskId, label })` or
  `awaitWorkResult`. `workTaskIdOfCall` reads the task id that the work session started for one
  `work` call, from the host's own `delegation.task_started` row. The measured sequence is in
  `tests/integration/harness.ts`'s delegation choreography seam.
- **Inside the work session, eve holds the turn open while its tasks work** (OPE-2248). eve holds the
  work session's turn at `turn.waiting` and calls the model again with each result, which arrives as
  a `task.result` message inside the same turn. So the step that reads a worker's output inside that
  turn is a LATER step of the same arm, and `awaitTaskResult({ handle, taskId, label })` waits for
  it. Write a task id that a step needs with the `TASK_FROM_RECEIPT` placeholder, because the whole
  arm is registered before the wake and eve mints the id at dispatch. A turn whose text is dropped
  is corrected only once it ENDS, which is after its tasks settle: release a held worker BEFORE you
  measure a correction.
- **A script belongs to ONE leg, and the harness enforces it.** A forwarded job settles on its own
  clock, so a leg's result wake — and the corrective re-drive behind it — can outlive the leg that
  dispatched the worker and land on the NEXT leg's script. The FOREIGN-WAKE FENCE
  (`agent/model/scripted-model.ts`) refuses that: a script registered under the wildcard key is never
  served a **call-bearing** step for a PARENT turn whose wake id a **different** registration already
  answered. Such a turn gets judged silence, spends no step, and is recorded as
  `RecordedRequest.foreignWakeSilence` — assert that field when you want to prove a straggler was
  absorbed. 🔴 **A test that MEANS to serve a later turn of an earlier wake registers on that
  SESSION's own id** — `registerScript(script, sessionId)`; the wildcard key is a catch-all, and a
  catch-all must not catch another leg's turn. A `say`-only step is exempt, because absorbing an
  unknown number of stragglers is exactly what a drain script
  (`SETTLEMENT_DRAIN_SCRIPT`) is for. **The signal is the `wake-id` on the LAST `<wake …>` envelope
  of the served prompt**, and that one fact is the whole of what the fence sees: a turn that renders
  no envelope of its own — the corrective re-drive, which re-stamps the original id — resolves the
  PREVIOUS leg's wake, while a turn with its own envelope resolves a fresh id that nothing owns. A
  result wake for a person's job is such a turn: the host mints a fresh wake id for it, so the fence
  does not catch it,
  and `armSettlement` keys its script on the seat's session id instead. A prompt with no envelope at
  all leaves the fence inert. Only a single-window
  unified session renders a `wake-id` at all, and on that path a leg-opening delivery is always
  judged, so a fresh leg can never be fenced. Why it matters: before
  the fence, a straggler took the next leg's `agent` call and the leg's own turn then found a spent
  script — which reads as a PRODUCT failure on whatever that leg was measuring, not as a harness
  red.
  `tests/integration/tasks/straggler-leg-isolation.test.ts` drives it, and
  `scripts/scripted-wake-ownership-test.ts` pins the rule offline.
- **The TIER BARRIER separates tests, and since OPE-2265 its quiet window is CONDITIONAL.**
  `harness.ts`'s `drainOutstandingSettlements` runs in the shared `afterEach`: it registers a closing
  drain and waits for the audit log to go quiet, so a result wake a test left behind is answered
  and closed before the next test registers anything. **It used to wait 1 500 ms after every test in a
  file that had booted.** Measured on a 4-core 13 680 MB cloud sandbox, on `main`, the
  whole tier at one worker: **265 barriers, 425.1 s, mean 1 604 ms each — and 245 of the 265 saw no
  settlement row at all.** That is **27.3 % of the tier's 1 558.9 s of test wall clock** spent on a
  window that almost never had anything to catch. **After the change, same box, same tier, at one
  worker: 291.2 s and 291.3 s over 270 barriers across two runs — 114 and 113 of the 270 on the short
  arm at a mean of ~300 ms, and 156 and 157 on the full arm at a mean of 1 637–1 647 ms, unchanged.**
  So the barrier's own cost fell 425.1 s → 291.2 s: **133.9 s, or 8.6 % of the BEFORE tier's
  1 558.9 s**, and that is this lever's own measured size.
  - ⚠️ **The tier wall fell further, and it must not be read as this lever.** One worker went
    1 558.9 s → **1 345.7 s / 1 341.9 s** (13.7 % / 13.9 %) — about 75 s more than the barrier
    produced. L4's shorter `turn.cancelled` branch accounts for at most 8 s of that, on one test and
    one fire; the rest is this box's run-to-run spread, measured **directly** at 41.5 s between two
    whole-tier pairs whose barrier cost and 79/191 split were identical. The BEFORE tier is a single
    run, so a tier-level delta cannot size a 134 s lever to better than that spread. OPE-2244's
    12–14 % estimate for this lever is neither confirmed nor refuted by it; **8.6 %** is what this
    change can claim.
  - ⚠️ **42 % of barriers shorten, not all of them.** A turn is OWED after 58 % of this tier's tests,
    because most of them end a turn in bare prose and the host re-drives that once. 🔴 **What the full
    window actually catches, counted over four whole-tier runs on this head** (two at one worker, two
    at four): of each run's ~157 full-arm barriers, **19, 18, 18 and 19** observed a settlement row
    land and extended past the window's floor; the other ~138 waited and saw nothing. Of the **453**
    short-arm barriers across those runs, **not one** saw a row. So the full arm earns its window
    about one time in eight, and shortening the rest would mean betting on OPE-2240's fence to absorb
    a re-drive instead of draining it, which is a different and larger change.
  - **What decides the window is a store read, not the fixture.** `barrierDispatchWitness` asks
    whether this test left a turn OWED to it, and reads the two mechanisms that leave a row at the
    DISPATCH, before the turn they owe can be served: `delegation.task_started` (a worker was
    dispatched, `hooks/delegation-settlement.ts`) and a `turn.supervisor_prose_dropped` row the turn had **not**
    already answered through the `reply` tool (a corrective re-drive is owed, `channels/unified.ts`,
    which AWAITS that append before it builds the re-injection). A test with neither waits **250 ms**;
    a test with either waits the full **1 500 ms**, unchanged. A settlement row arriving, or the
    witness firing on a later poll, restores the full window for the rest of that barrier.
  - ⚠️ **It is not an exhaustive read of the host's internal dispatches.** `channels/unified.ts`
    enumerates five: a task spawn, a completion wake, an approval-decision wake, the auto-redrive, and
    a routine fire. The completion wake is the task spawn's other edge, so three of the five are
    covered; the **approval-decision wake** and the **routine fire** leave no row this witness reads,
    and both are driven in this tier. What stands behind the short arm for those two is the loop's own
    poll: it watches `unified.task_wake`, `reply.no_reply` and `reply.post`, so a straggler of any
    class that has already written one of those restores the full window whatever the witness said.
    The residual is one shape — a straggler whose dispatch left no witness row **and** which has
    written no row of its own by the second poll. Over 453 short-arm barriers in four whole-tier runs,
    none has been measured. 🔴 **And for both classes there is more than a rate, though both arguments
    are about TODAY'S TIER rather than about the harness** — a new `schedules/` or `approvals/` file is
    what has to re-check them. **A routine fire is never scheduled here**: the tier runs no cron timer,
    so every fire is started synchronously by the test that calls `runRoutineDispatchTick()` or
    `runScheduleTask()`. A fire's own turn can still outlive that test, and then the two instruments
    apply. **An approval-decision wake has no onward barrier today**: `approvals/decision-wake.test.ts`
    holds two tests, the first being the control that writes no wake row, and the one that wakes the
    window is the file's last.
  - 🔴 **It still takes TWO readings of a quiet store.** The short window is one poll interval, never
    zero: the loop polls, finds nothing, sleeps, polls again, and only then returns. One reading
    cannot tell "nothing was dispatched" from "nothing has landed yet", which is the distinction the
    window exists for, and an exit on the first empty poll would reopen OPE-1982's bleed.
  - 🔴 **The floor cursor HOLDS while a delegation is still open**, and that is a correctness rule
    rather than a cost one. The witness reads the slice since the previous barrier's own cursor. If
    that cursor advanced unconditionally, a test that dispatched a worker which has not settled would
    hand the NEXT barrier an empty slice — "not owed" — and the next barrier would shorten over a
    result wake that is still owed. So the advance waits until a `delegation.task_settled` or
    `delegation.task_failed` row **naming that same task id** joins the spawn row. A dispatch a test
    abandons pins the floor for the rest of the file, and every later barrier then pays the full
    window. 🔴 **The join is on the id and never on a count.** `opened > closed` looks conservative
    and is not: a FAILED settlement writes both close rows for one task, the `result` failure edge
    writes one naming no task at all, and an unmatched close arrives whenever a spawn sits below the
    floor — each inflation would release the floor over an open dispatch. `bootAgent` seeds the floor
    from its own cursor read for the same reason: a worker the fork's FIRST test dispatches has to sit
    inside the first barrier's slice. ⚠️ Two bounds on the pin: it releases one barrier late (the
    witness is not re-read on the full arm), and a pinned slice past ~1 000 delegation rows loses its
    oldest rows off the read's page.
  - **The fail-closed directions are all the slow ones.** No floor cursor yet (a fork's first
    barrier), an unreadable store, an open delegation, a drop the host refused, a drop with no
    continuation token, and a drop row with no `replied` field at all — which is live, not
    hypothetical: `channels/supervisor-complete.ts` writes that action for a ticketing surface with no
    such field and no re-drive to owe. Every one of them answers "owed" and pays the full window.
  - **The witness takes TWO reads, one per row family.** The audit route serves one page ordered
    newest-first, so a single read could hide the one `delegation.task_started` row behind a page of
    benign drop rows — the one fail-OPEN direction the function would otherwise have.
  - **`liveness/settlement-barrier-window.test.ts` pins both arms** — the short window after a test
    that dispatched nothing, and the full window after one that dispatched a worker. It reads
    `lastBarrierSpend()`, and because the barrier runs BETWEEN tests the assertion for a given test's
    barrier lives in the test AFTER it.
  - **`OE_IT_BARRIER_TRACE=1` prints one line per barrier** — `ms`, `polls`, `rows`, `dispatched`,
    `window` and the test name — so a before/after per-test cost is two env vars and a `grep`. It is
    off by default: one line per test is about 270 lines a tier, in a log whose reader is hunting a
    failure.
- **A script step can also hold the call open and report its own token counts.**
  `{ delayMs }` keeps one MODEL CALL in flight, which is one of the two ways a turn lives long enough
  for a test to CANCEL it (`tests/integration/liveness/turn-cancel.test.ts`). The other is an `async`
  `wrapToolExecute` stub that holds a TOOL EXECUTION open
  (`tests/integration/liveness/turn-cancel-tool-hold.test.ts`); use that one when the claim is about
  the step the cancel ABORTS, because a step held at its model call has run no tools.
  🔴 **A cancel does not shorten a `delayMs` hold — call `handle.releaseHolds()` as soon as the hold
  has done its job.** A cancel does not end the hold, so the hold is a timer the fork pays in full.
  🔴 **A cancel test sets `holdUntilCancelled: true` on the held step (OPE-2310).** On eve 0.71 a stop
  reaches the active turn as an in-process abort, and the turn reads it only when the held call
  returns. A release on the `turn.cancel_requested` row alone can let the call return first, and the
  turn then completes instead of cancelling. With `holdUntilCancelled`, the release does not end the
  hold until eve has aborted that model call. eve passes the abort signal to the model call, and the
  scripted model reads it off the call options. Assert `handle.holdsCancelDelivered()` is 1 beside
  `holdsCutShort()`. `tests/integration/turn-cancel-barrier.test.ts` pins the barrier without a
  boot. (On `main`, eve 0.54.3, the barrier is OPE-2281's `waitForTurnCancelDelivered`, which reads
  a turn-control hook token that eve 0.71 does not write.)
  **A turn that fails for good: `failsForGood: true` on a step (OPE-2632).** The model call throws an
  error with HTTP status 400, which eve classifies `terminal`. eve then emits `turn.failed` and
  `session.failed`, and the session does not park. A retryable failure parks instead, so a test of
  what a person sees on a dead turn needs this flag (`tests/integration/channels/slack-agent-session.test.ts`).
  🔴 **A turn that ends in prose with no `reply` call owes a corrective re-drive.** Before the next
  turn in the same session, call `awaitProseRedriveSettled(cursor, label)` with the turn's handle
  still registered, then dispose it. `awaitWindowQuiet()` alone is a bounded quiet window, and at 6
  workers a re-drive outlived it and reached the next turn's script (OPE-2281).
  `delayMs` is then only the BACKSTOP that bounds a missed release. Assert
  `handle.holdsCutShort()` so a release that stops crossing the seam fails the test instead of
  quietly restoring the full wait (OPE-1029: two files paid 116 s of dead timer on every CI run).
  `{ usage: { inputTokens } }`
  replaces eve's estimate, which is how a test reaches eve's session-token bound and drives the park
  remedy (`tests/integration/liveness/session-park.test.ts`). Keep a reported `inputTokens` **under
  the per-prompt compaction threshold** (`agent.compactionThresholdPercent` × the primary window):
  eve runs compaction BEFORE the session-limit check in the same loop pass, and compaction fails the
  turn on this build (OPE-670).
- **Every ingress route has a signed-delivery rung at this tier** (OPE-774): the signed Discord
  relay wake (`discordMentionWake`), the signed Slack interactivity POST
  (`slackInteractivityPost`), the Ed25519-signed Discord interactions front
  (`discordOeCommandPost` — the only route that reaches `/oe` commands), the signed Slack MESSAGE
  EVENT (`slackMessageEventPost` — the CHANNEL family, `channel_type: "channel"`), the signed Slack
  DM-family event (`slackDmWake` — `im` / `mpim`, the only route that lands a binding whose `mode`
  is `dm`), the signed Notion
  webhook (`notionCommentEventPost`), the declared-webhook HMAC (`webhookDeliveryPost`), the signed
  GitHub App installation delivery (`githubInstallationPost`), the signed Linear agent-session
  delivery (`linearAgentSessionPost`), and the RS256-signed Teams Bot Framework Activity
  (`teamsActivityPost`, verified against a fork-owned JWKS host — `installTeamsJwksStub`). Each
  proves a signed delivery is accepted AND produces its own audit row, and a tampered/unsigned twin
  is refused with none — see each helper's own header in `tests/integration/harness.ts` for the
  ONE mechanism it drives (a route that serves and refuses is not the same claim as a verifier
  wired to a real consequence). The Discord/Slack keys mint per fork and publish only when the test
  has not already published its own — `approval-click.test.ts` and `decision-wake.test.ts` do, at
  module load, and the harness must not clobber them.
- **A Slack wake needs the Slack Web API stub in front of it.** `slackMessageEventPost` alone drives
  nothing: the name-drop route makes four live Slack reads (`auth.test`, `users.info`,
  `conversations.info`, `conversations.history`) before it wakes anything, and every one of them
  fails soft. So a test that forgets `installSlackWebApiStub` (`tests/integration/slack-web-api.ts`)
  reads as a silent no-wake, not as an error. `slackDmWake` needs the same stub for a different
  reason: a 1:1 reads its trust tier from the DM PARTNER (`users.info`), which fails CLOSED, so a
  missing stub does not drop the wake — it downgrades the turn to the fenced tier in silence. The stub also owns `SLACK_BOT_TOKEN`: it publishes the
  token on install and removes it on uninstall, so no test can reach the real Slack API by accident.
- **The ✋ stop-hand glyph needs the Discord REST stub in front of it, over Discord.**
  `setSurfaceReaction`'s Discord arm needs a `DISCORD_BOT_TOKEN` no test publishes by default, so
  the call throws, fail-softs to `false`, and `placeStopHand` un-marks itself — `handPlaced` reads
  false for every turn without `installDiscordWebApiStub` (`tests/integration/discord-web-api.ts`,
  the same `globalThis.fetch`-patch shape `installSlackWebApiStub` gives Slack, scoped to the
  reaction PUT/DELETE endpoint only). The worked example is
  `tests/integration/liveness/turn-delegation-glyph.test.ts`: it dispatches a real native delegation
  from the scripted model's `parent` arm and answers the worker on its `child` arm — no `execute` to
  swap, and no real network — then reads the ✋ add and remove off the stub's own call log.
  **That leg also turns the tier's egress spoof OFF, and a glyph test must.** `bootAgent` arms
  the `egress-spoof` test valve (`packages/core/agent/testing/test-valves.ts`) for the whole tier, and `setSurfaceReaction` asks `swallowRoomOp` before it
  builds any request: armed, it returns `true` without calling Discord, so the product behaves
  correctly and the stub's log stays empty.
- **Only three things cross into the booted agent**: `process.env`, `globalThis`, and HTTP. The
  bundle inlines core, so a core function whose state is module-scoped does NOT cross from your
  test imports into the running agent. The seams the harness exposes all ride the shared
  process-registry (`overrideSettingsForTest`, `registerApprovalJudgeCompletion`, the scripted
  model store) or `globalThis` (`wrapToolExecute`, and `installSlackWebApiStub`/
  `installDiscordWebApiStub`, which patch `globalThis.fetch` — eve's Slack client and OE's own
  Discord provider both resolve a bare `fetch` at call time, so that patch is the only seam that
  reaches a vendor API call at all).
- **A fork's port is never free before its agent binds it (OPE-498, OPE-2555).** The harness asks the
  OS for an ephemeral port and holds the socket open (`scripts/ephemeral-port.ts`). It does not
  release that socket before the bundle import. `bindListenerOnReservation` hands the bound socket
  to the bundle's own `listen` call, so a sibling fork's `listen(0)` cannot take the port during the
  bundle load. A bundle that stops calling `Server#listen` with the given `PORT` fails the boot by
  name. `assertOwnHost` stays as the backstop: a host that refuses the fork's control read token
  fails the boot. The prepare step's prewarm import uses the same handoff.
- **The fork host never closes an idle keep-alive socket; the client does (OPE-2586).** The test's
  `fetch` and the booted agent share one event loop. A synchronous stall past the server's idle
  window (5 s, plus a 1 s buffer on Node 24) let the server close a socket that undici had just
  reused, and a random spec read `fetch failed — read ECONNRESET`. `bootAgent` sets the adopted
  listener's `keepAliveTimeout` to 0 (`tests/integration/fork-host-keepalive.ts`), so undici alone
  closes an idle socket. There is no retry: a 5xx still reaches the caller as a 5xx, and a real
  reset still fails the `fetch`.
  `scripts/fork-host-keepalive-test.ts` reproduces the reset and holds both negative legs.
- **Every file is its own process** (`pool: "forks"`), with its own PGlite dir, and files run in
  PARALLEL (`fileParallelism: true`). The worker count is **not** a fixed pin:
  `scripts/ci-max-workers.ts` reads `OE_IT_CI_MAX_WORKERS` when it is set; otherwise a process a
  memory cgroup caps below the machine's RAM derives what that cap and the box's CORES fit —
  `min(floor(cores × 1.5), floor((cap − 3 072 MB reserve − 1 280 MB base) / 450 MB per worker))`,
  never below 1 — and then takes the **lower** of that and `HARNESS_CONCURRENCY_CEILING`. A box under
  no cap keeps **2**. 🔴 **That ceiling is 6 today, and it is not a memory number** — it was **1**
  while the OPE-2197 turn/script race was open, OPE-2265 raised it to 4 once OPE-2240's foreign-wake
  fence had closed that race's call-bearing half, and OPE-2281 raised it to 6 once the re-drive and
  cancel-delivery barriers were in (3 of 3 whole-tier runs green at 6 and at 4; 6 was 10.4 % faster).
  Those runs were on eve 0.54.3. On eve 0.71 the cancel-delivery barrier does not apply, and 6
  workers is not yet measured on eve 0.71.
  See the next bullet and `scripts/ci-max-workers.ts` for the measurements. So the measured 4-core
  sandbox now schedules **SIX** workers: a fork is not CPU-bound for its whole life, so the cores
  count at 1.5 workers each (`CORE_OVERSUBSCRIPTION`, measured on that box only). The ceiling still
  binds on a box with more than four cores. A booted agent host per worker is
  what makes this a memory decision, and the measurements behind it are these.
  - **Why a capped box answered 1 until OPE-2229** (OPE-1369): two hosts charged **~10.8 GB
    anon-rss**; inside a cloud sandbox's **~13.3 GiB** memory cgroup the charge went past the limit,
    the kernel killed the run, and vitest printed **no verdict at all**. Do not read an arithmetic
    relation between those numbers: a memcg charges more than anon-rss, and an uncapped box reclaims
    rather than being killed. `scripts/suite-lock-run.ts` names such a kill by its exit code (137)
    so it can never read as a product red.
  - **Why MEMORY AND CORES now answer 4 there** (OPE-2229, measured 2026-10-01 on OPE-2227's A/B) —
    while the tier still **schedules 1**, per the harness-ceiling bullet below. That `1` was
    right for the config it was measured on. The old runner config pulled the built
    `.output/server/index.mjs` bundle through a vite transform in the MAIN process, once per file,
    and ONE worker already peaked at **7 858 MB of 13 680 MB (57 %)** — so a second projected to
    ~12.9 GB, at the limit. The tier now loads the built artefacts natively (`server.deps.external`)
    and caps each fork's V8 old space, which moves the whole shape: **main process 3 421 → 589 MB**,
    **vite `transform` 51.9 → 2.1 s**, **cgroup peak 7 858 → 4 175 MB** at one worker, and
    **5 833 MB of 13 680 at four workers with no OOM**. ⚠️ The arms ran **12 of the tier's files**
    and changed no VERDICT on those 12 — two shell-fence tests in `memory.test.ts` failed in EVERY
    arm, the baseline included, because the arms bypass `suite-lock-run.ts` and so never drop
    `CAP_DAC_OVERRIDE`. "No test broken" is a claim about 12 files, not about the tier; the tier's
    own verdict is OPE-2229's `test:integration` gate run. The per-worker cost is **FITTED** from
    the only two arms that hold the file count constant (1 worker and 4 workers, both at 12 files):
    **≈ 441 MB of anon per added worker over a ~1 280 MB base**, rounded to 450 and 1 280, which is
    where the arithmetic above comes from. 🔴 Those are fitted parameters, not predictions: a
    two-parameter line through two points reproduces both by construction, and no arm ran a worker
    count other than 1 or 4. A one-worker arm at 6 files charged 1 359 MB against 1 718 MB at 12, so
    the "base" is not independent of the file list either. 🔴 **Memory stopped being the binding constraint; the CORES became it.** Four
    workers returned only **2.44×** on 12 files (225.4 s → 92.4 s) on a 4-core box, so the count is
    capped by the cores — one worker per core then, 1.5 per core since OPE-2281 (`CORE_OVERSUBSCRIPTION`) — even though the memory model would allow about twenty. (The A/B's
    own extrapolation stopped at eight workers, ≈7.6 GB — a measured projection rather than this
    model's answer, and the two are different kinds of number.)
  - **The 3 072 MB reserve is absolute, not a fraction of the cap.** What it covers is absolute:
    cgroup `file` (page cache) sat at **2 287–2 543 MB in every arm including the baseline**, plus
    the spike a 2-second sampler cannot see. A proportional margin would under-reserve exactly where
    the risk is worst — a small cgroup. So a 4 GB cgroup still answers **1**, which is the serial
    behaviour every capped box had before this change. ⚠️ The reserve does **not** cover a RAM-backed
    `os.tmpdir()`: the A/B falsified tmp-as-cgroup-memory for that sandbox only (`/tmp` was ext4 and
    cgroup `shmem` was 0 in every sample). Where `/tmp` is tmpfs the harness's per-fork state dirs
    become cgroup shmem, and `OE_IT_CI_MAX_WORKERS=<n>` is the answer.
  - **The 7 GB shared build box keeps its 2.** It runs the suites directly, under no memory cgroup of its
    own, so the cgroup read answers `undefined` — measured on that box, 2026-09-02 (OPE-1401).
    OPE-2229 measured a 4-core 13.7 GB sandbox and does not move that pin. A local raise past 2 is
    what crashed the box at 8 concurrent subagents (OPE-1095).
  - 🔴 **The raise and the three settings are one change, and one suite holds them together.**
    `scripts/it-memory-config-test.ts` asserts the heap cap, the native load and the console setting
    beside the worker count, because a diff that drops a setting and leaves the count would red
    nothing — it would make the tier die silently at a count it can no longer afford.
- 🔴 **THE WORKER COUNT IS CAPPED BY THE HARNESS, NOT BY MEMORY (OPE-2229, measured 2026-10-03).**
  OPE-2229 set out to run 4 workers per sandbox and the memory analysis behind it is sound — 4
  workers peak at 4.3–4.6 GB of 13 680 MB with no OOM. It is not memory that stops it. More than one
  concurrent agent host widens the OPE-2197 / OPE-2174 window where one leg's settlement turn is
  served the NEXT leg's scripted-model entry, so the next leg measures the earlier leg's turn and
  correct product code reports a red. Measured on shard 1 of the tier, the same 28 files every run,
  build reused, worker count the only variable:

  | config | workers | runs | red | wall (a green run) | peak tree RSS |
  |---|---|---|---|---|---|
  | clean `main` | 1 | 2 | 0 | 849.8 s / 823.5 s | 6.3 / 6.0 GB |
  | this config | 1 | 1 | 0 | **543.2 s** | **1.8 GB** |
  | this config | 2 | 2 | 1 | 287.8 s | 2.5 GB |
  | this config | 3 | 2 | 1 | 210.2 s | 3.4 GB |
  | this config | 4 | 2 | **2** | — | 4.6 GB |

  Three files red: `tasks/worker-admin-standing.test.ts`,
  `tasks/teams-turn-two-delegation-continuity.test.ts` and
  `tasks/scripted-model-redrive-silence.test.ts`. 🔴 **What identifies ONE race is the shared
  mechanism, not the count of files** — three different files reddening is equally consistent with
  three independent timing-sensitive tests. The evidence is that all three sequence SEVERAL LEGS OR
  TURNS ON ONE STANDING SEAT INSIDE ONE FORK, all three separate those legs only with the bounded
  `awaitWindowQuiet()` barrier, and each already carries its own OPE-1982 / OPE-2197 note naming this
  bleed. `drainDelegation` calls that barrier "a BOUNDED GRACE PERIOD, never a measurement", and CPU
  contention from several forks on 4 cores defeats the bound. Forks are separate processes, so the
  worker count changes the interleaving's TIMING, never its set — which is why OPE-2197's own
  reproduction is "1 red in 12 single-file runs under CPU load". Every count above 1 red at least once, so there is no
  larger green count to fall back to, and clean `main` is green at 1 worker, so this is not a
  pre-existing serial flake. ⚠️ At one or two runs per setting the table cannot rank 2 against 3 and
  does not prove 1 is immune; it supports two claims only — 4 reds reliably, and nothing above 1 was
  green every time. **What the ceiling does NOT cost:** the three settings pay at ONE worker, against
  clean `main` at the same worker count on the same files — **837 s** (the mean of two runs, 849.8 s
  and 823.5 s) **→ 543 s** (one run), and **6.15 GB** (the mean of 6.3 and 6.0) **→ 1.8 GB**. That is
  ~1.5× wall clock and ~3.4× memory with no concurrency at all. Only the further **1.9×** (2 workers)
  to **2.6×** (3 workers) from parallelism is withheld — both measured against this config's own
  543.2 s, not against `main`.
  - 🔴 **THE CEILING WAS RAISED TO 4 BY OPE-2265** (6 since OPE-2281, above) — raised here, against this bullet's own re-measurement,
    and never on the memory numbers alone, which is the inference OPE-2229 got wrong. Two things
    closed the mechanism above. **OPE-2240's foreign-wake fence** (the bullet above) refuses to serve
    a wildcard script a call-bearing step for a parent turn whose wake a different registration
    already answered, which is the bleed all three red files tripped; it measured the full tier green
    twice at 4 workers through `OE_IT_CI_MAX_WORKERS=4` (980.9 s / 1002.7 s against 2321.0 s /
    2286.7 s at one worker, peak tree RSS 6.9 GB). **OPE-2265's conditional barrier** shortens the
    window only where nothing is owed, so the guard those three files lean on is untouched — every
    between-leg `awaitWindowQuiet()` call in them still pays the full 1 500 ms, because each leg
    dispatches a worker inside its own slice of the audit log.
    **Measured 2026-10-03 on the raising head, the WHOLE tier** (120 files, 277 tests, 4 sequential
    one-process shards) on the same 4-core 13 680 MB sandbox. Wall is the sum of the four shards' own
    wall clocks; the build is the prepare step's and sits outside them:

    | run | workers | shell exit | wall (sum of the 4 shards) | peak tree RSS |
    |---|---|---|---|---|
    | ① | 1 (`OE_IT_CI_MAX_WORKERS=1`) | 0 | 1 345.7 s | 1.5 GB |
    | ② | 1 (`OE_IT_CI_MAX_WORKERS=1`) | 0 | 1 341.9 s | 1.5 GB |
    | ③ | 4 (`OE_IT_CI_MAX_WORKERS=4`) | 0 | 429.1 s | 3.8 GB |
    | ④ | 4 (**the default**, no override) | 0 | 427.0 s | 3.9 GB |

    277 tests passed in all four and no shard exited non-zero in any of them. Four workers return
    **3.14×** on the whole tier and peak at **3.9 GB of 13 680 MB** — 29 %, against 1.5 GB at one
    worker. Run ④ is the one that licenses the constant: it took its count from
    `integrationMaxWorkers()` with no override at all.
  - ⚠️ **What the OPE-2265 runs do not establish.** Four green runs across two heads are **not a rate** —
    OPE-2197's own reproduction was "1 red in 12 single-file runs under CPU load". They say nothing
    about 2 or 3 workers, nothing about a box with more than 4 cores, and nothing about a tier that
    grows new multi-leg files. 🔴 **What makes the raise reversible** is that `suite-lock-run.ts`
    prints `workers=<n>` on every tier line and `OE_IT_CI_MAX_WORKERS=1` outranks the constant: a red
    that goes away at one worker and returns above one is the ceiling's, not the product's. Lower it in
    `ci-max-workers.ts`, against a re-measurement, exactly as the raise was made.
- **The tier SHARDS by default in a sandbox** (OPE-1814). One worker was not enough on its own: a
  single vitest PROCESS grew past the cgroup over the whole tier whatever its worker count — one run
  measured `exit=137` twice on one head, the second time alone at `OE_IT_CI_MAX_WORKERS=1`, and four
  `--shard=k/4` passes at one worker recovered it. 🔴 **OPE-2229 removed that per-file growth and the
  shards stay anyway**: the growth was the main process re-transforming the built bundle per file, and
  the A/B measured that process flat against the file count. Three things still pay for the split —
  the shard boundary is the only place a vitest process DIES, so it bounds any retention the A/B
  could not measure (the arms ran 12 files, never 112); the per-shard peak-RSS series is how a leak
  is told apart from a merely large tier; and no shard pays the build at all — the prepare step pays
  it once, before the first shard (OPE-2235).
  `scripts/it-shards.ts` reads `OE_IT_SHARDS`; with no value it plans **one shard per 32 test files,
  never fewer than 4**, when
  `CI` is set or a memory cgroup caps this process, and **1** otherwise. Set `OE_IT_SHARDS=1` to
  force the single process back. The shards run sequentially, the tier's exit code is the WORST of
  them, and `suite-lock-run.ts` prints ONE `OE_PROOF … suite=test:integration exit=<code>` line
  after the last shard — the line the lander and `deploy:cloud-proof-verify` already
  read. Each shard also reports its peak process-tree RSS and its wall clock, which is how a
  per-file leak (a fixture that never closes an eve session or a store) is told apart from a merely
  large tier. 🔴 A **targeted** leg (`npm run test:integration -- <file>`) is never sharded and
  never prints that line: it is not the tier, and a line claiming one nobody ran is what the lander
  believes.
- **Run a LIST of spec files in ONE invocation, not a serial loop** (OPE-2345). Give every file as a
  vitest file argument: `npm run test:integration -- tests/integration/a.test.ts tests/integration/b.test.ts …`.
  The wrapper runs the prepare step once, then ONE vitest process for the whole list, at the tier's
  worker count (`integrationMaxWorkers()`, the same value the tier lines print as `workers=`). A serial
  loop of N single-file legs pays N prepare steps and N vitest start-ups, and runs one file at a time. Four
  rules apply. (1) Give the full repository-relative path: vitest reads each argument as a SUBSTRING
  filter, so `memory` alone selects every file whose path holds that word. (2) Keep one list to at most
  32 files (`SANDBOX_FILES_PER_SHARD`, the per-process count the tier's own shards are sized to), and
  split a longer list across invocations. A list is one process and the wrapper does not shard it. (3) Do
  not set `OE_IT_SHARD`: a list is a targeted leg, so the wrapper exits 2 and runs nothing. (4) A list
  prints no `OE_PROOF` line, because it is not the tier. Set `OE_IT_CI_MAX_WORKERS=1` only to bisect a
  red that you suspect is the worker count's.
- **One shard per sandbox, for a fan-out** (OPE-2282). `OE_IT_SHARD=k/N npm run test:integration`
  runs the prepare step, then ONLY shard k of N, and prints ONE line that names the shard:
  `OE_PROOF sha=<head> suite=test:integration--shard=k/N exit=<code>`. The run is the same
  `--shard=k/N` pass the full series runs at position k, so N fanned runs schedule the same files as
  one sequential run. The split reads only the tier's file list and the tracked timings file (next
  item). So one sha plans one split in every CLEAN sandbox: the list is the working tree's, and a
  stray untracked `*.test.ts` changes it. Each run logs the file count and a digest of the list;
  nothing compares the digests across runs yet.
  `npm run test:suite-lock` proves that N single-shard plans cover every tier file exactly once, and
  checks `shardFiles` against the sequencer vitest really runs.
- **The shards are balanced by measured duration, not by file count** (OPE-2344). vitest's own
  `--shard=k/N` cuts N runs of equal FILE COUNT, ordered by a sha1 of each path. One file's cost is
  not another's: on `eve-0.69` (121 files, 6 workers) shard 1 walled 368 s against 78–154 s for the
  other three, and the slowest shard sets the fan-out's proof time. `vitest.config.ts` now installs
  `DurationShardSequencer` (`scripts/it-shard-sequencer.ts`). Its `shard()` calls `balanceShards`
  (`scripts/it-shards.ts`): the longest file first, each into the least-loaded shard. The weights
  come from the checked-in `scripts/it-timings.json`, in wall milliseconds per file. A file with no
  entry weighs the median of the tier's measured files. Ties break on the path, then on the shard
  with fewer files, then on the lower index, so the split is deterministic for one file list and one
  timings file. The argv, the shard names and every log line stay `--shard=k/N`.
  🔴 Balance cannot beat one slow file. A shard's wall is at least its slowest file, so a spec that
  waits out `harness.ts`'s 360 s `waitFor` holds its shard at about 360 s however the rest is split.
  `eve-0.69`'s shard 1 fits that shape, but no run has proved it: 368 s is the 360 s ceiling plus
  about 8 s, both `own-account-rest-road` and `cancel-note-prefix-stability` hash into that shard
  there, and the same two files pass in 16 s and 12 s on `main`. Fix a red spec; do not re-split
  around it.
  **Regenerate the timings** after the tier changes shape. Run each shard with the JSON reporter
  beside the default one, one report file per shard, then merge them:

  ```sh
  OE_IT_SHARD=1/4 npm run test:integration -- --reporter=default --reporter=json --outputFile.json=/tmp/it-1.json
  # …the same for 2/4, 3/4 and 4/4…
  npm run integration:timings -- /tmp/it-1.json /tmp/it-2.json /tmp/it-3.json /tmp/it-4.json
  ```

  A file's duration is `endTime - startTime` in the report: from the first test's start to the last
  test's end. It does not hold the import, collection, `setupFiles` or `beforeAll`/`afterAll`. A file
  whose `beforeAll` fails measures about 0 ms, so the script refuses a report entry with status
  `failed`: regenerate from green runs only. A file in two reports takes the longest. An entry for a tier file that no report measured stays, so one shard's report
  refreshes one shard's files. An entry for a file outside the tier is dropped. A new spec needs no
  regeneration to run: it weighs the median until the next one. Only a COMPLETE, all-green series on one sha
  proves the tier: `deploy:cloud-proof-verify` refuses a partial series, two Ns, or two shas, and a
  red shard is a `fail` (see [the cloud-proof lane](../deploy/cloud-proof.md)). A bad value, a
  targeted leg, or an `OE_IT_SHARDS` that names another N exits 2 and runs nothing. With
  `OE_IT_SHARD` unset the tier runs as before, and its output does not change.
- **The shard count follows the tier's file count, and no shard builds** (OPE-2050, OPE-2235). A pinned
  count sizes the split against the tier the pin was written for, so the memory margin erodes as the
  tier grows. It did: `SANDBOX_SHARDS = 4` was set at ~85 files and ran at 110, where two of the
  four shards were SIGKILLed — peaks **7.5 / 6.1 / 9.2 / 9.3 GB** on a 16 GB box, on a split that
  had passed six hours earlier. `scripts/it-shards.ts` now counts the files its own
  `INTEGRATION_INCLUDE_GLOBS` match — the same constant `vitest.config.ts` takes its `include` from,
  so the count and the scheduled tier are one fact — and divides by `SANDBOX_FILES_PER_SHARD`,
  which OPE-2229 **re-derived from 12 to 32** once the per-file main-process growth the 12 defended
  against was gone. Headroom for that growth at 4 workers inside the measured 13 680 MB cgroup is
  7 528 MB (6 628 MB at the 6 workers OPE-2281 schedules, by the 450 MB per-worker model), and the residual slope is below the measurement's own resolution (589 MB at 6 files
  against 542 MB at 12); bounding it at ~10 MB per file leaves ~756 files of room (~662 at 6 workers). 32 is kept far
  inside that bound on purpose, because the arms ran 12 files and never 112 — so today's 112-file
  tier plans on the **floor of 4**, and the cap only starts adding shards past 128 files. A
  count the tree cannot answer falls back to the floor rather than to a guess. There is **no
  ceiling** on the count: a ceiling is the old pin under another name. What pays for the finer split
  is that **no shard builds** (OPE-2235) — the prepare step does, once, before the first shard, so a
  shard costs vitest start-up and the sweeps rather than a five-minute floor. Until that ticket, shard
  1 built and `suite-lock-run.ts` handed `OE_IT_SKIP_BUILD=1` to every shard after it; a shard 1 whose
  build failed then left shards 2..N running against whatever older tree was there, which the wrapper
  had to warn about. A prepare step that fails now runs **no shard at all** and the run reports its
  exit, so that reading hazard is gone rather than announced.
- **The fixed setup is a STEP, and it is cached** (OPE-2235). `npm run test:integration:prepare`
  (`tests/integration/prepare.ts`) is what builds the tier's target, in a process that exits before
  vitest starts. One cold receipt it printed itself, on a 4-core cloud sandbox (13.7 GB cgroup, Node
  24.21.0, n=1, 2026-10-03): `oe:build` **7.2 s**, `eve build` **169.8 s**, the just-bash prewarm
  **18.8 s**, the PGlite template mint **3.6 s**, `fixed-setup` **204.9 s** (the remainder is the
  key read, the stamp and publishing an 8.1 MB archive; it is 5.5 s by the printed fields). On the same tree a stamp hit is **10.6 s** and a
  remote hit **12.7 s** — `oe:build` and the mint run on every path, and what a hit skips is `eve build`
  plus the prewarm, 189 of those 205 seconds. A restored tree is byte-identical to the build its archive
  came from; against an independent build of the same source it differs only in `nitro.json`'s `date` and
  one per-build id inside a chunk comment. Two of those numbers are
  this ticket's:
  - The prewarm was **147.7 s** and peaked at **3 549 MB** (a standalone measurement; the same leg inside
    the step reports **18.8 s**, which is the figure the floor above quotes — `prewarm.ts` says why the two
    differ). eve's own graph load needs
    the compiled module map and builds it with `loadCompiledModuleMapFromAuthoredSource`, which
    re-parses the authored source in rolldown — the parse `eve build` had just finished (47.2 s of
    102 s in that parser alone, OPE-2227). The built bundle already carries that module map and eve
    keeps its runtime session on `globalThis`, so `tests/integration/prewarm.ts` imports the bundle the
    forks import and reads the artefacts back: **13.0 s, 391 MB**, and eve itself confirms the template
    key is unchanged (`1 reused, 0 built` against a tree the authored path had just prewarmed). A
    missing eve symbol falls back to the authored path with a named log line, never a silent one.
    On eve 0.69.0+ both roads enter through eve's one remaining export, `prewarmAppSandboxes`, and the
    fast road is its `loadAgentGraph` hook (OPE-2248).
  - The PGlite template was minted **once per shard** (~3.9 s × 4+ shards, OPE-2239) because
    `globalSetup` runs per process. The step mints one under `.oe-it-prepare/` and every shard reads it.
    `tests/integration/global-setup-env.test.ts` is what reds if a shard goes back to minting its own.
  The step also **caches the prepared tree**, in two tiers with very different trust. A stamp
  (`.oe-it-prepared.json`) skips `eve build` and the prewarm on a tree already prepared for the same key —
  local, written by a prepare step that ran here, and **on by default**. A prepare that is not warm
  deletes the stamp before it writes an artefact, and writes it again only under its own key (OPE-2324). A
  dirty tree's key reads its working-tree content (OPE-2345, below), so it is never the clean tree's key. The
  next run on the restored clean tree is then not warm: it builds again, or restores when the remote cache
  is on, and never boots the dirty bundle. One force-pushed branch on the dev
  repo (`oe-it-cache/prepared-tree`) carries a gzipped tar of `.output` + `.eve/sandbox-cache` across runs —
  and that half is **opt-in**. 🔴 A restore is not a read: it replaces those two trees on disk, and
  `harness.ts` then `import()`s the restored `.output/server/index.mjs` in every fork, so the bytes are
  EXECUTED and the trust boundary is push access to the cache remote rather than the reviewed tree. The
  default therefore keeps the tier a function of the tree, which is what `docs/deploy/cloud-proof.md` rests
  a run's proof on. `OE_IT_PREPARE_CACHE` takes `local` (the default, stamp only), `remote` (stamp plus the
  restore) or `off` (neither — a real cold build, which is what a floor measurement needs).
  A second local stamp (OPE-2280), `.oe-it-built.json`, belongs to the root `build` gate:
  `scripts/eve-build-stamp.ts` runs in `prebuild` and `postbuild` and records the key the gate's `.output`
  was built from. A prepare step on the same key then skips its own `eve build` (receipt `mode=built`) and
  still runs the prewarm and the mint, so a proof run builds eve once, not twice. The gate writes the stamp
  only when the key did not move during the build. The prepare step accepts it only under its own current
  key, so a keyed edit after the build (committed or not) makes it stale. `off` ignores it too.
  The key is the digest of `git ls-tree -r HEAD` over `agent`, `packages`, `package.json`,
  `package-lock.json`, `patches`, `roster.config.ts`, `roster.lock.json` and `tsconfig.json`, plus eve's
  version, the Node major, the platform and the checkout path (`.output/server/index.mjs` embeds that path
  178 times on this tree, so a bundle is not relocatable). The last four of those paths are there because the build really
  reads them: `patches/` is what `node_modules/eve/dist` contains (a patch edit changes the bundle while
  eve's version does not move), `roster.config.ts` + `roster.lock.json` are the committed source the eve
  slot tree is generated from, and the root `tsconfig.json` decides what `oe:build` emits. ⚠️ The generated
  slot tree under `agent/` is **gitignored**, so it is keyed only transitively, through those committed
  inputs — never directly, because `git ls-tree` cannot see it. 🔴 **An uncommitted edit under any of
  those paths is keyed on its working-tree content** (OPE-2345). The key adds one fingerprint for each
  path that `git status --porcelain -uall` reports there: a SHA-256 of the file's bytes plus its
  executable bit, or `absent` for a deleted file. The next edit to the same file moves the key. `git
  status` reports every non-ignored path whose content differs from HEAD, except a path marked
  `skip-worktree` or `assume-unchanged`. A reported symlink or directory (a nested repository or a
  submodule) REFUSES the key, so that run builds: a link's target can sit outside the keyed paths, and
  `git status` reports a nested repository as one line, never the files inside it. A key that reads working-tree content ends in `-wt`. It serves the two
  local stamps only, never the remote cache: no restore and no publish. The key of a clean tree did not
  change, so an archive published before OPE-2345 still matches. An edit outside the keyed paths — a
  test, a script, a doc — keeps the clean key. Before OPE-2345 an uncommitted keyed edit refused the key,
  so every prepare on a dirty tree was cold: OPE-2338 ran 17 single-file legs on one dirty tree and paid
  about 100 s of cold prepare on each. A second single-file run on the same dirty tree is now `mode=warm`.
  `OE_IT_PREPARE_CACHE_PUBLISH=1` plus `OE_IT_PREPARE_CACHE=remote` is what lets a run publish, and it is
  off by default because a force-push to a shared repository is not something a test run should do unasked. Why a branch and not a release asset or a custom ref:
  `tests/integration/prepare-cache.ts` records what the sandbox credential was measured to allow —
  branch pushes yes, `refs/oe-it-cache/*` pushes 403, branch deletes refused, `gh`'s token rejected.
- **The tier runs with the DAC bypass dropped, so a root runner measures real refusals**
  (OPE-1989 / OPE-1990). Some tests here prove that a write is REFUSED. They read that refusal out
  of the POSIX permission bits: the product chmods a directory read-only, and the kernel answers
  EACCES. uid 0 holds `CAP_DAC_OVERRIDE` and bypasses those bits, so under root the same write
  succeeded and the assertion inverted. `memory.test.ts` reported two failures, and
  `sandbox-session-sweep.test.ts` skipped its read-only arm. A cloud sandbox runs every build as
  root, so that was the normal case and not the exception. `scripts/dac-fence.ts` measures whether a
  read-only directory really refuses this process. When it does not, `scripts/suite-lock-run.ts`
  spawns vitest through `capsh --drop=cap_dac_override,cap_dac_read_search`. The uid does not
  change, and no file changes owner. The bounding set is inherited, so vitest, its workers and each
  worker's agent host are all fenced. 🔴 The drop is NARROW on purpose: only these two capabilities
  bypass the permission-bit checks the tests read, so a fenced root is an unprivileged user for
  those checks and not in general. `CAP_FOWNER` stays, and the sweep's own `chmod` needs no
  capability anyway — the test owns the fixture it chmods. A host that cannot drop the capability
  fails the run rather than running the tier unfenced. Every test that
  depends on this calls `assertWriteBitsBite` first, which fails BY NAME on an unfenced runner.
  Windows has no POSIX write bits at all, so no capability drop can make a fence refuse there.
  `posixWriteBitsAbsentReason()` names that host, and a unit suite that measures the fence
  (`memory-root-fence-test.ts`) prints a SKIPPED line with that reason and does not count the leg.
  On Windows the wrapper prints the same reason and spawns vitest without a drop. The integration
  tests that need the fence then fail by name in `assertWriteBitsBite`. They never pass unmeasured. The
  earlier remedy was a non-root `runner` user; a cloud sandbox refuses `useradd` and `chown`,
  so it is gone.
- Two booted hosts can coexist because each
  fork enters its own constructed **app root** first (`tests/integration/setup-fork-app-root.ts`).
  The built server hard-wires its durable session store to `<cwd>/.eve/.workflow-data`, which the
  harness wipes at each boot — so that directory must be fork-private. The app root is a tree of
  symlinks back to the repository with exactly one real, empty directory: that store. The just-bash
  template cache at `<cwd>/.eve/sandbox-cache` stays a symlink to the shared one, because only the
  prepare step mints a template and a fork that cannot reach it dies on
  `SandboxTemplateNotProvisionedError`. Read `tests/integration/fork-app-root.ts` before you change
  anything that resolves a path off `process.cwd()`. Fixed costs are still per FILE — so grow the
  tier by adding tests to existing files, not by adding files.
- 🔴 **WHICH FILE a new test may join, and the six conditions that decide it** (OPE-2266). The fixed
  floor above is ~2.4 s of vitest import plus ~2.6 s of `bootAgent` per FILE, measured in
  OPE-2244 (its evidence branch, not this tree). "Grow existing files" is therefore the rule, but
  `bootAgent` is one-shot per fork and REFUSES a second boot with different options, so a test may
  only join a file whose fork it can share. All six must hold, and the FIRST is the one most often
  mistaken for the whole test:
  1. **Identical `bootAgent` options.** `{ sharedSqlite: true }` and `{}` are different forks.
  2. **No differing `process.env` seam written BEFORE the boot, and identical boot `settings`.**
     `bootAgent` assembles env once, so an env var one section publishes is published for every
     section. Same set, or no set. A surface identity is a setting since OPE-2650, and the test
     names it as a boot option: `bootAgent({ settings: { github: { appSlug } } })` or
     `{ discord: { publicKey } }`. `bootAgent` layers these over the app's own registration before
     the entry import (`layerForkSettings` in `tests/integration/harness.ts`). Every fork pins all
     the surface-identity settings (`FORK_IDENTITY_SETTINGS`): its own Discord key and Teams app id,
     and every other id unset. So the app's own `agent/settings/settings.ts` never leaks a real id
     into a test.
  3. **No differing global `fetch` stub or tool-execute wrap held for the file.** Both are
     process-global. A stub a section installs and uninstalls per test composes; one installed at
     module or `beforeAll` scope changes the host for every other section.
  4. **No differing file-wide `overrideSettingsForTest` posture.** A per-test override with an
     `afterThisTest` restore composes; one set for the whole file (`window.topology`,
     `approvals.judgeMode`) is the fork's posture and every section inherits it.
  5. 🔴 **At most ONE spec may hold a scripted-model handle past its own test, and it goes LAST.**
     `registerScript` REFUSES a second script for the wildcard key `"*"` while one is live — "two
     live scripts for one key means a test leaked". A spec that hands its handle to `afterAll`
     (the `live` + `open` pattern) rather than closing it inside the test therefore makes every
     LATER section fail at its own `registerScript`, before that section's first assertion. Two such
     specs cannot share a file at all. A spec that uses `disposeLater`, `afterThisTest` or an
     explicit `close()` composes freely and needs no ordering. This condition is the one that is
     invisible until the tier runs: it costs nothing at typecheck and reds four tests at once.
  6. **And the test must not need a seat with no history.** A shared fork means a shared standing
     seat, so a later section runs against a seat that has already delegated. Most assertions do not
     care. One measured counter-example: `tasks/worker-question-answer.test.ts` asserts
     `requestId.startsWith(`${taskId}:`)` on the question bridge, which is false once an earlier
     delegation has run in the same fork. A spec like that keeps a file of its own. There is no
     static test for this one — it is why a fold is proved by running the tier, twice, not by
     reading the diff. The sharpest MEASURED instance is `taskIdOfDelegation`: it answers the first
     `agent` receipt in ANY prompt the handle was served, and a prompt is cumulative within a
     session, so on a seat two sections drive in turn the later section's call answers the EARLIER
     section's task (`tests/integration/harness.ts`'s own warning, measured in OPE-2174 — the wait
     keyed on it burned its ceiling). A spec that calls `taskIdOfDelegation` can therefore only ever
     be a file's FIRST delegating section.
  Sharing a fork also means sharing the standing SEAT when two sections wake one channel. That is
  ordinary — `approvals/clicker-floor.test.ts` runs nine tests and `memory/memory.test.ts` six
  against one seat — but it means each test must take its own `auditCursor()` and join on its own
  ids rather than on "the only row of this action". What a fold costs is blast radius: one failed
  boot reds every section. Test NAMES are what keep that diagnosable, so a fold never renames one.
- **Every temp directory the tier makes is MARKED with its owner's PID, and swept** (OPE-1165) —
  fork app roots, state directories, and the sweep suites' own scratch trees alike.
  A fork's app root and its **state directory** (the `OE_PGLITE_DIR` / `OE_MEMORY_DIR` /
  `OE_SQLITE_PATH` root, holding tens of MB of PGlite and memory tier) are removed when the fork
  exits cleanly, and vitest terminates most forks instead — so `global-setup.ts` sweeps all three
  kinds at the start of each run. The sweep deletes a directory only when it carries the marker AND
  the PID in that marker names no running process, so a second suite run keeps the first run's live
  directories, and a marker it cannot read or parse keeps the directory too. Make a new temp
  directory through `tests/integration/state-dir.ts`, `temp-dir-fixtures.ts`, or the mechanics in
  `owned-temp-dir.ts`; a bare `mkdtemp` leaks, which is how ~450 directories totalling ~12 GB
  reached one box. A directory left by a run older than OPE-1165 carries no marker and no sweep touches it —
  clear those once with `rm -rf /tmp/oe-it-*` on an idle box.
- **Never set `NODE_ENV=test` in the fork.** Under it, eve silently replaces any authored model
  with its own fixture mock and every scripted turn answers from the wrong double. The vitest
  config clears it; the harness throws if it comes back.
- Poll for completion with `waitFor(...)` — the wake POST returns before the turn runs, so every
  assertion races without it.
- **Your test process's own core modules freeze their env reads at FILE LOAD.** Importing
  `../harness` pulls a large slice of core in before any test body runs, and a module-level
  constant read from `process.env` (`memory/store.ts`'s `ROOT` is the worked example) is fixed from
  that moment — `bootAgent()` re-pointing the variable afterwards changes nothing for it. So ASK
  THE MODULE what it resolved (`storeRoot()`), never rebuild the path from what you think the
  environment held. A wrong guess is silent: the fixture lands where the code under test never
  looks. `globalSetup` leaks no state-dir variable at all. It sets no sandbox
  backend either: every fork reads the root app's committed `sandbox.selfHostBackend: "justbash"`
  (it pinned the `OE_SANDBOX_BACKEND` variable until OPE-2411). Since OPE-2235 it has ONE path through it — the build that used to branch on
  `OE_IT_SKIP_BUILD` is a separate step now, so the two run modes cannot hand the forks different
  environments. That divergence reads as a depth-dependent flake and is not one (OPE-582, OPE-1363);
  the prewarm's own state-dir pinning moved with it to `tests/integration/prewarm.ts`. `global-setup-env.test.ts` guards that contract from inside a real fork, and proves it is
  reading an INHERITED environment by matching the setup process's pid against its own `process.ppid`.
- **Two lifecycle events never reach a hook on this build, so never write a test that waits on
  one.** `subagent.called` is not dispatched to hook handlers at all. `session.completed` is not
  emitted for any session: the framework emits it only when a session hits its TIMEOUT deadline,
  which `limits.sessionTimeoutMs: false` removes, and the per-turn epilogue emits `session.waiting`
  instead for every `conversation`-mode run, delegated workers included. `session.failed` and `session.started` DO reach hooks.
  Nothing binds `session.completed` as its only edge any more — the routine outcome fold, the
  dream cycle and the memory persist backstop all run at the end of a TURN. `tests/integration/
  session-end/` exercises those turn edges, so a change that breaks them turns those files red.
- If a test fails with `REDELIVERY STORM (OPE-559)`, it is a HARNESS artifact, not a product
  failure — a loaded box can make eve's local workflow world re-execute one step's body thousands
  of times. `waitFor` detects it and fails in low seconds instead of burning its full 360 s
  ceiling. Do not bisect your diff — re-run on a quiet box. A count BELOW that threshold never
  trips anything, so `waitFor` names it on an ordinary timeout instead. **Before you treat eve's
  "Re-executing inline steps" line in a suite log as a cause, check which file emitted it:
  `redelivery-storm-guard.test.ts` writes ~40 SYNTHETIC copies of that exact signature to stderr to
  prove the guard, and it marks each one `[oe-test-fixture …] SYNTHETIC`.** Since OPE-2229 turned
  console interception off, vitest prints no `stdout | <file>` header, so that fixture marker — not a
  reporter header — is what tells you which file emitted a line.
- **A booted host's `console.log` now PRINTS, and is no longer attributed to a file.** The tier runs
  with `disableConsoleIntercept: true` (OPE-2229), so each fork writes straight to stdout. 🔴 **What
  that costs:** a fork's lines INTERLEAVE with the main process's own output, and none of them carries the file it
  came from. Pass `--disable-console-intercept=false` to get the per-file attribution back for one
  debugging run. Nothing load-bearing reads the captured logs — this tier's evidence is the
  `OE_PROOF` line `suite-lock-run.ts` prints from the MAIN process, which was never intercepted, and
  the per-shard peak-RSS label beside it. Expect a bigger log: the A/B's lever runs were 210–302 KB
  against the baseline's 33 KB — a like-for-like only for the 6-file arm, since the 210–302 KB range
  spans arms that ran 12 files against the baseline's 6.
- 🔴 **The history, because it still shapes how a log line reads as evidence.** Until OPE-2229 vitest
  intercepted each fork's console, and the default reporter printed a file's output only when that
  file had a failing test. Measured 2026-08-18, two full-tier runs on one tree: the all-green run
  printed no `[open-everywhere:…]` line from any fork, and a run with `--disable-console-intercept`
  printed 2884. ⚠️ That 2026-08-18 measurement has NOT been reproduced against vitest 4.1.10, whose
  `BaseReporter.onUserConsoleLog` prints whenever `silent` is false, and this config never sets
  `silent`; the measurement may predate the vitest 4 upgrade. **So a host log line is not evidence
  about a failure merely because a red run is where you saw it** — under the old default it was in the green runs too, unprinted, and under the
  new one it prints whatever the verdict. Judge it on what the code does. That reading cost OPE-708 a
  ticket.

## Beside the ladder: the eval lane

The eval lane (`packages/core/scripts/eval/`) measures the MODEL, not the code. Its benches are run
by hand, they cost real inference, and none of them gates. What DOES gate is each bench's pure
scorers, pinned offline by a script test — a scorer that stops seeing a defect reports zero and
reads exactly like a clean result, so the scorer is the part that needs a gate.

The **injection eval** (`scripts/eval/injection-eval.ts`, OPE-1150) is the lane's bench for the
untrusted-content envelope and the memory provenance mark. Their mechanisms are held by the three
tiers above; this suite asks the behavioural question those tiers cannot reach — given the fence
bytes the deployment renders, does the model obey hostile text anyway? Three legs: instruction
resistance (leg 1), the two-turn memory launder (leg 3), and the lean standing seat against a real
delegated worker (leg 5). OPE-2726 removed legs 2 and 4 when the turn-mark gates went. It runs with
no key at all (`--model scripted`), which drives each leg's instrument controls, or against a live
model for the rates. Read `scripts/eval/INJECTION-EVAL.md` before quoting any number from it — it
states which halves the offline tier cannot prove. **Check the leg reached its subject before you
read its rate**: a leg whose probes never met the attack scores nothing, and zero-over-nothing prints
the same as a clean result. Each such leg reports its reachability count beside its rate for exactly
that reason. Its scorers gate through
`npm run test:injection-eval-scoring --workspace @open-everywhere/core`.

The **family bench** (`scripts/eval/family-bench.ts`, OPE-1703) is the lane's regression bench of
failed turns. Each case is one turn lifted out of a soak or e2e evidence transcript by
`scripts/eval/mine-family-case.ts`, filed under its
[failure family](../dev/failure-families.md), and carrying the one predicate that separates the
failure from the fix. It needs no key: its green is a pair check — every case's predicate must fire
on its own recorded failure and stay quiet on the corrected turn. The recipe for mining a new case is
[evals mined from transcripts](../dev/transcript-mined-evals.md). Its rung in the core `test:chain`
is `npm run test:family-bench --workspace @open-everywhere/core`; the bench itself gates nothing.

The **memory battery** (`scripts/eval/memory-eval.ts`, probes M1–M7) asks whether the model
navigates a thin index over heterogeneous silos to the right fact, refuses poisoning, and respects
access clauses. Seed its corpus first with `scripts/eval/seed-silo.ts` (`--plan` prints both the
topology and the `domains.ts` snippet an operator must paste). Its scorers gate through
`npm run test:memory-eval --workspace @open-everywhere/core`.

The **retrieval-quality bench** (`scripts/eval/retrieval-quality.ts`, OPE-36) asks the one question
the memory battery cannot: a domain resolves silos of DIFFERENT TYPES, so does the model route by
type? The top-level index labels each silo by its source — `sourceLabel` in
`packages/core/agent/memory/listing.ts` derives "database", "git", "GitHub (…)" or "Notion" from the
provider — and that label is a signal the model can follow, ignore, or be lured by. Five probes, one
axis each: a cross-type question that cues its source, the same split with no cue, two silos the
label cannot tell apart (only their descriptions differ), a read-only projection, and a question no
silo answers.

```bash
cd packages/core && npx tsx scripts/eval/retrieval-quality.ts                       # dry: free
cd packages/core && DATABASE_URL=… npx tsx scripts/eval/retrieval-quality.ts --seed-corpus --live
# then paste the printed defineMemorySilo/defineDomain block into agent/memory/config/domains.ts
cd packages/core && DATABASE_URL=… npx tsx scripts/eval/retrieval-quality.ts --live --model <id>
```

🔴 **The `domains.ts` paste is a step, not a nicety.** A silo reaches the agent only when the
operator-owned config declares it and a domain references it. Skip it and a live run is worse than
empty: the probes resolve whatever silos the named domain already owns, the agent reads THOSE and
answers, so every probe looks reached and the summary blames the model for a wiring gap. The
reachability rule below cannot catch that — the turn is alive, only the corpus is wrong. The dry
mode and the seed step both print the exact block, with each silo's real provider.

**It runs DRY unless you pass `--live`.** That inverts the older benches, which run live unless you
remember `--plan`: a forgotten flag should cost nothing. `--seed-corpus` takes `--live` too, and
refuses without it — seeding deletes and rewrites four memory tiers in a real store, and
`DATABASE_URL` is ambient in a dev shell, so an unconfirmed seed would be a destructive command that
looks like a dry run. The dry mode is not a print-out — it scores
five mock agents (an ideal one, one that opens the wrong-typed silo first, one that swallows the
near-miss, one that claims to have edited the read-only projection, and one that does nothing)
through the real scorers, and `npm run test:retrieval-quality --workspace @open-everywhere/core`
pins what the scorer must say about each.

**Reading a score.** `retrieval` is correct answers over probes that were REACHED. `silo-routing` is
how often the first memory read landed in the silo holding the truth. `type-routing` is the same
question about the source LABEL, and it is deliberately scored on FEWER probes: where a near-miss
carries the truth silo's own label, the label decides nothing and a verdict there would be a free
pass. Every rate prints its own denominator, and a rate over an empty denominator prints `n/a`,
never `0%`. Read `unreached` before any rate: a probe that read nothing and said nothing never met
its subject, which is what an unseeded corpus looks like.

**Three limits, all structural on this base.** `sourceLabel` collapses postgres and sqlite to one
label, so the corpus presents two distinct labels, not four. `providerById`
(`packages/core/agent/memory/provider.ts`) throws for `github` and `notion` — no adapter is
registered — so there is no real Notion projection to score. What the projection leg scores is the
read-only BASELINE: `readOnly: true` alone renders "read-only — edits are blocked" in the index. A
silo's update `skill` stays **inert** until `provider === "notion"`, because every consumer of it is
gated on `isProjectedCache` (`packages/core/agent/memory/readonly.ts`), so no leg here scores
whether a model follows a projection's update route. And a `git`-backed silo is seedable only where
the seeding process shares `OE_MEMORY_DIR` with the agent host, the same constraint
`agent/memory/config/domains.ts` records for the integration fixture; against a remote deployment
that leg's probes come back `UNREACHED`.

## An LLM judge measures the model, so it never gates

Some live e2e scenarios grade a reply with an LLM judge. **A judged verdict reports; it never sets
an exit code.** Use `ctx.judgeReport` for reply quality, and `ctx.gate` / `ctx.judgePass` for
anything a status code, an audit row or a substring can decide.

The reason is measured, not stylistic. The webhook scenario's judged gate came back **red then
green on two runs minutes apart against the same deployment**, and an earlier rollback to different
deployment bytes produced a byte-identical verdict. On one of those reds the judge said the reply
did not quote a token that the scenario's own substring check had already found. A verdict that
flips without a code change cannot carry a go/no-go, and a red nobody can act on trains people to
ignore reds.

So the post-deploy smoke is split:

- **`npm run deploy:smoke`** — the deterministic half, and the only half that gates. Signed POST →
  `200` → the deployment's own `webhook.fired` and `reply.post` audit rows, joined by the delivery
  id the smoke minted and by the wake id the fire minted; an unsigned POST → `401` with no audit
  trace. See
  [Rollback, verify, record](../deploy/rollback.md).
- **The judged reply-quality probe** — kept, still graded, printed loudly on stderr with a
  `judged (non-gating)` marker and re-listed in the run summary. It never changes the exit code.

The rule generalises: **tests prove the logic journey; evals prove the model.** Do not put a judge
inside a code gate — it makes the suite slow, non-deterministic, and eventually ignored.

### The reader check reads what the agent posted (OPE-2485)

Every live e2e leg sees the agent post text: replies, cards, notices, recaps. The runner collects
that text per leg and reads it the way an ordinary office worker would. Its flags print as their own
section, `## Reader check`, directly under the `## Ship legs` board, with the leg, the ruling, the
quote and why. **A reader flag is a defect to fix. It never reds a leg and never moves the exit
code.**

- **One rubric file.** `packages/core/scripts/e2e/reader-rubric.ts` holds the six reader rulings, the
  deterministic rules that cite them, and the judge prompt rendered from them. The shared
  person-text detector (`agent/channels/person-text.ts`) is one rule in it, not a second copy.
- **Fixtures prove the rubric.** `reader-fixtures.ts` holds before/after pairs from the text sweep:
  every "before" must flag and every rewrite must pass. With the rules removed every "before" passes,
  so the fixtures measure the rubric and nothing else (`npm run test:reader-check`). A new rule
  needs a fixture that only it catches.
- **Two graders.** The rules always run, with no key and no network. The judge model (the shipped
  stack's `utility` role) joins only when `AI_GATEWAY_API_KEY` is reachable, and only after it passes
  its own fixtures in one calibration call at the start of the read. A judge that misses a "before"
  or flags a rewrite is dropped for the run, and the section's count line says which fixture it got
  wrong. After calibration the judge costs at most one call per leg that posted text, and a text
  already read is not sent again. Each call times out after 60 seconds, and the read stops calling
  the judge after five minutes, so a stalled gateway cannot hold the run's exit.
- **What is collected.** Each leg's drivers are wrapped, so every Slack, Discord, Teams and GitHub
  message the leg reads back counts when its author field marks it as the agent's (`botId`,
  `authorIsBot`, `fromApplicationId`, `authorType: "Bot"`). A Linear or Notion comment counts when
  its author is the driver's own `appUserId` or `botUserId`. A driver that `withChannel` returns is
  wrapped too. Other text a leg reads (an email, a page) it hands in with `ctx.readerText(text)`; no
  leg does yet. A string of 8 or more characters that a leg passes to a driver call is dropped when a
  harvested message carries the same words. A short harness post, or one the platform rewrites, is
  not caught, and the Discord harness posts with a bot token. Another app's bot message in the same
  room counts too. Both are known false flags.
- **Room news is not noise.** A recap quotes the room, and a room talks about ledgers, backends and
  colleagues who will report back. The rules are narrowed toward the agent's own words, and
  `READER_CONTROLS` pins room-news sentences that must pass.
- **The instructions get the same pass.** `npm run test:reader-instructions` reads every quoted
  phrase in the rendered seat and worker instructions, both `instructions.md` copies and every tool
  description. A phrase the rubric flags must sit in a clause that tells the model not to use it.
  This test gates, because it reads source, not a model.

The soak tests call the same check. `reviewPostedTexts`, `resolveReaderJudge`,
`calibrateReaderJudge` and `renderReaderReport` in `reader-check.ts` are its whole surface.

### The board runs the riskiest legs first, in declared lanes (OPE-2364)

A ship board selects its legs from the release diff, runs them in risk order, and runs two legs at
once only where both declare it safe. The first leg that runs and fails stops the board from
starting more legs, so a remediation starts at the first red.

- **Select.** `--diff-base <ref>` (or `--changed <csv>`) gives the runner the release diff, and
  `relevantScenarios` (`scripts/e2e/changed-relevant-map.ts`) picks the legs. A leg it does not pick
  is `FILTERED` with the reason "not selected by the release diff". A scoped release
  (`E2E_RELEASE_SCOPE`) never drops a leg this way: its scope is the whole selector, so the diff only
  orders the legs. With no diff, the board runs the whole roster.
- **Order by risk.** A leg that a changed area reaches AND that was red on the last board runs first.
  Next come the legs a changed area reaches, then the legs red on the last board, then the rest in
  roster order. The last board is the newest `scripts/e2e/results/e2e-board-*.json`, or the file
  `--last-board <path>` names. A live run writes the record when at least one leg ran. The newest
  record wins, even when it comes from a partial run such as `--only J1`. The record holds ids,
  statuses and durations only. A RED counts as "red last board" only when the leg ran: a cannot-run
  or RED-until-fixture row does not.
- **Lanes by declaration.** `scripts/e2e/lanes.ts` holds one row per leg: the seats and fixtures the
  leg drives, or `serial` with the reason it must run alone. Two legs run at once only when their
  resources do not overlap. A resource is a seat, never a surface: the `e2e-unified` domain holds
  the base Slack room, the e2e-scratch repo and the Linear, Notion, Discord and Teams rooms in ONE seat,
  so the legs on those rooms share a lane. A leg that cannot start yet reserves its resources, so a
  leg behind it in the risk order cannot take them first. A serial leg runs with nothing beside it.
  `npm run lint:e2e-lanes` (in `npm test`) is red on a leg with no row, and the runner refuses such
  a roster. Up to four legs run at once; `--max-lanes <n>` changes the cap, and `--serial` runs one
  at a time.
- **Stop at the first red.** The runner prints `E2E-RED <leg> — <reason>` the moment any leg goes
  red, with the leg's own failing assertion. The first leg that RAN and failed stops new starts.
  The legs already running finish, and each leg that never started is `FILTERED` with the reason.
  A cannot-run or RED-until-fixture leg does not stop the board: its remedy is a fixture, known
  before any drive. `--full-board` runs every leg.
- **Fail at once on an unknown shape.** A probe that filters a response by today's shape reads an
  old shape as "nothing yet", and its gate then waits out the whole budget. When a probe reads a
  shape the current product never writes, it throws `UnrecognisedShape` (`scripts/e2e/poll.ts`).
  `pollUntil` and `pollOptional` both end on the first such throw, and the `E2E-RED` line names the
  shape the probe saw. `S-CARD-teams-dm` uses it for an unreadable card and for a card in the team
  channel instead of the chat.
- **Plan before a board.** `npm run e2e:plan -- --diff-base <ref>` (in `packages/core`) prints the
  selected legs in risk order, each with its lane, its start and its needs, and drives nothing.
  It applies the run's own filters (`--only`, `E2E_SUITE`, `E2E_SURFACES`, the expensive-leg
  deferral), but it does not check capabilities: a leg the deployment cannot arm still shows.
  The estimate uses each leg's time on the last board, or its budget when the last board has none.
- **Shared windows.** A leg's wake evidence covers its own run. In a parallel lane, other legs write
  audit rows in the same window, so the record names them (`shared with …`). Join on the ids before
  blaming the leg.

The runner does not prove that two declared-safe legs never interfere. A full board on a test bed
proves it, and `--serial` is the bisect when a red appears only in lanes.

## The tier no test can reach: deployed state

Every tier above proves something about the CODE. None can prove the deployment holds the state that
code needs, because that state lives in a database and a routing table. A missing credential row
fails closed at first use, silently, behind a `200` — measured: the Notion webhook path was dead in
production for the feature's whole life over a missing `db:notion:channel-key` row.

`npm run deploy:census` is the tier that can see it: it derives the required rows and routes from the
shipped config and joins them against the running deployment. Its own logic is unit-tested offline by
`npm run test:deploy-census`. When a change adds a behaviour that depends on deployed state — a
credential row, a webhook declaration, a new ingress route — the census is where it becomes provable.
See [Rollback, verify, record](../deploy/rollback.md).

## The lint gates are not a tier

`lint:*` legs in `npm test` gate config and generated artifacts, not behaviour. A new behaviour
needs a test in one of the three tiers above; a new config invariant may instead need a lint leg.
