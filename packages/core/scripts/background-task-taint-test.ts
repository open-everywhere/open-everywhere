import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-background-task-taint-")), "ops.sqlite3");
process.env.OE_WORKSPACE = "dev";

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
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { readAudit } = await import("../agent/audit/audit.js");

const PARENT = "sess-seat";
const ORG = "default";

const parentCtx = {
  channel: { kind: "channel:slack", continuationToken: "unified:oe-dom:e2e:oe-sup:g1" },
  session: { id: PARENT, auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } } },
  agent: { name: "oe", nodeId: "__root__" },
};

function childCtx(callId: string, sessionId: string) {
  return {
    channel: { kind: "subagent", continuationToken: `subagent:${PARENT}:${callId}` },
    session: {
      id: sessionId,
      parent: { sessionId: PARENT, callId, rootSessionId: PARENT, turn: { id: "turn_1", sequence: 1 } },
      auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  };
}

function receiptResult(callId: string, taskId: string, agentId: string) {
  return {
    backgroundTask: { status: "working", taskId },
    callId,
    kind: "subagent-result",
    origin: "child",
    outcome: { kind: "parked", result: { kind: "succeeded", output: `Delegated as background task ${taskId} (working).` }, usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 } },
    output: { agentId, status: "working", taskId },
    subagentName: "agent",
  };
}

function peekResult(views: { taskId: string; status: string; agentId: string; output?: string }[]) {
  return {
    callId: "peek-1",
    kind: "tool-result",
    toolName: "task_peek",
    output: {
      tasks: views.map((v) => ({
        metadata: { agentId: v.agentId, kind: "subagent", mode: "local", name: "agent" },
        taskId: v.taskId,
        status: v.status,
        ...(v.output === undefined ? {} : { lastOutput: { data: v.output, type: "result" } }),
      })),
    },
  };
}

async function onParentTurn<T>(fn: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    ok(!untrustedIngestedThisTurn(), "precondition: the parent's turn starts CLEAN");
    return await fn();
  });
}

async function runChild(callId: string, sessionId: string, taint: boolean): Promise<void> {
  contextStorage.run(new ContextContainer(), () => {
    spawnTaint.openTaintTurn(childCtx(callId, sessionId) as never);
    if (taint) markUntrustedIngestedThisTurn();
  });
  await new Promise((r) => setTimeout(r, 50));
}

{
  const receipt = tasks.readTaskReceipt(receiptResult("call_a", "task_a", "ag_agent:aaaa"));
  eq(receipt, { taskId: "task_a", callId: "call_a", agentId: "ag_agent:aaaa" }, "🔴 the receipt reader takes the three ids off eve's parked receipt and nothing else — no brief, no output prose");

  const sync = { kind: "subagent-result", origin: "child", callId: "call_a", subagentName: "agent", output: "the child answered", outcome: { kind: "terminal" } };
  eq(tasks.readTaskReceipt(sync), null, "🔴 THE DISCRIMINATOR: a SYNC subagent-result — same kind, same callId — reads as `null`, because it carries no `backgroundTask`. This is the one field that separates a dispatch from a settlement");
  eq(tasks.readTaskReceipt({ kind: "tool-result", toolName: "task_peek", output: { tasks: [] } }), null, "…and a task_peek result is not a receipt either");
  eq(tasks.readTaskReceipt(undefined), null, "…and an absent result reads as `null` rather than throwing");

  const working = peekResult([{ taskId: "task_w", status: "working", agentId: "ag_agent:wwww" }]);
  eq(tasks.taskViewsOf(working).length, 1, "the peek reader RECOGNISES a working view — asserted so the terminal filter below cannot pass by failing to parse at all");
  eq(tasks.terminalTaskViewsOf(working), [], "🔴 …and the TERMINAL filter drops it: a working child can still read untrusted content, so its taint answer is not final");
  eq(tasks.terminalTaskViewsOf(peekResult([{ taskId: "task_q", status: "input_required", agentId: "ag_agent:qqqq" }])), [], "🔴 `input_required` is NOT terminal either — a child parked on a question can be released and go on reading");

  for (const status of ["completed", "failed", "cancelled"]) {
    eq(
      tasks.terminalTaskViewsOf(peekResult([{ taskId: `task_${status}`, status, agentId: "ag_agent:tttt" }])),
      [{ taskId: `task_${status}`, status, agentId: "ag_agent:tttt" }],
      `🔴 \`${status}\` IS terminal — eve's own isTerminalTaskStatus. \`failed\`/\`cancelled\` count because a child that read a hostile page and then died still wrote its marker`,
    );
  }
  eq(
    tasks.terminalTaskViewsOf({ kind: "tool-result", toolName: "task_cancel", output: { tasks: [{ taskId: "t", status: "completed" }] } }),
    [{ taskId: "t", status: "completed", agentId: null }],
    "🔴 a `task_cancel` terminal view IS read — eve returns the full view (lastOutput included) from BOTH view-bearing tools, and a cancel of an already-terminal task delivers the child's prose exactly like a peek (train-#59 review finding 1: reading only the peek left this second output path taint-blind)",
  );
  eq(
    tasks.terminalTaskViewsOf({ kind: "tool-result", toolName: "task_sleep", output: { tasks: [{ taskId: "t", status: "completed" }] } }),
    [],
    "…and a view-SHAPED payload under a NON-view-bearing tool name is still ignored — the accept-set is exactly {task_peek, task_cancel}, never a prefix match",
  );
  eq([...tasks.TASK_TOOL_NAMES].sort(), ["task_cancel", "task_peek", "task_sleep", "task_update"], "the four task tool names are named once, in the isolation module");
}

