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
  actually runs" appear in the claim. Toolset assembly, delegation, taint travel, approval-chain
  audit rows, the reply choke point — a script test can only fake the context around these, and a
  faked context is how a green suite hides a dead event handler. (The tier's first sample test
  found exactly that: a taint-adoption hook listening on an event eve never delivers to hooks.)
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
2. Append `&& npm run test:<name>` to that package's `test:chain` script.

That is all. `npm test` picks the suite up from `test:chain` — no other list names it.

**Driving the behaviour settings from a test.** `resetSettingsForTest()` drops the registered
overrides back to the shipped defaults, so a fresh test never inherits another's posture.
`overrideSettingsForTest(patch)` patches them mid-process, for a test that must hold one flag while
varying another. Both are bootstrap seams: runtime code always reads the resolved values through
`getSettings()`, and a test that reaches for the schema directly is reading a different store from the
one the running agent resolves through.

**How the tier runs.** Each package keeps its chain string as `test:chain`, and `npm run
test:chain` still walks it serially, one `npm run` at a time. `npm test` does not: its last leg,
`test:suites`, hands every package's chain to ONE vitest run
(`vitest.chain.config.ts`, `scripts/chain/`) which spreads the ~360 workspace suites over a pool of
forked workers. Batching cut the deterministic gate from 619 s to 166 s (measured 2026-08-17,
OPE-703); most of what it removed was `npm run` process spawn, at ~0.54 s a leg.

The root package.json keeps its own `test:chain` the same way (~90 legs — config lints, roster,
boot, deploy-ops, per-surface script tests). `npm test` used to walk those serially before ever
reaching `test:suites`; now `test:suites` batches them too, alongside the workspace legs, ~454
suites total (measured 2026-08-18, OPE-709). The root `test` script keeps only `lint:script-chain`
(the fail-fast resolver, which must run before the batched pool exists) and the provider-discord
`test --workspace` echo outside the batched pool — everything else routes through root
`test:chain`. A root-level script test joins the same way a workspace one does: add
`"test:<name>"` to the root `package.json`, then append `&& npm run test:<name>` to the root
`test:chain` script.

**Every suite still runs alone.** `npm run test:<name> --workspace <pkg>` is unchanged, and it is
the right way to reproduce a red — the batched runner names each failure by package and script for
exactly that reason.

**Write the suite so it does not care what ran before it.** A shard runs many suites in one
process. The runner gives each one a fresh module registry, a clean `globalThis` registration
plane, its package as cwd, and a restored `process.env`. It does NOT undo a file the previous suite
wrote outside a temp dir, or a fixture it left in a shared database. A suite that passes alone and
fails in a shard has an order dependence — that is a real defect in the suite, not a batching
problem.

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

Start from `tests/integration/taint/taint-delegation.test.ts` — it is the worked example — and
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
- **A script belongs to ONE leg, and the harness enforces it.** A background delegation settles on
  its own clock, so a leg's settlement turn — and the corrective re-drive behind it — can outlive the
  leg that dispatched the worker and land on the NEXT leg's script. The FOREIGN-WAKE FENCE
  (`agent/model/scripted-model.ts`) refuses that: a script registered under the wildcard key is never
  served a **call-bearing** step for a PARENT turn whose wake id a **different** registration already
  answered. Such a turn gets judged silence, spends no step, and is recorded as
  `RecordedRequest.foreignWakeSilence` — assert that field when you want to prove a straggler was
  absorbed. 🔴 **A test that MEANS to serve a later turn of an earlier wake registers on that
  SESSION's own id**, which is what `armSettlement` does; the wildcard key is a catch-all, and a
  catch-all must not catch another leg's turn. A `say`-only step is exempt, because absorbing an
  unknown number of stragglers is exactly what a drain script
  (`SETTLEMENT_DRAIN_SCRIPT`) is for. **The signal is the `wake-id` on the LAST `<wake …>` envelope
  of the served prompt**, and that one fact is the whole of what the fence sees: a turn that renders
  no envelope of its own — a settlement turn, the corrective re-drive, which re-stamps the original
  id — resolves the PREVIOUS leg's wake, while a turn with its own envelope resolves a fresh id that
  nothing owns, and a prompt with no envelope at all leaves the fence inert. Only a single-window
  unified session renders a `wake-id` at all, and on that path a leg-opening delivery is always
  judged, so a fresh leg can never be fenced. Why it matters: before
  the fence, a straggler took the next leg's `agent` call and the leg's own turn then found a spent
  script — which reads as a PRODUCT failure on whatever that leg was measuring, not as a harness
  red.
  `tests/integration/tasks/straggler-leg-isolation.test.ts` drives it, and
  `scripts/scripted-wake-ownership-test.ts` pins the rule offline.
