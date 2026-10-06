import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let passed = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  passed++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const read = (rel: string): string => readFileSync(join(eveRoot, "dist/src", rel), "utf8");

const flat = (src: string): string => src.replace(/\n\s*\*/g, " ").replace(/\s+/g, " ");

const workflowRuntime = read("compiled/@workflow/core/runtime.js");
const vercelWorld = read("compiled/@workflow/world-vercel/index.js");
const queueContract = flat(read("compiled/@workflow/world/queue.d.ts"));
const worldCapabilities = flat(read("compiled/@workflow/world/interfaces.d.ts"));
const stepOwnership = flat(read("compiled/@workflow/core/runtime/step-ownership.d.ts"));
const singleFlight = flat(read("compiled/@workflow/core/runtime/step-single-flight.d.ts"));
const sessionTurn = flat(read("execution/session/turn.d.ts"));
const turnStepContract = flat(read("execution/session/turn-step.d.ts"));
const sessionEntry = flat(read("execution/session/entry.d.ts"));
const sessionTurnJs = read("execution/session/turn.js");

{
  const IN_FLIGHT_WARNING = "Step execution already in flight in this process";
  ok(
    workflowRuntime.includes(IN_FLIGHT_WARNING),
    "1: eve's step guard still announces itself — the runtime carries the in-flight single-flight branch",
  );
  for (const nearMiss of ["already in flight in this deployment", "already in flight in this run", "already in flight globally"]) {
    ok(!workflowRuntime.includes(nearMiss), `1: the guard is NOT scoped "${nearMiss}" — a cross-instance guard would read differently`);
  }
  const warnSite = workflowRuntime.slice(workflowRuntime.indexOf(IN_FLIGHT_WARNING), workflowRuntime.indexOf(IN_FLIGHT_WARNING) + 220);
  ok(
    /workflowRunId\s*:\s*\w+\s*,\s*stepId\s*:\s*\w+/.test(warnSite),
    "1: the guard keys on (workflowRunId, stepId) — the pair, so two DIFFERENT steps of one run are never mutually excluded",
  );
  ok(
    singleFlight.includes("same run + step correlation ID") && singleFlight.includes("already in flight in this process"),
    "1: eve's own contract states the key and the scope — run + step correlation ID, in this process",
  );
  ok(
    singleFlight.includes("returns `{ type: 'skipped' }`"),
    "1: the loser acks WITHOUT running the body — so within one process a same-step redelivery does not double-execute",
  );
}

{
  const EXCLUSIVITY_CLAUSE =
    "only a delivery of that same message may re-execute the step before the ownership lease expires (crash recovery via queue redelivery)";
  ok(
    queueContract.includes("uses it as a liveness lease"),
    "2: eve calls inline step ownership a LIVENESS lease, keyed on the queue messageId",
  );
  ok(
    queueContract.includes(EXCLUSIVITY_CLAUSE),
    "🔴 2: eve DOES state an exclusivity — but a bounded one: only the owning message may re-execute the step BEFORE THE LEASE EXPIRES. The bound is the finding, not the exclusivity",
  );
  ok(
    stepOwnership.includes("0 means the lease has expired") && stepOwnership.includes("dispatch falls back to the immediate enqueue"),
    "2: an expired (or unstampable) lease falls back to the IMMEDIATE enqueue — a slow owner that is still alive does not hold the step",
  );
  ok(
    queueContract.includes("A World whose queue mints a fresh ID per delivery degrades gracefully") &&
      queueContract.includes("adding recovery latency but never wedging or duplicating"),
    "2: eve promises no duplication for the DEGRADED World (a fresh messageId per delivery), where owner redeliveries fall to the delayed backstop — one step under one message, not two turns of one session",
  );
  for (const nearMiss of ["ownership lock", "exclusive lease", "mutual exclusion"]) {
    ok(!stepOwnership.includes(nearMiss) && !queueContract.includes(nearMiss), `2: eve does NOT describe ownership as "${nearMiss}"`);
  }
}

{
  ok(
    worldCapabilities.includes("WORKFLOW_SEQUENTIAL_REPLAYS=1") && worldCapabilities.includes("serialize a run's"),
    "3: per-run serialization exists only as an OPT-IN World capability behind WORKFLOW_SEQUENTIAL_REPLAYS",
  );
  ok(
    worldCapabilities.includes("which a runtime process cannot verify today"),
    "3: …whose build-time half a running process cannot verify — so no code may read it as a guarantee",
  );
  ok(
    worldCapabilities.includes("The core runtime therefore does not yet take any fast path from this"),
    "🔴 3: eve's core runtime takes NO fast path from the capability — it does not assume one orchestrator invocation per run, so neither may we",
  );
  ok(
    worldCapabilities.includes("it exists so a future build-verified signal can be combined with it"),
    "3: …and eve says what the capability IS for — a FUTURE build-verified signal. Pinned so a rewrite of the one paragraph where eve would state the guarantee reds this leg",
  );
  ok(
    vercelWorld.includes("process.env.WORKFLOW_SEQUENTIAL_REPLAYS===`1`"),
    "🔴 3: the Vercel World gates the serialization on WORKFLOW_SEQUENTIAL_REPLAYS===\"1\" — OFF unless set, so no deployment inherits it. If eve ever makes it the default, this leg reds and the residual may be closable",
  );
  ok(
    !workflowRuntime.includes("WORKFLOW_SEQUENTIAL_REPLAYS"),
    "3 control: the token is absent from the CORE runtime — the gate lives in the World, which is why the leg above reads that file and not this one",
  );
}

