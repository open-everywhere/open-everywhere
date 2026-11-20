import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { asSchema } from "ai";
import { installedEveRoot, readEveSchemaHelpers } from "./eve-tool-schema.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-worker-continuation-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const { TASK_CONTINUATION_REFUSAL_MESSAGE, decideTaskContinuation, guardTaskContinuations, noteWakeAttachments } = await import("../agent/access/worker-continuation.js");
const { noteContinuationTurn } = await import("../agent/access/continuation-turn-state.js");
const { claimTasksForAddressedWake } = await import("../agent/access/dispatch-origin-signal.js");
const { continuationAdmitted, noteTaskClaimDispatched, noteTaskProvenanceSettled, recordTaskOpening, taskProvenanceKey, TASK_CONTINUATION_BUSY_MESSAGE, TASK_CONTINUATION_UNAVAILABLE_MESSAGE } = await import("../agent/channels/task-provenance.js");
const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = require.resolve("eve/package.json").replace(/package\.json$/, "");
const eveRootUrl = pathToFileURL(eveRoot).href;
const agentContract = { SUBAGENT_TOOL_INPUT_SCHEMA: (await import("eve/tools/agent")).default.inputSchema as unknown };
const taskIdInput = (await import(`${eveRootUrl}dist/src/execution/tasks/task-id-input.js`)) as { withTaskIdSchema(schema: unknown): unknown; TASK_ID_INPUT: string };
const askQuestion = (await import(`${eveRootUrl}dist/src/tools/provided/ask-question.js`)) as { ASK_QUESTION_INPUT_SCHEMA: unknown };
const taskCancel = (await import(`${eveRootUrl}dist/src/tools/provided/task-cancel.js`)) as { taskCancelTool: { name: string; inputSchema: unknown } };
const taskTools = (await import(`${eveRootUrl}dist/src/protocol/task-tools.js`)) as { TASK_CANCEL_TOOL_NAME: string };
const toolSchema = await readEveSchemaHelpers(installedEveRoot(import.meta.url));

const rehydrated = (schema: unknown) => toolSchema.toInputSchema(toolSchema.serializeInputSchema(schema));
const agentSchema = () => rehydrated(taskIdInput.withTaskIdSchema(agentContract.SUBAGENT_TOOL_INPUT_SCHEMA));
const plainSchema = () => rehydrated(askQuestion.ASK_QUESTION_INPUT_SCHEMA);
const cancelSchema = () => rehydrated(taskCancel.taskCancelTool.inputSchema);
const advertised = (schema: unknown): Record<string, unknown> =>
  (asSchema(schema as never).jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};

eq(taskIdInput.TASK_ID_INPUT, "taskId", "§0 eve's continuation field is still spelled `taskId` — the field the guard keys on");
ok("taskId" in advertised(agentSchema()), "§0 eve's agent schema really does advertise `taskId` — the premise this guard exists for");
ok(!("agentId" in advertised(agentSchema())), "§0 …and no `agentId`: the OPE-593 refusal's field is gone at eve 0.70, which is why the refusal had gone inert");
ok(!("taskId" in advertised(plainSchema())), "§0 an eve tool schema that is not a task tool has no `taskId`, so the no-op arm below checks a real difference");
eq(taskCancel.taskCancelTool.name, taskTools.TASK_CANCEL_TOOL_NAME, "§0 eve's cancel tool is the one its protocol names");
eq(taskTools.TASK_CANCEL_TOOL_NAME, "eve__task_cancel", "§0 …and it is still spelled `eve__task_cancel` — the name the stop-only pass keys on");
ok("taskId" in advertised(cancelSchema()), "🔴 §0 eve's `eve__task_cancel` schema DOES carry `taskId`, so an affordance-keyed guard alone would wrap it (OPE-2290)");

const eveDist = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveDist, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { setNativeDelegationSeat } = await import("../agent/access/native-delegation-state.js");
// Every session below models one whose per-wake `agent` verdict admits native delegation (a work
// session). §13 pins the verdict's own gate.
const inSession = <T>(fn: () => T): T =>
  contextStorage.run(new ContextContainer(), () => {
    setNativeDelegationSeat("allow");
    return fn();
  });

const original = agentSchema();
const plainOriginal = plainSchema();
const reviewerOriginal = agentSchema();
const cancelOriginal = cancelSchema();
const toolset: Record<string, { inputSchema: unknown }> = {
  agent: { inputSchema: original },
  fresh_eyes_review: { inputSchema: reviewerOriginal },
  ask_question: { inputSchema: plainOriginal },
  eve__task_cancel: { inputSchema: cancelOriginal },
  cancel_work: { inputSchema: cancelSchema() },
};
const cancelWorkOriginal = toolset.cancel_work.inputSchema;
eq(guardTaskContinuations(toolset), ["agent", "fresh_eyes_review"], "🔴 §1 every tool eve gave a `taskId` is guarded — a NAMED subagent too, not only the built-in `agent` — except the stop-only `eve__task_cancel` (OPE-2290) and `cancel_work` (OPE-2338, D15)");
ok(toolset.cancel_work.inputSchema === cancelWorkOriginal, "🔴 §1 OPE-2338 D15: the forwarding seat's stop `cancel_work` is not wrapped either — it continues nothing, and its own D10 check decides who may stop the job");
ok(toolset.eve__task_cancel.inputSchema === cancelOriginal, "🔴 §1 OPE-2290: `eve__task_cancel` keeps eve's own schema object, identity included — a stop continues nothing, so the fence does not wrap it");
ok(toolset.agent.inputSchema !== original, "§1 the `agent` schema object is replaced in place");
ok(toolset.ask_question.inputSchema === plainOriginal, "🔴 §1 NEGATIVE CONTROL: a tool with no `taskId` keeps its schema object, identity included");
eq(advertised(toolset.agent.inputSchema), advertised(original), "🔴 §1 the ADVERTISED bytes are eve's own — `taskId` stays taught, nothing is hidden");
const again: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: original } };
guardTaskContinuations(again);
ok(again.agent.inputSchema === toolset.agent.inputSchema, "§1 one replacement per original schema object, so the per-call pass keeps the advertised bytes stable for the prompt cache");
eq(guardTaskContinuations({}), [], "§1 an empty toolset ⇒ no-op");
eq(guardTaskContinuations({ agent: null } as unknown as Record<string, unknown>), [], "§1 a null entry ⇒ no-op, never a throw");
eq(guardTaskContinuations({ agent: {} }), [], "§1 a tool with no input schema ⇒ no-op");

const validate = asSchema(toolset.agent.inputSchema as never).validate!;

const ORG = "default";
const store = getOperationalStore();
const iso = () => new Date().toISOString();
const SEAT = "sess-seat-2251";
const WINDOW = "oe-dom:e2e:oe-sup:g2251";

const ORIGIN_A = { platform: "slack", channelId: "C_ROOM_A", threadTs: "100.1" } as const;
const ORIGIN_A2 = { platform: "slack", channelId: "C_ROOM_A", threadTs: "200.2" } as const;
const ORIGIN_B = { platform: "slack", channelId: "C_ROOM_B", threadTs: "300.3" } as const;
const binding = (channel: string, threadTs: string, principalId: string) =>
  ({
    org: ORG,
    platform: "slack",
    workspace: "TW",
    surface: channel,
    mode: "channel",
    visibility: "private",
    trust: "internal",
    principalId,
    target: { channelId: channel },
    threadTs,
  }) as const;
async function seedWake(wakeId: string, origin: typeof ORIGIN_A | typeof ORIGIN_A2 | typeof ORIGIN_B, principalId: string): Promise<void> {
  const b = binding(origin.channelId, origin.threadTs, principalId);
  await registerUnifiedWakeTarget(store, ORG, wakeId, origin, iso(), WINDOW, true, "direct-mention", `slack/TW/${origin.channelId}`, b, {
    binding: b,
    requester: { kind: "requester", principalId },
    nonMemberWake: false,
  });
}
await seedWake("wake-open-a", ORIGIN_A, "U_ALICE");
await seedWake("wake-cont-a2", ORIGIN_A2, "U_BOB");
await seedWake("wake-cont-b", ORIGIN_B, "U_BOB");
await seedWake("wake-cont-a3", { platform: "slack", channelId: "C_ROOM_A", threadTs: "400.4" } as unknown as typeof ORIGIN_A2, "U_CAROL");

