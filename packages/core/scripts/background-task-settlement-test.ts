import assert from "node:assert/strict";
import { filesContainingAll, readEveDist, eveDistCarries } from "./eve-dist-search.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { v27Hooks } from "./_hook-view.js";
import { EVE_EVENT_NAMES } from "../../../scripts/eve-event-names.generated.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-background-task-settlement-")), "ops.sqlite3");
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

const hub = await import("../agent/hooks/delegation-settlement.js");
const tasks = await import("../agent/access/background-tasks.js");
const taskCall = await import("../agent/access/task-call-link.js");
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
  return await contextStorage.run(new ContextContainer(), async () => await fn());
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
  eq(tasks.readTaskStarted({ ...startedData("", "agent-aa0004") }), null, "🔴 NEGATIVE CONTROL: no `callId` — without it there is no join row to key, so there is nothing to remember");
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
    tasks.readTaskSettled(settledData("c", "agent-aa0006", "cancelled", { cancel: { reason: "turn-ended" } }))?.cancelReason,
    "turn-ended",
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
    tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0013", "cancelled", { cancel: { reason: "task-cancel" } }))),
    { errorClass: "task-cancel", errorText: "task-cancel", parse: "event" },
    "the projection of a CANCELLED settlement carries eve's reason as the CLASS too: `turn-ended` and `task-cancel` are different operator stories and the projection keeps them apart (no audit row carries a cancel — see T4 CANCEL below)",
  );

  {
    const long = `turn-${"x".repeat(2000)}`;
    const capped = tasks.taskSettledFailure(tasks.readTaskSettled(settledData("c", "agent-aa0014", "cancelled", { cancel: { reason: long } })));
    ok(
      capped.errorClass.length < 700 && capped.errorText.length < 700 && capped.errorClass.startsWith("turn-x"),
      `🔴 DEFENCE IN DEPTH: the projection bounds its own output whatever the caller does — an OPEN cancel reason of any length is capped in both the class and the text, because eve 1.x types \`reason\` as a plain string (class ${String(capped.errorClass.length)} chars)`,
    );
  }
  eq([...tasks.TASK_TOOL_NAMES].sort(), ["eve__task_cancel", "eve__task_wait"], "the task tool names are named once, in the isolation module");
  eq([...tasks.TASK_PARENT_TOOL_NAMES].sort(), ["eve__task_cancel", "eve__task_wait"], "🔴 and the PARENT list is the SAME set at 0.70 — see PART 0B, which reads eve's own mount and availability rules rather than trusting this line");
}

