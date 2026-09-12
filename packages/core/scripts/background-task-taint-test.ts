import assert from "node:assert/strict";
import { filesContainingAll } from "./eve-dist-search.js";
import { mkdtempSync, readFileSync } from "node:fs";
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
const { untrustedIngestedThisTurn, markUntrustedIngestedThisTurn, taintKindsThisTurn } = await import("../agent/access/taint-signal.js");
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

function receiptResultV2(callId: string, taskId: string, agentId: string) {
  return { callId, kind: "tool-result", toolName: "agent", output: { agentId, status: "working", taskId } };
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
  const receipt = tasks.readTaskReceipt(receiptResult("call_a", "task_a", "ag_agent:aaaa"));
  eq(
    receipt,
    { taskId: "task_a", callId: "call_a", agentId: "ag_agent:aaaa", tool: "agent" },
    "🔴 the receipt reader takes the three ids and eve's own tool name off the parked receipt and nothing else — no brief, no output prose. The tool name is what lets a settlement's failure row say WHICH delegated read died (OPE-1737)",
  );

  const sync = { kind: "subagent-result", origin: "child", callId: "call_a", subagentName: "agent", output: "the child answered", outcome: { kind: "terminal" } };
  eq(tasks.readTaskReceipt(sync), null, "🔴 THE DISCRIMINATOR: a SYNC subagent-result — same kind, same callId — reads as `null`, because it carries no `backgroundTask`. This is the one field that separates a dispatch from a settlement");
  eq(tasks.readTaskReceipt({ kind: "tool-result", toolName: "task_peek", output: { tasks: [] } }), null, "…and a task_peek result is not a receipt either");
  eq(tasks.readTaskReceipt(undefined), null, "…and an absent result reads as `null` rather than throwing");

  eq(
    tasks.readTaskReceipt(receiptResultV2("t597-delegate", "task_6c7d596fcff2a3972c60cfa8", "ag_agent:6c7d596fcff2")),
    { taskId: "task_6c7d596fcff2a3972c60cfa8", callId: "t597-delegate", agentId: "ag_agent:6c7d596fcff2", tool: "agent" },
    "🔴 ENVELOPE B: the receipt eve 0.43.0+ hands the model — a plain `tool-result` with no `backgroundTask` envelope — reads to the SAME three ids as envelope A. The reader is a version UNION, exactly like TASK_TOOL_NAMES",
  );
  eq(
    tasks.readTaskReceipt(receiptResultV2("c1", "task_6c7d596fcff2a3972c60cfa8", "ag_agent:6c7d596fcff2")),
    tasks.readTaskReceipt(receiptResult("c1", "task_6c7d596fcff2a3972c60cfa8", "ag_agent:6c7d596fcff2")),
    "🔴 …and the two envelopes read IDENTICALLY. Nothing downstream can tell which eve produced the dispatch, which is what keeps one settlement plane serving both",
  );

  eq(tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "agent", output: { agentId: "ag_agent:6666", status: "completed", taskId: "task_6c7d596fcff2a3972c60cfa8" } }), null, "🔴 ARM B NEGATIVE CONTROL: a tool result whose `status` is not the literal `working` is NOT a parked receipt — asserted `=== null`");
  eq(tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "agent", output: { status: "working", taskId: "task_6c7d596fcff2a3972c60cfa8" } }), null, "🔴 ARM B NEGATIVE CONTROL: no `agentId` — the parked-worker census (OPE-566) has no handle to store, so this is not the receipt eve stamps");
  eq(tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "agent", output: { agentId: "ag_agent:6666", status: "working", taskId: "job-17" } }), null, "🔴 ARM B NEGATIVE CONTROL: a taskId outside eve's `task_` namespace is refused — the fence that keeps an arbitrary word out of a store key");
  eq(tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "agent", output: { agentId: "ag_agent:6666", status: "working", taskId: "task_" } }), null, "…and the bare prefix with nothing after it is refused too");
  eq(tasks.readTaskReceipt({ kind: "tool-result", toolName: "agent", output: { agentId: "ag_agent:6666", status: "working", taskId: "task_6c7d596fcff2a3972c60cfa8" } }), null, "🔴 ARM B NEGATIVE CONTROL: no `callId` — without it there is no join to the child's own taint marker, so there is nothing to remember");
  eq(tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "spawn_thread_session", output: { taskId: "task_6c7d596fcff2a3972c60cfa8", thread: "slack:C1:1.0", note: "spawned" } }), null, "🔴 ARM B NEGATIVE CONTROL: an OE spawn result carrying a `task_`-shaped id is still refused — `status` and `agentId` are what make a result a receipt, and it has neither");
  eq(
    tasks.readTaskReceipt({ callId: "c1", kind: "tool-result", toolName: "some_new_subagent", output: { agentId: "ag_some_new_subagent:6666", status: "working", taskId: "task_6c7d596fcff2a3972c60cfa8" } }),
    { taskId: "task_6c7d596fcff2a3972c60cfa8", callId: "c1", agentId: "ag_some_new_subagent:6666", tool: "some_new_subagent" },
    "🔴 ARM B IS NOT KEYED ON THE TOOL NAME: eve names a subagent tool after the SUBAGENT, so a receipt under a name OE never listed is still read. A name allow-list here would answer `null` and take the taint adoption fail-OPEN — the OPE-943 defect, one case along",
  );

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