ok(continuationAdmitted(ORIGIN_A, ORIGIN_A), "§2 the same thread is the same room");
ok(continuationAdmitted(ORIGIN_A, ORIGIN_A2), "🔴 §2 two threads of ONE channel are one room — the audience is the channel, so a follow-up in a sibling thread is not a leak");
ok(!continuationAdmitted(ORIGIN_A, ORIGIN_B), "🔴 §2 a different channel is a different room");
ok(!continuationAdmitted(ORIGIN_A, { platform: "discord", channelId: "C_ROOM_A", guildId: "G1" } as never), "§2 the same id on another platform is a different room");

const TASK = "agent-k7m2q9";
ok(await recordTaskOpening({ org: ORG, parentSessionId: SEAT, taskId: TASK, callId: "call-open", tool: "agent", wakeId: "wake-open-a" }), "§2 the dispatch edge records where the task was opened");
await recordTaskOpening({ org: ORG, parentSessionId: SEAT, taskId: TASK, callId: "call-later", tool: "agent", wakeId: "wake-cont-b" });
const opening = JSON.parse((await store.getTaskResult(ORG, taskProvenanceKey(SEAT, TASK))) ?? "null") as { openingCallId?: string; origin?: { channelId?: string } } | null;
eq(opening?.openingCallId, "call-open", "🔴 §2 a continuation's own `task.started` never MOVES the record — it is put-if-absent");
eq(opening?.origin?.channelId, "C_ROOM_A", "…and the origin stays the opening room");
eq(await recordTaskOpening({ org: ORG, parentSessionId: SEAT, taskId: "agent-none", callId: "c", tool: "agent", wakeId: undefined }), false, "§2 no dispatch wake ⇒ nothing is recorded, so every continuation of that task is refused");

const turnFor = (turnId: string, unified = true) => ({ sessionId: SEAT, turnId, unified });
eq(await decideTaskContinuation(null, TASK), { admit: false, reason: "no-turn" }, "§2 no recorded turn ⇒ refused");
eq(await decideTaskContinuation(turnFor("turn-x", false), TASK), { admit: false, reason: "not-unified" }, "🔴 §2 a non-unified seat ⇒ refused: no wake can name the continuing room or re-point the child");
eq(
  await inSession(async () => await decideTaskContinuation(turnFor("turn-no-wake"), TASK)),
  { admit: false, reason: "no-continuing-wake" },
  "§2 a unified turn that addressed no wake ⇒ refused, as the dispatch edge refuses it",
);
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-unknown-task", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-unknown-task"), "agent-never-opened");
  }),
  { admit: false, reason: "no-provenance" },
  "§2 a task with no opening row ⇒ refused (a task opened before this guard, or a lost row)",
);
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-bad-wake", "wake-that-does-not-exist");
    return await decideTaskContinuation(turnFor("turn-bad-wake"), TASK);
  }),
  { admit: false, reason: "continuing-origin-unresolvable" },
  "§2 a continuing wake that does not resolve ⇒ refused",
);
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-cross", "wake-cont-b");
    return await decideTaskContinuation(turnFor("turn-cross"), TASK);
  }),
  { admit: false, reason: "cross-room" },
  "🔴 §2 THE SEAM: a task opened in room A, continued from room B ⇒ refused",
);

eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-while-working", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-while-working"), TASK);
  }),
  { admit: false, reason: "task-working" },
  "🔴 §2 a same-room continuation while the task still WORKS ⇒ refused: two calls in flight would share the worker's one authority row",
);
await noteTaskProvenanceSettled(ORG, SEAT, TASK);

const delegatedRow = async (callId: string) => JSON.parse((await store.getTaskResult(ORG, `oe-delegated-task-wake:${SEAT}:${callId}`)) ?? "null") as { wakeId?: string; requester?: { principalId?: string } } | null;
eq(await delegatedRow("call-open"), null, "precondition: no authority row for the opening call yet in this fixture");
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-same-room", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-same-room"), TASK);
  }),
  { admit: true, openingCallId: "call-open" },
  "🔴 §2 NEGATIVE CONTROL: a continuation from the SAME room (another thread of the channel) is admitted",
);
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-same-room", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-same-room"), TASK);
  }),
  { admit: true, openingCallId: "call-open" },
  "🔴 §2 the claim is RE-ENTRANT for its own turn: a redelivered model step re-runs `validate`, and the replay is admitted",
);
await noteTaskClaimDispatched(ORG, SEAT, TASK, "call-alice", "turn-same-room");
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-bob-races", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-bob-races"), TASK);
  }),
  { admit: false, reason: "task-working" },
  "🔴 §2 …but a DIFFERENT turn's continuation before the first one settles is refused — Bob cannot overwrite the row Alice's message is about to read",
);
const repointed = await delegatedRow("call-open");
eq(repointed?.wakeId, "wake-cont-a2", "🔴 §2 the admit re-points the OPENING call's authority row at the continuing wake, before the call runs");
eq(repointed?.requester?.principalId, "U_BOB", "🔴 §2 …so the child's next turn restores the CONTINUING requester (Bob), not the opener (Alice)");

const unifiedCtx = (turnId: string) => ({ channel: { kind: "unified" }, session: { id: SEAT, turn: { id: turnId } } });
const viaValidate = async (turnId: string, wakeId: string | undefined, input: Record<string, unknown>) =>
  await inSession(async () => {
    noteContinuationTurn(unifiedCtx(turnId) as never);
    if (wakeId !== undefined) claimTasksForAddressedWake(turnId, wakeId);
    return await validate(input);
  });
await noteTaskProvenanceSettled(ORG, SEAT, TASK);
eq(
  await inSession(async () => {
    claimTasksForAddressedWake("turn-tool", "wake-cont-a2");
    return await decideTaskContinuation(turnFor("turn-tool"), TASK, "fresh_eyes_review");
  }),
  { admit: false, reason: "tool-mismatch" },
  "🔴 §2 a `taskId` passed to a DIFFERENT task tool is refused before any claim — eve reaches a task only through the tool that started it",
);
const rowBefore = (await delegatedRow("call-open"))?.wakeId;
const malformed = await viaValidate("turn-v-malformed", "wake-cont-a3", { taskId: TASK });
eq(malformed.success, false, "§2 precondition: eve's own validation refuses a `taskId` call with no `message`");
ok((malformed as { error?: Error }).error?.message !== TASK_CONTINUATION_BUSY_MESSAGE, "…with eve's own error, not OE's");
eq((await delegatedRow("call-open"))?.wakeId, rowBefore, "🔴 §2 …and the refused call did NOT re-point the worker's authority row: the write half runs only after eve accepted the call");
const afterMalformed = await viaValidate("turn-v-after-malformed", "wake-cont-a2", { message: "now properly", taskId: TASK });
eq(afterMalformed.success, true, "🔴 §2 a call eve refused took NO claim, so the next turn's well-formed continuation is admitted — no 6-hour lock");
const afterStale = await viaValidate("turn-v-after-stale", "wake-cont-a2", { message: "again", taskId: TASK });
eq(afterStale.success, true, "🔴 §2 a claim an ended turn took but eve never dispatched is STALE, and the next turn is admitted");
await noteTaskClaimDispatched(ORG, SEAT, TASK, "call-busy-holder", "turn-v-after-stale");
const busyRefused = await viaValidate("turn-v-busy", "wake-cont-a2", { message: "second", taskId: TASK });
eq((busyRefused as { error?: Error }).error?.message, TASK_CONTINUATION_BUSY_MESSAGE, "🔴 §2 through `validate`: a second turn's continuation while the task works is told to WAIT for the result, not to start over");
await noteTaskProvenanceSettled(ORG, SEAT, TASK);
const refused = await viaValidate("turn-v-cross", "wake-cont-b", { message: "carry on", taskId: TASK });
eq(refused.success, false, "🔴 §2 through `validate`: a cross-room `taskId` call FAILS");
eq((refused as { error?: Error }).error?.message, TASK_CONTINUATION_REFUSAL_MESSAGE, "…with OE's own message, so the seat is told what to do");
ok(/new task/.test(TASK_CONTINUATION_REFUSAL_MESSAGE) && /without `taskId`/.test(TASK_CONTINUATION_REFUSAL_MESSAGE), "§2 the message names the route that works, so the refusal cannot become a retry loop");
ok(!TASK_CONTINUATION_REFUSAL_MESSAGE.includes("C_ROOM"), "§2 …and discloses neither room");
const admitted = await viaValidate("turn-v-same", "wake-cont-a2", { message: "carry on", taskId: TASK });
eq(admitted.success, true, "🔴 §2 NEGATIVE CONTROL through `validate`: a same-room `taskId` call passes");
eq((admitted as { value?: unknown }).value, { message: "carry on", taskId: TASK }, "…and reaches eve's own validation with its `taskId` intact");
const noTurn = await inSession(async () => await validate({ message: "carry on", taskId: TASK }));
eq(noTurn.success, false, "§2 through `validate`: no `turn.started` record ⇒ refused, never read as \"this room\"");
eq((noTurn as { error?: Error }).error?.message, TASK_CONTINUATION_UNAVAILABLE_MESSAGE, "🔴 §2 …and its message claims nothing about a room it could not read");
const fresh = await viaValidate("turn-v-fresh", undefined, { message: "a new job" });
eq(fresh.success, true, "🔴 §2 a FRESH call (no `taskId`) is never fenced — even on a turn that addressed no wake");
const blank = await viaValidate("turn-v-blank", undefined, { message: "a new job", taskId: "" });
ok((blank as { error?: Error }).error?.message !== TASK_CONTINUATION_REFUSAL_MESSAGE, "§2 a blank `taskId` is not a continuation, so the fence does not answer it (eve's own lookup does)");
const badShape = await viaValidate("turn-v-shape", "wake-cont-b", { taskId: TASK });
eq((badShape as { error?: Error }).error?.message, TASK_CONTINUATION_REFUSAL_MESSAGE, "§2 the fence runs BEFORE eve's own validation, so a refused call never reaches it");

