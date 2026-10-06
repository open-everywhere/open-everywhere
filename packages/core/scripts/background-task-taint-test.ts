import assert from "node:assert/strict";
import { filesContainingAll, readEveDist, eveDistCarries } from "./eve-dist-search.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-background-task-taint-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ workspace: "dev" });

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

const spawnTaint = await import("../agent/hooks/spawn-taint.js");
const tasks = await import("../agent/access/background-tasks.js");
const store = await import("../agent/access/subagent-taint.js");
const { untrustedIngestedThisTurn, markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { isUnifiedWindowContext } = await import("../agent/identity/binding.js");
const { taskWakeId, installTaskWake, taskWakeKey } = await import("../agent/channels/task-wake.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { noteTurnBoundary, uningressedTurn } = await import("../agent/access/task-wake-signal.js");
const { noteSettlementDispatchAuthority, settlementDispatchAuthorityThisTurn } = await import("../agent/access/settlement-dispatch-signal.js");

const PARENT = "sess-seat";
const ORG = "default";
const TURN = "turn_parent_1";

const parentCtx = {
  channel: { kind: "channel:slack", continuationToken: "unified:oe-dom:e2e:oe-sup:g1" },
  session: { id: PARENT, auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } } },
  agent: { name: "oe", nodeId: "__root__" },
};

function childCtx(callId: string, sessionId: string) {
  return {
    channel: { kind: "subagent", continuationToken: `subagent:wrun_fixture_${sessionId}:0` },
    session: {
      id: sessionId,
      parent: { sessionId: PARENT, callId, rootSessionId: PARENT, turn: { id: TURN, sequence: 1 } },
      auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  };
}

function startedData(callId: string, taskId: string, kind: "agent" | "tool" = "agent", name = "agent") {
  return { callId, kind, name, taskId, turnId: TURN };
}

function settledData(
  callId: string,
  taskId: string,
  status: "completed" | "failed" | "cancelled" = "completed",
  extra: Record<string, unknown> = {},
) {
  return { callId, kind: "agent", name: "agent", status, taskId, turnId: TURN, ...extra };
}

function agentStartedData(callId: string, taskId: string | undefined, sessionId: string) {
  return { callId, name: "agent", sessionId, streamPath: `/sessions/${sessionId}/stream`, turnId: TURN, ...(taskId === undefined ? {} : { taskId }) };
}

async function onParentTurn<T>(fn: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    ok(!untrustedIngestedThisTurn(), "precondition: the parent's turn starts CLEAN");
    return await fn();
  });
}

async function runChild(callId: string, sessionId: string, taint: boolean, kinds: readonly string[] = []): Promise<void> {
  contextStorage.run(new ContextContainer(), () => {
    spawnTaint.openTaintTurn(childCtx(callId, sessionId) as never);
    if (!taint) return;
    if (kinds.length === 0) markUntrustedIngestedThisTurn();
    else for (const kind of kinds) markUntrustedIngestedThisTurn(kind as never);
  });
  await new Promise((r) => setTimeout(r, 50));
}

