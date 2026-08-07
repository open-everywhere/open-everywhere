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

for (const verb of WORKER_INDEX_SEAT_VERBS) {
  ok(!WORKER_ONLY_TOOLS_STANDING.includes(verb), `"${verb}" is the seat's own verb and is never listed as worker-only`);
}

eq(
  renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session"),
  standingBlock,
  "the render is a pure function of its inputs — byte-stable across calls, so the prompt cache does not churn turn to turn",
);

console.log(`✓ worker-capabilities: ${n} assertions passed (${WORKER_ONLY_TOOLS_STANDING.length} worker-only tools across ${WORKER_CAPABILITY_GROUPS.length} capability groups)`);