{
  const { continuationGuardedTool, taskContinuationApproval } = await import("../agent/access/worker-continuation.js");
  const { readFileSync } = await import("node:fs");
  const agentApproval = (await import(`${eveRootUrl}dist/src/approval/agent.js`)) as { withAgentApprovalOnEntries(entries: Map<string, unknown>, approval: unknown): Map<string, { approval?: unknown }> };
  const approvalEval = (await import(`${eveRootUrl}dist/src/approval/evaluation.js`)) as { evaluateApproval(policy: unknown, ctx: Record<string, unknown>): Promise<{ denied: boolean; reason?: string; awaitsPerson?: boolean }> };
  const approvalDef = (await import(`${eveRootUrl}dist/src/approval/definition.js`)) as { resolveApprovalPolicy(a: unknown): unknown };
  const eveAgentTool = (await import("eve/tools/agent")).default as unknown;

  eq(continuationGuardedTool("agent", { message: "m", taskId: "t" }), "delegation", "§11 an `agent` call by `taskId` is guarded");
  eq(continuationGuardedTool("agent", { message: "m" }), undefined, "🔴 §11 NEGATIVE CONTROL: a fresh `agent` call is not judged here — on eve 1.x the `call.requested` hook joins it to its job");
  eq(continuationGuardedTool("agent", { message: "m", taskId: "" }), undefined, "§11 a blank `taskId` is not a continuation");
  eq(continuationGuardedTool("fresh_eyes_review", { message: "m", taskId: "t" }), "task", "§11 a named subagent's `taskId` call is guarded");
  eq(continuationGuardedTool("fresh_eyes_review", { message: "m" }), undefined, "§11 NEGATIVE CONTROL: a named subagent's fresh call is not");
  eq(continuationGuardedTool("eve__task_cancel", { taskId: "t" }), undefined, "§11 a stop is not a continuation (OPE-2290)");
  eq(continuationGuardedTool("cancel_work", { taskId: "t" }), undefined, "§11 `cancel_work` is not guarded (OPE-2338 D15)");
  eq(continuationGuardedTool("work", { message: "m", taskId: "t" }), undefined, "§11 `work` fences its own continuation");
  eq(continuationGuardedTool("tracker__get_task", { taskId: "t" }), undefined, "🔴 §11 a connector op whose own schema names `taskId` is not a continuation");

  // eve's own merge: the root agent's `approval` reaches `agent`, and never a `frameworkAction` task tool.
  const entries = new Map<string, unknown>([["agent", eveAgentTool], [taskTools.TASK_CANCEL_TOOL_NAME, taskCancel.taskCancelTool]]);
  const wired = agentApproval.withAgentApprovalOnEntries(entries, taskContinuationApproval);
  const unwired = agentApproval.withAgentApprovalOnEntries(entries, undefined);
  ok(typeof wired.get("agent")?.approval === "function", "🔴 §11 eve puts the root agent's policy on its own `agent` tool — the eve 1.x seam of this fence");
  eq(wired.get(taskTools.TASK_CANCEL_TOOL_NAME)?.approval, undefined, "🔴 §11 TRIPWIRE: eve keeps the root policy OFF `eve__task_cancel` (frameworkAction), so the cancel fence has no seam here (OPE-2778). If this goes red, eve now offers one.");
  eq(unwired.get("agent")?.approval, undefined, "§11 with no root policy, `agent` carries none: the wiring below is the only thing that fences it");

  const TASK11 = "agent-ope2767";
  await recordTaskOpening({ org: ORG, parentSessionId: SEAT, taskId: TASK11, callId: "call-open-11", tool: "agent", wakeId: "wake-open-a" });
  await noteTaskProvenanceSettled(ORG, SEAT, TASK11);
  const viaEve = async (turnId: string, wakeId: string | undefined, toolInput: Record<string, unknown>): Promise<{ denied: boolean; reason?: string; awaitsPerson?: boolean }> =>
    await inSession(async () => {
      noteContinuationTurn(unifiedCtx(turnId) as never);
      if (wakeId !== undefined) claimTasksForAddressedWake(turnId, wakeId);
      const approval = wired.get("agent")?.approval;
      return await approvalEval.evaluateApproval(approvalDef.resolveApprovalPolicy(approval), { callId: `c-${turnId}`, toolName: "agent", toolInput, abortSignal: new AbortController().signal });
    });
  const cross = await viaEve("turn-11-cross", "wake-cont-b", { message: "carry on", taskId: TASK11 });
  eq(cross, { denied: true, reason: TASK_CONTINUATION_REFUSAL_MESSAGE }, "🔴 §11 through eve's approval path: a cross-room continuation is DENIED with OE's refusal");
  const same = await viaEve("turn-11-same", "wake-cont-a2", { message: "carry on", taskId: TASK11 });
  eq(same.denied, false, "🔴 §11 NEGATIVE CONTROL: a same-room continuation passes eve's approval");
  ok(same.awaitsPerson !== true, "§11 …and the policy never asks a person");
  await noteTaskProvenanceSettled(ORG, SEAT, TASK11);
  const fresh11 = await viaEve("turn-11-fresh", undefined, { message: "a new job" });
  eq(fresh11.denied, false, "§11 a fresh `agent` call is never fenced");
  const noTurn11 = await inSession(async () => await taskContinuationApproval({ toolName: "agent", toolInput: { message: "carry on", taskId: TASK11 } }));
  eq(noTurn11, { type: "denied", reason: TASK_CONTINUATION_UNAVAILABLE_MESSAGE }, "§11 no recorded turn ⇒ denied, never read as \"this room\"");
  eq(await taskContinuationApproval({ toolName: "read_channel", toolInput: { channel: "x" } }), undefined, "§11 any other tool ⇒ no opinion (eve's own decision stands)");

  for (const rel of ["agent/agent.ts", "packages/create/template/agent/agent.ts"]) {
    const src = readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
    ok(/^\s*approval: taskContinuationApproval,$/m.test(src), `🔴 §11 ${rel} hands eve the continuation fence as the root agent's \`approval\``);
    ok(/import \{ taskContinuationApproval \} from "@open-everywhere\/core\/agent\/access\/worker-continuation\.js";/.test(src), `§11 ${rel} imports it from core`);
  }
}

