import assert from "node:assert/strict";

import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import {
  WORKER_CAPABILITY_GROUPS,
  WORKER_INDEX_LIFECYCLE,
  WORKER_INDEX_MACHINERY,
  WORKER_INDEX_SEAT_VERBS,
  checkWorkerCapabilityGroups,
  checkWorkerSeatReservedTools,
  renderWorkerCapabilityIndex,
  workerOnlyTools,
} from "../agent/access/worker-capabilities.js";
import { DM_SEAT_CARVE_IN } from "../agent/access/lean-seat.js";
import { allowedOnWorkerSeat, restrictToolsetForWorkerSeat } from "../agent/access/worker-seat.js";
import { WORKER_ONLY_TOOLS_STANDING, WORKER_ONLY_TOOLS_THREAD } from "../agent/access/worker-capability-index.generated.js";
import type { WindowGrain } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

eq(checkWorkerCapabilityGroups(), [], "the grouping is TOTAL + duplicate-free + stale-free over the real posture tables");

const surface = new Set<string>([...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS]);
const grouped = new Set(WORKER_CAPABILITY_GROUPS.flatMap((g) => g.tools));
const excluded = new Set([...WORKER_INDEX_MACHINERY, ...WORKER_INDEX_LIFECYCLE, ...WORKER_INDEX_SEAT_VERBS]);
eq(
  [...surface].filter((t) => !grouped.has(t) && !excluded.has(t)).sort(),
  [],
  "every authored tool is either grouped or deliberately excluded (machinery / lifecycle / the seat's own verbs)",
);
eq([...grouped].filter((t) => excluded.has(t)).sort(), [], "no tool is both grouped and excluded");
ok(WORKER_CAPABILITY_GROUPS.every((g) => g.headline.length > 0 && g.tools.length > 0), "every group carries a headline and at least one tool");
eq(
  WORKER_CAPABILITY_GROUPS.map((g) => g.id).length,
  new Set(WORKER_CAPABILITY_GROUPS.map((g) => g.id)).size,
  "group ids are unique",
);

const craftedGated: Record<string, readonly WindowGrain[]> = { widget: ["task"] };
const craftedUngated = new Set(["reply"]);
ok(
  checkWorkerCapabilityGroups(craftedGated, craftedUngated, []).some((p) => p.includes('tool "widget" has NO worker-capability group')),
  "an ungrouped tool is reported (there is deliberately no default)",
);
ok(
  checkWorkerCapabilityGroups(craftedGated, craftedUngated, [
    { id: "a", headline: "h", tools: ["widget"] },
    { id: "b", headline: "h", tools: ["widget"] },
  ]).some((p) => p.includes("is in BOTH worker-capability groups")),
  "a tool in two groups is reported",
);
ok(
  checkWorkerCapabilityGroups(craftedGated, craftedUngated, [{ id: "a", headline: "h", tools: ["widget", "ghost"] }]).some((p) =>
    p.includes('names "ghost", which is in neither window-gate posture table'),
  ),
  "a stale group row is reported",
);

eq([...WORKER_ONLY_TOOLS_STANDING], [...workerOnlyTools("standing")], "the committed standing index matches the posture tables");
eq([...WORKER_ONLY_TOOLS_THREAD], [...workerOnlyTools("thread")], "the committed thread index matches the posture tables");
ok(WORKER_ONLY_TOOLS_STANDING.length > 0, "a conversational seat is genuinely missing capability a worker has (an empty index would mean the cut did nothing)");

const withFullKit = (kit: readonly WindowGrain[]): Record<string, readonly WindowGrain[]> =>
  Object.fromEntries(
    Object.entries(WINDOW_GATED_TOOLS).map(([name, grains]) => [
      name,
      ["agent", "spawn_thread_session", "complete_thread"].includes(name) ? grains : kit,
    ]),
  );
for (const grain of ["standing", "thread"] as const) {
  eq(
    [...workerOnlyTools(grain, withFullKit(["task"]), WINDOW_UNGATED_TOOLS)],
    [...workerOnlyTools(grain, withFullKit(["task", "native"]), WINDOW_UNGATED_TOOLS)],
    `the ${grain} index is identical under both wide-hands matrices (OE_ONESHOT_AGENT cannot silently change what a seat is told it can route)`,
  );
}

eq(
  [...WORKER_ONLY_TOOLS_STANDING],
  [...WORKER_ONLY_TOOLS_THREAD],
  "a standing seat and a thread seat see the SAME worker capability — the two grains differ only on grain-lifecycle verbs, which the index excludes (plan §3/§4.1)",
);