await onParentTurn(async () => {
  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_1", callId: "call_1", agentId: "ag_agent:1111" }, PARENT);
  eq(untrustedIngestedThisTurn(), false, "🔴 T1 THE MEASURED DEFECT, CLOSED: a parked task receipt marks the parent's turn NOT AT ALL — asserted `=== false`, not merely falsy. Before this branch existed the fail-closed read ran here and every clean delegation tainted its own seat");
  eq(link, { callId: "call_1", childToken: `subagent:${PARENT}:call_1` }, "…and it REMEMBERS the join instead: the callId the child writes its marker under, and the continuation token eve minted for it");
  eq(await store.taskCallLink(ORG, "task_1"), link, "…persisted under the task id, which is the only id present on BOTH edges of a background delegation");
});

{
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const undelivered = await getOperationalStore().listUndeliveredTaskResults(ORG, "oe-dom:e2e:oe-sup:g1", 50);
  ok(
    undelivered.every((r) => !r.taskId.startsWith("oe-task-call:") && !r.taskId.startsWith("oe-task-agent:")),
    "🔴 T1: both join rows carry NO callerToken, so neither appears in listUndeliveredTaskResults — they are bookkeeping, not results",
  );
  ok(store.taskCallKey("t").startsWith("oe-task-call:") && store.taskAgentKey(PARENT, "a").startsWith("oe-task-agent:"), "…and the two prefixes are namespaced apart from each other and from both marker prefixes");
}

await runChild("call_2", "sess-child-dirty", true);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_2"), true, "precondition: the child that read untrusted content wrote its call-keyed marker TAINTED");

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_2", callId: "call_2", agentId: "ag_agent:2222" }, PARENT);
  eq(untrustedIngestedThisTurn(), false, "…and the receipt for that same tainted child STILL marks nothing at dispatch — the taint exists, but the parent has not read a byte of it yet");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_2", status: "completed", agentId: "ag_agent:2222" }, PARENT);
  eq(adopted, true, "🔴 T2 THE DEFENCE IS RELOCATED, NOT WEAKENED: a child that genuinely read untrusted content marks its parent on the TERMINAL view — the edge where the child's output enters the parent's history");
  eq(untrustedIngestedThisTurn(), true, "…and the parent's own turn signal is set, so remember / create_routine / create_skill gate as if the seat had read what the child read");
});

await runChild("call_3", "sess-child-clean", false);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_3"), false, "precondition: the clean child's eager claim left a POSITIVE known-clean row, not silence");

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_3", callId: "call_3", agentId: "ag_agent:3333" }, PARENT);
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_3", status: "completed", agentId: "ag_agent:3333" }, PARENT);
  eq(adopted, false, "🔴 T2 NEGATIVE CONTROL: a terminal peek over a CLEAN child does NOT mark the parent — asserted `=== false`, not merely falsy");
  eq(untrustedIngestedThisTurn(), false, "…and the turn signal reads `=== false` too: a clean background delegation is clean end to end, which is the whole point of this ticket");
});