{
  const eveSrc = (rel: string): string | null => {
    try {
      return readFileSync(join(eveRoot, "dist/src", rel), "utf8");
    } catch {
      return null;
    }
  };

  const delegate = eveSrc("execution/tasks/parent/delegate.js");
  const producerA = delegate !== null && delegate.includes("settleDelegatedDispatch") && /backgroundTask:\{status:/.test(delegate) && /kind:`subagent-result`/.test(delegate);
  if (delegate !== null && producerA) {
    ok(/backgroundTask:\{status:[^,]+,taskId:/.test(delegate), "🔴 PART 0B PRODUCER A: eve's `settleDelegatedDispatch` still stamps `backgroundTask:{status, taskId}` — the field arm A discriminates on");
    eq(
      tasks.readTaskReceipt(receiptResult("call_a", "task_6c7d596fcff2a3972c60cfa8", "ag_agent:aaaa")),
      { taskId: "task_6c7d596fcff2a3972c60cfa8", callId: "call_a", agentId: "ag_agent:aaaa" },
      "🔴 PART 0B PRODUCER A: the installed eve still produces envelope A, and the reader still takes it",
    );
  }

  const frameworkTasks = eveSrc("tools/framework/task-contract.js");
  const schema = frameworkTasks === null ? null : /SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA=z\.strictObject\(\{([^}]*)\}\)/.exec(frameworkTasks);
  if (schema === null) {
    throw new Error(
      "🔴 PART 0B PRODUCER B: cannot read `SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA` out of eve's " +
        "dist/src/tools/framework/task-contract.js. The reader below claims to track eve's own shape; " +
        "without it every PRODUCER B assertion is vacuous. Find where eve moved the constant.",
    );
  }
  {
    const body = schema[1] ?? "";
    const keys = [...body.matchAll(/(?:^|,)([A-Za-z_$][\w$]*):/g)].map((m) => m[1]).sort();
    eq(keys, ["agentId", "status", "taskId"], "🔴 PART 0B PRODUCER B: eve's `SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA` still names exactly `agentId`, `status`, `taskId` — the three fields arm B reads. A rename here is a silent settlement outage everywhere else");
    ok(/status:z\.literal\(`working`\)/.test(body), "🔴 PART 0B PRODUCER B: eve still stamps the receipt status as the literal `working` — arm B's positive discriminator");

    const producers = filesContainingAll("execution:`background`", "SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA");
    ok(
      producers.length > 0,
      "🔴 PART 0B PRODUCER B: some module of the installed eve still pairs `execution: \"background\"` with the receipt schema — the pairing that routes a delegation through generic tool execution and produces the plain `tool-result` envelope",
    );

    eq(
      tasks.readTaskReceipt(receiptResultV2("t597-delegate", "task_6c7d596fcff2a3972c60cfa8", "ag_agent:6c7d596fcff2")),
      { taskId: "task_6c7d596fcff2a3972c60cfa8", callId: "t597-delegate", agentId: "ag_agent:6c7d596fcff2", tool: "agent" },
      "🔴 PART 0B PRODUCER B END TO END: the shape eve's installed schema declares parses to the three ids",
    );
  }

  ok(producerA || schema !== null, "🔴 PART 0B: the installed eve produces AT LEAST ONE receipt envelope this reader knows. If both producers vanish, eve has re-shaped the dispatch edge again and the settlement plane is off — this is the assertion that refuses to go vacuously green");
}

await onParentTurn(async () => {
  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_1", callId: "call_1", agentId: "ag_agent:1111", tool: "agent" }, PARENT);
  eq(untrustedIngestedThisTurn(), false, "🔴 T1 THE MEASURED DEFECT, CLOSED: a parked task receipt marks the parent's turn NOT AT ALL — asserted `=== false`, not merely falsy. Before this branch existed the fail-closed read ran here and every clean delegation tainted its own seat");
  eq(
    link,
    { callId: "call_1", childToken: `subagent:${PARENT}:call_1`, agentId: "ag_agent:1111", tool: "agent" },
    "…and it REMEMBERS the join instead: the callId the child writes its marker under, the continuation token eve minted for it, and the worker's agent handle for the census",
  );
  eq(await store.taskCallLink(ORG, "task_1"), link, "…persisted under the task id, which is the only id present on BOTH edges of a background delegation");
});

{
  ok(store.taskCallKey("t").startsWith("oe-task-call:") && store.taskAgentKey(PARENT, "a").startsWith("oe-task-agent:"), "🔴 T1: the two join-row prefixes are namespaced separately from each other and from the taint markers, so no two consumers of the shared slice can collide");
}

await runChild("call_2", "sess-child-dirty", true);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_2"), true, "precondition: the child that read untrusted content wrote its call-keyed marker TAINTED");

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_2", callId: "call_2", agentId: "ag_agent:2222", tool: "agent" }, PARENT);
  eq(untrustedIngestedThisTurn(), false, "…and the receipt for that same tainted child STILL marks nothing at dispatch — the taint exists, but the parent has not read a byte of it yet");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_2", status: "completed", agentId: "ag_agent:2222" }, PARENT);
  eq(adopted, true, "🔴 T2 THE DEFENCE IS RELOCATED, NOT WEAKENED: a child that genuinely read untrusted content marks its parent on the TERMINAL view — the edge where the child's output enters the parent's history");
  eq(untrustedIngestedThisTurn(), true, "…and the parent's own turn signal is set, so remember / create_routine / create_skill gate as if the seat had read what the child read");
});