{
  eq(
    tasks.readTaskStarted(startedData("call_a", "agent-aa0001")),
    { taskId: "agent-aa0001", callId: "call_a", turnId: TURN, kind: "agent", tool: "agent" },
    "🔴 the DISPATCH reader takes eve's `task.started` and keys on `taskId` — the id present on every later event for the call",
  );
  eq(
    tasks.readTaskStarted(startedData("call_t", "agent-aa0002", "tool", "research_tool"))?.kind,
    "tool",
    "…and it carries eve's `tool` kind, which is an authored `serve` tool rather than a subagent",
  );
  eq(tasks.readTaskStarted({ ...startedData("c", "agent-aa0003"), kind: "wizard" }), null, "🔴 NEGATIVE CONTROL: a kind outside eve's own two reads as `null` rather than being classified as a tool — a third kind upstream must red PART 0B, not be silently absorbed");
  eq(tasks.readTaskStarted({ ...startedData("c", "job-17") })?.taskId, "job-17", "🔴 a short hyphenated id IS accepted: it is the shape eve mints, and refusing it is what killed the plane once");
  eq(tasks.readTaskStarted({ ...startedData("c", "fresh_eyes_review-p0ttbs") })?.taskId, "fresh_eyes_review-p0ttbs", "…and so is a long underscored tool name, because eve builds the id from the TOOL NAME");
  eq(tasks.readTaskStarted({ ...startedData("c", "../../etc") }), null, "🔴 NEGATIVE CONTROL: a path-shaped id is refused — this is the whole job of the fence");
  eq(tasks.readTaskStarted({ ...startedData("c", "agent:p0ttbs") }), null, "🔴 NEGATIVE CONTROL: a colon is refused — the store key is colon-delimited, so an id carrying one could address another row");
  eq(tasks.readTaskStarted({ ...startedData("c", "agent p0ttbs") }), null, "🔴 NEGATIVE CONTROL: whitespace is refused");
  eq(tasks.readTaskStarted({ ...startedData("c", "") }), null, "🔴 NEGATIVE CONTROL: an empty id is refused — it would key a row on the prefix alone");
  eq(tasks.readTaskStarted({ ...startedData("c", `agent-${"a".repeat(130)}`) }), null, "🔴 NEGATIVE CONTROL: an over-long id is refused, so a store key cannot be grown without bound");
  eq(tasks.readTaskStarted({ ...startedData("", "agent-aa0004") }), null, "🔴 NEGATIVE CONTROL: no `callId` — without it there is no join to the child's own taint marker, so there is nothing to remember");
  eq(tasks.readTaskStarted(undefined), null, "…and an absent payload reads as `null` rather than throwing");

  eq(
    tasks.readTaskSettled(settledData("call_a", "agent-aa0001")),
    { taskId: "agent-aa0001", callId: "call_a", turnId: TURN, status: "completed", kind: "agent", tool: "agent", cancelReason: "", errorText: "" },
    "🔴 the SETTLEMENT reader takes eve's `task.settled` — the event that replaced the rendered notification sentence",
  );
  eq(
    tasks.readTaskSettled(settledData("c", "agent-aa0005", "failed", { error: { message: "the worker died" } }))?.errorText,
    "the worker died",
    "…and the FAILED arm's error rides eve's own `error.message` field, not a parsed paragraph",
  );
  eq(
    tasks.readTaskSettled(settledData("c", "agent-aa0006", "cancelled", { cancel: { reason: "turn_ended" } }))?.cancelReason,
    "turn_ended",
    "…and the CANCELLED arm carries eve's own reason word",
  );
  eq(
    tasks.readTaskSettled({ callId: "c", status: "completed", taskId: "agent-aa0007", turnId: TURN })?.kind,
    null,
    "🔴 an event with NO `kind` reads to `kind: null` and still parses — eve states both `kind` and `name` are 'absent on events recorded by eve versions before it was added', so requiring either would drop a real settlement",
  );
  for (const status of ["completed", "failed", "cancelled"]) {
    ok(tasks.readTaskSettled(settledData("c", "agent-aa0008", status as never)) !== null, `every terminal status parses: ${status}`);
    ok(tasks.TERMINAL_TASK_STATUSES.includes(status), `…and ${status} is in OE's terminal set`);
  }
  eq(tasks.readTaskSettled(settledData("c", "agent-aa0009", "working" as never)), null, "🔴 NEGATIVE CONTROL: `working` is NOT a `task.settled` status — the status is ADMITTED against eve's union, so a word outside it reads as `null` and the caller treats the settlement as unreadable");
  eq(tasks.readTaskSettled(settledData("c", "agent-aa0010", "input_required" as never)), null, "…and neither is `input_required`: it was a task-VIEW status, and views do not exist at 0.70");
  eq(tasks.readTaskSettled(undefined), null, "…and an absent payload reads as `null` rather than throwing");

  eq(
    tasks.readAgentStarted(agentStartedData("call_a", "agent-aa0001", "sess-child-1")),
    { callId: "call_a", turnId: TURN, taskId: "agent-aa0001", sessionId: "sess-child-1", tool: "agent" },
    "🔴 the CHILD-SESSION reader takes eve's `agent.started`, whose `sessionId` is the field eve 0.54 did not hand OE at all",
  );
  eq(
    tasks.readAgentStarted(agentStartedData("call_x", undefined, "sess-exec"))?.taskId,
    null,
    "…and an `execute` call, which opens a session with NO task, reads to `taskId: null` instead of being dropped",
  );
  eq(tasks.readAgentStarted({ ...agentStartedData("call_a", "agent-aa0001", "") }), null, "🔴 NEGATIVE CONTROL: no `sessionId` — the one field this reader exists for — is refused");

  eq(tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0001"))), { errorClass: "", errorText: "", parse: "none" }, "a COMPLETED settlement is not a failure, and it is the only arm with an empty errorText");
  eq(
    tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0011", "failed", { error: { message: "boom" } }))),
    { errorClass: "", errorText: "boom", parse: "event" },
    "a FAILED settlement reads eve's own message under `parse: \"event\"`",
  );
  eq(
    tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0012", "failed"))),
    { errorClass: "", errorText: "failed", parse: "status" },
    "🔴 OPE-1737: a failure eve sent with NO message half still yields a non-empty errorText — the status word — under a `parse` that says so. A live run wrote three rows whose `error` was `\"\"`, and an empty field says nothing at all, not even whether the reader looked",
  );
  eq(
    tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0013", "cancelled", { cancel: { reason: "task_cancel" } }))),
    { errorClass: "task_cancel", errorText: "task_cancel", parse: "event" },
    "a CANCELLED settlement carries eve's reason as the CLASS too: `turn_ended` and `task_cancel` are different operator stories and one row must not blur them",
  );

  eq([...tasks.TASK_TOOL_NAMES].sort(), ["task_cancel", "task_wait"], "the task tool names are named once, in the isolation module");
  eq([...tasks.TASK_PARENT_TOOL_NAMES].sort(), ["task_cancel", "task_wait"], "🔴 and the PARENT list is the SAME set at 0.70 — see PART 0B, which reads eve's own mount and availability rules rather than trusting this line");
}

{
  const taskTools = readEveDist("protocol/task-tools.js");
  ok(/TASK_WAIT_TOOL_NAME=`task_wait`/.test(taskTools), "🔴 PART 0B: eve still names the wait tool `task_wait`");
  ok(/TASK_CANCEL_TOOL_NAME=`task_cancel`/.test(taskTools), "🔴 PART 0B: eve still names the cancel tool `task_cancel`");
  ok(
    /TASK_TOOL_NAMES=\[TASK_WAIT_TOOL_NAME,TASK_CANCEL_TOOL_NAME\]/.test(taskTools),
    "🔴 PART 0B: eve's own `TASK_TOOL_NAMES` is exactly those two, in that order. A THIRD task tool added upstream reds HERE — and it must, because `access/untrusted-projection.ts` subtracts this list from a seat that may not delegate, and a name missing from it is a tool that survives the cut",
  );
  ok(/isTaskControlTool\(e\)\{return TASK_TOOL_NAMES\.includes\(e\)\}/.test(taskTools), "…and eve reserves those names against authored tools, so no authored tool can answer to one");

  const modelStep = readEveDist("execution/tasks/model-step.js");
  ok(
    /withTaskTools\(e\)\{return offersTasks\(e\)\?new Map\(\[\.\.\.e,\[TASK_WAIT_TOOL_NAME,taskWaitTool\],\[TASK_CANCEL_TOOL_NAME,taskCancelTool\]\]\):e\}/.test(modelStep),
    "🔴 PART 0B THE PARENT SET: eve mounts BOTH task tools together, keyed on whether any tool starts tasks — not on a root-only narrowing. This is why TASK_PARENT_TOOL_NAMES equals TASK_TOOL_NAMES at 0.70",
  );
  const advertised = readEveDist("harness/advertised-tools.js");
  ok(
    /shouldHideTool\(e,t\)\{let n=t\.rootSessionId!==void 0;return e\.rootOnly===!0\|\|e\.availableInSubagents===!1\|\|e\.behavior\?\.availability\.includes\(`root-session`\)===!0\?n:!1\}/.test(advertised),
    "🔴 PART 0B: `shouldHideTool` reads exactly three fields — `rootOnly`, `availableInSubagents` and a `root-session` availability. Those are the only ways eve hides a tool from a child",
  );
  for (const [file, tool] of [
    ["tools/provided/task-wait.js", "taskWaitTool"],
    ["tools/provided/task-cancel.js", "taskCancelTool"],
  ] as const) {
    const body = readEveDist(file);
    ok(
      !/rootOnly/.test(body) && !/availableInSubagents/.test(body) && !/availability/.test(body),
      `🔴 PART 0B: ${tool} declares NONE of the three fields \`shouldHideTool\` reads, so eve never hides it from a child. The 0.54 parent/child SUBSET distinction has no bytes left behind it`,
    );
  }

  {
    const { createTask } = (await import(pathToFileURL(join(eveRoot, "dist/src/execution/tasks/table.js")).href)) as {
      createTask: (
        table: { tasks: readonly unknown[] },
        input: { callId: string; kind: string; name: string; resumable: boolean; turnId: string },
      ) => { taskId: string };
    };
    const minted = createTask({ tasks: [] }, { callId: "call_mint", kind: "agent", name: "fresh_eyes_review", resumable: true, turnId: TURN }).taskId;
    ok(
      !minted.startsWith("task_"),
      `🔴 PART 0B THE ID AXIS: eve does NOT prefix a task id with \`task_\` — it minted \`${minted}\`. A reader that required that prefix refused every event eve sends, which is the break this leg exists to catch`,
    );
    ok(
      minted.startsWith("fresh_eyes_review-"),
      `🔴 PART 0B: eve builds the id from the TOOL NAME plus a suffix (\`createTaskId(table, t.name)\`) — got \`${minted}\``,
    );
    eq(tasks.readTaskStarted(startedData("call_mint", minted))?.taskId, minted, "🔴 PART 0B: `readTaskStarted` ACCEPTS an id eve itself minted");
    eq(tasks.readTaskSettled(settledData("call_mint", minted))?.taskId, minted, "🔴 PART 0B: …and so does `readTaskSettled`, which is the edge the whole taint adoption hangs off");
    eq(tasks.readAgentStarted(agentStartedData("call_mint", minted, "sess-mint"))?.taskId, minted, "🔴 PART 0B: …and `readAgentStarted` joins it rather than dropping it to `null`");
    ok(
      /function createTaskId\(e,t\)\{for\(;;\)\{let n=crypto\.getRandomValues\(new Uint8Array\(6\)\)/.test(readEveDist("execution/tasks/table.js")),
      "🔴 PART 0B: and the minter is six random bytes over a 32-symbol alphabet, checked for a clash against THIS SESSION's table only — which is why `access/subagent-taint.ts` `taskCallKey` cannot claim org uniqueness and `adoptTaskTaint` checks the recorded parent session",
    );
  }

  const message = readEveDist("protocol/message.d.ts");
  ok(/type: "task\.started";/.test(message), "🔴 PART 0B: eve still declares the `task.started` event");
  ok(/type: "task\.settled";/.test(message), "🔴 PART 0B: eve still declares the `task.settled` event");
  ok(/type: "agent\.started";/.test(message), "🔴 PART 0B: eve still declares the `agent.started` event");
  ok(
    /kind: "agent" \| "tool";/.test(message),
    "🔴 PART 0B: `task.started`'s kind union is exactly `agent | tool` — the two names `readTaskStarted` admits and the reason a third reds its negative control",
  );
  ok(
    /status: "completed" \| "failed" \| "cancelled";/.test(message),
    "🔴 PART 0B THE TERMINAL SET: eve's `task.settled` status union is exactly OE's `TERMINAL_TASK_STATUSES`. This is the leg that reds if eve adds a non-terminal settlement status, which would make `task.settled` stop meaning 'this can no longer change'",
  );
  ok(
    /export type TaskCancelReason = "task_cancel" \| "turn_cancelled" \| "turn_ended";/.test(message),
    "🔴 PART 0B: eve's cancel-reason vocabulary is closed and unchanged, which is why the failure projection carries it as a CLASS",
  );
  ok(
    /interface AgentStartedStreamEvent {/.test(message) && /The opened session's id/.test(message) && /sessionId: string;/.test(message),
    "🔴 PART 0B THE NEW FIELD: eve 0.70 publishes the opened child's own SESSION id on `agent.started`. The 0.54 comments in `access/background-tasks.ts` and `access/subagent-taint.ts` claimed eve stripped it before OE ever saw it, and this is the byte that disproved them",
  );

  const hookMap = readEveDist("public/definitions/hook.d.ts");
  for (const ev of ["task.started", "task.settled", "agent.started"]) {
    ok(
      new RegExp(`readonly "${ev.replace(".", "\\.")}": ProtocolEvent<"${ev.replace(".", "\\.")}">;`).test(hookMap),
      `🔴 PART 0B REACHABILITY: \`${ev}\` is in eve's PUBLIC \`HookEventMap\`. Without this, every assertion below tests a handler eve would never call, and the whole settlement edge does not exist on a real host`,
    );
  }

  {
    const start = readEveDist("execution/tasks/start.js");
    const modelStep = readEveDist("execution/tasks/model-step.js");
    const subagentTool = readEveDist("subagents/tool.js");
    ok(
      /function taskStartedEvent\(e,t\)\{return createTaskStartedEvent\(\{callId:e\.task\.callId,/.test(start),
      "🔴 PART 0B THE JOIN, PARENT SIDE: `task.started` carries `e.task.callId` — the model's own tool-call id for the delegating call, not an id eve mints for the task",
    );
    ok(
      /createTask\(readTaskTable\(e\.state\),\{callId:t\.callId,/.test(modelStep),
      "…and the task RECORD is created against that same `t.callId`, so the id on the event is the id of the call that started the task",
    );
    const dispatchStep = readEveDist("execution/coordination-dispatch-step.js");
    ok(
      /agentContext:captureAgentSessionContext\(t,r\.callId,s\)/.test(dispatchStep) && /task:r\}\)/.test(dispatchStep),
      "🔴 PART 0B THE JOIN, CHILD SIDE (1/4): eve captures the agent-session context with `r.callId` off the SAME plan entry it passes as `task:r`, so the lineage's call id and the task's are one id",
    );
    ok(
      /parent:\{callId:t,rootSessionId:/.test(readEveDist("execution/agent-sessions/context.js")),
      "…(2/4): and that argument becomes the lineage's own `parent.callId`",
    );
    ok(
      /lineage:e\.parent,/.test(readEveDist("execution/agent-sessions/steps.js")),
      "…(3/4): which rides the PARENT CONTEXT as `lineage` (`createParentContext`); the run input carries it as `parent`, which (4/4) pins",
    );
    ok(
      /parent:e\.parent\.lineage,/.test(subagentTool),
      "🔴 …(4/4): and `buildSubagentRunInput` sets the child's `parent` to that lineage — which `channel/types.d.ts` declares as `SessionParent.callId`, \"Parent runtime-action tool call id that created this child session\". THIS is the byte the marker key depends on, and this is the leg that reds if eve re-keys it",
    );
    ok(
      /u=\{callId:t\.callId,/.test(subagentTool) || /\{callId:t\.callId,parentContinuationToken:/.test(subagentTool),
      "…and the child's ADAPTER STATE carries the same id as well — eve's HITL/authorization forwarding key, a second user of it rather than the carrier the taint join reads",
    );
  }

  ok(
    /function mintSubagentContinuationToken\(e\)\{return`subagent:\$\{e\?\?crypto\.randomUUID\(\)\}`\}/.test(readEveDist("execution/session.js")),
    "PART 0B: eve mints the child's continuation token as `subagent:<key>`, falling back to a random uuid when no key is given",
  );
  ok(
    /let [a-z]=`\$\{e\.from\.runId\}:\$\{String\([a-z]\)\}`/.test(readEveDist("execution/agent-sessions/session.js")),
    "🔴 PART 0B: eve's `ctx.agent()` handle keys itself `<runId>:<index>` — one colon, always present",
  );
  ok(
    /continuationKey:[a-z]\.key/.test(readEveDist("execution/agent-sessions/steps.js")),
    "🔴 PART 0B: …and that key is what reaches `mintSubagentContinuationToken`, so a real token is `subagent:wrun_<id>:<index>`. `/^subagent:([^:]+):([^:]+)$/` parses THAT to a pair naming no session — the misparse the deleted arm would have made on every delegation",
  );
  ok(
    filesContainingAll("buildSubagentRunInput", "parentSessionId:", "mintSubagentContinuationToken").length > 0,
    "…and eve carries the parent pair in the child's ADAPTER STATE instead, which is what `ctx.session.parent` projects",
  );

  ok(
    !eveDistCarries(/SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA/),
    "🔴 PART 0B RETIRED: eve no longer declares `SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA` anywhere. That schema WAS arm B of the 0.54 `readTaskReceipt`, and this is the exact leg whose 0.54 form caught the upgrade. If it returns, the dispatch edge has two shapes again and `readTaskStarted` is no longer the whole story",
  );
  ok(
    !eveDistCarries(/backgroundTask:\{status:/),
    "🔴 PART 0B RETIRED: no module stamps a `backgroundTask:{status, taskId}` envelope — arm A of the 0.54 reader. Detached background work is gone, not merely unused",
  );
  ok(
    !eveDistCarries(/`task_peek`/) && !eveDistCarries(/`task_sleep`/),
    "🔴 PART 0B RETIRED: `task_peek` and `task_sleep` do not exist. They were the two VIEW-bearing tools, and their absence is why `taskViewsOf` was deleted rather than kept as a union arm",
  );

  const render = readEveDist("execution/tasks/render.js");
  ok(
    /function renderTaskCancelResult\(e,t\)\{return t\.status===`already_finished`\?`\$\{e\} had no work to stop\.`/.test(render),
    "🔴 PART 0B STEP 2: `task_cancel` answers a rendered SENTENCE at 0.70. The 0.54 reader accepted cancel results because cancelling an already-terminal task returned `lastOutput`; this is the byte that says it no longer does",
  );
  const session = readEveDist("execution/tasks/session.js");
  ok(
    /taskToolResult\(t\.callId,TASK_CANCEL_TOOL_NAME,renderTaskCancelResult\(t\.taskId,n\)\)/.test(session),
    "🔴 PART 0B STEP 2: and that sentence IS the whole tool output — `answerTaskCancel` passes the rendered string straight through, with no `tasks` array and no child output beside it. The taint path the view branch defended is therefore CLOSED, which is why deleting the branch did not open a hole",
  );
  ok(
    /TASK_RESULT_TAG=`<task_result`/.test(render) && /function renderTaskResults\(e\)/.test(render),
    "…and the child's own output reaches the model as a `<task_result>` block instead, on the settlement this file adopts taint for",
  );
}

await onParentTurn(async () => {
  const link = await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_1", "agent-bb0001"))!, PARENT);
  eq(untrustedIngestedThisTurn(), false, "🔴 T1 THE MEASURED DEFECT, CLOSED: a task dispatch marks the parent's turn NOT AT ALL — asserted `=== false`, not merely falsy. Before this branch existed the fail-closed read ran here and every clean delegation tainted its own seat");
  eq(
    link,
    { callId: "call_1", childToken: `subagent:${PARENT}:call_1`, parentSessionId: PARENT, kind: "agent", tool: "agent" },
    "…and it REMEMBERS the join instead: the callId the child writes its marker under, OE's own row key, and — new at 0.70 — the dispatching session RECORDED rather than parsed back out of a token",
  );
  eq(await store.taskCallLink(ORG, "agent-bb0001"), link, "…persisted under the task id, which is the only id present on EVERY event of a 0.70 task");
});

ok(store.taskCallKey("t").startsWith("oe-task-call:"), "🔴 T1: the join-row prefix is namespaced away from the taint markers, so no two consumers of the shared slice can collide");
ok(!Object.keys(store).includes("taskAgentKey"), "🔴 T1 (OPE-2250 step 1): the `oe-task-agent:` row is RETIRED — keyed on `taskId`, not on `agentId`. A resumable 0.70 task IS its taskId, so a continuation needs no handle pinned to find the first dispatch's join");

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_1b", "agent-bb0002"))!, PARENT);
  await spawnTaint.noteAgentStarted(tasks.readAgentStarted(agentStartedData("call_1b", "agent-bb0002", "sess-child-1b"))!, PARENT);
  eq(
    (await store.taskCallLink(ORG, "agent-bb0002"))?.agentId,
    "sess-child-1b",
    "🔴 PART 1B: the child's REAL session id lands on the dispatch row. eve 0.54 handed OE an opaque handle and the old comments said the session id reached no hook at all; `agent.started` carries it, and the census row joins on it",
  );
});

await runChild("call_2", "sess-child-dirty", true);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_2"), true, "precondition: the child that read untrusted content wrote its call-keyed marker TAINTED");

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_2", "agent-bb0003"))!, PARENT);
  eq(untrustedIngestedThisTurn(), false, "…and the dispatch for that same tainted child STILL marks nothing — the taint exists, but the parent has not read a byte of it yet");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-bb0003", status: "completed", agentId: null }, PARENT);
  eq(adopted, true, "🔴 T2 THE DEFENCE IS RELOCATED, NOT WEAKENED: a child that genuinely read untrusted content marks its parent at the SETTLEMENT — the edge where the child's output enters the parent's history");
  eq(untrustedIngestedThisTurn(), true, "…and the parent's own turn signal is set, so remember / create_routine / create_skill gate as if the seat had read what the child read");
});

await runChild("call_3", "sess-child-clean", false);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_3"), false, "precondition: the clean child's eager claim left a POSITIVE known-clean row, not silence");

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_3", "agent-bb0004"))!, PARENT);
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-bb0004", status: "completed", agentId: null }, PARENT);
  eq(adopted, false, "🔴 T2 NEGATIVE CONTROL: a settlement over a CLEAN child does NOT mark the parent — asserted `=== false`, not merely falsy");
  eq(untrustedIngestedThisTurn(), false, "…and the turn signal reads `=== false` too: a clean background delegation is clean end to end, which is the whole point of this ticket");
});

await onParentTurn(async () => {
  eq(await store.taskCallLink(ORG, "agent-cc0001"), undefined, "precondition: no join row exists for this task at all");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-cc0001", status: "completed", agentId: null }, PARENT);
  eq(adopted, true, "🔴 T3 FAIL CLOSED, LOST JOIN: a settlement whose join row is gone marks the parent — it cannot establish the child's taint, and it may not answer 'clean' for a fact it could not read");
  eq(untrustedIngestedThisTurn(), true, "…and the turn signal is set");
});

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_never_ran", "agent-cc0002"))!, PARENT);
  eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_never_ran"), undefined, "precondition: the child never reached its own turn.started, so it wrote no marker of either value");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-cc0002", status: "failed", agentId: null }, PARENT);
  eq(adopted, true, "🔴 T3 FAIL CLOSED, LOST MARKER: a settlement over a child whose taint record was lost marks the parent — the same direction OPE-437 fixed for the sync leg, on the new edge");
});

for (const [i, status] of (["failed", "cancelled"] as const).entries()) {
  const call = `call_dead_${String(i)}`;
  const task = `agent-dddd000${String(i)}`;
  await runChild(call, `sess-child-dead-${String(i)}`, true);
  await onParentTurn(async () => {
    await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData(call, task))!, PARENT);
    const adopted = await spawnTaint.adoptTaskTaint({ taskId: task, status, agentId: null }, PARENT);
    eq(adopted, true, `🔴 T3: a ${status} settlement over a TAINTED child adopts — a death is not a reason to trust what the child read`);
  });
}