eq(renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "none"), "", 'a seat that cannot delegate renders NOTHING (route "none") — an index there is an instruction to bluff');
eq(renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "file-tools"), "", 'a seat holding the file tools itself renders NOTHING (route "file-tools") — telling a worker to delegate is backwards');
eq(renderWorkerCapabilityIndex([], "agent"), "", "no worker-only capability ⇒ no block (nothing to say)");

const standingBlock = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session");
ok(standingBlock.startsWith("## What a worker can do that you cannot"), "the block leads with its heading");
ok(standingBlock.includes("`agent`") && standingBlock.includes("`spawn_thread_session`"), "a standing seat is told BOTH verbs — the blocking one and the async one");
ok(/Brief it by INTENT, not by tool/.test(standingBlock), "the block asks for intent-shaped briefs (plan's 'achieve X, not use tool Y' ruling)");

const threadBlock = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_THREAD, "agent");
ok(!threadBlock.includes("spawn_thread_session"), "a THREAD seat is never told to use spawn_thread_session — it is standing-only (no recursive thread trees, plan §4.1)");
ok(threadBlock.includes("`agent`"), "a thread seat is still told its own delegation verb");

for (const name of grouped) {
  if (WORKER_ONLY_TOOLS_STANDING.includes(name)) continue;
  ok(!standingBlock.includes("`" + name + "`"), `the block does not name "${name}" — it is not worker-only from a standing seat`);
}

ok(!/BLOCKS this turn/.test(standingBlock), "🔴 OPE-1440: the blocking claim is GONE — it is the sentence that would strand a seat waiting for a result that arrives on a later turn");
ok(/does NOT block/.test(standingBlock), "…and the block says so in as many words, rather than leaving the old claim merely unstated");
ok(/task receipt/.test(standingBlock), "the seat is told what the call hands back — a receipt, not the worker's answer");
ok(/`done: false`/.test(standingBlock), "the acknowledge route is named exactly: `reply` with `done: false` keeps the wake open for the real answer");
ok(/arrives as a NEW message on a later turn/.test(standingBlock), "the seat is told WHERE the result appears — a later turn, not this one");
ok(!standingBlock.includes("`task_peek`"), "🔴 OPE-904: the prompt names NO read verb — eve owns that steer, and the tool it named is deleted at eve 0.40.0");
ok(/that message tells you how to read its output/.test(standingBlock), "…and points the seat at the completion message, which is the one instruction true on every eve version");
ok(standingBlock.includes("`task_cancel`"), "the STOP verb is named — `task_cancel` is how a seat drops work it no longer needs");
ok(!standingBlock.includes("`task_update`"), "🔴 `task_update` is the CHILD's verb and is NEVER offered to a seat — naming it would be the dead-affordance class OPE-359 removed");
ok(!standingBlock.includes("`task_sleep`"), "`task_sleep` is not named either — pausing its own delegated work is a worker decision, not a routing one (OPE-583)");
ok(/which request the result answers/.test(standingBlock), "🔴 OPE-555 risk 4: the wrong-thread mitigation is IN the copy — a completion notice carries no thread of its own");
ok(/`agentId` is refused/.test(standingBlock), "🔴 OPE-593: the copy states the refusal — eve's own prompt still teaches `agentId`, so OE must contradict it out loud");
ok(/A worker does ONE job/.test(standingBlock), "…and states the invariant the refusal protects: a delegated worker is single-turn");
ok(
  !/call \`agent\` with that worker's/.test(standingBlock) && !/with that worker's `agentId`/.test(standingBlock),
  "🔴 OPE-593: the OPE-564 teaching sentence is GONE — a seat told how to continue would try, and a refused call it was taught to make is a retry loop",
);
ok(/put everything the new worker needs in its brief/.test(standingBlock), "…and the copy names the route that replaces continuation, so the refusal is actionable");

ok(/does NOT block/.test(threadBlock), "a thread seat is told the same return shape — the shape is build-wide, not per grain");
ok(!/BLOCKS this turn/.test(threadBlock), "…and the retired blocking claim is absent there too");
ok(!threadBlock.includes("spawn_thread_session"), "…and it STILL never hears about the standing-only spawner (no recursive thread trees)");

const SHARED_FS_SENTENCE =
  "Every worker shares ONE filesystem with you and with every other worker running beside it. " +
  "Give each one its own directory or file scope in the brief, or two of them will write over each other.";

for (const [label, block] of [
  ["the standing prompt", standingBlock],
  ["the thread prompt", threadBlock],
  ["the standing prompt with no async verb", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent")],
] as const) {
  ok(block.includes(SHARED_FS_SENTENCE), `🔴 OPE-584: ${label} carries the shared-filesystem sentence VERBATIM — one mechanism, one sentence, every delegating prompt`);
}

for (const route of ["none", "file-tools"] as const) {
  ok(
    !renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, route, undefined, "spawn_thread_session").includes("shares ONE filesystem"),
    `a seat on route "${route}" is told nothing about a shared filesystem — it starts no workers`,
  );
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session"),
  standingBlock,
  "the render is byte-stable across calls — the prompt cache must not churn turn to turn",
);

const PERMISSION_STEER =
  "Permission works the same way. Do not refuse an ask because you judge the person is not allowed it, " +
  "or because the answer looks internal. You do not hold these verbs, so you do not hold their gates: " +
  "a verb that needs standing checks it when the worker runs it, and refuses with a reason the " +
  "person can act on. A refusal you write instead never reaches that gate, so the person gets your " +
  "guess in place of the real reason. Route the ask, let the verb answer, and relay what it says — " +
  "its refusal included.";

ok(
  !/audit/i.test(PERMISSION_STEER),
  "🔴 the permission steer makes NO audit claim — `memory_admin_list` is unaudited by design, so 'leaves no audit row' would be false on the leg that motivated the line",
);

for (const [label, block] of [
  ["the standing prompt", standingBlock],
  ["the thread prompt", threadBlock],
  ["the standing prompt with no async verb", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent")],
] as const) {
  ok(block.includes(PERMISSION_STEER), `🔴 OPE-651: ${label} carries the permission steer VERBATIM — a seat must not pre-empt a gate it does not hold`);
}

ok(
  /never say you cannot do something that a worker can/.test(standingBlock),
  "🔴 the CAPABILITY refusal rule survives the permission addition — the two forbid different moves and the block needs both",
);

for (const route of ["none", "file-tools"] as const) {
  const block = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, route, undefined, "spawn_thread_session");
  eq(block, "", `a seat on route "${route}" renders no block at all, so it never receives the permission steer either`);
  ok(!block.includes("Permission works the same way"), `…asserted directly on route "${route}" as well, so a later non-empty render on that route cannot smuggle the steer in`);
}

for (const verb of WORKER_INDEX_SEAT_VERBS) {
  ok(!WORKER_ONLY_TOOLS_STANDING.includes(verb), `"${verb}" is the seat's own verb and is never listed as worker-only`);
}

