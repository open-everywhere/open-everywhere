import assert from "node:assert/strict";

import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import {
  WORKER_CAPABILITY_GROUPS,
  WORKER_INDEX_LIFECYCLE,
  WORKER_INDEX_MACHINERY,
  WORKER_INDEX_SEAT_VERBS,
  checkWorkerCapabilityGroups,
  renderWorkerCapabilityIndex,
  workerOnlyTools,
} from "../agent/access/worker-capabilities.js";
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
      ["agent", "spawn_task", "spawn_thread_session", "complete_task", "complete_thread", "return_result"].includes(name) ? grains : kit,
    ]),
  );
for (const grain of ["standing", "thread"] as const) {
  eq(
    [...workerOnlyTools(grain, withFullKit(["task"]), WINDOW_UNGATED_TOOLS)],
    [...workerOnlyTools(grain, withFullKit(["task", "native"]), WINDOW_UNGATED_TOOLS)],
    `the ${grain} index is identical under both FULL_KIT matrices (OE_ONESHOT_AGENT cannot silently change what a seat is told it can route)`,
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
ok(/BLOCKS this turn/.test(standingBlock), "the block states the synchronous cost of `agent` (plan §2.3 — eve's agent tool blocks, unlike Tag's async Agents)");
ok(/Brief it by INTENT, not by tool/.test(standingBlock), "the block asks for intent-shaped briefs (plan's 'achieve X, not use tool Y' ruling)");

const threadBlock = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_THREAD, "agent");
ok(!threadBlock.includes("spawn_thread_session"), "a THREAD seat is never told to use spawn_thread_session — it is standing-only (no recursive thread trees, plan §4.1)");
ok(threadBlock.includes("`agent`"), "a thread seat is still told its own delegation verb");

for (const name of grouped) {
  if (WORKER_ONLY_TOOLS_STANDING.includes(name)) continue;
  ok(!standingBlock.includes("`" + name + "`"), `the block does not name "${name}" — it is not worker-only from a standing seat`);
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session", false),
  standingBlock,
  "🔴 the flag DEFAULTS to false: passing `false` renders BYTE-IDENTICALLY to omitting the argument",
);

const backgroundBlock = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session", true);
ok(backgroundBlock !== standingBlock, "🔴 OPE-564: the background build renders a DIFFERENT delegation paragraph — without this the flag would be cosmetic");
ok(!/BLOCKS this turn/.test(backgroundBlock), "🔴 OPE-564: the blocking claim is GONE on a background build — it is the sentence that would strand a seat waiting for a result that arrives on a later turn");
ok(/does NOT block/.test(backgroundBlock), "…and the block says so in as many words, rather than leaving the old claim merely unstated");
ok(/task receipt/.test(backgroundBlock), "the seat is told what the call hands back — a receipt, not the worker's answer");
ok(/`done: false`/.test(backgroundBlock), "the acknowledge route is named exactly: `reply` with `done: false` keeps the wake open for the real answer");
ok(/arrives as a NEW message on a later turn/.test(backgroundBlock), "the seat is told WHERE the result appears — a later turn, not this one");
ok(backgroundBlock.includes("`task_peek`"), "the read verb is named — eve's own completion notice tells the seat to peek, so the prompt must too (OPE-583/T1)");
ok(backgroundBlock.includes("`task_cancel`"), "the stop verb is named — the other half of the two lifecycle verbs a seat actually holds");
ok(!backgroundBlock.includes("`task_update`"), "🔴 `task_update` is the CHILD's verb and is NEVER offered to a seat — naming it would be the dead-affordance class OPE-359 removed");
ok(!backgroundBlock.includes("`task_sleep`"), "`task_sleep` is not named either — pausing its own delegated work is a worker decision, not a routing one (OPE-583)");
ok(/which request the result answers/.test(backgroundBlock), "🔴 OPE-555 risk 4: the wrong-thread mitigation is IN the copy — a completion notice carries no thread of its own");
ok(/`agentId` is refused/.test(backgroundBlock), "🔴 OPE-593: the copy states the refusal — eve's own prompt still teaches `agentId`, so OE must contradict it out loud");
ok(/A worker does ONE job/.test(backgroundBlock), "…and states the invariant the refusal protects: a delegated worker is single-turn");
ok(
  !/call \`agent\` with that worker's/.test(backgroundBlock) && !/with that worker's `agentId`/.test(backgroundBlock),
  "🔴 OPE-593: the OPE-564 teaching sentence is GONE — a seat told how to continue would try, and a refused call it was taught to make is a retry loop",
);
ok(/put everything the new worker needs in its brief/.test(backgroundBlock), "…and the copy names the route that replaces continuation, so the refusal is actionable");
ok(/Brief it by INTENT, not by tool/.test(backgroundBlock), "the intent-shaped-brief ruling survives the re-aim");

const backgroundThreadBlock = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_THREAD, "agent", undefined, undefined, true);
ok(/does NOT block/.test(backgroundThreadBlock), "a thread seat is told the same return shape — the flag is build-wide, not per grain");
ok(!backgroundThreadBlock.includes("spawn_thread_session"), "…and STILL never hears about the standing-only spawner (no recursive thread trees)");

const SHARED_FS_SENTENCE =
  "Every worker shares ONE filesystem with you and with every other worker running beside it. " +
  "Give each one its own directory or file scope in the brief, or two of them will write over each other.";

for (const [label, block] of [
  ["the SYNC standing prompt", standingBlock],
  ["the SYNC thread prompt", threadBlock],
  ["the SYNC standing prompt with no async verb", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent")],
  ["the BACKGROUND standing prompt", backgroundBlock],
  ["the BACKGROUND thread prompt", backgroundThreadBlock],
  ["the SYNC `spawn_task` prompt (delegation.oneshotAgent disarmed)", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "spawn_task")],
  [
    "the BACKGROUND `spawn_task` prompt",
    renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "spawn_task", undefined, undefined, true),
  ],
] as const) {
  ok(block.includes(SHARED_FS_SENTENCE), `🔴 OPE-584: ${label} carries the shared-filesystem sentence VERBATIM — one mechanism, one sentence, every delegating prompt`);
}

ok(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "spawn_task").includes("`spawn_task`"),
  "the spawn_task render names its OWN verb — without this the two entries above could be passing on an `agent` paragraph",
);

ok(/BLOCKS this turn/.test(standingBlock), "🔴 the sync prompt still states the BLOCKING return shape — the shared-filesystem line is an addition, never a replacement");
ok(/does NOT block/.test(backgroundBlock), "…and the background prompt still states the non-blocking one");

ok(!/does NOT block/.test(standingBlock) && !/BLOCKS this turn/.test(backgroundBlock), "🔴 the two return-shape claims stay mutually exclusive — a prompt carrying both would be unreadable advice");

for (const route of ["none", "file-tools"] as const) {
  ok(
    !renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, route, undefined, "spawn_thread_session", true).includes("shares ONE filesystem"),
    `a seat on route "${route}" is told nothing about a shared filesystem — it starts no workers`,
  );
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session", true),
  backgroundBlock,
  "the background render is byte-stable across calls as well — the prompt cache must not churn on either build",
);

const PERMISSION_STEER =
  "Permission works the same way. Do not refuse an ask because you judge the person is not allowed it, " +
  "or because the answer looks internal. You do not hold these verbs, so you do not hold their gates: " +
  "each verb checks the caller's own standing when the worker runs it, and refuses with a reason the " +
  "person can act on. A refusal you write instead never reaches that gate, so the person gets your " +
  "guess in place of the real reason. Route the ask, let the verb answer, and relay what it says — " +
  "its refusal included.";

ok(
  !/audit/i.test(PERMISSION_STEER),
  "🔴 the permission steer makes NO audit claim — `memory_admin_list` is unaudited by design, so 'leaves no audit row' would be false on the leg that motivated the line",
);

for (const [label, block] of [
  ["the SYNC standing prompt", standingBlock],
  ["the SYNC thread prompt", threadBlock],
  ["the SYNC standing prompt with no async verb", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent")],
  ["the BACKGROUND standing prompt", backgroundBlock],
  ["the BACKGROUND thread prompt", backgroundThreadBlock],
  ["the SYNC `spawn_task` prompt (delegation.oneshotAgent disarmed)", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "spawn_task")],
  ["the BACKGROUND `spawn_task` prompt", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "spawn_task", undefined, undefined, true)],
] as const) {
  ok(block.includes(PERMISSION_STEER), `🔴 OPE-651: ${label} carries the permission steer VERBATIM — a seat must not pre-empt a gate it does not hold`);
}

ok(
  /never say you cannot do something that a worker can/.test(standingBlock),
  "🔴 the CAPABILITY refusal rule survives the permission addition — the two forbid different moves and the block needs both",
);

for (const route of ["none", "file-tools"] as const) {
  const block = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, route, undefined, "spawn_thread_session", true);
  eq(block, "", `a seat on route "${route}" renders no block at all, so it never receives the permission steer either`);
  ok(!block.includes("Permission works the same way"), `…asserted directly on route "${route}" as well, so a later non-empty render on that route cannot smuggle the steer in`);
}

for (const verb of WORKER_INDEX_SEAT_VERBS) {
  ok(!WORKER_ONLY_TOOLS_STANDING.includes(verb), `"${verb}" is the seat's own verb and is never listed as worker-only`);
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session"),
  standingBlock,
  "the render is a pure function of its inputs — byte-stable across calls, so the prompt cache does not churn turn to turn",
);

console.log(`✓ worker-capabilities: ${n} assertions passed (${WORKER_ONLY_TOOLS_STANDING.length} worker-only tools across ${WORKER_CAPABILITY_GROUPS.length} capability groups)`);
