import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { eveWorldVercelSource } from "./_eve-world-source.js";

let passed = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  passed++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const read = (rel: string): string => readFileSync(join(eveRoot, "dist/src", rel), "utf8");
const flat = (src: string): string => src.replace(/\n\s*\*/g, " ").replace(/\s+/g, " ");

const workflowChunksDir = join(eveRoot, "dist/src/compiled/_chunks/workflow");
const workflowChunks = readdirSync(workflowChunksDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(workflowChunksDir, name), "utf8"))
  .join("\n");

const workflowRuntime = read("compiled/@workflow/core/runtime.js");
const vercelWorld = eveWorldVercelSource();
const localWorld = read("compiled/@workflow/world-local/index.js");
const queueContract = flat(read("compiled/@workflow/world/queue.d.ts"));
const worldCapabilities = flat(read("compiled/@workflow/world/interfaces.d.ts"));
const specVersionContract = flat(read("compiled/@workflow/world/spec-version.d.ts"));
const singleFlight = flat(read("compiled/@workflow/core/runtime/step-single-flight.d.ts"));
const spec8Ownership = flat(read("compiled/@workflow/core/runtime/spec8/step-ownership.d.ts"));
const spec9SingleFlight = flat(read("compiled/@workflow/core/runtime/spec9/step-single-flight.d.ts"));
const spec9CreatorRules = flat(read("compiled/@workflow/core/runtime/spec9/creator-rules.d.ts"));
const spec9InBandWriter = flat(read("compiled/@workflow/core/runtime/spec9/in-band-writer.d.ts"));
const spec9StepExecutor = flat(read("compiled/@workflow/core/runtime/spec9/step-executor.d.ts"));
const eveSpecDefaultContract = flat(read("internal/workflow/spec-version-default.d.ts"));
const eveSpecDefault = read("internal/workflow/spec-version-default.js");
const eveCompiledArtifacts = read("internal/application/compiled-artifacts.js");
const sessionTurn = flat(read("execution/session/turn.d.ts"));
const sessionEntry = flat(read("execution/session/entry.d.ts"));
const sessionHandoff = flat(read("execution/session/handoff.d.ts"));
const turnStepContract = flat(read("execution/workflow-host/turn-step.d.ts"));
const turnStepJs = read("execution/workflow-host/turn-step.js");
const sessionTurnJs = read("execution/session/turn.js");

{
  const IN_FLIGHT_WARNING = "Step execution already in flight in this process";
  ok(
    workflowChunks.includes(IN_FLIGHT_WARNING),
    "1: eve's step guard still announces itself — the bundled Workflow runtime carries the in-flight single-flight branch",
  );
  for (const nearMiss of ["already in flight in this deployment", "already in flight in this run", "already in flight globally"]) {
    ok(!workflowChunks.includes(nearMiss), `1: the guard is NOT scoped "${nearMiss}" — a cross-instance guard would read differently`);
  }
  const warnAt = workflowChunks.indexOf(IN_FLIGHT_WARNING);
  const warnSite = workflowChunks.slice(warnAt, warnAt + 220);
  ok(
    /workflowRunId\s*:\s*\w+\s*,\s*stepId\s*:\s*\w+/.test(warnSite),
    "1: the guard keys on (workflowRunId, stepId) in the CODE — the pair, so two DIFFERENT steps of one run are never mutually excluded",
  );
  ok(
    singleFlight.includes("same run + step correlation ID") && singleFlight.includes("already in flight in this process"),
    "1: eve's own contract states the key and the scope — run + step correlation ID, in this process",
  );
  ok(
    singleFlight.includes("a loser gets `loserResult()` once the winner settled") &&
      singleFlight.includes("unless `rerunAfter(winner)` says the winner ran nothing") &&
      singleFlight.includes("in which case the loser re-enters and tries the step itself"),
    "1: the shared (spec 8) rule — the same-process loser takes the winner's result, and runs the body itself only when the winner ran nothing",
  );
  ok(
    spec9SingleFlight.includes("two executions of one step in one process are two deliveries of that message") &&
      spec9SingleFlight.includes("instead of running the body"),
    "1: on a spec 9 run the same-process loser waits for the winner and asks for a redelivery instead of running the body",
  );
  ok(
    spec9SingleFlight.includes("Background step invocations are not fenced; a cross-instance duplicate runs the body twice."),
    "🔴 1: eve states in so many words that a cross-instance duplicate of a background step RUNS THE BODY TWICE — the single-flight is per process, never per run",
  );
}