await onParentTurn(async () => {
  eq(await store.taskCallLink(ORG, "task_no_row"), undefined, "precondition: no join row exists for this task at all");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_no_row", status: "completed", agentId: "ag_agent:xxxx" }, PARENT);
  eq(adopted, true, "🔴 T3 FAIL CLOSED, LOST JOIN: a terminal view whose join row is gone marks the parent — the settlement cannot establish the child's taint, and it may not answer 'clean' for a fact it could not read");
  eq(untrustedIngestedThisTurn(), true, "…and the turn signal is set");
});

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_lost_marker", callId: "call_never_ran", agentId: "ag_agent:llll" }, PARENT);
  eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_never_ran"), undefined, "precondition: the child never reached its own turn.started, so it wrote no marker of either value");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_lost_marker", status: "failed", agentId: "ag_agent:llll" }, PARENT);
  eq(adopted, true, "🔴 T3 FAIL CLOSED, LOST MARKER: a terminal view over a child whose taint record was lost marks the parent — the same direction OPE-437 fixed for the sync leg, on the new edge");
});

const handler = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["action.result"]!;

await runChild("call_4", "sess-child-working", true);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_4"), true, "precondition: this child IS tainted — so a marking on a working view would come from the view, not from a clean child");

await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: receiptResult("call_4", "task_4", "ag_agent:4444") } }, parentCtx);
  eq(untrustedIngestedThisTurn(), false, "🔴 T4 THROUGH THE REAL HANDLER: the receipt takes BRANCH 1 and marks nothing, even though branch 3 would have matched the same `kind` and `callId`");
  await handler({ data: { result: peekResult([{ taskId: "task_4", status: "working", agentId: "ag_agent:4444" }]) } }, parentCtx);
  eq(untrustedIngestedThisTurn(), false, "🔴 T4: a WORKING view over a TAINTED child marks nothing — the child's answer is not in the parent's history yet, and its taint answer is not final");
  await handler({ data: { result: peekResult([{ taskId: "task_4", status: "input_required", agentId: "ag_agent:4444" }]) } }, parentCtx);
  eq(untrustedIngestedThisTurn(), false, "…and neither does `input_required`");
  await handler({ data: { result: peekResult([{ taskId: "task_4", status: "completed", agentId: "ag_agent:4444", output: "what the child found" }]) } }, parentCtx);
  eq(untrustedIngestedThisTurn(), true, "🔴 T4 THE DISCRIMINATOR: the SAME task, the SAME child, one field different — `completed` — and the parent adopts. The gate is the status, nothing else");
});

await runChild("call_5", "sess-child-persistent", false);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_5"), false, "precondition: the persistent child is clean, and its marker sits under its FIRST callId");

await onParentTurn(async () => {
  const first = await spawnTaint.noteTaskReceipt({ taskId: "task_5a", callId: "call_5", agentId: "ag_agent:5555" }, PARENT);
  eq(first?.childToken, `subagent:${PARENT}:call_5`, "the first dispatch mints the token and pins it against the agent id");
  const second = await spawnTaint.noteTaskReceipt({ taskId: "task_5b", callId: "call_5_continued", agentId: "ag_agent:5555" }, PARENT);
  eq(second, first, "🔴 T5: a continuation on the same agentId resolves the ORIGINAL join — the pinned row wins over the receipt's own newer callId, because the child never re-minted its token");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_5b", status: "completed", agentId: "ag_agent:5555" }, PARENT);
  eq(adopted, false, "🔴 T5: so the CONTINUATION's terminal peek reads the clean child's real marker and does NOT mark — without the pinned token this reads `undefined` and fail-closes on a clean child");
  eq(untrustedIngestedThisTurn(), false, "…asserted on the turn signal too, `=== false`");
});

eq(await store.taskAgentLink(ORG, PARENT, "ag_agent:5555"), { callId: "call_5", childToken: `subagent:${PARENT}:call_5` }, "🔴 T5: the agent-keyed row still holds the FIRST dispatch's callId after a continuation wrote through it");

await runChild("call_6", "sess-child-sync", true);
await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: { kind: "subagent-result", origin: "child", callId: "call_6", subagentName: "agent", output: "the child answered" } } }, parentCtx);
  eq(untrustedIngestedThisTurn(), true, "🔴 T6 SYNC UNCHANGED: a sync subagent-result from a TAINTED child still marks the parent on `action.result` — branch 3, reached because branches 1 and 2 both declined");
});
await runChild("call_7", "sess-child-sync-clean", false);
await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: { kind: "subagent-result", origin: "child", callId: "call_7", subagentName: "agent", output: "the child answered" } } }, parentCtx);
  eq(untrustedIngestedThisTurn(), false, "🔴 T6 SYNC UNCHANGED, NEGATIVE HALF: a sync result from a CLEAN child marks nothing — asserted `=== false`");
});
await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: { kind: "subagent-result", origin: "child", callId: "call_sync_lost", subagentName: "agent", output: "x" } } }, parentCtx);
  eq(untrustedIngestedThisTurn(), true, "🔴 T6 SYNC UNCHANGED, FAIL-CLOSED HALF: OPE-437's fail-closed read still fires for a sync result whose marker was lost — the branch order moved the RECEIPT off this path, and nothing else");
});

