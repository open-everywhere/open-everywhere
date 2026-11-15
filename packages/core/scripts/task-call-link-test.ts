import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-task-call-link-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

const link = await import("../agent/access/task-call-link.js");
const legacy = await import("../agent/access/subagent-taint.js");
const spawnTaint = await import("../agent/hooks/spawn-taint.js");
const tasks = await import("../agent/access/background-tasks.js");
const { untrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const stop = await import("../agent/channels/work-stop-note.js");
const { readAudit } = await import("../agent/audit/audit.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "default";
const PARENT = "sess-parent-2712";
const TURN = "turn_parent_2712";

const parentCtx = {
  channel: { kind: "channel:slack", continuationToken: "unified:oe-dom:e2e:oe-sup:g1" },
  session: { id: PARENT, auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } } },
  agent: { name: "oe", nodeId: "__root__" },
};

const startedData = (callId: string, taskId: string) => ({ callId, kind: "agent", name: "agent", taskId, turnId: TURN });
const agentStartedData = (callId: string, taskId: string, sessionId: string) => ({ callId, name: "agent", sessionId, streamPath: `/sessions/${sessionId}/stream`, turnId: TURN, taskId });

async function onTurn<T>(fn: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    return await fn();
  });
}

async function dispatch(sessionId: string, callId: string, taskId: string, childSession: string): Promise<void> {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData(callId, taskId))!, sessionId);
  await spawnTaint.noteAgentStarted(tasks.readAgentStarted(agentStartedData(callId, taskId, childSession))!, sessionId);
}

console.log("§1 the join row round-trips, under its old key and shape:");
{
  eq(link.taskCallKey("agent-x"), "oe-task-call:agent-x", "🔴 the key is UNCHANGED from the row the taint module wrote, so a row an earlier deployment wrote still reads back");
  const row = { callId: "call_1", childToken: `subagent:${PARENT}:call_1`, parentSessionId: PARENT, kind: "agent", tool: "agent" };
  await link.rememberTaskCall(ORG, "agent-r1", row);
  eq(await link.taskCallLink(ORG, "agent-r1"), row, "a remembered row reads back whole");
  eq(await link.taskCallLink(ORG, "agent-none"), undefined, "a task with no row answers undefined");
  await getOperationalStore().putTaskResult(ORG, link.taskCallKey("agent-old"), JSON.stringify({ callId: "call_old", childToken: "subagent:s:call_old" }), new Date().toISOString(), 60_000);
  eq(await link.taskCallLink(ORG, "agent-old"), { callId: "call_old", childToken: "subagent:s:call_old" }, "🔴 a row with only the two required fields (an earlier deployment's) still parses");
  await link.rememberTaskCall(ORG, "agent-empty", { callId: "", childToken: "x" });
  eq(await link.taskCallLink(ORG, "agent-empty"), undefined, "a row with an empty call id is never written");
  ok(legacy.taskCallLink === link.taskCallLink && legacy.rememberTaskCall === link.rememberTaskCall && legacy.taskCallKey === link.taskCallKey, "the public `access/subagent-taint.js` names re-export the neutral module's functions, unchanged");
}

console.log("§2 taint off: every task start and agent start writes the row:");
registerSettings({ taint: { mode: "off" } } as never);
try {
  await onTurn(async () => {
    await dispatch(PARENT, "call_off", "agent-off0001", "sess-child-off");
    const row = await link.taskCallLink(ORG, "agent-off0001");
    eq(
      row,
      { callId: "call_off", childToken: `subagent:${PARENT}:call_off`, parentSessionId: PARENT, kind: "agent", tool: "agent", taintOff: true, agentId: "sess-child-off" },
      "🔴 with `taint.mode: \"off\"` the task start writes the join row and the agent start fills the child's session id. On main neither wrote anything",
    );
    await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_off", "agent-off0001"))!, PARENT);
    await new Promise((r) => setTimeout(r, 50));
    const startedRows = (await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION })).filter((r) => (r.detail as { task?: unknown }).task === "agent-off0001");
    eq(startedRows.length, 1, "taint off: a redelivered task start writes ONE `delegation.task_started` row, not two");
    await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_off_2", "agent-off0001"))!, PARENT);
    eq((await link.taskCallLink(ORG, "agent-off0001"))?.callId, "call_off", "a continuation keeps the first dispatch's row, as on a taint-on deployment");
    const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-off0001", status: "completed", agentId: null }, PARENT);
    eq(adopted, false, "🔴 taint off: a settlement with a join row present still adopts NO taint — the write moved, the taint read did not");
    ok(!untrustedIngestedThisTurn(), "…and the turn is still clean");
  });
} finally {
  resetSettingsForTest();
}