{
  const EXCLUSIVITY_CLAUSE =
    "only a delivery of that same message may re-execute the step before the ownership lease expires";
  ok(
    queueContract.includes("On earlier runs the runtime's inline step ownership uses it as a liveness lease"),
    "2: eve calls inline step ownership a LIVENESS lease keyed on the queue messageId — and now scopes it to EARLIER (spec <= 8) runs",
  );
  ok(
    queueContract.includes(EXCLUSIVITY_CLAUSE),
    "🔴 2: on a spec 8 run eve states a bounded exclusivity: only the owning message may re-execute the step BEFORE THE LEASE EXPIRES. The bound is the finding, not the exclusivity",
  );
  ok(
    spec8Ownership.includes("0 means the lease has expired") && spec8Ownership.includes("dispatch falls back to the immediate enqueue"),
    "2: an expired (or unstampable) spec 8 lease falls back to the IMMEDIATE enqueue — a slow owner that is still alive does not hold the step",
  );
  ok(
    queueContract.includes("fresh id per delivery degrades gracefully") &&
      queueContract.includes("adding recovery latency but never wedging or duplicating"),
    "2: eve promises no duplication for the DEGRADED World (a fresh messageId per delivery), where owner redeliveries fall to the delayed backstop — one step under one message, not two turns of one session",
  );
  ok(
    queueContract.includes("at most one delivery for a given run id is in flight at a time") &&
      queueContract.includes("That is the queue half of the single-writer guarantee"),
    "2: on a spec 9 run eve serializes a run's ORCHESTRATOR deliveries — the queue half of a single-writer guarantee",
  );
  ok(
    queueContract.includes("makes an overlap that the queue still lets through (a delivery that outlives its lease) safe"),
    "🔴 2: …and eve states that the queue half CAN be overrun (a delivery that outlives its lease); the in-band fence makes that overlap safe for the run's LOG",
  );
  ok(
    spec9InBandWriter.includes("The refusal does not say that another writer is running."),
    "2: a fence refusal is not a liveness signal — eve does not claim the fence detects a second running orchestrator",
  );
  ok(
    spec9CreatorRules.includes("Nothing on the write path refuses a second `step_started` of a step that is still running"),
    "🔴 2: eve states that NOTHING refuses a second start of a running step — a dedupe window, not a lock, keeps a re-send from a second owner",
  );
  for (const nearMiss of ["ownership lock", "exclusive lease", "mutual exclusion"]) {
    ok(
      !spec8Ownership.includes(nearMiss) && !queueContract.includes(nearMiss) && !spec9CreatorRules.includes(nearMiss),
      `2: eve does NOT describe ownership as "${nearMiss}"`,
    );
  }
}