- **A script step can also hold the call open and report its own token counts.**
  `{ delayMs }` keeps one MODEL CALL in flight, which is one of the two ways a turn lives long enough
  for a test to CANCEL it (`tests/integration/liveness/turn-cancel.test.ts`). The other is an `async`
  `wrapToolExecute` stub that holds a TOOL EXECUTION open
  (`tests/integration/liveness/turn-cancel-tool-hold.test.ts`); use that one when the claim is about
  the step the cancel ABORTS, because a step held at its model call has run no tools.
  🔴 **A cancel does not shorten a `delayMs` hold — call `handle.releaseHolds()` as soon as the hold
  has done its job.** eve carries an abort signal into a real provider call, but the mock-model shape
  a scripted step answers exposes none, so the hold is a plain timer the fork pays in full. Release
  it once the `turn.cancel_requested` audit row proves the ingress accepted the stop: the turn is
  already marked cancelled there, so the released call's answer is discarded exactly as the held
  one's would have been. `delayMs` is then only the BACKSTOP that bounds a missed release. Assert
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
  `OE_EGRESS_SPOOF=1` for the whole tier, and `setSurfaceReaction` asks `swallowRoomOp` before it
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
- **Every file is its own process** (`pool: "forks"`), with its own PGlite dir, and files run in
  PARALLEL (`fileParallelism: true`). The worker count is **not** a fixed pin:
  `scripts/ci-max-workers.ts` reads `OE_IT_CI_MAX_WORKERS` when it is set; otherwise a process a
  memory cgroup caps below the machine's RAM derives what that cap and the box's CORES fit —
  `min(cores, floor((cap − 3 072 MB reserve − 1 280 MB base) / 450 MB per worker))`, never below 1 —
  and then takes the **lower** of that and `HARNESS_CONCURRENCY_CEILING`. A box under no cap keeps
  **2**. 🔴 **That ceiling is 1 today, and it is not a memory number** — see the next bullet. So a
  capped sandbox still schedules ONE worker, exactly as before OPE-2229; what changed is that the
  memory answer is now derived, measured and separately testable
  (`cgroupMaxWorkersByMemoryAndCores`), ready for the day the ceiling lifts. A booted agent host per worker is what makes this a memory
  decision, and the measurements behind it are these.
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
    capped at one worker per core even though the memory model would allow about twenty. (The A/B's
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
  543.2 s, not against `main`. Raise `HARNESS_CONCURRENCY_CEILING` when OPE-2197 closes, against a
  re-measurement — never on the memory numbers alone, which is the inference this ticket got wrong.
  🔴 **OPE-2240 has since closed the CALL-BEARING half of that window** — the foreign-wake fence in
  the bullet above — and measured the full tier green twice at 4 workers through
  `OE_IT_CI_MAX_WORKERS=4` (980.9 s / 1002.7 s against 2321.0 s / 2286.7 s at one worker, peak tree
  RSS 6.9 GB). **The ceiling is still 1, deliberately.** Four runs do not establish a rate, and the
  decision is this bullet's own: raise it here, against its own re-measurement, not off another
  ticket's matrix.
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
- **The shard count follows the tier's file count, and no shard builds** (OPE-2050, OPE-2235). A pinned
  count sizes the split against the tier the pin was written for, so the memory margin erodes as the
  tier grows. It did: `SANDBOX_SHARDS = 4` was set at ~85 files and ran at 110, where two of the
  four shards were SIGKILLed — peaks **7.5 / 6.1 / 9.2 / 9.3 GB** on a 16 GB box, on a split that
  had passed six hours earlier. `scripts/it-shards.ts` now counts the files its own
  `INTEGRATION_INCLUDE_GLOBS` match — the same constant `vitest.config.ts` takes its `include` from,
  so the count and the scheduled tier are one fact — and divides by `SANDBOX_FILES_PER_SHARD`,
  which OPE-2229 **re-derived from 12 to 32** once the per-file main-process growth the 12 defended
  against was gone. Headroom for that growth at 4 workers inside the measured 13 680 MB cgroup is
  7 528 MB, and the residual slope is below the measurement's own resolution (589 MB at 6 files
  against 542 MB at 12); bounding it at ~10 MB per file leaves ~756 files of room. 32 is kept far
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
    differ). eve's own `prewarmBuiltAppSandboxes` needs
    the compiled module map and builds it with `loadCompiledModuleMapFromAuthoredSource`, which
    re-parses the authored source in rolldown — the parse `eve build` had just finished (47.2 s of
    102 s in that parser alone, OPE-2227). The built bundle already carries that module map and eve
    keeps its runtime session on `globalThis`, so `tests/integration/prewarm.ts` imports the bundle the
    forks import and reads the artefacts back: **13.0 s, 391 MB**, and eve itself confirms the template
    key is unchanged (`1 reused, 0 built` against a tree the authored path had just prewarmed). A
    missing eve symbol falls back to the authored path with a named log line, never a silent one.
  - The PGlite template was minted **once per shard** (~3.9 s × 4+ shards, OPE-2239) because
    `globalSetup` runs per process. The step mints one under `.oe-it-prepare/` and every shard reads it.
    `tests/integration/global-setup-env.test.ts` is what reds if a shard goes back to minting its own.
  The step also **caches the prepared tree**, in two tiers with very different trust. A stamp
  (`.oe-it-prepared.json`) skips `eve build` and the prewarm on a tree already prepared for the same key —
  local, written by a prepare step that ran here, and **on by default**. One force-pushed branch on the dev
  repo (`oe-it-cache/prepared-tree`) carries a gzipped tar of `.output` + `.eve/sandbox-cache` across runs —
  and that half is **opt-in**. 🔴 A restore is not a read: it replaces those two trees on disk, and
  `harness.ts` then `import()`s the restored `.output/server/index.mjs` in every fork, so the bytes are
  EXECUTED and the trust boundary is push access to the cache remote rather than the reviewed tree. The
  default therefore keeps the tier a function of the tree, which is what `docs/deploy/cloud-proof.md` rests
  a run's proof on. `OE_IT_PREPARE_CACHE` takes `local` (the default, stamp only), `remote` (stamp plus the
  restore) or `off` (neither — a real cold build, which is what a floor measurement needs).
  The key is the digest of `git ls-tree -r HEAD` over `agent`, `packages`, `package.json`,
  `package-lock.json`, `patches`, `roster.config.ts`, `roster.lock.json` and `tsconfig.json`, plus eve's
  version, the Node major, the platform and the checkout path (`.output/server/index.mjs` embeds that path
  178 times on this tree, so a bundle is not relocatable). The last four of those paths are there because the build really
  reads them: `patches/` is what `node_modules/eve/dist` contains (a patch edit changes the bundle while
  eve's version does not move), `roster.config.ts` + `roster.lock.json` are the committed source the eve
  slot tree is generated from, and the root `tsconfig.json` decides what `oe:build` emits. ⚠️ The generated
  slot tree under `agent/` is **gitignored**, so it is keyed only transitively, through those committed
  inputs — never directly, because `git ls-tree` cannot see it. 🔴 **An uncommitted edit under any of
  those paths refuses the key entirely**, because the key reads the COMMIT and a hit would otherwise
  serve a bundle this tree did not build. An edit outside them — a test, a script, a doc — keeps it.
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
  depends on this calls `assertWriteBitsBite` first, which fails BY NAME on an unfenced runner. The
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
  looks. `globalSetup` leaks no state-dir variable at all and pins `OE_SANDBOX_BACKEND` for every
  fork, and since OPE-2235 it has ONE path through it — the build that used to branch on
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

The **injection eval** (`scripts/eval/injection-eval.ts`, OPE-1150) is the lane's taint bench. The
taint plane's mechanisms are held by the three tiers above; this suite asks the behavioural
question those tiers cannot reach — given the fence bytes the deployment renders, does the model
obey hostile text anyway? Five legs: instruction resistance, the vector-1 floor joined to the real
approver chain, the two-turn memory launder, the same-step read-and-dispatch race, and the lean
standing seat against a real delegated worker. It runs with
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