{
  const { taskContinuationApproval } = await import("../agent/access/worker-continuation.js");
  const work = await import("../agent/channels/work.js");
  const turnState = await import("../agent/access/work-request-turn.js");
  const { recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
  const { registerContinuationRefusalNotifier, WORK_CONTINUATION_RETURNED_MESSAGE } = await import("../agent/access/work-refusal-notice.js");
  const { readContinuationWake } = await import("../agent/channels/task-provenance.js");
  const { readAudit } = await import("../agent/audit/audit.js");
  const readContinuationWakeOf = async (session: string, callId: string) => (await readContinuationWake(ORG, session, callId))?.wakeId;
  const { AuthKey } = (await import(pathToFileURL(join(eveDist, "dist/src/context/keys.js")).href)) as { AuthKey: unknown };

  const W12 = "sess-work-2767";
  const T_A = "agent-w2767a";
  const T_B = "agent-w2767b";
  const at = "2026-10-08T02:00:00.000Z";
  await seedWake("req-2767-a", ORIGIN_A, "U_ALICE");
  await seedWake("req-2767-a-follow", ORIGIN_A, "U_ALICE");
  await seedWake("req-2767-b-follow", ORIGIN_B, "U_BOB");
  await seedWake("req-2767-cross", ORIGIN_B, "U_BOB");
  await recordTaskOpening({ org: ORG, parentSessionId: W12, taskId: T_A, callId: "call-2767-a", tool: "agent", wakeId: "req-2767-a" });
  await recordTaskOpening({ org: ORG, parentSessionId: W12, taskId: T_B, callId: "call-2767-b", tool: "agent", wakeId: "req-2767-cross" });
  await noteTaskProvenanceSettled(ORG, W12, T_A);
  await noteTaskProvenanceSettled(ORG, W12, T_B);

  type Job = { readonly requestId: string; readonly brief: string; readonly origin: typeof ORIGIN_A | typeof ORIGIN_B; readonly taskId?: string };
  const FRESH_A: Job = { requestId: "req-2767-a", brief: "draft the summary for room A", origin: ORIGIN_A };
  const FOLLOW_A: Job = { requestId: "req-2767-a-follow", brief: "add the totals", origin: ORIGIN_A, taskId: T_A };
  const FOLLOW_B: Job = { requestId: "req-2767-b-follow", brief: "post it here", origin: ORIGIN_B, taskId: T_B };
  const CROSS: Job = { requestId: "req-2767-cross", brief: "carry on from room B", origin: ORIGIN_B, taskId: T_A };

  const returned: string[] = [];
  registerContinuationRefusalNotifier(async (n: { requestId: string }) => {
    returned.push(n.requestId);
    return true;
  });
  const step = <T>(turn: string, jobs: readonly Job[], stamp: string, fn: () => Promise<T>): Promise<T> => {
    const c = new ContextContainer() as { set(key: unknown, value: unknown): void };
    c.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
    return contextStorage.run(c, async () => {
      setNativeDelegationSeat("allow");
      noteContinuationTurn({ channel: { kind: "unified" }, session: { id: W12, turn: { id: turn } } } as never);
      for (const j of jobs) {
        const message = work.renderWorkRequest({ requestId: j.requestId, brief: j.brief, origin: j.origin as never, nowIso: at, ...(j.taskId !== undefined ? { taskId: j.taskId } : {}) });
        recordDeliveredWakes(turn, message);
        turnState.recordWorkRequestsThisTurn(turn, message);
      }
      return await fn();
    });
  };
  const rows = async (action: string, task: string) => {
    for (let i = 0; i < 50; i++) {
      const got = (await readAudit({ org: ORG, action, detailEquals: { task, session: W12 } })) as readonly { detail?: Record<string, unknown> }[];
      if (got.length > 0) return got;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };
  const policy = (message: string, taskId: string) => taskContinuationApproval({ toolName: "agent", toolInput: { message, taskId } });

  const admitted = await step("w12-same", [FRESH_A, FOLLOW_A], FOLLOW_A.requestId, async () => await policy(FOLLOW_A.brief, T_A));
  eq(admitted, undefined, "🔴 §12 a work session's continuation that its joined job NAMES, from the task's own room, is admitted");
  eq(await readContinuationWakeOf(W12, "call-2767-a"), FOLLOW_A.requestId, "🔴 §12 …under that job's wake: the worker's authority row is re-pointed at the follow-up");
  ok((await rows("delegation.continuation_admitted", T_A)).length >= 1, "🔴 §12 …and the work session writes its own `delegation.continuation_admitted` row");
  ok(!turnState.workCallClaimed("w12-same", FOLLOW_A.brief), "§12 the policy takes no claim: the `call.requested` hook owns the join on eve 1.x");
  await noteTaskProvenanceSettled(ORG, W12, T_A);

  const cross = await step("w12-cross", [FRESH_A, CROSS], CROSS.requestId, async () => await policy(CROSS.brief, T_A));
  eq(cross, { type: "denied", reason: WORK_CONTINUATION_RETURNED_MESSAGE }, "🔴 §12 a forwarded follow-up that names a task opened in ANOTHER room is denied, and the job goes back to the seat");
  eq(returned, [CROSS.requestId], "🔴 §12 …the refusal notice names exactly that job");
  const refusedRows = await rows("delegation.continuation_refused", T_A);
  ok(refusedRows.some((r) => r.detail?.reason === "cross-room"), "🔴 §12 …and the work session writes `delegation.continuation_refused` with reason `cross-room`");

  const started = await step("w12-started", [FRESH_A, FOLLOW_A], FOLLOW_A.requestId, async () => {
    turnState.noteWorkRequestStarted("w12-started", FOLLOW_A.requestId);
    return await policy(FOLLOW_A.brief, T_A);
  });
  eq(started, { type: "denied", reason: turnState.WORK_REQUEST_ALREADY_STARTED_MESSAGE }, "🔴 §12 OPE-2613: a continuation of a job that already started in this turn is denied");

  returned.length = 0;
  const mismatch = await step("w12-mismatch", [FRESH_A, FOLLOW_B], FRESH_A.requestId, async () => await policy(FRESH_A.brief, T_B));
  ok(mismatch !== undefined && mismatch.type === "denied", `🔴 §12 a call that joins job A (by its brief) but names job B's task is DENIED — it never takes B's room (got ${JSON.stringify(mismatch)})`);
  eq(mismatch?.reason, TASK_CONTINUATION_UNAVAILABLE_MESSAGE, "§12 …as `no-continuing-wake`: the turn holds two jobs and the joined job names no such task");
  eq(returned, [], "§12 …and no job is returned, because the joined job does not name the task");
  eq(await readContinuationWakeOf(W12, "call-2767-b"), undefined, "🔴 §12 …and B's worker row is NOT re-pointed");
  registerContinuationRefusalNotifier(undefined);
}

{
  const { approvalDecisionBody } = await import("../agent/approvals/decision-wake.js");
  const brake = approvalDecisionBody({ origin: ORIGIN_A, wakeId: "wake-decision", summaryLine: "spend 10", outcome: "rejected", pendingId: "pa-2290" });
  ok(brake.includes(`(\`${taskTools.TASK_CANCEL_TOOL_NAME}\`)`), "§2 precondition: the decision wake names eve's own cancel tool — the call the brake depends on");
  const cancelValidate = asSchema(toolset.eve__task_cancel.inputSchema as never).validate!;
  const cancelVia = async (turnId: string, wakeId: string | undefined, input: Record<string, unknown>) =>
    await inSession(async () => {
      noteContinuationTurn(unifiedCtx(turnId) as never);
      if (wakeId !== undefined) claimTasksForAddressedWake(turnId, wakeId);
      return await cancelValidate(input);
    });
  const claimKey = async () => `oe-task-claim:${SEAT}:${TASK}:${(JSON.parse((await store.getTaskResult(ORG, taskProvenanceKey(SEAT, TASK))) ?? "{}") as { generation?: number }).generation}`;
  const claimBefore = await store.getTaskResult(ORG, await claimKey());
  eq(JSON.parse(claimBefore ?? "null"), { turn: "turn-v-same" }, "§2 precondition: the claim the brake meets is a stale one a continuation could take over");
  const sameRoom = await cancelVia("turn-brake-same", "wake-cont-a2", { taskId: TASK });
  eq(sameRoom.success, true, "🔴 §2 OPE-2290: the brake's `eve__task_cancel` from the SAME room passes the fence — before the fix it was refused as `tool-mismatch`");
  eq((sameRoom as { value?: unknown }).value, { taskId: TASK }, "…and reaches eve with its `taskId` intact");
  eq(await store.getTaskResult(ORG, await claimKey()), claimBefore, "🔴 §2 OPE-2290: the cancel took NO claim — the stale claim is byte-identical after it");
  const crossRoom = await cancelVia("turn-brake-cross", "wake-cont-b", { taskId: TASK });
  eq(crossRoom.success, true, "🔴 §2 OPE-2290: a `eve__task_cancel` from ANOTHER room passes too — a stop carries no input in and no content out");
  await noteTaskClaimDispatched(ORG, SEAT, TASK, "call-brake-holder", "turn-brake-holder");
  const whileWorking = await cancelVia("turn-brake-working", "wake-cont-a2", { taskId: TASK });
  eq(whileWorking.success, true, "🔴 §2 OPE-2290: a `eve__task_cancel` while the task WORKS passes — that is the brake's whole case: a worker still running toward the act");
  eq(JSON.parse((await store.getTaskResult(ORG, await claimKey())) ?? "null"), { turn: "turn-brake-holder", call: "call-brake-holder" }, "§2 …and the working call still holds its claim");
  eq((await cancelVia("turn-brake-none", undefined, {})).success, false, "§2 NEGATIVE CONTROL: eve's own validation still refuses a cancel with no `taskId`");
  const continuationStillRefused = await viaValidate("turn-brake-cont", "wake-cont-b", { message: "carry on", taskId: TASK });
  eq((continuationStillRefused as { error?: Error }).error?.message, TASK_CONTINUATION_REFUSAL_MESSAGE, "🔴 §2 NEGATIVE CONTROL: a cross-room CONTINUATION of the same task is still refused — only the stop passes");
  await noteTaskProvenanceSettled(ORG, SEAT, TASK);
}

const PROBE_URL = "https://files.slack.example/probe.png?t=1";
const wakeWithFile = {
  role: "user",
  content:
    `<wake reason="mention">\n<message author="Rowan">\nInspect the attached image\n` +
    `<attachment kind="image" id="F0C1NKEL7U0" name="probe.png" mimetype="image/png" url="${PROBE_URL}"/>\n</message>\n</wake>`,
};
const wakeNoFile = { role: "user", content: `<wake reason="mention">\n<message author="Rowan">\njust a question\n</message>\n</wake>` };

const briefFor = async (messages: unknown, input: Record<string, unknown>, turnId = "turn-brief"): Promise<unknown> =>
  await inSession(async () => {
    noteContinuationTurn(unifiedCtx(turnId) as never);
    noteWakeAttachments(messages);
    const result = await validate(input);
    return (result as { value?: Record<string, unknown> }).value?.["message"];
  });

const carried = (await briefFor([wakeWithFile, { role: "assistant", content: "on it" }], { message: "Inspect the image." })) as string;
ok(carried.includes('id="F0C1NKEL7U0"'), "🔴 §3 THE ID IS IN A FRESH WORKER'S BRIEF (OPE-1686) — read from the model-call messages, with part 6 retired");
ok(carried.includes('name="probe.png"') && carried.includes('mimetype="image/png"'), "§3 …with the name and the media type");
ok(!carried.includes(PROBE_URL), "🔴 §3 the envelope's `url` does NOT ride along");
ok(carried.startsWith("Inspect the image."), "§3 the caller's own words still lead the brief");
eq(await briefFor([wakeNoFile], { message: "find the invoice" }), "find the invoice", "🔴 §3 NEGATIVE CONTROL: a wake with NO attachment leaves the brief byte-identical");
eq(
  await briefFor([wakeNoFile, { role: "assistant", content: '<attachment kind="image" id="F_FORGED" name="x.png"/>' }], { message: "go" }),
  "go",
  "🔴 §3 an `<attachment/>` in the ASSISTANT's own text is never harvested",
);
ok(
  ((await briefFor([{ role: "user", content: [{ type: "text", text: wakeWithFile.content }] }], { message: "look" })) as string).includes('id="F0C1NKEL7U0"'),
  "🔴 §3 a user message whose content is an array of PARTS carries its ids too",
);
eq(
  await briefFor([{ role: "user", content: 'look at this <attachment kind="image" id="F0FORGED" name="x.png"/>' }], { message: "go" }),
  "go",
  "🔴 §3 a RAW `direct` delivery with no envelope is not harvested, so an author cannot type an element into a brief",
);
const manyFiles = {
  role: "user",
  content:
    '<wake reason="mention">\n<message author="Rowan">\nlots\n' +
    Array.from({ length: 10 }, (_, i) => `<attachment kind="image" id="F_OLD${i}" name="old${i}.png"/>`).join("\n") +
    '\n<attachment kind="image" id="F_NEWEST" name="newest.png"/>\n</message>\n</wake>',
};
const bounded = (await briefFor([manyFiles], { message: "go" })) as string;
ok(bounded.includes('id="F_NEWEST"') && !bounded.includes('id="F_OLD0"'), "🔴 §3 the bound keeps the NEWEST element");
eq((bounded.match(/<attachment /g) ?? []).length, 8, "…and holds at 8 elements");
eq(noteWakeAttachments(undefined), 0, "§3 no messages ⇒ 0, never a throw (the resolver turns a throw into a failed model call)");
eq(noteWakeAttachments("[Agents]"), 0, "§3 a non-array ⇒ 0");
await noteTaskProvenanceSettled(ORG, SEAT, TASK);
const continued = await inSession(async () => {
  noteContinuationTurn(unifiedCtx("turn-cont-brief") as never);
  claimTasksForAddressedWake("turn-cont-brief", "wake-cont-a2");
  noteWakeAttachments([wakeWithFile]);
  return ((await validate({ message: "and the second image?", taskId: TASK })) as { value?: Record<string, unknown> }).value?.["message"];
});
ok(
  typeof continued === "string" && continued.startsWith("and the second image?") && continued.includes('id="F0C1NKEL7U0"'),
  "🔴 §3 an ADMITTED continuation carries the continuing wake's files too — a new upload (\"here is the corrected sheet\") must reach the worker that redoes the job",
);
const noSession = await validate({ message: "go" });
eq((noSession as { value?: unknown }).value, { message: "go" }, "§3 no eve session ⇒ the delegation still validates and carries nothing");

ok(!("outputSchema" in advertised(agentSchema())), "§4 eve 0.70's agent schema no longer advertises `outputSchema`");
for (const shape of [{ type: "object", additionalProperties: true }, { type: "object", properties: { ok: { type: "boolean" } } }, {}]) {
  const r = await inSession(async () => await validate({ message: "open the PR", outputSchema: shape }));
  eq(r.success, true, `🔴 §4 a delegation carrying \`outputSchema: ${JSON.stringify(shape)}\` still DISPATCHES — without the drop, eve's \`additionalProperties: false\` fails it`);
  eq((r as { value?: unknown }).value, { message: "open the PR" }, "🔴 §4 …and the field is GONE from the value eve validates");
}
const noMessage = await inSession(async () => await validate({ outputSchema: { type: "object" } }));
eq(noMessage.success, false, "🔴 §4 NEGATIVE CONTROL: eve's own `message` requirement still fails a call that carries ONLY the dropped field");

{
  const { ensureDelegatedTaskBinding, rememberDelegatedTaskWake, DelegatedTaskBindingUnavailableError } = await import("../agent/channels/task-wake.js");
  const { delegatedRequesterThisTurn, delegatedWakeThisTurn } = await import("../agent/identity/delegated-binding.js");
  const childCtx = (callId: string, turnId: string | undefined, sequence: number | undefined) => ({
    channel: { kind: "subagent", continuationToken: `subagent:${SEAT}:${callId}` },
    session: {
      id: `sess-child-${callId}`,
      parent: { sessionId: SEAT, callId, rootSessionId: SEAT, turn: { id: "turn_9", sequence: 9 } },
      ...(turnId !== undefined ? { turn: { id: turnId, sequence } } : {}),
    },
  });
  const requester = () => (delegatedRequesterThisTurn(undefined) as { principalId?: string } | undefined)?.principalId;

  await rememberDelegatedTaskWake(ORG, SEAT, "call-child", "wake-open-a");
  const container = new ContextContainer();
  const seen: (string | undefined)[] = [];
  await contextStorage.run(container, async () => {
    await ensureDelegatedTaskBinding(childCtx("call-child", undefined, undefined) as never);
    await ensureDelegatedTaskBinding(childCtx("call-child", "turn_0", 0) as never);
    seen.push(requester(), delegatedWakeThisTurn());
  });
  eq(seen, ["U_ALICE", "wake-open-a"], "§6 precondition: the child's first turn runs as the OPENER, from the opening call's row");

  await rememberDelegatedTaskWake(ORG, SEAT, "call-child", "wake-cont-a2");
  const later: (string | undefined)[] = [];
  await contextStorage.run(container, async () => {
    await ensureDelegatedTaskBinding(childCtx("call-child", "turn_1", 1) as never);
    later.push(requester(), delegatedWakeThisTurn());
  });
  eq(later, ["U_BOB", "wake-cont-a2"], "🔴 §6 a LATER turn — the continuation — re-resolves: the child runs as the CONTINUING requester and answers on the continuing wake");

  await rememberDelegatedTaskWake(ORG, SEAT, "call-child-2", "wake-open-a");
  const firstOnly: (string | undefined)[] = [];
  await contextStorage.run(new ContextContainer(), async () => {
    await ensureDelegatedTaskBinding(childCtx("call-child-2", undefined, undefined) as never);
    await rememberDelegatedTaskWake(ORG, SEAT, "call-child-2", "wake-cont-a2");
    await ensureDelegatedTaskBinding(childCtx("call-child-2", "turn_0", 0) as never);
    firstOnly.push(requester());
  });
  eq(firstOnly, ["U_ALICE"], "🔴 §6 NEGATIVE CONTROL: turn 0 keeps the snapshot it opened with — only a later turn re-resolves");

  let refusedLater: unknown;
  await contextStorage.run(new ContextContainer(), async () => {
    await rememberDelegatedTaskWake(ORG, SEAT, "call-child-3", "wake-open-a");
    await ensureDelegatedTaskBinding(childCtx("call-child-3", undefined, undefined) as never);
    await store.putTaskResult(ORG, `oe-delegated-task-wake:${SEAT}:call-child-3`, "{}", iso(), 60_000);
    try {
      await ensureDelegatedTaskBinding(childCtx("call-child-3", "turn_1", 1) as never);
    } catch (err) {
      refusedLater = err;
    }
  });
  ok(refusedLater instanceof DelegatedTaskBindingUnavailableError, "🔴 §6 a later turn with an unreadable row is REFUSED — running it as the opener would be the defect this re-read exists for");
}

{
  const work = await import("../agent/channels/work.js");
  const { recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
  const { recordWorkRequestsThisTurn } = await import("../agent/access/work-request-turn.js");
  const { readContinuationWake } = await import("../agent/channels/task-provenance.js");
  const { AuthKey } = (await import(pathToFileURL(join(eveDist, "dist/src/context/keys.js")).href)) as { AuthKey: unknown };

  const W = "sess-work-2384";
  const W_TASK = "agent-w2384a";
  const OTHER_TASK = "agent-w2384b";
  const at = "2026-10-08T01:25:00.000Z";
  await seedWake("req-2384-first", ORIGIN_A, "U_ALICE");
  await seedWake("req-2384-follow", ORIGIN_A, "U_ALICE");
  await seedWake("req-2384-plain", ORIGIN_A, "U_ALICE");
  await seedWake("req-2384-other", ORIGIN_B, "U_BOB");
  ok(await recordTaskOpening({ org: ORG, parentSessionId: W, taskId: W_TASK, callId: "call-w-open", tool: "agent", wakeId: "req-2384-first" }), "§7 precondition: W's child task is opened under the first job");
  ok(await recordTaskOpening({ org: ORG, parentSessionId: W, taskId: OTHER_TASK, callId: "call-w-other", tool: "agent", wakeId: "req-2384-first" }), "§7 precondition: a second task of W, in the same room");
  await noteTaskProvenanceSettled(ORG, W, W_TASK);
  await noteTaskProvenanceSettled(ORG, W, OTHER_TASK);

  type Delivery = { readonly requestId: string; readonly brief: string; readonly origin: typeof ORIGIN_A | typeof ORIGIN_B; readonly taskId?: string };
  const FIRST: Delivery = { requestId: "req-2384-first", brief: "post the update to the page", origin: ORIGIN_A };
  const FOLLOW: Delivery = { requestId: "req-2384-follow", brief: "approved: retry the exact call", origin: ORIGIN_A, taskId: W_TASK };
  const PLAIN: Delivery = { requestId: "req-2384-plain", brief: "a job that names no task", origin: ORIGIN_A };
  const OTHER_ROOM: Delivery = { requestId: "req-2384-other", brief: "a follow-up from another room", origin: ORIGIN_B, taskId: W_TASK };

  const wStep = <T>(turn: string, delivered: readonly Delivery[], stamp: string, fn: () => Promise<T>): Promise<T> => {
    const c = new ContextContainer() as { set(key: unknown, value: unknown): void };
    c.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
    return contextStorage.run(c, async () => {
      noteContinuationTurn({ channel: { kind: "unified" }, session: { id: W, turn: { id: turn } } } as never);
      for (const d of delivered) {
        const message = work.renderWorkRequest({ requestId: d.requestId, brief: d.brief, origin: d.origin as never, nowIso: at, ...(d.taskId !== undefined ? { taskId: d.taskId } : {}) });
        recordDeliveredWakes(turn, message);
        recordWorkRequestsThisTurn(turn, message);
      }
      return await fn();
    });
  };
  const wTurn = (turn: string) => ({ sessionId: W, turnId: turn, unified: true });
  const wValidate = async (input: Record<string, unknown>) => {
    const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: agentSchema() } };
    guardTaskContinuations(ts);
    const r = await asSchema(ts.agent.inputSchema as never).validate!(input);
    return r.success ? "ok" : String((r as { error?: Error }).error?.message);
  };

  eq(
    await wStep("w-turn-precond", [FIRST, FOLLOW], FOLLOW.requestId, async () => await decideTaskContinuation(wTurn("w-turn-precond"), W_TASK)),
    { admit: false, reason: "no-continuing-wake" },
    "§7 precondition: a W turn that holds two jobs' wakes has no turn-wide continuing wake — a continuation no job names is refused",
  );

  eq(
    await wStep("w-turn-wait", [FIRST, FOLLOW], FOLLOW.requestId, async () => await wValidate({ message: FOLLOW.brief, taskId: W_TASK })),
    "ok",
    "🔴 §7 OPE-2384: a follow-up the job NAMES (its `task` attribute) is admitted in a W turn that holds several wakes",
  );
  eq(
    await readContinuationWake(ORG, W, "call-w-open"),
    { wakeId: FOLLOW.requestId, generation: 1 },
    "🔴 §7 …under THAT job's wake: the admitted continuing wake is the follow-up's request, so the child adopts the follow-up's ask",
  );
  const wRow = JSON.parse((await store.getTaskResult(ORG, `oe-delegated-task-wake:${W}:call-w-open`)) ?? "null") as { wakeId?: string; requester?: { principalId?: string } } | null;
  eq(wRow?.wakeId, FOLLOW.requestId, "🔴 §7 …and the child's authority row is re-pointed at the follow-up's wake");
  eq(wRow?.requester?.principalId, "U_ALICE", "§7 …so the child runs as the follow-up's requester");

  eq(
    await wStep("w-turn-plain", [FIRST, PLAIN], PLAIN.requestId, async () => await wValidate({ message: PLAIN.brief, taskId: W_TASK })),
    TASK_CONTINUATION_UNAVAILABLE_MESSAGE,
    "🔴 §7 NEGATIVE CONTROL: a `taskId` the joined job does not name is refused — the model cannot pick a task the host did not forward",
  );
  eq(
    await wStep("w-turn-plain-2", [FIRST, PLAIN], PLAIN.requestId, async () => await decideTaskContinuation(wTurn("w-turn-plain-2"), W_TASK, "agent", ORG, async () => true, PLAIN.requestId)),
    { admit: false, reason: "no-continuing-wake" },
    "§7 …and the reason is `no-continuing-wake`, as before the fix",
  );
  eq(
    await wStep("w-turn-mismatch", [FIRST, FOLLOW], FOLLOW.requestId, async () => await decideTaskContinuation(wTurn("w-turn-mismatch"), OTHER_TASK, "agent", ORG, async () => true, FOLLOW.requestId)),
    { admit: false, reason: "no-continuing-wake" },
    "🔴 §7 NEGATIVE CONTROL: a job that names task X never admits a continuation of task Y",
  );
  eq(
    await wStep("w-turn-stale", [FIRST, PLAIN], PLAIN.requestId, async () => await decideTaskContinuation(wTurn("w-turn-stale"), W_TASK, "agent", ORG, async () => true, FOLLOW.requestId)),
    { admit: false, reason: "no-continuing-wake" },
    "🔴 §7 NEGATIVE CONTROL: a job id that this turn did not receive is not read as the continuing wake",
  );
  eq(
    await wStep("w-turn-cross", [FIRST, OTHER_ROOM], OTHER_ROOM.requestId, async () => await decideTaskContinuation(wTurn("w-turn-cross"), W_TASK, "agent", ORG, async () => true, OTHER_ROOM.requestId)),
    { admit: false, reason: "cross-room" },
    "🔴 §7 NEGATIVE CONTROL: a follow-up from another room that names the task is refused as `cross-room` — the named wake runs every fence check",
  );
  eq(
    await wStep("w-turn-cross-2", [FIRST, OTHER_ROOM], OTHER_ROOM.requestId, async () => await wValidate({ message: OTHER_ROOM.brief, taskId: W_TASK })),
    TASK_CONTINUATION_REFUSAL_MESSAGE,
    "§7 …and through the real validate, the model reads the cross-room refusal",
  );
  ok(
    (await wStep("w-turn-steered", [FIRST, FOLLOW], FIRST.requestId, async () => await wValidate({ message: FOLLOW.brief, taskId: W_TASK }))) !== "ok",
    "🔴 §7 NEGATIVE CONTROL: the same-step gate (OPE-2339) still refuses a follow-up started on a step that received another job",
  );

  const { registerContinuationRefusalNotifier, registeredContinuationRefusalNotifier, WORK_CONTINUATION_RETURNED_MESSAGE } = await import("../agent/access/work-refusal-notice.js");
  const liveNotifier = registeredContinuationRefusalNotifier();
  const notices: { requestId: string; taskId: string; reason: string }[] = [];
  registerContinuationRefusalNotifier(async (input) => {
    notices.push({ ...input });
    return true;
  });
  await noteTaskClaimDispatched(ORG, W, W_TASK, "call-w-follow", "w-turn-wait");
  await seedWake("req-2379-busy", ORIGIN_A, "U_ALICE");
  await seedWake("req-2379-silent", ORIGIN_A, "U_ALICE");
  await seedWake("req-2379-repeat", ORIGIN_A, "U_ALICE");
  const BUSY: Delivery = { requestId: "req-2379-busy", brief: "and also fix the title", origin: ORIGIN_A, taskId: W_TASK };
  eq(
    await wStep("w-turn-busy-pre", [BUSY], BUSY.requestId, async () => await decideTaskContinuation(wTurn("w-turn-busy-pre"), W_TASK, "agent", ORG, async () => true, BUSY.requestId)),
    { admit: false, reason: "task-working" },
    "§8 precondition: the task still works on the §7 follow-up, so W's fence refuses this one as `task-working`",
  );
  const busyOutcome = await wStep("w-turn-busy", [BUSY], BUSY.requestId, async () => {
    const refused = await wValidate({ message: BUSY.brief, taskId: W_TASK });
    const retry = await wValidate({ message: BUSY.brief });
    return { refused, retry };
  });
  eq(busyOutcome.refused, WORK_CONTINUATION_RETURNED_MESSAGE, "🔴 §8 OPE-2379: W reads that the job went back to the conversation, and that it must not retry");
  eq(notices, [{ requestId: BUSY.requestId, taskId: W_TASK, reason: "task-working" }], "🔴 §8 …and the refused job is returned to the seat ONCE, with its request, its task and the reason");
  ok(busyOutcome.retry !== "ok", "🔴 §8 the returned job is RETIRED for the turn: a retry as a new task is refused, so the room is never answered twice");
  eq(notices.length, 1, "§8 …and the refused retry returns nothing more");

  const REPEAT: Delivery = { requestId: "req-2379-repeat", brief: "rerun the check", origin: ORIGIN_A, taskId: W_TASK };
  const repeatOutcome = await wStep("w-turn-repeat", [REPEAT], REPEAT.requestId, async () => {
    const first = await wValidate({ message: REPEAT.brief });
    const second = await wValidate({ message: REPEAT.brief, taskId: W_TASK });
    return { first, second };
  });
  eq(repeatOutcome, { first: "ok", second: TASK_CONTINUATION_BUSY_MESSAGE }, "🔴 §8 NEGATIVE CONTROL: a refused call for a job an earlier call claimed keeps the plain refusal");
  eq(notices.length, 1, "🔴 §8 NEGATIVE CONTROL: …and returns nothing to the seat, because the earlier call's task may answer the room");

  await seedWake("req-2379-fresh", ORIGIN_A, "U_ALICE");
  const FRESH: Delivery = { requestId: "req-2379-fresh", brief: "a fresh job W mislabels", origin: ORIGIN_A };
  eq(
    await wStep("w-turn-fresh", [FRESH], FRESH.requestId, async () => await wValidate({ message: FRESH.brief, taskId: W_TASK })),
    TASK_CONTINUATION_BUSY_MESSAGE,
    "🔴 §8 NEGATIVE CONTROL: a `taskId` on a job that names no task keeps the plain refusal",
  );
  eq(notices.length, 1, "🔴 §8 NEGATIVE CONTROL: …and returns nothing to the seat, so W can still start the job as it was forwarded");

  registerContinuationRefusalNotifier(undefined);
  const SILENT: Delivery = { requestId: "req-2379-silent", brief: "one more change", origin: ORIGIN_A, taskId: W_TASK };
  eq(
    await wStep("w-turn-silent", [SILENT], SILENT.requestId, async () => await wValidate({ message: SILENT.brief, taskId: W_TASK })),
    TASK_CONTINUATION_BUSY_MESSAGE,
    "§8 NEGATIVE CONTROL: no registered notice ⇒ the plain `task-working` refusal, and no claim that the job went back",
  );
  eq(notices.length, 1, "§8 NEGATIVE CONTROL: …and the recorder hears nothing");
  registerContinuationRefusalNotifier(liveNotifier);

  const turnState = await import("../agent/access/work-request-turn.js");
  const { noteTurnStep } = await import("../agent/model/step-boundary.js");
  await seedWake("req-2613-job", ORIGIN_A, "U_ALICE");
  await seedWake("req-2613-next", ORIGIN_A, "U_ALICE");
  const JOB: Delivery = { requestId: "req-2613-job", brief: "create a one-shot routine for 9am", origin: ORIGIN_A };
  const NEXT: Delivery = { requestId: "req-2613-next", brief: "and a second one for 5pm", origin: ORIGIN_A };
  const T = "w-turn-2613";
  const oneStart = await wStep(T, [JOB], JOB.requestId, async () => {
    const first = await wValidate({ message: JOB.brief });
    const beforeStart = turnState.workTurnSettled(T);
    turnState.noteWorkRequestStarted(T, JOB.requestId);
    const again = await wValidate({ message: JOB.brief });
    const continued = await wValidate({ message: JOB.brief, taskId: W_TASK });
    const settled = turnState.workTurnSettled(T);
    const settledAgain = turnState.workTurnSettled(T);
    const tier = (await noteTurnStep({ channel: { kind: "unified" }, session: { id: W, turn: { id: T } } } as never)).tier;
    turnState.recordWorkRequestsThisTurn(T, work.renderWorkCancel({ cancelId: "cancel-2613", taskId: W_TASK, origin: ORIGIN_A as never, nowIso: at }));
    const withCancel = turnState.workTurnSettled(T);
    turnState.noteWorkCancelHandled(T, W_TASK);
    const afterCancel = turnState.workTurnSettled(T);
    const nextMessage = work.renderWorkRequest({ requestId: NEXT.requestId, brief: NEXT.brief, origin: NEXT.origin as never, nowIso: at });
    recordDeliveredWakes(T, nextMessage);
    turnState.recordWorkRequestsThisTurn(T, nextMessage);
    const withNext = turnState.workTurnSettled(T);
    return { first, beforeStart, again, continued, settled, settledAgain, tier, withCancel, afterCancel, withNext };
  });
  eq(oneStart.first, "ok", "§9 precondition: W's first `agent` call for the job is admitted");
  eq(oneStart.beforeStart, undefined, "§9: a job that has not started keeps W's model live");
  eq(oneStart.again, turnState.WORK_REQUEST_ALREADY_STARTED_MESSAGE, "🔴 §9 OPE-2613: a second `agent` call for a job that already started is refused");
  eq(oneStart.continued, turnState.WORK_REQUEST_ALREADY_STARTED_MESSAGE, "🔴 §9 …and so is a continuation of it by `taskId`");
  eq(oneStart.settled, { first: true, jobs: 1 }, "🔴 §9 OPE-2613: once every job of the turn has started, the turn is settled");
  eq(oneStart.settledAgain, { first: false, jobs: 1 }, "§9 …and the ending is reported once");
  eq(oneStart.tier, "settled", "🔴 §9 …and the step resolver's boundary serves the `settled` stub tier");
  eq(oneStart.withCancel, undefined, "🔴 §9 NEGATIVE CONTROL: a relayed cancel waiting for its `eve__task_cancel` keeps W's model live");
  eq(oneStart.afterCancel, { first: true, jobs: 1 }, "§9 …and once W made the `eve__task_cancel`, the turn is settled again, as a new ending");
  eq(oneStart.withNext, undefined, "🔴 §9 NEGATIVE CONTROL: a new job steered into the turn keeps W's model live");
  eq(await wStep("w-turn-2613-none", [], JOB.requestId, async () => turnState.workTurnSettled("w-turn-2613-none")), undefined, "§9 NEGATIVE CONTROL: a turn that holds no job is never settled (inert off a work session)");
}


{
  // §13 the per-wake `agent` verdict, enforced at call time. On eve 1.x eve mounts its built-in
  // `agent` on every root session, so the seat cut cannot withhold it; the root `approval` policy
  // refuses the call instead, before any task starts.
  const { taskContinuationApproval } = await import("../agent/access/worker-continuation.js");
  const { nativeAgentRefusal, NATIVE_AGENT_REFUSED_MESSAGE } = await import("../agent/access/native-delegation-gate.js");
  const agentApproval = (await import(`${eveRootUrl}dist/src/approval/agent.js`)) as { withAgentApprovalOnEntries(entries: Map<string, unknown>, approval: unknown): Map<string, { approval?: unknown }> };
  const approvalEval = (await import(`${eveRootUrl}dist/src/approval/evaluation.js`)) as { evaluateApproval(policy: unknown, ctx: Record<string, unknown>): Promise<{ denied: boolean; reason?: string; awaitsPerson?: boolean }> };
  const approvalDef = (await import(`${eveRootUrl}dist/src/approval/definition.js`)) as { resolveApprovalPolicy(a: unknown): unknown };
  const eveAgentTool = (await import("eve/tools/agent")).default as unknown;
  const wired = agentApproval.withAgentApprovalOnEntries(new Map<string, unknown>([["agent", eveAgentTool]]), taskContinuationApproval);
  type Verdict = "allow" | "leaf" | "no-seat" | "unclassified" | undefined;
  const fresh = async (verdict: Verdict, toolName = "agent") =>
    await contextStorage.run(new ContextContainer(), async () => {
      if (verdict !== undefined) setNativeDelegationSeat(verdict);
      return await approvalEval.evaluateApproval(approvalDef.resolveApprovalPolicy(wired.get("agent")?.approval), {
        callId: `c13-${String(verdict)}-${toolName}`,
        toolName,
        toolInput: { message: "a new job" },
        abortSignal: new AbortController().signal,
      });
    });
  eq(await fresh("no-seat"), { denied: true, reason: NATIVE_AGENT_REFUSED_MESSAGE }, "🔴 §13 a seat whose verdict is `no-seat` (a channel seat that forwards with `work`): a fresh `agent` call is DENIED through eve's approval path");
  eq(await fresh("leaf"), { denied: true, reason: NATIVE_AGENT_REFUSED_MESSAGE }, "🔴 §13 a subagent child (`leaf`): denied");
  eq(await fresh("unclassified"), { denied: true, reason: NATIVE_AGENT_REFUSED_MESSAGE }, "🔴 §13 an unclassified wake: denied (fail-closed, as the seat cut was)");
  eq(await fresh(undefined), { denied: true, reason: NATIVE_AGENT_REFUSED_MESSAGE }, "🔴 §13 no verdict recorded at all: denied (fail-closed)");
  const allowed = await fresh("allow");
  eq(allowed.denied, false, "🔴 §13 NEGATIVE CONTROL: a work session whose verdict is `allow` starts its `agent` call");
  ok(allowed.awaitsPerson !== true, "§13 …and the gate never asks a person");
  eq((await fresh("no-seat", "fresh_eyes_review")).denied, false, "🔴 §13 NEGATIVE CONTROL: a declared subagent is not judged by the `agent` verdict");
  eq(nativeAgentRefusal("agent", () => false), NATIVE_AGENT_REFUSED_MESSAGE, "§13 the pure gate refuses `agent` without the verdict");
  eq(nativeAgentRefusal("agent", () => true), undefined, "§13 …and admits it with the verdict");
  eq(nativeAgentRefusal("read_channel", () => false), undefined, "§13 NEGATIVE CONTROL: no other tool is judged");

  // §14 the seat-cut backstop. The model-call cut hides each tool eve mounts outside a seat-cut slot,
  // but eve runs a call against the session's whole catalog. So the same policy refuses a call to a
  // name the seat cut withholds, whenever eve passes that call to the policy.
  const { setLeanSeatWake, setWorkTierWake } = await import("../agent/access/lean-seat-state.js");
  const { seatCutCallRefusal } = await import("../agent/access/seat-cut.js");
  const subagent = { description: "fresh eyes", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" };
  const wiredSub = agentApproval.withAgentApprovalOnEntries(new Map<string, unknown>([["fresh_eyes_review", subagent]]), taskContinuationApproval);
  const call = async (lean: boolean) =>
    await contextStorage.run(new ContextContainer(), async () => {
      setNativeDelegationSeat("no-seat");
      if (lean) {
        setWorkTierWake("forwards");
        setLeanSeatWake(true, false);
      }
      return await approvalEval.evaluateApproval(approvalDef.resolveApprovalPolicy(wiredSub.get("fresh_eyes_review")?.approval), {
        callId: `c14-${String(lean)}`,
        toolName: "fresh_eyes_review",
        toolInput: { message: "review this" },
        abortSignal: new AbortController().signal,
      });
    });
  const refused = await call(true);
  ok(refused.denied && (refused.reason ?? "").includes("does not hold this tool") && (refused.reason ?? "").includes("NOT started"), "🔴 §14 a lean seat's call to a declared subagent it does not hold is DENIED through eve's approval path");
  eq((await call(false)).denied, false, "🔴 §14 NEGATIVE CONTROL: a wide seat that holds the subagent starts the call");
  eq(seatCutCallRefusal("eve__tool", { workTier: "none", jobWake: "restricted", lean: false, dmSeat: false, worker: true, invoker: "unattended-fire", halted: false, agentAllowed: false }), undefined, "§14 a catalog route is never refused by name: its reach is cut entry by entry");
  ok(
    seatCutCallRefusal("notion__update_page", { workTier: "none", jobWake: "restricted", lean: false, dmSeat: false, worker: true, invoker: "unattended-fire", halted: false, agentAllowed: false }) !== undefined &&
      seatCutCallRefusal("notion__search", { workTier: "none", jobWake: "restricted", lean: false, dmSeat: false, worker: true, invoker: "unattended-fire", halted: false, agentAllowed: false }) === undefined,
    "🔴 §14 a restricted job wake: the backstop refuses a write-op name and admits a read-op name",
  );
}

console.log(`worker-continuation: ${n} assertions passed`);

// proves: AP-MOD-core-access-worker-continuation
// proves: AP-MOD-core-access-native-delegation-gate
