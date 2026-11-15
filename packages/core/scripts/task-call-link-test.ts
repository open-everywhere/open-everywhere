// proves: AP-MOD-core-access-task-call-link

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
const hub = await import("../agent/hooks/delegation-settlement.js");
const tasks = await import("../agent/access/background-tasks.js");
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
  return await contextStorage.run(new ContextContainer(), async () => await fn());
}

async function dispatch(sessionId: string, callId: string, taskId: string, childSession: string): Promise<void> {
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData(callId, taskId))!, sessionId);
  await hub.noteAgentStarted(tasks.readAgentStarted(agentStartedData(callId, taskId, childSession))!, sessionId);
}

console.log("§1 the join row round-trips, under its old key and shape:");
{
  eq(link.taskCallKey("agent-x"), "oe-task-call:agent-x", "🔴 the key is UNCHANGED from the row the deleted taint module wrote, so a row an earlier deployment wrote still reads back");
  const row = { callId: "call_1", childToken: `subagent:${PARENT}:call_1`, parentSessionId: PARENT, kind: "agent", tool: "agent" };
  await link.rememberTaskCall(ORG, "agent-r1", row);
  eq(await link.taskCallLink(ORG, "agent-r1"), row, "a remembered row reads back whole");
  eq(await link.taskCallLink(ORG, "agent-none"), undefined, "a task with no row answers undefined");
  await getOperationalStore().putTaskResult(ORG, link.taskCallKey("agent-old"), JSON.stringify({ callId: "call_old", childToken: "subagent:s:call_old" }), new Date().toISOString(), 60_000);
  eq(await link.taskCallLink(ORG, "agent-old"), { callId: "call_old", childToken: "subagent:s:call_old" }, "🔴 a row with only the two required fields (an earlier deployment's) still parses");
  await link.rememberTaskCall(ORG, "agent-empty", { callId: "", childToken: "x" });
  eq(await link.taskCallLink(ORG, "agent-empty"), undefined, "a row with an empty call id is never written");
  await getOperationalStore().putTaskResult(ORG, link.taskCallKey("agent-taintoff"), JSON.stringify({ callId: "call_to", childToken: "subagent:s:call_to", taintOff: true }), new Date().toISOString(), 60_000);
  eq(await link.taskCallLink(ORG, "agent-taintoff"), { callId: "call_to", childToken: "subagent:s:call_to" }, "🔴 OPE-2720: an old `taintOff` row still parses, and the retired field is ignored");
}

console.log("§2 taint off: every task start and agent start writes the row:");
registerSettings({ taint: { mode: "off" } } as never);
try {
  await onTurn(async () => {
    await dispatch(PARENT, "call_off", "agent-off0001", "sess-child-off");
    const row = await link.taskCallLink(ORG, "agent-off0001");
    eq(
      row,
      { callId: "call_off", childToken: `subagent:${PARENT}:call_off`, parentSessionId: PARENT, kind: "agent", tool: "agent", agentId: "sess-child-off" },
      "🔴 with `taint.mode: \"off\"` the task start writes the join row and the agent start fills the child's session id. On main neither wrote anything",
    );
    await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_off", "agent-off0001"))!, PARENT);
    await new Promise((r) => setTimeout(r, 50));
    const startedRows = (await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION })).filter((r) => (r.detail as { task?: unknown }).task === "agent-off0001");
    eq(startedRows.length, 1, "taint off: a redelivered task start writes ONE `delegation.task_started` row, not two");
    await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_off_2", "agent-off0001"))!, PARENT);
    eq((await link.taskCallLink(ORG, "agent-off0001"))?.callId, "call_off", "a continuation keeps the first dispatch's row, as on a taint-on deployment");
  });
} finally {
  resetSettingsForTest();
}

console.log("§3 taint on: the same row:");
await onTurn(async () => {
  await dispatch(PARENT, "call_on", "agent-on00001", "sess-child-on");
  eq(
    await link.taskCallLink(ORG, "agent-on00001"),
    { callId: "call_on", childToken: `subagent:${PARENT}:call_on`, parentSessionId: PARENT, kind: "agent", tool: "agent", agentId: "sess-child-on" },
    "taint on: the task start and the agent start write the same row as before",
  );
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