const events = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
const startedHandler = events["task.started"]!;
const settledHandler = events["task.settled"]!;
const agentHandler = events["agent.started"]!;

ok(typeof startedHandler === "function", "🔴 T4 REACHABILITY: the taint hook SUBSCRIBES to `task.started`. Without it the dispatch join is never written and every settlement below resolves `no-row`");
ok(typeof settledHandler === "function", "🔴 T4 REACHABILITY: …and to `task.settled`, which is the whole settlement edge at 0.70");
ok(typeof agentHandler === "function", "🔴 T4 REACHABILITY: …and to `agent.started`, which is where the child's session id comes from");
eq(events["message.received"], undefined, "🔴 T4: the hook NO LONGER subscribes to `message.received`. It carried the 0.54 notification edge, and eve 0.70 sends no task notifications — a reader left matching that grammar would answer 'no settlement' on every call, which is a settlement that adopts no taint");

for (const [label, taint, expected] of [
  ["hostile", true, true],
  ["clean", false, false],
] as const) {
  const call = `call_e2e_${label}`;
  const task = `agent-eeee000${label === "hostile" ? "1" : "2"}`;
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await startedHandler({ data: startedData(call, task) }, parentCtx);
    await agentHandler({ data: agentStartedData(call, task, `sess-child-e2e-${label}`) }, parentCtx);
  });
  await runChild(call, `sess-child-e2e-${label}`, taint);
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    ok(!untrustedIngestedThisTurn(), `E2E ${label} CONTROL: the settlement turn starts CLEAN, so any adoption below is caused by the settlement and not inherited`);
    await settledHandler({ data: settledData(call, task) }, parentCtx);
    eq(
      untrustedIngestedThisTurn(),
      expected,
      expected
        ? "🔴 E2E: a child that read HOSTILE content taints the parent at `task.settled` — through eve's real event, the real subscription and the real handler, with no tool call of any kind"
        : "🔴 E2E NEGATIVE CONTROL: a CLEAN child leaves the parent `tainted === false` on the same path. This is the leg that fails if the adoption is implemented as 'mark on every settlement'",
    );
  });
  await new Promise((r) => setTimeout(r, 50));
}