await runChild("call_3", "sess-child-clean", false);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_3"), false, "precondition: the clean child's eager claim left a POSITIVE known-clean row, not silence");

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_3", callId: "call_3", agentId: "ag_agent:3333", tool: "agent" }, PARENT);
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
  await spawnTaint.noteTaskReceipt({ taskId: "task_lost_marker", callId: "call_never_ran", agentId: "ag_agent:llll", tool: "agent" }, PARENT);
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

{
  const messageHandler = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;
  const TASK_V2_DIRTY = "task_9f31ac7b21d0445ea6b1c3d8";
  const TASK_V2_CLEAN = "task_4b0e6d15c87a33f29ec5701b";

  await runChild("call_v2_dirty", "sess-child-v2-dirty", true);
  eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_v2_dirty"), true, "precondition: the envelope-B child that read untrusted content wrote its call-keyed marker TAINTED");

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await handler({ data: { result: receiptResultV2("call_v2_dirty", TASK_V2_DIRTY, "ag_agent:9f31ac7b21d0") } }, parentCtx);
    eq(untrustedIngestedThisTurn(), false, "🔴 PART 4B: the envelope-B receipt takes BRANCH 1 and marks nothing at dispatch — the child has not run");
    eq(
      await store.taskCallLink(ORG, TASK_V2_DIRTY),
      { callId: "call_v2_dirty", childToken: `subagent:${PARENT}:call_v2_dirty`, agentId: "ag_agent:9f31ac7b21d0", tool: "agent" },
      "🔴 PART 4B THE DISPATCH ROW, WHICH IS THE WHOLE DEFECT: an eve 0.43.0+ receipt now MINTS the join row. Before the reader was widened this read `undefined`, and every settlement that followed resolved `no-row` — no reply address, no taint adoption, no memory flush",
    );
  });

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await messageHandler({ data: { message: `Background task ${TASK_V2_DIRTY} (agent) is completed.\n\nResult:\nwhat the worker found` } }, parentCtx);
    eq(untrustedIngestedThisTurn(), true, "🔴 PART 4B: the settlement notification for that task ADOPTS the child's taint — the security control (OPE-563) that failed OPEN on eve 0.43.0+ because no join row existed");
  });

  await runChild("call_v2_clean", "sess-child-v2-clean", false);
  eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_v2_clean"), false, "precondition: the clean child's eager claim left a POSITIVE known-clean row");

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await handler({ data: { result: receiptResultV2("call_v2_clean", TASK_V2_CLEAN, "ag_agent:4b0e6d15c87a") } }, parentCtx);
    ok((await store.taskCallLink(ORG, TASK_V2_CLEAN)) !== undefined, "PART 4B: the clean child's envelope-B dispatch minted its join row too");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await messageHandler({ data: { message: `Background task ${TASK_V2_CLEAN} (agent) is completed.\n\nResult:\nnothing untrusted was read` } }, parentCtx);
    eq(untrustedIngestedThisTurn(), false, "🔴 PART 4B NEGATIVE CONTROL: a CLEAN envelope-B child's settlement marks NOTHING — asserted `=== false`. This can only pass if the join row minted at dispatch was found and read; with no row the settlement fails CLOSED and marks");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    eq(await store.taskCallLink(ORG, "task_1122334455667788990011aa"), undefined, "precondition: no dispatch ever minted a row for this task");
    await messageHandler({ data: { message: "Background task task_1122334455667788990011aa (agent) is completed.\n\nResult:\nunknown" } }, parentCtx);
    eq(untrustedIngestedThisTurn(), true, "🔴 PART 4B FAIL-CLOSED CONTROL: a settlement with NO join row MARKS the turn. That is what the whole deployment did on eve 0.43.0+ for taint — and it is the reason the clean leg above is the assertion that proves the fix");
  });
}