{
  const carveIn = [...DM_SEAT_CARVE_IN];
  ok(carveIn.length > 0, "§7 precondition: the carve-in names at least one verb, so the loop below asserts something");

  for (const verb of carveIn) {
    ok(
      WINDOW_UNGATED_TOOLS.has(verb),
      `🔴 §7 PREMISE: "${verb}" is an UNGATED row — which is why a worker mounted it, and why absence had to be added rather than assumed`,
    );
    eq(allowedOnWorkerSeat(verb), false, `🔴 §7 "${verb}" is NOT allowed on a delegated worker — containment, not routing`);
  }

  const toolset: Record<string, unknown> = { post_message: {}, bash: {} };
  for (const verb of carveIn) toolset[verb] = {};
  const removed = restrictToolsetForWorkerSeat(toolset);
  for (const verb of carveIn) {
    ok(!(verb in toolset), `🔴 §7 the worker's assembled toolset no longer HOLDS "${verb}" — absence, so there is no refusal for an injected instruction to argue with`);
    ok(removed.includes(verb), `…and the removal is REPORTED, so audit/worker-toolset.ts records it`);
  }
  ok("post_message" in toolset, "🔴 §7 NEGATIVE CONTROL: an ungated verb that is NOT a carve-in survives on a worker");
  ok("bash" in toolset, "…and so does the worker's own wide-hands kit");

  eq(checkWorkerSeatReservedTools(), [], "🔴 §7 the reserved set and the DM carve-in name the SAME verbs today");
  eq(
    checkWorkerSeatReservedTools(new Set([...DM_SEAT_CARVE_IN, "future_dm_verb"])).length,
    1,
    "🔴 §7 …and a carve-in verb with no reserved entry REDS — the drift this join exists to catch",
  );
  eq(
    checkWorkerSeatReservedTools(new Set(["link_identity"]), new Set(["link_identity", "stray_verb"])).length,
    1,
    "🔴 §7 …and so does a reserved entry that is not a carve-in verb, so the set cannot grow into a second withheld list",
  );
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session"),
  standingBlock,
  "the render is a pure function of its inputs — byte-stable across calls, so the prompt cache does not churn turn to turn",
);

console.log(`✓ worker-capabilities: ${n} assertions passed (${WORKER_ONLY_TOOLS_STANDING.length} worker-only tools across ${WORKER_CAPABILITY_GROUPS.length} capability groups)`);