await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await settledHandler({ data: { status: "working", taskId: "agent-ff0001", callId: "c", turnId: TURN } }, parentCtx);
  eq(untrustedIngestedThisTurn(), false, "🔴 T4 NEGATIVE CONTROL: a payload whose status is outside eve's terminal union reaches NO settlement — asserted `=== false`. The handler's guard is the reader, so an unreadable event cannot half-settle");
});
await new Promise((r) => setTimeout(r, 50));
{
  const refused = await readAudit({ org: ORG, action: spawnTaint.TASK_UNREADABLE_ACTION });
  const mine = refused.filter((r) => r.detail?.task === "agent-ff0001");
  eq(mine.length, 1, "🔴 T4: an UNREADABLE settlement writes exactly one row, so a reader that refuses what eve sends is visible in an audit query instead of silent");
  eq(mine[0]?.detail?.marker, "unreadable", "…under a marker disjoint from every verdict a real adoption writes, so it can never be counted as one");
  eq(mine[0]?.detail?.adopted, false, "…and it says plainly that nothing was adopted");
  eq(mine[0]?.detail?.edge, "task.settled", "…and names the edge that refused it");
  const settledRows = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  eq(
    settledRows.filter((r) => r.detail?.task === "agent-ff0001").length,
    0,
    "🔴 T4 NEGATIVE CONTROL: a refused event writes NO `delegation.task_settled` row at all, so the parked-worker census and every settlement consumer still see only tasks that really settled",
  );
}