await runChild("call_5", "sess-child-persistent", false);
eq(await store.subagentCallTaintStatus(ORG, PARENT, "call_5"), false, "precondition: the persistent child is clean, and its marker sits under its FIRST callId");

await onParentTurn(async () => {
  const first = await spawnTaint.noteTaskReceipt({ taskId: "task_5a", callId: "call_5", agentId: "ag_agent:5555", tool: "agent" }, PARENT);
  eq(first?.childToken, `subagent:${PARENT}:call_5`, "the first dispatch mints the token and pins it against the agent id");
  const second = await spawnTaint.noteTaskReceipt({ taskId: "task_5b", callId: "call_5_continued", agentId: "ag_agent:5555", tool: "agent" }, PARENT);
  eq(second, first, "🔴 T5: a continuation on the same agentId resolves the ORIGINAL join — the pinned row wins over the receipt's own newer callId, because the child never re-minted its token");
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_5b", status: "completed", agentId: "ag_agent:5555" }, PARENT);
  eq(adopted, false, "🔴 T5: so the CONTINUATION's terminal peek reads the clean child's real marker and does NOT mark — without the pinned token this reads `undefined` and fail-closes on a clean child");
  eq(untrustedIngestedThisTurn(), false, "…asserted on the turn signal too, `=== false`");
});