await onParentTurn(async () => {
  const receipt = { taskId: "task_replay", callId: "call_replay", agentId: "ag_agent:rrrr" };
  const first = await spawnTaint.noteTaskReceipt(receipt, PARENT);
  eq(first, { callId: "call_replay", childToken: `subagent:${PARENT}:call_replay` }, "the first pass mints the join exactly as T1 does");

  const replayed = await spawnTaint.noteTaskReceipt(receipt, PARENT);
  eq(replayed, first, "🔴 OPE-586: the replayed pass resolves to the SAME recorded link, not a fresh one");

  await new Promise((r) => setTimeout(r, 50));
  const rows = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  const mine = rows.filter((r) => r.detail?.task === "task_replay");
  eq(mine.length, 1, "🔴 OPE-586 THE ACCEPTANCE: a replayed dispatch writes EXACTLY ONE `delegation.task_started` row, not two");
  eq(mine[0]?.detail?.continuation, false, "🔴 OPE-586: and that one row's `continuation` is `false` — a first dispatch, never a continuation, replayed or not");
});

await onParentTurn(async () => {
  const halfWritten = { callId: "call_crash", childToken: `subagent:${PARENT}:call_crash` };
  await store.rememberTaskAgent(ORG, PARENT, "ag_agent:crash", halfWritten);
  eq(await store.taskCallLink(ORG, "task_crash"), undefined, "precondition: the task-keyed row never landed — the simulated crash window");

  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_crash", callId: "call_crash", agentId: "ag_agent:crash" }, PARENT);
  eq(link, halfWritten, "the redelivery resolves to the SAME link the crashed pass had already pinned");

  await new Promise((r) => setTimeout(r, 50));
  const rows = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  const mine = rows.filter((r) => r.detail?.task === "task_crash");
  eq(mine.length, 1, "exactly one row for this task — the redelivery is the only pass that ever reached the audit write");
  eq(mine[0]?.detail?.continuation, false, "🔴 OPE-586 NARROW WINDOW: `continuation` reads `false` — the pinned row's `callId` equals this receipt's own, so it is this dispatch's own surviving write, not a later continuation");
});

registerSettings({ taint: { mode: "off" } });
await runChild("call_8", "sess-child-off", true);
await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_8", callId: "call_8", agentId: "ag_agent:8888" }, PARENT);
  eq(link, null, "🔴 taint OFF: the receipt branch writes NO join row — the rows exist only to serve the settlement read, and an opted-out deployment may not pay a store round trip for a fact nothing consumes");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_8", status: "completed", agentId: "ag_agent:8888" }, PARENT);
  eq(adopted, false, "…and the settlement branch does not mark, even though the child really was tainted — the deployer's reviewed choice, same posture as adoptSubagentTaint");
  eq(untrustedIngestedThisTurn(), false, "…asserted on the turn signal, `=== false`");
});
resetSettingsForTest();

await onParentTurn(async () => {
  await spawnTaint.adoptTaskTaint({ taskId: "task_census", status: "completed", agentId: "ag_agent:cccc" }, PARENT);
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  const mine = settled.filter((r) => r.detail?.task === "task_census");
  eq(mine.length, 1, "one settled row for the settled task");
  eq(mine[0]?.detail?.agent, "ag_agent:cccc", "🔴 OPE-566 THE CENSUS: the settled row names the parked worker's agent handle — remove it and the parked population becomes uncountable");
}

await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: receiptResult("call_live", "task_live", "ag_agent:live") } }, parentCtx);
  await handler({ data: { result: peekResult([{ taskId: "task_live", status: "working", agentId: "ag_agent:live" }]) } }, parentCtx);
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  eq(settled.filter((r) => r.detail?.task === "task_live").length, 0, "🔴 OPE-566 NEGATIVE CONTROL: a WORKING view writes NO settled row — the census counts parked workers, never peeks");
  const started = await readAudit({ org: ORG, action: spawnTaint.TASK_STARTED_ACTION });
  eq(started.filter((r) => r.detail?.task === "task_live" && r.detail?.agent === "ag_agent:live").length, 1, "…and the dispatch row carries the SAME `agent` key, which is what joins the two halves of the census");
}

console.log(`background-task-taint-test: ${n} assertions passed`);