{
  const OTHER = "sess-other-seat";
  await runChild("call_collide", "sess-child-collide", false, []);
  await store.claimSubagentCallClean(ORG, OTHER, "call_collide");
  eq(await store.subagentCallTaintStatus(ORG, OTHER, "call_collide"), false, "precondition: the OTHER seat's call is recorded KNOWN-CLEAN, so a read that followed the row would answer `clean`");
  await store.rememberTaskCall(ORG, "agent-gg0001", { callId: "call_collide", childToken: `subagent:${OTHER}:call_collide`, parentSessionId: OTHER, kind: "agent", tool: "agent" });
  await onParentTurn(async () => {
    const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-gg0001", status: "completed", agentId: null }, PARENT);
    eq(adopted, true, "🔴 PART 4C: a row whose recorded `parentSessionId` is ANOTHER session reads as a LOST record and MARKS this turn — a colliding id cannot hand this seat another seat's clean answer");
    eq(untrustedIngestedThisTurn(), true, "…and the turn signal is set, so the seat gates as if it had read what it could not account for");
  });
  await new Promise((r) => setTimeout(r, 50));
  {
    const rows = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
    const mine = rows.filter((r) => r.detail?.task === "agent-gg0001");
    eq(mine.length, 1, "PART 4C: the settlement is still audited");
    eq(mine[0]?.detail?.marker, "lost", "🔴 PART 4C: …and the row says `lost`, naming WHY it marked, rather than reporting a clean read it did not make");
  }
}