eq(
  await store.taskAgentLink(ORG, PARENT, "ag_agent:5555"),
  { callId: "call_5", childToken: `subagent:${PARENT}:call_5`, agentId: "ag_agent:5555", tool: "agent" },
  "🔴 T5: the agent-keyed row still holds the FIRST dispatch's callId after a continuation wrote through it",
);

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
  const receipt = { taskId: "task_replay", callId: "call_replay", agentId: "ag_agent:rrrr", tool: "agent" };
  const first = await spawnTaint.noteTaskReceipt(receipt, PARENT);
  eq(first, { callId: "call_replay", childToken: `subagent:${PARENT}:call_replay`, agentId: "ag_agent:rrrr", tool: "agent" }, "the first pass mints the join exactly as T1 does");

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

  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_crash", callId: "call_crash", agentId: "ag_agent:crash", tool: "agent" }, PARENT);
  eq(link?.callId, halfWritten.callId, "the redelivery resolves to the SAME link the crashed pass had already pinned");
  eq(link?.childToken, halfWritten.childToken, "…the same continuation token, which is the id the child's marker is readable under");
  eq(link?.agentId, "ag_agent:crash", "🔴 OPE-904: a join row written without the census field GAINS it from the receipt — a task in flight across the deploy stays countable");

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
  const link = await spawnTaint.noteTaskReceipt({ taskId: "task_8", callId: "call_8", agentId: "ag_agent:8888", tool: "agent" }, PARENT);
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

const messageHandler = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;

ok(typeof messageHandler === "function", "🔴 OPE-904 REACHABILITY: the taint hook SUBSCRIBES to `message.received`. Without this subscription every assertion below tests a function nothing calls, and the settlement edge does not exist on a real host");

await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: receiptResult("call_note", "task_a1b2c3d4e5f60001", "ag_agent:note") } }, parentCtx);
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(childCtx("call_note", "sess-child-note") as never);
    markUntrustedIngestedThisTurn();
  });
  await new Promise((r) => setTimeout(r, 50));
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    ok(!untrustedIngestedThisTurn(), "OPE-904 N1 CONTROL: the settlement turn starts CLEAN, so the adoption below is caused by the notification and not inherited");
    await messageHandler({ data: { message: "Background task task_a1b2c3d4e5f60001 (agent) is completed.\n\nResult:\nI read a page." } }, parentCtx);
    ok(untrustedIngestedThisTurn(), "🔴 OPE-904 N1: the NOTIFICATION alone adopts the child's taint — no `task_peek`, no `task_cancel`, no tool result of any kind");
  });
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  const mine = settled.filter((r) => r.detail?.task === "task_a1b2c3d4e5f60001");
  eq(mine.length, 1, "OPE-904 N1: exactly one settled row for the notification-settled task");
  eq(mine[0]?.detail?.marker, "tainted", "OPE-904 N1: …and it records the child's marker as the reason, not a bare boolean");
  eq(mine[0]?.detail?.adopted, true, "OPE-904 N1: …and says the parent adopted it");
  eq(mine[0]?.detail?.agent, "ag_agent:note", "🔴 OPE-904 N3 THE CENSUS SURVIVES: the settled row still names the parked worker's agent handle, read back off the DISPATCH row this session wrote — eve's notification text does not carry one");
}

await contextStorage.run(new ContextContainer(), async () => {
  spawnTaint.openTaintTurn(parentCtx as never);
  await handler({ data: { result: receiptResult("call_wip", "task_a1b2c3d4e5f60002", "ag_agent:wip") } }, parentCtx);
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(childCtx("call_wip", "sess-child-wip") as never);
    markUntrustedIngestedThisTurn();
  });
  await new Promise((r) => setTimeout(r, 50));
  await contextStorage.run(new ContextContainer(), async () => {
    spawnTaint.openTaintTurn(parentCtx as never);
    await messageHandler({ data: { message: "Background task task_a1b2c3d4e5f60002 (agent) is working. Use task_peek to read its output." } }, parentCtx);
    eq(
      untrustedIngestedThisTurn(),
      false,
      "🔴 OPE-904 N2 NEGATIVE CONTROL: a `working` notification adopts NOTHING — asserted `=== false`. Such a child can still read untrusted content, so its marker is not final and settling on it would be a lie in both directions",
    );
    await messageHandler({ data: { message: "Background task task_a1b2c3d4e5f60002 (agent) update: read 3 of 9 files" } }, parentCtx);
    eq(untrustedIngestedThisTurn(), false, "🔴 OPE-904 N2: eve's PROGRESS notification adopts nothing either — asserted `=== false`");
  });
});
await new Promise((r) => setTimeout(r, 50));
{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  eq(settled.filter((r) => r.detail?.task === "task_a1b2c3d4e5f60002").length, 0, "🔴 OPE-904 N2: …and writes NO settled row, so the census still counts parked workers rather than notifications");
}