console.log("§2b a task dispatched with taint off and settled after a flip to taint on still marks:");
registerSettings({ taint: { mode: "off" } } as never);
try {
  await onTurn(async () => {
    await dispatch(PARENT, "call_flip", "agent-flip0001", "sess-child-flip");
  });
  await legacy.claimSubagentCallClean(ORG, PARENT, "call_flip");
  eq((await legacy.subagentCallTaintRecord(ORG, PARENT, "call_flip"))?.tainted, false, "precondition: the child's clean claim exists");
} finally {
  resetSettingsForTest();
}
await onTurn(async () => {
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-flip0001", status: "completed", agentId: null }, PARENT);
  eq(adopted, true, "🔴 after the flip to taint on, a task dispatched with taint off still reads as LOST and marks the turn — the same answer as before OPE-2712");
  ok(untrustedIngestedThisTurn(), "…and the turn is marked");
});
registerSettings({ taint: { mode: "off" } } as never);
try {
  await onTurn(async () => {
    await dispatch(PARENT, "call_cont_1", "agent-cont0001", "sess-child-cont");
  });
} finally {
  resetSettingsForTest();
}
await onTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_cont_2", "agent-cont0001"))!, PARENT);
});
eq((await link.taskCallLink(ORG, "agent-cont0001"))?.callId, "call_cont_2", "after the flip, a continuation replaces the `taintOff` row with a fresh row under its own call");
eq((await link.taskCallLink(ORG, "agent-cont0001"))?.taintOff, undefined, "…and the fresh row carries no `taintOff`");
await legacy.claimSubagentCallClean(ORG, PARENT, "call_cont_2");
await onTurn(async () => {
  eq(await spawnTaint.adoptTaskTaint({ taskId: "agent-cont0001", status: "completed", agentId: null }, PARENT), false, "🔴 …so its settlement reads the continuation's own clean claim, the same answer as before OPE-2712");
});
await onTurn(async () => {
  await dispatch(PARENT, "call_flip_on", "agent-flip0002", "sess-child-flip-on");
});
await legacy.claimSubagentCallClean(ORG, PARENT, "call_flip_on");
await onTurn(async () => {
  eq(await spawnTaint.adoptTaskTaint({ taskId: "agent-flip0002", status: "completed", agentId: null }, PARENT), false, "control: a task dispatched with taint ON and a clean claim adopts nothing, so the arm above is not a free pass");
});

console.log("§3 taint on: the same row, and the settlement read still fails closed:");
await onTurn(async () => {
  await dispatch(PARENT, "call_on", "agent-on00001", "sess-child-on");
  eq(
    await link.taskCallLink(ORG, "agent-on00001"),
    { callId: "call_on", childToken: `subagent:${PARENT}:call_on`, parentSessionId: PARENT, kind: "agent", tool: "agent", agentId: "sess-child-on" },
    "taint on: the task start and the agent start write the same row as before",
  );
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-on00001", status: "completed", agentId: null }, PARENT);
  eq(adopted, true, "🔴 taint on: a settled child with no marker still fails CLOSED and marks the turn");
});
await onTurn(async () => {
  await link.rememberTaskCall(ORG, "agent-on00002", { callId: "call_x", childToken: "subagent:other:call_x", parentSessionId: "sess-other" });
  eq(await spawnTaint.adoptTaskTaint({ taskId: "agent-on00002", status: "completed", agentId: null }, PARENT), true, "taint on: a row naming another session still reads as lost and marks");
});

console.log("§4 taint off: the work-result wake's key reads back W's child's stop row:");
registerSettings({ taint: { mode: "off" } } as never);
try {
  const W = "sess-w-2712";
  const W_TOKEN = "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g1";
  await onTurn(async () => {
    await dispatch(W, "call_w1", "agent-w000001", "sess-w-child");
  });
  const childOfW = {
    channel: { kind: "unified", continuationToken: `unified:${W_TOKEN}` },
    session: { id: "sess-w-child", turn: { id: "turn-child" }, parent: { sessionId: W, callId: "call_w1" }, auth: { current: { attributes: {} } } },
  };
  ok(await stop.rememberWorkStop(childOfW as never, { connector: "notion", refusal: "Refused: OE's own words." }, "session.started"), "precondition: W's child records the host's stop");
  const childToken = (await link.taskCallLink(ORG, "agent-w000001"))?.childToken;
  ok(childToken !== undefined, "🔴 taint off: W's settlement finds a join row for its task. On main it found none");
  eq(
    childToken === undefined ? undefined : await stop.readWorkStop(ORG, childToken, "call_w1"),
    { connector: "notion", refusal: "Refused: OE's own words." },
    "🔴 …and its `childToken` is the key the child's stop row is stored under. (This leg reads the row and the stop store directly; it does not run `wakeSeatWithWorkResult`.)",
  );
} finally {
  resetSettingsForTest();
}

console.log(`task-call-link: ${n} assertions passed`);