{
  const requestedHandler = events["actions.requested"]!;
  eq(typeof requestedHandler, "function", "precondition: the hook still subscribes to `actions.requested`");

  const unifiedCtx = { ...parentCtx, channel: { kind: "channel:unified", continuationToken: "unified:oe-dom:e2e:oe-sup:g1" } };
  eq(isUnifiedWindowContext(unifiedCtx as never), true, "precondition: the fixture really is a unified seat, read through the same predicate the handler uses");
  eq(isUnifiedWindowContext(parentCtx as never), false, "🔴 …and `parentCtx` is NOT, which is why it drives the binding path and writes no unauthorized row");

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await requestedHandler({ data: { actions: [{ kind: "tool-call", toolName: "agent", callId: "call_noauth" }] } }, unifiedCtx);
  });
  await new Promise((r) => setTimeout(r, 50));
  {
    const rows = await readAudit({ org: ORG, action: spawnTaint.DISPATCH_UNAUTHORIZED_ACTION });
    const mine = rows.filter((r) => r.detail?.call === "call_noauth");
    eq(mine.length, 1, "🔴 PART 4D: a unified delegating turn with no addressed wake writes ONE `delegation.dispatch_unauthorized` row — the state the swallowed throw used to pass over in silence");
    eq(mine[0]?.detail?.edge, "actions.requested", "…naming the edge it fired on, because the same recorder also serves `task.started`");
    eq(mine[0]?.detail?.reason, "unified-turn-no-wake", "…and the REASON, which is the only field separating this arm from the settlement-turn arms");
    eq(mine[0]?.detail?.adopted, false, "🔴 …and `adopted: false`, because this row is NOT an adoption: it records a dispatch, and the marking happens at the settlement that follows");
    eq("task" in (mine[0]?.detail ?? {}), false, "🔴 PART 4D: the `task` field is OMITTED at this edge, not written empty — eve mints the task id at `task.started`, and an empty joinable field would read as a lookup that found nothing");
  }

  await onParentTurn(async () => {
    await startedHandler({ data: startedData("call_noauth", "agent-4d0001") }, unifiedCtx);
  });
  await new Promise((r) => setTimeout(r, 50));
  eq(
    await taskWakeId(ORG, "agent-4d0001"),
    undefined,
    "🔴 PART 4D END TO END: a dispatch refused for want of authority ends the turn with NO task wake, so there is no address for its settlement to install",
  );
  {
    const mine = (await readAudit({ org: ORG, action: spawnTaint.DISPATCH_UNAUTHORIZED_ACTION })).filter((r) => r.detail?.task === "agent-4d0001");
    eq(mine.length, 1, "🔴 PART 4D: the `task.started` arm records exactly one row for this task");
    eq(mine[0]?.detail?.edge, "task.started", "…naming the OTHER edge, so the recorder is proven on both");
    eq(mine[0]?.detail?.reason, "authority-row-absent-at-task-started", "🔴 …and its own reason, which is the fifth of the five the registry declares");
  }
  eq(
    (await installTaskWake({ org: ORG, taskId: "agent-4d0001", status: "completed", sessionId: PARENT, turnId: "turn-4d-install", inheritedWakeId: undefined, adopt: () => true, uningressed: () => true })).outcome,
    "no-row",
    "🔴 …and the settlement edge answers `no-row`, which is what leaves the turn with no reply address and makes the reply fence refuse under `task-wake-unread`",
  );
  eq(
    (await store.taskCallLink(ORG, "agent-4d0001"))?.callId,
    "call_noauth",
    "🔴 PART 4D THE CORRECTED CLAIM: `oe-task-call:<taskId>` IS present for a refused dispatch, so taint carries on the call-keyed marker and the refusal neither helps nor harms it",
  );
  {
    const CTL = "agent-4dctl";
    const opStore = getOperationalStore();
    await opStore.putTaskResult(ORG, taskWakeKey(CTL), JSON.stringify({ wakeId: "wake-4d-ctl" }), new Date().toISOString(), 60_000);
    eq(await taskWakeId(ORG, CTL), "wake-4d-ctl", "🔴 PART 4D CONTROL: given a real row the SAME reader answers the wake id — so the absence check above is reading a reader that works, not one that always answers `undefined`");
    const installed = await installTaskWake({ org: ORG, taskId: CTL, status: "completed", sessionId: PARENT, turnId: "turn-4d-ctl", inheritedWakeId: undefined, adopt: () => true, uningressed: () => true });
    ok(installed.outcome !== "no-row", `🔴 PART 4D CONTROL: …and the settlement edge does NOT answer \`no-row\` for it (got \`${installed.outcome}\`), so \`no-row\` above means an absent row rather than a reader that cannot read`);
  }

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    noteTurnBoundary("turn-4d-first", "stamp-4d");
    noteTurnBoundary("turn-4d-second", "stamp-4d");
    eq(uningressedTurn("turn-4d-second"), true, "precondition: a second boundary carrying the SAME delivery stamp is what makes this turn uningressed");
    noteSettlementDispatchAuthority("turn-4d-second", "agent-4d0002", undefined);
    eq(settlementDispatchAuthorityThisTurn("turn-4d-second").kind, "blocked", "precondition: a missing authority reads `blocked`, so this turn is a settlement turn WITHOUT a single authority");
    await requestedHandler(
      { data: { actions: [{ kind: "subagent-call", callId: "call_ambig" }] } },
      { ...unifiedCtx, session: { ...unifiedCtx.session, turn: { id: "turn-4d-second" } } },
    );
  });
  await new Promise((r) => setTimeout(r, 50));
  {
    const rows = await readAudit({ org: ORG, action: spawnTaint.DISPATCH_UNAUTHORIZED_ACTION });
    const mine = rows.filter((r) => r.detail?.call === "call_ambig");
    eq(mine.length, 1, "🔴 PART 4D: an uningressed unified settlement turn that delegates without a SINGLE authority is recorded too — this is the arm whose throw claimed to refuse the launch before an exact wake was addressed");
    eq(mine[0]?.detail?.reason, "settlement-turn-ambiguous-authority", "…and `blocked` is reported as AMBIGUOUS rather than absent, because the two are different operator stories");
  }

  {
    const before = (await readAudit({ org: ORG, action: spawnTaint.DISPATCH_UNAUTHORIZED_ACTION })).length;
    await contextStorage.run(new ContextContainer(), async () => {
      spawnTaint.openTaintTurn(parentCtx as never);
      await requestedHandler({ data: { actions: [{ kind: "tool-call", toolName: "reply", callId: "call_reply" }] } }, unifiedCtx);
    });
    await new Promise((r) => setTimeout(r, 50));
    const after = await readAudit({ org: ORG, action: spawnTaint.DISPATCH_UNAUTHORIZED_ACTION });
    eq(after.length, before, "🔴 PART 4D NEGATIVE CONTROL: a non-delegating action writes NO unauthorized-dispatch row — the recorder keys on delegation, not on the turn being unaddressed");
    eq(after.filter((r) => r.detail?.call === "call_reply").length, 0, "…and nothing names the reply call");
  }
}