await runChild("call_kinds", "sess-child-kinds", true, ["web", "github"]);
{
  const record = await store.subagentCallTaintRecord(ORG, PARENT, "call_kinds");
  eq(record?.tainted, true, "precondition: the two-source child's marker is TAINTED");
  eq(
    [...(record?.kinds ?? [])].sort(),
    ["github", "web"],
    "🔴 OPE-1251 CHILD SIDE: BOTH classes are stored beside the marker. The flip observer fires on the first mark only, so a row holding just `web` here would be the two-source defect OPE-1215 measured on the forward leg, one leg along",
  );
}

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_kinds", callId: "call_kinds", agentId: "ag_agent:kkkk", tool: "agent" }, PARENT);
  const adopted = await spawnTaint.adoptTaskTaint({ taskId: "task_kinds", status: "completed", agentId: "ag_agent:kkkk" }, PARENT);
  eq(adopted, true, "OPE-1251: the settlement still marks the parent — the kinds ride the existing adoption, they do not replace it");
  eq(
    [...taintKindsThisTurn()].sort(),
    ["github", "web"],
    "🔴 OPE-1251 PARENT SIDE: the parent's OWN turn now names what the child read, so its next memory bullet and its next approval card name `web` and `github` rather than 'external content'",
  );
});

await runChild("call_bare", "sess-child-bare", true);
await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_bare", callId: "call_bare", agentId: "ag_agent:bbbb", tool: "agent" }, PARENT);
  eq(await spawnTaint.adoptTaskTaint({ taskId: "task_bare", status: "completed", agentId: "ag_agent:bbbb" }, PARENT), true, "OPE-1251 NEGATIVE CONTROL: a child that knew it was tainted but not by what still marks the parent");
  eq(untrustedIngestedThisTurn(), true, "…the bit is set");
  eq([...taintKindsThisTurn()], [], "🔴 …and the parent names NO class — asserted empty, so the leg cannot be passing by inventing one");
});

await onParentTurn(async () => {
  await spawnTaint.noteTaskReceipt({ taskId: "task_kinds_lost", callId: "call_kinds_never", agentId: "ag_agent:llll", tool: "agent" }, PARENT);
  eq(await store.subagentCallTaintRecord(ORG, PARENT, "call_kinds_never"), undefined, "precondition: no marker was ever written for this call");
  eq(await spawnTaint.adoptTaskTaint({ taskId: "task_kinds_lost", status: "completed", agentId: "ag_agent:llll" }, PARENT), true, "OPE-1251: a lost marker still fails CLOSED");
  eq([...taintKindsThisTurn()], [], "🔴 …and names no class, because none could be established — the fail-closed direction is about the BIT, never about inventing a source");
});

{
  const settled = await readAudit({ org: ORG, action: spawnTaint.TASK_SETTLED_ACTION });
  const row = settled.find((r) => r.detail?.task === "task_kinds");
  eq(
    [...((row?.detail?.kinds as string[] | undefined) ?? [])].sort(),
    ["github", "web"],
    "🔴 OPE-1251: the `delegation.task_settled` row names the adopted classes, so an auditor can join a parent's later act to the sources its child read",
  );
  const bare = settled.find((r) => r.detail?.task === "task_bare");
  eq((bare?.detail?.kinds as string[] | undefined) ?? [], [], "…and a class-less adoption writes an EMPTY list, never a guess");
}

console.log(`background-task-taint-test: ${n} assertions passed`);