{
  ok(
    eveSpecDefaultContract.includes("Spec version eve opts new Workflow runs into: one orchestrator per run.") &&
      /EVE_WORKFLOW_SPEC_VERSION\s*=\s*9\b/u.test(eveSpecDefault),
    "🔴 3: eve 1.x opts NEW Workflow runs into spec 9, the single-orchestrator model — the change from eve 0.71.0, where per-run serialization was an opt-in gated OFF",
  );
  ok(
    /isSet\(\w+\.WORKFLOW_SPEC_VERSION\)\|\|isSet\(\w+\.WORKFLOW_SEALED_LOG\)\|\|\(\w+\.WORKFLOW_SPEC_VERSION=`9`\)/u.test(eveSpecDefault),
    "🔴 3: …but only when the operator set neither WORKFLOW_SPEC_VERSION nor WORKFLOW_SEALED_LOG — an operator value wins, so no deployment is guaranteed spec 9",
  );
  ok(
    /applyWorkflowSpecVersionDefault\(\);`,\w+\.createWorldSource/u.test(eveCompiledArtifacts),
    "3: eve applies the default in the compiled entry BEFORE it constructs the World, which reads the setting at creation",
  );
  ok(
    specVersionContract.includes("| unset | any | {@link SPEC_VERSION_DEFAULT_MINTED} (8) |") &&
      specVersionContract.includes("| `9` | not `true` | the default, with a warning once per process |"),
    "3: Workflow's own default is still spec 8, and a World without the in-band fence ignores `9` — eve's default is what moves OE's runs",
  );
  ok(
    /maxConcurrency:!0,[\w:!,]*inBandFence:!0/u.test(vercelWorld) && /maxConcurrency:!0,inBandFence:!0/u.test(localWorld),
    "3: the Vercel and the local World both declare maxConcurrency and inBandFence in their capabilities",
  );
  ok(
    /(\w+)=\w+\(process\.env,\{inBandFence:!0\}\);[^]{0,80}?specVersion:\1/u.test(vercelWorld) &&
      /(\w+)=\{[^;]{0,250}inBandFence:!0\};return\{specVersion:\w+\(process\.env,\{inBandFence:\1\.inBandFence\}\)/u.test(localWorld),
    "🔴 3: …and both MINT with `{ inBandFence: true }` — without it mintedSpecVersion never returns 9, so this is what lets eve's default take effect on both",
  );
  ok(
    specVersionContract.includes("so a run never changes orchestrator"),
    "🔴 3: a run keeps the spec it was created with — a session run created under eve 0.x never moves to spec 9 (it stays at an earlier spec, <= 8), unserialized, after the upgrade",
  );
  ok(
    queueContract.includes("Messages of earlier runs (spec <= 8) are not serialized"),
    "3: …and eve states that spec 8 runs are not serialized",
  );
  ok(
    queueContract.includes("it can run beside the run's serialized orchestrator") &&
      queueContract.includes("which can include running the body of an inline step a second time; it does not corrupt the log"),
    "🔴 3: even on a spec 9 run, an unstamped message from another producer can run BESIDE the serialized orchestrator, and eve names the cost: an inline step body can run a second time",
  );
  ok(
    worldCapabilities.includes("The runtime takes no fast path from it: one orchestrator at a time is a frequency mechanism"),
    "🔴 3: eve's core runtime still takes NO fast path from per-run serialization — it calls one orchestrator at a time a FREQUENCY mechanism, so neither may we read it as a guarantee",
  );
  ok(
    vercelWorld.includes("process.env.WORKFLOW_SEQUENTIAL_REPLAYS===`1`"),
    "3: the Vercel World still gates its per-run-topic variant on WORKFLOW_SEQUENTIAL_REPLAYS===\"1\" — the default serialization is the concurrency key, not this flag",
  );
  ok(
    !workflowRuntime.includes("WORKFLOW_SEQUENTIAL_REPLAYS"),
    "3 control: the token is absent from the CORE runtime entry — the gate lives in the World, which is why the leg above reads that file and not this one",
  );
}

{
  ok(
    sessionTurn.includes("Executes conversational turns inside the owning session workflow") && sessionTurn.includes("There is no child run"),
    "4: eve runs each turn INSIDE the owning session workflow, with no child run",
  );
  ok(
    sessionEntry.includes("The current owner directly executes every turn") &&
      sessionEntry.includes("An idle owner can transfer its settled checkpoint and hooks to an exact successor deployment"),
    "🔴 4: …but the owner can move: an IDLE session transfers to a successor run, so the turns of one session are no longer always steps of ONE run",
  );
  ok(
    sessionHandoff.includes("on this deployment after compaction so no single run's event log grows with the session"),
    "4: the move happens on the SAME deployment too, after compaction — not only on an upgrade",
  );
  ok(
    sessionHandoff.includes("Until the attempt settles the owner runs no turn.") &&
      sessionHandoff.includes("Only one run per attempt can hold this; a successor that loses it exits untouched."),
    "4: eve states the turn exclusion ACROSS a move: the owner runs no turn until the attempt settles, and one run per attempt holds the claim",
  );
  ok(
    turnStepContract.includes("Runs a bounded batch of harness model steps inside one durable `\"use step\"` boundary"),
    "4: a turn's model work runs in `turnStep`, ONE durable step per batch — so two turns are two DIFFERENT steps, outside §1's (run, step) key",
  );
  ok(
    /\.maxRetries=\d/u.test(read("internal/workflow/builtins.js")),
    "4 control: eve sets a step's retries as `<step>.maxRetries=<n>` in the file that declares it — so the absence check below reads the right file",
  );
  ok(
    /async function turnStep\(\w+\)\{"use step";/u.test(turnStepJs) &&
      !turnStepJs.includes("maxRetries") &&
      /runTurnStep:\w+=>turnStep\(\w+\)/u.test(read("execution/session/workflow-host.js")) &&
      !read("execution/session/workflow-host.js").includes("maxRetries"),
    "🔴 4: `turnStep` declares no `maxRetries`, so it keeps the default retries — and eve takes such a step to be idempotent:",
  );
  ok(
    spec9StepExecutor.includes("A step that allows retries (`maxRetries > 0`, the default) is taken to be idempotent and to survive running again after a lost write."),
    "🔴 4: …\"taken to be idempotent and to survive running again\". A turn body can therefore run again, and a side effect in it must carry its own fence",
  );
  ok(
    /for\(;;\)\{[^]{0,400}?await \w+\.advanceWithHistory\(\w+=>\{let run=\w+=>this\.input\.host\.runTurnStep\(/u.test(sessionTurnJs),
    "4: the session loop AWAITS each turn step before the next — the HAPPY path is sequential, which is why this residual is about re-execution and not about ordinary dispatch",
  );
  const turnContracts = [sessionTurn, sessionEntry, sessionHandoff, turnStepContract];
  for (const nearMiss of ["one turn at a time", "turns never overlap", "exclusive owner", "at most one turn", "exactly once"]) {
    ok(
      turnContracts.every((src) => !src.includes(nearMiss)),
      `4: the session contracts do NOT state "${nearMiss}"`,
    );
  }
  ok(
    workflowRuntime.includes("Re-executing inline steps owned by this queue message"),
    "🔴 4: the spec 8 redelivery-recovery path is still shipped — a previous delivery that crashed mid-body has its inline step bodies RE-EXECUTED (<repo root>/tests/integration/redelivery-storm-guard.ts watches for its storm)",
  );
  const uniquenessClaims = ["at most one running instance", "at-most-one running", "only one invocation per run", "exactly one live instance"];
  for (const claim of uniquenessClaims) {
    ok(
      !queueContract.includes(claim) &&
        !worldCapabilities.includes(claim) &&
        !spec8Ownership.includes(claim) &&
        !spec9CreatorRules.includes(claim),
      `4: none of the queue, capability, step-ownership and creator contracts states "${claim}" — one of four exact phrasings, so this is a hint and not a proof. If it ever reds, re-read OPE-1281 step 7a: the residual may be closable by citation`,
    );
  }
}

{
  const projection = read("protocol/session-projection.js");
  const fold = read("protocol/session-projection/fold.js");
  const projectionState = read("harness/session-machine/current.js");
  ok(
    /let (\w+)=\w+\.view\.session\.turnCount\s*;?\s*return\{sequence:\1,stepIndex:0,turnId:`turn_\$\{\1\}`\}/u.test(projection),
    "🔴 5: eve mints a new turn's id as `turn_${turnCount}` — the shape operational/credential-grant-rows.ts grantRefundTurnOrdinal parses",
  );
  ok(
    !/turnId:`turn_\$\{[^}]*sequenceId[^}]*\}`/u.test(projection),
    "5: …and the near miss `turn_${x.sequenceId}` is absent, so the search above discriminates rather than matching any `turn_` interpolation",
  );
  const sessionView = read("harness/session-machine/view.js");
  ok(
    /function activeTurnId\((\w+)\)\{return \1\.turnId===``\?`turn_\$\{\1\.sequence\}`/u.test(sessionView) &&
      /function turnPosition\(\w+\)\{let\{sequence:\w+,stepIndex:\w+\}=turnCoordinates\(/u.test(sessionView),
    "🔴 5: the session machine writes `turn.started` with the id `turn_${sequence}`, and takes `sequence` from turnCoordinates — the mint site the ordinal reaches OE through",
  );
  ok(
    /function receive\(\w+,\w+\)\{let\{projection:(\w+)\}=\w+;let (\w+)=turnPosition\(\1\);let (\w+)=activeTurnId\(\2\);[^]{0,400}?\2\.turnId===``&&\w+\.push\(fact\(`turn\.started`,\{[^}]*turnId:\3\}\)\)/u.test(
      read("harness/session-machine/transitions.js"),
    ),
    "🔴 5: …and `receive()`, the one writer of `turn.started`, writes exactly that id — not one it mints itself",
  );
  ok(
    /let (\w+)=turnPosition\([^;]*\);let \w+=activeTurnId\(\1\)/u.test(read("context/providers/session.js")),
    "5: the session context hands a turn its key through the same activeTurnId(turnPosition(…)) — the id OE's turn claim reads",
  );
  ok(
    !/turn_\$\{[^}]*sequenceId[^}]*\}/u.test(sessionView),
    "5: …and the near miss `turn_${x.sequenceId}` is absent from the session machine too",
  );
  ok(
    /function turnSequence\(\w+\)\{let \w+=\/\^turn_\(\\d\+\)\$\/\.exec\(\w+\)/u.test(projection),
    "5: eve parses the ordinal back out of `turn_<n>` itself — the id shape is eve's own contract, not an OE reading of it",
  );
  const advances = fold.match(/case`turn\.started`:[^]{0,120}?turnCount:\w+\.session\.turnCount\+1/gu) ?? [];
  ok(
    advances.length === 1,
    "🔴 5: the session projection ADVANCES turnCount by one on each `turn.started` — a later turn therefore carries a larger ordinal than an earlier one",
  );
  ok(
    (fold.match(/turnCount/gu) ?? []).length === 3 &&
      fold.includes("turnCount:0") &&
      !/turnCount:[^,}]*-\s*1/u.test(projection),
    "🔴 5: …and the fold writes turnCount nowhere else (its only other write is the initial `turnCount:0`), so within the fold the ordinal is monotonic and `strictly later` is a sound reading of `numerically greater`",
  );
  ok(
    /function saveProjection\(\w+,\w+\)\{return\{\.\.\.\w+,state:\{\.\.\.\w+\.state,\[SESSION_PROJECTION_STATE_KEY\]:\w+\}\}\}/u.test(projectionState),
    "5: the projection, turnCount with it, is saved in the session state",
  );
  ok(
    flat(read("execution/session/checkpoint.d.ts")).includes("readonly sessionState: DurableSessionState;"),
    "5: …and a session checkpoint carries that session state — the source-level reason a successor run continues the count (a source pin, not a behavioural proof)",
  );
  const legacyImport = read("execution/legacy-session/snapshot.js");
  ok(
    legacyImport.includes("turnCount:t.sequence+1") && legacyImport.includes("turnCount:t.sequence}}"),
    "🔴 5: a session imported through the legacy driver continues its 0.x turn sequence, with or without a turn in flight",
  );
  const preV27 = read("execution/session/pre-v27-checkpoint.js");
  ok(
    flat(read("execution/session/pre-v27-checkpoint.d.ts")).includes("Turns the earlier owner numbered: the next turn takes the next number.") &&
      /readCount\(\w+\.sequence\)/u.test(preV27) &&
      /turnCount:(\w+),\.\.\.\1>0&&\{latestTurnId:`turn_\$\{String\(\1-1\)\}`\}/u.test(preV27),
    "🔴 5: a session imported from a pre-v27 checkpoint reads the earlier owner's sequence and continues it — the count does not restart at 0 on the upgrade",
  );
  ok(
    sessionTurn.includes("inside the owning session workflow"),
    "5: a turn runs inside ONE session's workflow — the ordinal this section pins counts turns within that session, never across sessions",
  );
}

console.log(
  `✓ eve-turn-concurrency — ${passed} assertions (eve 1.0.0-rc.18 states no at-most-one-turn-body guarantee: it opts new runs into one orchestrator per run, a single-writer guarantee on the run's LOG that an operator env value can turn off and a pre-upgrade run never gets; the single-flight is per process, a background step's cross-instance duplicate runs its body twice, and a turn step is taken to be idempotent; §5 pins the advancing turn_<n> ordinal the OPE-1281 claim key rests on)`,
);