ok(
  /case`serve`:\{let\{input:r,taskId:i\}=splitTaskIdInput\(t\.input\);return i===void 0\?commitTask\(e,t,n,r\):\{entry:\{entryPoint:`receive`,taskId:i\},input:r,session:e\}\}/.test(readEveDist("execution/tasks/model-step.js")),
  "🔴 T5 PART 0B: eve routes a call carrying `taskId` onto the EXISTING task record rather than minting a new one. This is the byte behind 'key on taskId, not on agentId'",
);

await runChild("call_5", "sess-child-cont", false);
await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_5", "agent-bb0005"))!, PARENT);
  const first = await store.taskCallLink(ORG, "agent-bb0005");
  const again = await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_5_again", "agent-bb0005"))!, PARENT);
  eq(again?.callId, "call_5", "🔴 T5: a continuation on the same taskId resolves the ORIGINAL call, so the marker read still names the child that ran — no handle row needed to get there");
  eq(again, first, "…and the row is returned unchanged rather than rewritten, which is what makes a redelivered event idempotent");
  ok(
    /async function sendToTask\(e\)/.test(readEveDist("execution/tasks/start.js")) && /started:taskStartedEvent\(e,a\)/.test(readEveDist("execution/tasks/start.js")),
    "🔴 T5 PART 0B: a continuation really does reach this edge — eve's `sendToTask` answers `started: taskStartedEvent(...)` for a call that names an existing task. Without this byte the branch above would be testing an event eve never sends",
  );
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-bb0005", status: "completed", agentId: null }, PARENT);
  eq(adopted, false, "🔴 T5 NEGATIVE CONTROL: a CLEAN continuation stays clean — the resolution above did not fall through to the fail-closed read");
});
await new Promise((r) => setTimeout(r, 50));
{
  const started = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  const mine = started.filter((r) => r.detail?.task === "agent-bb0005");
  eq(mine.length, 2, "🔴 T5: the continuation earns its OWN dispatch row — it is a real event eve sends, not a redelivery to swallow");
  eq(mine.filter((r) => r.detail?.continuation === true).length, 1, "…and exactly one of the two is marked `continuation: true`, keyed on the callId differing while the taskId does not");
  eq(mine.filter((r) => r.detail?.continuation === false).length, 1, "…and the first dispatch is NOT: a continuation and a first dispatch are different operator facts");
}