{
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
    eq(tasks.readTaskSettled(settledData("call_mint", minted))?.taskId, minted, "🔴 PART 0B: …and so does `readTaskSettled`, which is the edge the whole settlement hangs off");
    eq(tasks.readAgentStarted(agentStartedData("call_mint", minted, "sess-mint"))?.taskId, minted, "🔴 PART 0B: …and `readAgentStarted` joins it rather than dropping it to `null`");
    ok(
      /function createTaskId\(e,t\)\{for\(;;\)\{let n=crypto\.getRandomValues\(new Uint8Array\(6\)\)/.test(readEveDist("execution/tasks/table.js")),
      "🔴 PART 0B: and the minter is six random bytes over a 32-symbol alphabet, checked for a clash against THIS SESSION's table only — which is why `access/task-call-link.ts` `taskCallKey` cannot claim org uniqueness, and why the dispatching session is recorded on the row",
    );
  }

  // eve 1.x (v27) declares each event family in its own module, and the session machine
  // (`harness/session-machine/transitions.js`) is the one place that emits the task facts.
  const taskTypes = readEveDist("protocol/session-events/families/task.d.ts");
  const childTypes = readEveDist("protocol/session-events/families/child.d.ts");
  ok(/export type TaskStarted = Envelope<"task\.started", TaskStartedData>;/.test(taskTypes), "🔴 PART 0B: eve still declares the `task.started` event");
  ok(/export type TaskEnded = Envelope<"task\.ended", TaskEndedData>;/.test(taskTypes), "🔴 PART 0B: eve declares `task.ended`, the v27 end of a task (0.x `task.settled`)");
  ok(/export type ChildOpened = Envelope<"child\.opened", ChildOpenedData>;/.test(childTypes), "🔴 PART 0B: eve declares `child.opened`, the v27 event that names an opened child session (0.x `agent.started`)");
  ok(
    /readonly kind: "agent" \| "tool" \| \(string & \{\}\);/.test(taskTypes),
    "🔴 PART 0B: `task.started`'s NAMED kinds are exactly `agent | tool` — the two names `readTaskStarted` admits. eve 1.x leaves the type open (`string & {}`), so a third named kind reds this pin, and an unnamed one reads as `null` (the negative control above)",
  );
  {
    const outcome = /export type TaskOutcome = ((?:"[a-z]+"(?: \| )?)+);/.exec(taskTypes)?.[1];
    eq(
      [...(outcome ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort(),
      [...tasks.TERMINAL_TASK_STATUSES].sort(),
      "🔴 PART 0B THE TERMINAL SET: eve's `task.ended` outcome union is exactly OE's `TERMINAL_TASK_STATUSES`. This is the leg that reds if eve adds a non-terminal outcome, which would make `task.ended` stop meaning 'this can no longer change'",
    );
  }
  ok(
    /export interface TaskEndedData \{[^}]*readonly reason\?: string;/.test(taskTypes),
    "🔴 PART 0B: eve 1.x's cancel reason is an OPEN string (0.x had a closed union). OE never matches on the word: the failure projection carries it, capped, as the CLASS, so a new word upstream is still carried (the `task-cancel` arm above)",
  );
  ok(
    /export interface ChildOpenedData \{\s*\/\*\* The child session; [^*]*\*\/\s*readonly sessionId: string;/.test(childTypes),
    "🔴 PART 0B THE FIELD: eve publishes the opened child's own SESSION id on `child.opened`. The 0.54 comments in `access/background-tasks.ts` and the deleted `access/subagent-taint.ts` claimed eve stripped it before OE ever saw it",
  );
  ok(
    /readonly owner: \{\s*readonly callId: string;\s*\} \| \{\s*readonly taskId: string;\s*\};/.test(childTypes),
    "🔴 PART 0B: `child.opened` names its owner as a call OR a task, never both — which is why `childOpenedData` resolves the other id through the session view",
  );

  {
    const authoring = readEveDist("protocol/session-events/authoring.js");
    const hookMap = readEveDist("public/definitions/hook.d.ts");
    ok(/readonly \[T in AuthoringEventType\]: ProtocolEvent<T>;/.test(hookMap), "PART 0B REACHABILITY: eve's PUBLIC `HookEventMap` is mapped over `authoringEventTypes`");
    const authored = /authoringEventTypes=`([^`]*)`/.exec(authoring)?.[1]?.split(",") ?? [];
    for (const ev of ["task.started", "task.ended", "child.opened", "call.started", "call.settled", "call.requested"]) {
      ok(
        authored.includes(ev),
        `🔴 PART 0B REACHABILITY: \`${ev}\` is in eve's PUBLIC hook events. Without this, every assertion below tests a handler eve would never call, and the whole settlement edge does not exist on a real host`,
      );
    }
  }

  {
    const machine = readEveDist("harness/session-machine/transitions.js");
    ok(
      /function startTask\((\w+),(\w+),\w+\)\{let (\w+)=\[\];return\([^]*?\1\.projection\.view\.tasks\[\2\.taskId\]!==void 0\)\|\|\([^]*?\3\.push\(\{type:`task\.started`,data:\{taskId:\2\.taskId,kind:\2\.kind,name:\2\.name,startedBy:\{callId:\2\.callId\}\}\}\)\),\3\.push\(\{type:`call\.started`,data:defined\(\{callId:\2\.callId,taskId:\2\.taskId,/.test(machine),
      "🔴 PART 0B THE JOIN, PARENT SIDE: the session machine emits `task.started` with `startedBy.callId` — the model's own tool-call id for the delegating call — ONLY for a task the view does not yet hold, and `call.started {callId, taskId}` for every call. So a continuation reaches OE as `call.started`, not as a second `task.started` (T5 below)",
    );
    ok(
      /function settleTask\((\w+),(\w+)\)\{let\{outcome:(\w+)\}=\2;[^]*?\2\.calls\.map\([^]*?fact\(`call\.settled`,\{callId:/.test(machine) &&
        /reason:\w+\.status===`cancelled`\?\w+\.reason\?\?`task-cancelled`:void 0/.test(machine),
      "🔴 PART 0B THE SETTLEMENT, PER CALL: a task's result settles EVERY call it serves with `call.settled` (outcome `interrupted` and a reason word for a cancel) — the edge `taskCallSettledData` reads",
    );
    ok(
      /function endTask\((\w+),(\w+)\)\{let (\w+)=\1\.projection\.view\.tasks\[\2\.taskId\];if\(\3===void 0\|\|\3\.status===`ended`\)return unchanged\(\1,\[\]\);[^]*?fact\(`task\.ended`,\{[^]*?outcome:\w+\.status,reason:\w+\.status===`cancelled`\?\w+\.reason\?\?`task-ended`:void 0,taskId:\2\.taskId\}\)/.test(machine),
      "🔴 PART 0B THE SETTLEMENT, PER TASK: a task ends ONCE with `task.ended {taskId, outcome}` — it carries no call id, which is why `taskEndedData` takes the opening call off the view",
    );
    ok(
      /function openChild\((\w+),(\w+)\)\{return commitOf\(\[\{\.\.\.fact\(`child\.opened`,\1\),scope:scoped\(\2\)\}\]\)\}/.test(readEveDist("harness/session-machine/children.js")),
      "PART 0B: the session machine commits `child.opened` as a fact, which is what reaches a hook",
    );
    ok(
      /function commitTask\((\w+),(\w+),\w+,\w+\)\{let \w+=createTask\(readTaskTable\(\1\.state\),\{callId:\2\.callId,kind:isAgentTool\(\2\.definition\)\?`agent`:`tool`,/.test(readEveDist("execution/tasks/model-step.js")),
      "🔴 PART 0B: the task RECORD is created against the delegating call's own `callId`, and eve's only producer of a task kind writes `agent` or `tool` — the two kinds `readTaskStarted` admits",
    );
    const dispatchStep = readEveDist("execution/coordination-dispatch-step.js");
    ok(
      /agentContext:captureAgentSessionContext\(\w+,(\w+)\.callId\)[^]*?task:\1\}/.test(dispatchStep),
      "🔴 PART 0B THE JOIN, CHILD SIDE (1/4): eve captures the agent-session context with the `callId` off the SAME plan entry it passes as `task`, so the lineage's call id and the task's are one id",
    );
    ok(
      /parent:\{callId:t,rootSessionId:/.test(readEveDist("execution/agent-sessions/context.js")),
      "…(2/4): and that argument becomes the lineage's own `parent.callId`",
    );
    ok(
      /function createParentContext\(\w+,\w+\)\{return\{[^}]*lineage:\w+\.parent,/.test(readEveDist("execution/agent-sessions/start.js")),
      "…(3/4): which rides the PARENT CONTEXT as `lineage` (`createParentContext`); the run input carries it as `parent`, which (4/4) pins",
    );
    const subagentTool = readEveDist("subagents/tool.js");
    ok(
      /parent:e\.parent\.lineage,/.test(subagentTool),
      "🔴 …(4/4): and `buildSubagentRunInput` sets the child's `parent` to that lineage — which `channel/types.d.ts` declares as `SessionParent.callId`, \"Parent runtime-action tool call id that created this child session\". THIS is the byte the delegation key depends on, and this is the leg that reds if eve re-keys it",
    );
    ok(
      /u=\{callId:t\.callId,/.test(subagentTool) || /\{callId:t\.callId,parentContinuationToken:/.test(subagentTool),
      "…and the child's ADAPTER STATE carries the same id as well — eve's HITL/authorization forwarding key, a second user of it rather than the carrier the delegation key reads",
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
    /continuationKey:[a-z]\.key/.test(readEveDist("execution/agent-sessions/start.js")),
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

}

await onParentTurn(async () => {
  const link = await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_1", "agent-bb0001"))!, PARENT);
  eq(
    link,
    { callId: "call_1", childToken: `subagent:${PARENT}:call_1`, parentSessionId: PARENT, kind: "agent", tool: "agent" },
    "🔴 T1: a dispatch REMEMBERS the join: the callId, OE's own delegation row key, and — new at 0.70 — the dispatching session RECORDED rather than parsed back out of a token",
  );
  eq(await taskCall.taskCallLink(ORG, "agent-bb0001"), link, "…persisted under the task id, which is the only id present on EVERY event of a 0.70 task");
});

ok(taskCall.taskCallKey("t").startsWith("oe-task-call:"), "🔴 T1: the join-row prefix is namespaced, so no two consumers of the shared task_result slice can collide");
ok(!Object.keys(taskCall).includes("taskAgentKey"), "🔴 T1 (OPE-2250 step 1): the `oe-task-agent:` row is RETIRED — keyed on `taskId`, not on `agentId`. A resumable 0.70 task IS its taskId, so a continuation needs no handle pinned to find the first dispatch's join");

await onParentTurn(async () => {
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_1b", "agent-bb0002"))!, PARENT);
  await hub.noteAgentStarted(tasks.readAgentStarted(agentStartedData("call_1b", "agent-bb0002", "sess-child-1b"))!, PARENT);
  eq(
    (await taskCall.taskCallLink(ORG, "agent-bb0002"))?.agentId,
    "sess-child-1b",
    "🔴 PART 1B: the child's REAL session id lands on the dispatch row. eve 0.54 handed OE an opaque handle and the old comments said the session id reached no hook at all; `agent.started` carries it, and the census row joins on it",
  );
});

const bound = (hub.default as unknown as { events: Record<string, unknown> }).events;
const events = v27Hooks(hub.default);
const startedHandler = events.taskStarted;
const settledHandler = events.taskEnded;
const agentHandler = events.childOpened;

ok(typeof bound["task.started"] === "function", "🔴 T4 REACHABILITY: the settlement hub SUBSCRIBES to `task.started`. Without it the dispatch join is never written and every settlement below resolves `no-row`");
ok(typeof bound["task.ended"] === "function", "🔴 T4 REACHABILITY: …and to `task.ended`, the end of a task on eve 1.x (0.x `task.settled`)");
ok(typeof bound["call.settled"] === "function", "🔴 T4 REACHABILITY: …and to `call.settled`, which settles each call a task serves");
ok(typeof bound["call.started"] === "function", "🔴 T4 REACHABILITY: …and to `call.started`, which is how a continuation of a task arrives (PART 0B above)");
ok(typeof bound["child.opened"] === "function", "🔴 T4 REACHABILITY: …and to `child.opened`, which is where the child's session id comes from");
{
  const known: ReadonlySet<string> = new Set(EVE_EVENT_NAMES);
  const stale = Object.keys(bound).filter((k) => !known.has(k));
  eq(stale, [], "🔴 T4: every event the hub binds is one eve 1.x emits. The 0.54 notification edge and the 0.x `task.settled` / `agent.started` keys are gone — a handler left on a name eve no longer sends would answer 'no settlement' on every call");
}

{
  const call = "call_e2e_settle";
  const task = "agent-eeee0001";
  await onParentTurn(async () => {
    await startedHandler({ data: startedData(call, task) }, parentCtx);
    await agentHandler({ data: agentStartedData(call, task, "sess-child-e2e") }, parentCtx);
  });
  await onParentTurn(async () => {
    await settledHandler({ data: settledData(call, task) }, parentCtx);
  });
  await new Promise((r) => setTimeout(r, 50));
  const settled = (await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION })).filter((r) => r.detail?.task === task);
  eq(settled.length, 1, "🔴 T4 E2E: a settlement through eve's `task.ended`, the real subscription and the real handler writes exactly ONE `delegation.task_settled` row");
  eq(
    settled[0]?.detail,
    { task, status: "completed", session: PARENT, agent: "sess-child-e2e" },
    "🔴 T4 E2E: …carrying ids and eve's status word ONLY. The taint verdict fields (`marker`, `adopted`, `kinds`) are gone with the carriage (OPE-2720), and the child's session id comes off the dispatch row `child.opened` filled in",
  );
}

{
  const call = "call_e2e_call_settle";
  const task = "agent-eeee0002";
  await onParentTurn(async () => {
    await startedHandler({ data: startedData(call, task) }, parentCtx);
    await agentHandler({ data: agentStartedData(call, task, "sess-child-e2e-2") }, parentCtx);
  });
  await onParentTurn(async () => {
    await events.taskCallSettled({ data: settledData(call, task) }, parentCtx);
  });
  await new Promise((r) => setTimeout(r, 50));
  const settled = (await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION })).filter((r) => r.detail?.task === task);
  eq(settled.length, 1, "🔴 T4 E2E: the OTHER v27 edge — the `call.settled` of the call the task serves — writes exactly ONE `delegation.task_settled` row too");
  eq(settled[0]?.detail?.agent, "sess-child-e2e-2", "…naming the child session `child.opened` recorded");
}

{
  const failedRows = async (task: string) => (await readAudit({ org: ORG, action: hub.TASK_FAILED_ACTION })).filter((r) => r.detail?.task === task);
  const settledRows = async (task: string) => (await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION })).filter((r) => r.detail?.task === task);
  const drive = async (call: string, task: string, status: "cancelled" | "failed", extra: Record<string, unknown>) => {
    await onParentTurn(async () => {
      await startedHandler({ data: startedData(call, task) }, parentCtx);
    });
    await onParentTurn(async () => {
      await settledHandler({ data: settledData(call, task, status, extra) }, parentCtx);
    });
    await new Promise((r) => setTimeout(r, 50));
  };
  await drive("call_cancel_row", "agent-eeee0003", "cancelled", { cancel: { reason: "task-cancel" } });
  eq((await failedRows("agent-eeee0003")).length, 0, "🔴 T4 CANCEL: a cancelled task's `task.ended` through the real hub writes NO `delegation.task_failed` row — only a `failed` task writes one, and the security doc says so");
  eq(
    (await settledRows("agent-eeee0003")).map((r) => r.detail?.status),
    ["cancelled"],
    "…and its `cancelled` status word lands on exactly one `delegation.task_settled` row",
  );
  await drive("call_failed_row", "agent-eeee0004", "failed", { error: { message: "the worker died" } });
  eq((await failedRows("agent-eeee0004")).length, 1, "🔴 T4 CANCEL NEGATIVE CONTROL: a FAILED task in the same run writes exactly one `delegation.task_failed` row, so the zero above is the cancel arm and not a reader that sees nothing");
}

await onParentTurn(async () => {
  await settledHandler({ data: { status: "working", taskId: "agent-ff0001", callId: "c", turnId: TURN } }, parentCtx);
});
await new Promise((r) => setTimeout(r, 50));
{
  const refused = await readAudit({ org: ORG, action: hub.TASK_UNREADABLE_ACTION });
  const mine = refused.filter((r) => r.detail?.task === "agent-ff0001");
  eq(mine.length, 1, "🔴 T4: an UNREADABLE settlement writes exactly one row, so a reader that refuses what eve sends is visible in an audit query instead of silent");
  eq(mine[0]?.detail?.edge, "task.ended", "…and names the edge that refused it");
  const settledRows = await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION });
  eq(
    settledRows.filter((r) => r.detail?.task === "agent-ff0001").length,
    0,
    "🔴 T4 NEGATIVE CONTROL: a refused event writes NO `delegation.task_settled` row at all, so the parked-worker census and every settlement consumer still see only tasks that really settled",
  );
}

{
  const requestedHandler = events.callRequested;
  eq(typeof bound["call.requested"], "function", "precondition: the hook subscribes to `call.requested`, eve 1.x's per-call step edge (0.x `actions.requested`)");

  const unifiedCtx = { ...parentCtx, channel: { kind: "channel:unified", continuationToken: "unified:oe-dom:e2e:oe-sup:g1" } };
  eq(isUnifiedWindowContext(unifiedCtx as never), true, "precondition: the fixture really is a unified seat, read through the same predicate the handler uses");
  eq(isUnifiedWindowContext(parentCtx as never), false, "🔴 …and `parentCtx` is NOT, which is why it drives the binding path and writes no unauthorized row");

  await contextStorage.run(new ContextContainer(), async () => {
    await requestedHandler({ data: { actions: [{ kind: "tool-call", toolName: "agent", callId: "call_noauth" }] } }, unifiedCtx);
  });
  await new Promise((r) => setTimeout(r, 50));
  {
    const rows = await readAudit({ org: ORG, action: hub.DISPATCH_UNAUTHORIZED_ACTION });
    const mine = rows.filter((r) => r.detail?.call === "call_noauth");
    eq(mine.length, 1, "🔴 PART 4D: a unified delegating turn with no addressed wake writes ONE `delegation.dispatch_unauthorized` row — the state the swallowed throw used to pass over in silence");
    eq(mine[0]?.detail?.edge, "call.requested", "…naming the edge it fired on, because the same recorder also serves `task.started`");
    eq(mine[0]?.detail?.reason, "unified-turn-no-wake", "…and the REASON, which is the only field separating this arm from the settlement-turn arms");
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
    const mine = (await readAudit({ org: ORG, action: hub.DISPATCH_UNAUTHORIZED_ACTION })).filter((r) => r.detail?.task === "agent-4d0001");
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
    (await taskCall.taskCallLink(ORG, "agent-4d0001"))?.callId,
    "call_noauth",
    "🔴 PART 4D: `oe-task-call:<taskId>` IS present for a refused dispatch: the refusal leaves only the dispatch-authority row unwritten",
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
    const rows = await readAudit({ org: ORG, action: hub.DISPATCH_UNAUTHORIZED_ACTION });
    const mine = rows.filter((r) => r.detail?.call === "call_ambig");
    eq(mine.length, 1, "🔴 PART 4D: an uningressed unified settlement turn that delegates without a SINGLE authority is recorded too — this is the arm whose throw claimed to refuse the launch before an exact wake was addressed");
    eq(mine[0]?.detail?.reason, "settlement-turn-ambiguous-authority", "…and `blocked` is reported as AMBIGUOUS rather than absent, because the two are different operator stories");
  }

  {
    const before = (await readAudit({ org: ORG, action: hub.DISPATCH_UNAUTHORIZED_ACTION })).length;
    await contextStorage.run(new ContextContainer(), async () => {
      await requestedHandler({ data: { actions: [{ kind: "tool-call", toolName: "reply", callId: "call_reply" }] } }, unifiedCtx);
    });
    await new Promise((r) => setTimeout(r, 50));
    const after = await readAudit({ org: ORG, action: hub.DISPATCH_UNAUTHORIZED_ACTION });
    eq(after.length, before, "🔴 PART 4D NEGATIVE CONTROL: a non-delegating action writes NO unauthorized-dispatch row — the recorder keys on delegation, not on the turn being unaddressed");
    eq(after.filter((r) => r.detail?.call === "call_reply").length, 0, "…and nothing names the reply call");
  }
}

ok(
  /case`serve`:\{let\{input:r,taskId:i\}=splitTaskIdInput\(t\.input\);return i===void 0\?commitTask\(e,t,n,r\):\{entry:\{entryPoint:`receive`,taskId:i\},input:r,session:e\}\}/.test(readEveDist("execution/tasks/model-step.js")),
  "🔴 T5 PART 0B: eve routes a call carrying `taskId` onto the EXISTING task record rather than minting a new one. This is the byte behind 'key on taskId, not on agentId'",
);

await onParentTurn(async () => {
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_5", "agent-bb0005"))!, PARENT);
  const first = await taskCall.taskCallLink(ORG, "agent-bb0005");
  const again = await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_5_again", "agent-bb0005"))!, PARENT);
  eq(again?.callId, "call_5", "🔴 T5: a continuation on the same taskId resolves the ORIGINAL call — no handle row needed to get there");
  eq(again, first, "…and the row is returned unchanged rather than rewritten, which is what makes a redelivered event idempotent");
  ok(
    /async function sendToTask\((\w+)[^{]*\)\{[^]*?started:taskCallStart\(\1,\w+\)\}\}/.test(readEveDist("execution/tasks/start.js")) &&
      /function taskCallStart\((\w+),(\w+)\)\{return\{callId:\1\.task\.callId,[^}]*taskId:\1\.taskId,/.test(readEveDist("execution/tasks/start.js")),
    "🔴 T5 PART 0B: a continuation really does reach OE — eve's `sendToTask` answers `started` with the NEW call's id and the EXISTING task id, and the session machine turns that into `call.started {callId, taskId}` (PART 0B above). Without these bytes the branch below would be testing an event eve never sends",
  );
});
{
  const TASK = "agent-bb0009";
  const { viewOf, ev } = await import("./_hook-view.js");
  await onParentTurn(async () => {
    await startedHandler({ data: startedData("call_9", TASK) }, parentCtx);
  });
  const scope = { turnId: TURN };
  const view = viewOf([
    ev("session.started", {}),
    ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, scope),
    ev("model.requested", { runId: "r1", owner: { turnId: TURN } }, { ...scope, runId: "r1" }),
    ev("call.requested", { callId: "call_9", owner: { runId: "r1" }, capability: { kind: "agent", name: "agent" } }, { ...scope, runId: "r1" }),
    ev("call.started", { callId: "call_9", taskId: TASK }, scope),
    ev("task.started", { taskId: TASK, startedBy: { callId: "call_9" }, kind: "agent", name: "agent" }, scope),
    ev("call.requested", { callId: "call_9_again", owner: { runId: "r1" }, capability: { kind: "agent", name: "agent" } }, { ...scope, runId: "r1" }),
    ev("call.started", { callId: "call_9_again", taskId: TASK }, scope),
  ]);
  await onParentTurn(async () => {
    await (bound["call.started"] as (e: unknown, c: unknown) => Promise<void>)({ type: "call.started", data: { callId: "call_9_again", taskId: TASK }, scope }, { ...parentCtx, view });
  });
  await new Promise((r) => setTimeout(r, 50));
  const mine = (await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION })).filter((r) => r.detail?.task === TASK);
  eq(mine.length, 2, "🔴 T5 REAL EDGE: a continuation's `call.started` through the hub's own handler earns its own dispatch row");
  eq(mine.filter((r) => r.detail?.continuation === true).length, 1, "🔴 …marked `continuation: true`");
  eq((await taskCall.taskCallLink(ORG, TASK))?.callId, "call_9", "…and the join row still names the ORIGINAL call");
  const firstCall = (await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION })).filter((r) => r.detail?.task === TASK).length;
  await onParentTurn(async () => {
    await (bound["call.started"] as (e: unknown, c: unknown) => Promise<void>)({ type: "call.started", data: { callId: "call_9", taskId: TASK }, scope }, { ...parentCtx, view });
  });
  await new Promise((r) => setTimeout(r, 50));
  eq(
    (await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION })).filter((r) => r.detail?.task === TASK).length,
    firstCall,
    "🔴 T5 NEGATIVE CONTROL: the OPENING call's own `call.started` is not a continuation and writes no second row — `task.started` already recorded it",
  );
}
await new Promise((r) => setTimeout(r, 50));
{
  const started = await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION });
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

await onParentTurn(async () => {
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_census", "agent-bb0007"))!, PARENT);
  await hub.noteAgentStarted(tasks.readAgentStarted(agentStartedData("call_census", "agent-bb0007", "sess-child-census"))!, PARENT);
  await hub.settleFromTaskSettled(tasks.readTaskSettled(settledData("call_census", "agent-bb0007"))!, PARENT, parentCtx as never);
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION });
  const mine = settled.filter((r) => r.detail?.task === "agent-bb0007");
  eq(mine.length, 1, "one settled row for the settled task");
  eq(mine[0]?.detail?.agent, "sess-child-census", "🔴 OPE-566 THE CENSUS: the settled row names the parked worker's own session id — remove it and the parked population becomes uncountable");
  const started = await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION });
  const dispatch = started.filter((r) => r.detail?.task === "agent-bb0007");
  eq(dispatch.length, 1, "…and exactly one dispatch row, which is the other half of the census");
  eq(dispatch[0]?.detail?.kind, "agent", "🔴 OPE-566: the dispatch row carries eve's own task KIND, which is what tells an operator this row is a delegation at all now that the agent handle is gone from `task.started`");
}

{
  const settled = await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION });
  eq(settled.filter((r) => r.detail?.task === "agent-bb0002").length, 0, "🔴 OPE-566 NEGATIVE CONTROL: the task from PART 1B was dispatched and never settled, and it has NO settled row — the census counts parked workers, never dispatches");
}

await onParentTurn(async () => {
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_replay", "agent-bb0008"))!, PARENT);
  await hub.noteTaskStarted(tasks.readTaskStarted(startedData("call_replay", "agent-bb0008"))!, PARENT);
});
await new Promise((r) => setTimeout(r, 50));
{
  const started = await readAudit({ org: ORG, action: hub.TASK_STARTED_ACTION });
  const mine = started.filter((r) => r.detail?.task === "agent-bb0008");
  eq(mine.length, 1, "🔴 OPE-586: a replayed dispatch writes EXACTLY ONE dispatch row, so an operator counting delegations is not reading eve's redelivery behaviour");
  eq(mine[0]?.detail?.continuation, false, "…and it is not misclassified as a continuation: a replay carries the SAME callId, which is what tells the two apart");
}

console.log(`background-task-settlement: ${String(n)} assertions passed`);

// proves: AP-MOD-core-access-background-tasks, delegation.task_unreadable, delegation.dispatch_unauthorized