{
  ok(
    sessionTurn.includes("Executes conversational turns inside the owning session workflow") && sessionTurn.includes("There is no child run"),
    "4: eve runs each turn INSIDE the owning session workflow, with no child run — two turns of one session are steps of ONE run",
  );
  ok(
    sessionEntry.includes("The current owner directly executes every turn"),
    "4: …and the session entrypoint says the same: the owner executes every turn directly",
  );
  ok(
    turnStepContract.includes("Runs a bounded batch of harness model steps inside one durable `\"use step\"` boundary"),
    "4: a turn's model work runs in `turnStep`, ONE durable step per batch — so two turns are two DIFFERENT steps, outside §1's (run, step) key",
  );
  ok(
    /for\(;;\)\{[^]{0,200}?await \w+\.advanceWithHistory\(\w+=>turnStep\(/u.test(sessionTurnJs),
    "4: the session loop AWAITS each turnStep before the next — the HAPPY path is sequential, which is why this residual is about redelivery and not about ordinary dispatch",
  );
  for (const nearMiss of ["one turn at a time", "turns never overlap", "exclusive owner"]) {
    ok(
      !sessionTurn.includes(nearMiss) && !sessionEntry.includes(nearMiss) && !turnStepContract.includes(nearMiss),
      `4: the session contracts do NOT state "${nearMiss}"`,
    );
  }
  ok(
    workflowRuntime.includes("Re-executing inline steps owned by this queue message"),
    "🔴 4: the redelivery-recovery path is real and shipped — a previous delivery that crashed mid-body has its inline step bodies RE-EXECUTED (<repo root>/tests/integration/redelivery-storm-guard.ts watches for its storm)",
  );
  const uniquenessClaims = ["at most one running instance", "at-most-one running", "only one invocation per run", "exactly one live instance"];
  for (const claim of uniquenessClaims) {
    ok(
      !queueContract.includes(claim) && !worldCapabilities.includes(claim) && !stepOwnership.includes(claim),
      `4: none of the three contracts read here states "${claim}" — one of four exact phrasings, so this is a hint and not a proof. If it ever reds, re-read OPE-1281 step 7a: the residual may be closable by citation`,
    );
  }
}

{
  const emission = read("harness/emission.js");
  const mint = /turn_\$\{[A-Za-z_$][\w$]*\.sequence\}/u;
  const mintNearMiss = /turn_\$\{[A-Za-z_$][\w$]*\.sequenceId\}/u;
  ok(
    mint.test(emission),
    "🔴 5: eve mints `turn.id` as `turn_${sequence}` — the shape operational/credential-grant-rows.ts grantRefundTurnOrdinal parses",
  );
  ok(
    !mintNearMiss.test(emission),
    "5: …and the near miss `turn_${x.sequenceId}` is absent, so the search above discriminates rather than matching any `turn_` interpolation",
  );

  const advances = emission.match(/sequence:\s*[A-Za-z_$][\w$]*\.sequence\+1/gu) ?? [];
  ok(
    advances.length > 0,
    `🔴 5: the emission state ADVANCES its sequence (${advances.length} site(s) returning \`sequence + 1\` — the turn epilogue and the recoverable-failure arm) — a later turn therefore carries a larger ordinal than an earlier one`,
  );
  ok(
    !/sequence:\s*[A-Za-z_$][\w$]*\.sequence-1/u.test(emission),
    "🔴 5: …and NOTHING decrements it, so the ordinal is monotonic within one session and `strictly later` is a sound reading of `numerically greater`",
  );

  ok(
    sessionTurn.includes("inside the owning session workflow"),
    "5: a turn runs inside ONE session's workflow — the ordinal this section pins counts turns within that session, never across sessions",
  );
}

console.log(
  `✓ eve-turn-concurrency — ${passed} assertions (eve 0.71.0 states no at-most-one-turn-per-session guarantee in the runtime, queue, world-capability, step-ownership and session-turn contracts read here: in-process single-flight keyed on one step, an exclusivity bounded by a lease that expires, per-run serialization gated OFF on an env var, turns as separate steps of the session's run; §5 pins the advancing turn_<n> ordinal the OPE-1281 claim key rests on)`,
);