{
  const actionTypes = readEveDist("shared/action-types.d.ts");
  ok(
    /RuntimeSubagentDispatchFailure/.test(actionTypes) && /origin: z\.ZodLiteral<"dispatch">/.test(actionTypes),
    "🔴 T6 PART 0B: eve still synthesizes a parent-side dispatch failure, so the belt that reads it is live and not a retired shape",
  );
  eq(
    tasks.readDelegationFailure({ kind: "subagent-result", origin: "dispatch", isError: true, callId: "call_6", subagentName: "agent", output: { code: "SUBAGENT_EXECUTION_FAILED", message: "no child" } }),
    { callId: "call_6", errorClass: "SUBAGENT_EXECUTION_FAILED", errorText: "no child", tool: "agent", status: "failed" },
    "T6: the dispatch-failure reader is unchanged — the discriminator is `isError`, never the code, so a ninth code upstream cannot make a death invisible",
  );
  eq(tasks.readDelegationFailure({ kind: "subagent-result", origin: "child", callId: "call_6", subagentName: "agent" }), null, "🔴 T6 NEGATIVE CONTROL: a non-error `subagent-result` is not a failure — asserted `=== null`");
}

{
  const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
  registerSettings({ taint: { mode: "off" } } as never);
  await runChild("call_off", "sess-child-off", true);
  await onParentTurn(async () => {
    await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_off", "agent-bb0006"))!, PARENT);
    const adopted = await spawnTaint.adoptTaskTaint({ taskId: "agent-bb0006", status: "completed", agentId: null }, PARENT);
    eq(adopted, false, "🔴 PART 7: with taint OFF the settlement adopts nothing, so the whole plane has ONE switch and this edge is not a second one");
  });
  resetSettingsForTest();
}

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_census", "agent-bb0007"))!, PARENT);
  await spawnTaint.noteAgentStarted(tasks.readAgentStarted(agentStartedData("call_census", "agent-bb0007", "sess-child-census"))!, PARENT);
  const link = await store.taskCallLink(ORG, "agent-bb0007");
  await spawnTaint.adoptTaskTaint({ taskId: "agent-bb0007", status: "completed", agentId: link?.agentId ?? null }, PARENT);
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  const mine = settled.filter((r) => r.detail?.task === "agent-bb0007");
  eq(mine.length, 1, "one settled row for the settled task");
  eq(mine[0]?.detail?.agent, "sess-child-census", "🔴 OPE-566 THE CENSUS: the settled row names the parked worker's own session id — remove it and the parked population becomes uncountable");
  const started = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  const dispatch = started.filter((r) => r.detail?.task === "agent-bb0007");
  eq(dispatch.length, 1, "…and exactly one dispatch row, which is the other half of the census");
  eq(dispatch[0]?.detail?.kind, "agent", "🔴 OPE-566: the dispatch row carries eve's own task KIND, which is what tells an operator this row is a delegation at all now that the agent handle is gone from `task.started`");
}

{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  eq(settled.filter((r) => r.detail?.task === "agent-bb0002").length, 0, "🔴 OPE-566 NEGATIVE CONTROL: the task from PART 1B was dispatched and never settled, and it has NO settled row — the census counts parked workers, never dispatches");
}

await onParentTurn(async () => {
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_replay", "agent-bb0008"))!, PARENT);
  await spawnTaint.noteTaskStarted(tasks.readTaskStarted(startedData("call_replay", "agent-bb0008"))!, PARENT);
});
await new Promise((r) => setTimeout(r, 50));
{
  const started = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  const mine = started.filter((r) => r.detail?.task === "agent-bb0008");
  eq(mine.length, 1, "🔴 OPE-586: a replayed dispatch writes EXACTLY ONE dispatch row, so an operator counting delegations is not reading eve's redelivery behaviour");
  eq(mine[0]?.detail?.continuation, false, "…and it is not misclassified as a continuation: a replay carries the SAME callId, which is what tells the two apart");
}

console.log(`background-task-taint: ${String(n)} assertions passed`);
