process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_TASK_STATUSES, readAgentStarted } from "../agent/access/background-tasks.js";

let n = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  n++;
}

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const distSrc = join(eveRoot, "dist", "src");
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const read = (rel: string): string => readFileSync(join(distSrc, rel), "utf8");

console.log(`parked-child-lifecycle: pinning against installed eve ${eveVersion}`);

function fnBody(src: string, name: string, method = false): string | undefined {
  const head = new RegExp(method ? `\\}${name}\\([^)]*\\)\\{` : `function ${name}\\([^)]*\\)\\{`).exec(src);
  if (head === null) return undefined;
  let depth = 0;
  for (let i = head.index + head[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(head.index + head[0].length, i);
    }
  }
  return undefined;
}

{
  const message = read("protocol/message.js");
  const agentStarted = /function createAgentStartedEvent\((\w+)\)\{let \w+=\{([^}]*)\}/.exec(message);
  ok(agentStarted !== null, "PIN 1: eve still builds `agent.started` in `createAgentStartedEvent`");
  ok(
    agentStarted !== null && new RegExp(`(?:^|,)sessionId:${agentStarted[1]}\\.sessionId(?:,|$)`).test(agentStarted[2]!),
    "PIN 1 🔴: `agent.started` carries the opened worker session's own `sessionId` — the id the 0.69 ruling said OE never sees",
  );
  const hookMap = read("public/definitions/hook.d.ts");
  ok(
    hookMap.includes(`readonly "agent.started": ProtocolEvent<"agent.started">;`),
    "PIN 1: `agent.started` is in eve's AUTHORED hook map type",
  );
  const emitStep = read("execution/tools/workflow/emit-workflow-tool-run-report-step.js");
  ok(
    /async function emitAgentStartedStep\(\w+\)\{"use step";[^]*?createAgentStartedEvent\([^]*?publishSessionEvents\(/.test(emitStep),
    "PIN 1 🔴: `emitAgentStartedStep` builds `agent.started` and publishes it through `publishSessionEvents`",
  );
  const publishEvents = read("execution/publish-session-events.js");
  const scope = fnBody(publishEvents, "publishInSessionScope");
  ok(
    scope !== undefined && /handleEvent:(\w+)\.publish,[^]*?\?\?\1\.publish;/.test(scope),
    "PIN 1 🔴: …and `publishSessionEvents` hands each event to the publisher's `publish`, not its bare `emit`",
  );
  ok(
    /async publish\((\w+)\)\{await \w+\.runHooks\(await emit\(\1\)\)\}/.test(publishEvents),
    "PIN 1 🔴: …and that `publish` RUNS THE HOOKS — so an OE hook, not only a client stream, receives the worker's session id",
  );
  const taskStarted = /function createTaskStartedEvent\(\w+\)\{return\{data:\{([^}]*)\},type:`task\.started`\}/.exec(message);
  ok(taskStarted !== null, "PIN 1: eve still builds `task.started` in `createTaskStartedEvent`");
  ok(
    taskStarted !== null && !/sessionId|runId|hookToken/.test(taskStarted[1]!),
    "PIN 1 negative control: `task.started` names no session, run or hook id — the worker id rides on `agent.started` alone",
  );
  for (const rel of ["execution/tasks/render.js", "execution/tasks/calls.js", "protocol/task-tools.js"]) {
    ok(!/sessionId|runId|hookToken/.test(read(rel)), `PIN 1: \`${rel}\` names no session, run or hook id — a task-tool result shows the model the task id only`);
  }
}

{
  const table = read("execution/tasks/table.js");
  ok(table.includes("TASK_TABLE_STATE_KEY=`eve.taskTable`"), "PIN 2: the task table still lives in the session's durable state under `eve.taskTable`");
  const isTaskRun = fnBody(table, "isTaskRun");
  ok(isTaskRun !== undefined, "PIN 2: eve still validates a task's `run` record in `isTaskRun`");
  ok(
    /isNonEmptyString\(\w+\.runId\)&&isNonEmptyString\(\w+\.hookToken\)/.test(isTaskRun ?? ""),
    "PIN 2 🔴: a task's `run` record carries the run's `runId` AND its control `hookToken` — the per-worker road through the task record is BACK at 0.70",
  );
  ok(
    /function liveTaskRuns\((\w+)\)\{return \1\.tasks\.flatMap\((\w+)=>\2\.run===void 0\?\[\]:\[toRunAddress\(\2\.run\)\]\)\}/.test(table),
    "PIN 2: `liveTaskRuns` enumerates the run address of every task that still holds a run — idle resumable tasks included",
  );
  ok(!(isTaskRun ?? "sessionId").includes("sessionId"), "PIN 2 negative control: the `run` record names no `sessionId` — the worker session belongs to the run, not to the task record");
}

{
  const table = read("execution/tasks/table.js");
  const session = read("execution/tasks/session.js");
  ok(
    /status:isTaskWorking\(\w+\)\?`cancelled`:`already_finished`/.test(table),
    "PIN 3: `taskCancelResult` answers `already_finished` for a task that holds no working call",
  );
  ok(
    /\w+\.status===`cancelled`&&await \w+\.advance\(\w+=>cancelTasksStep\(/.test(session),
    "PIN 3 🔴: `answerTaskCancel` runs `cancelTasksStep` ONLY on a `cancelled` answer — a settled task's `task_cancel` sends nothing",
  );
  const resumable = fnBody(table, "cancelResumableTask");
  ok(resumable !== undefined, "PIN 3: eve still cancels a resumable task through `cancelResumableTask`");
  ok(
    /if\(\w+===void 0\|\|!isTaskWorking\(\w+\)\)return\{settled:\[\],table:\w+\}/.test(resumable ?? ""),
    "PIN 3 🔴: an IDLE resumable task — a parked worker — returns from `cancelResumableTask` unchanged",
  );
  ok(
    !/finishTaskRun|removeTask/.test(resumable ?? "finishTaskRun"),
    "PIN 3: …and the table-level cancel of a WORKING resumable task keeps the task's run — `cancelResumableTask` never calls `finishTaskRun` or `removeTask`",
  );
  const steps = read("execution/tasks/steps.js");
  ok(/case`cancel`:return\{kind:`cancel`,reason:`The task was cancelled\.`\}/.test(steps), "PIN 3: a task cancel sends the run a `cancel` control");
  const toControl = fnBody(steps, "toControlMessage");
  ok(toControl !== undefined && !/case`end`|kind:`end`/.test(toControl), "PIN 3 🔴: …and `toControlMessage` has no `end` arm — a task command never SENDS `end`");
  const serve = read("execution/tools/workflow/serve.js");
  const serveCancel = fnBody(serve, "cancel", true);
  const serveEnd = fnBody(serve, "end", true);
  ok(serveCancel !== undefined && !serveCancel.includes("this.run.abort("), "PIN 3 🔴: a serve run's `cancel` aborts the current call only — it does not abort the run, so the worker stays parked unless the 30-second escalation below fires");
  ok(serveEnd !== undefined && serveEnd.includes("this.run.abort("), "PIN 3 negative control: the serve run's `end` DOES abort the run — the arm a task cancel never sends");
  ok(
    /if\((\w+)===`cancel`\)\{if\(!(\w+)\.control\.unwinding\)\{\w+=void 0;continue\}\w+\.aborted\|\|\2\.control\.apply\(\{kind:`end`,reason:`The task was cancelled and its serve body didn't return to receive\(\) within 30 seconds\.`\}\)/.test(
      read("execution/tools/workflow/workflow.js"),
    ),
    "PIN 3 ⚠️: the run escalates an UNWINDING cancel to `end` itself when the serve body has not returned to `receive()` within the cleanup window — the one road by which a task cancel ends a worker",
  );
  ok(
    /\.control\.unwinding&&\((\w+)\?\?=sleep\(WORKFLOW_CANCELLATION_CLEANUP_MS\)\.then\(\(\)=>`cancel`\)\)[^]*?=await raceChannelReads\(\w+,\1\)/.test(
      read("execution/tools/workflow/workflow.js"),
    ),
    "PIN 3: …the escalation timer sleeps for `WORKFLOW_CANCELLATION_CLEANUP_MS`, and it is the timeout that `raceChannelReads` races — the timer that yields the `cancel` sentinel above",
  );
  ok(/WORKFLOW_CANCELLATION_CLEANUP_MS=3e4/.test(read("execution/tools/workflow/cancellation-policy.js")), "PIN 3: …and that cleanup window is 30 seconds");
}

{
  const reaper = read("execution/terminate-child-sessions-step.js");
  ok(
    /async function stopTaskRuns\((\w+)\)\{let (\w+)=liveTaskRuns\(readTaskTable\(\1\.state\)\);await Promise\.all\(\2\.map\(\w+=>cancelWorkflowToolRun\(\w+,\{kind:`end`,/.test(reaper),
    "PIN 4 🔴: eve's reaper sends an `end` control to EVERY live task run — `end`, not the `cancel` a `task_cancel` sends (pin 3)",
  );
  ok(
    /async function terminateChildSessionsStep\(\w+\)\{"use step";let (\w+);try\{\1=readDurableSession\([^)]*\)\}catch\([^)]*\)\{[^}]*\}[^}]*\}await stopTaskRuns\(\1\)\}/.test(reaper),
    "PIN 4: …and the reaper calls `stopTaskRuns` unconditionally once it can read the session",
  );
  const workflow = read("execution/tools/workflow/workflow.js");
  ok(
    /let (\w+)=startWorkflowBody\([^]*?finally\{await \1\.close\(\)\}/.test(workflow),
    "PIN 4 🔴: a task run closes its BODY in a `finally` — on every exit, the reaper's `end` included",
  );
  ok(
    /(\w+)=createAgentSessions\([^)]*\)[^]*?close:\1\.close/.test(read("execution/tools/workflow/serve.js")),
    "PIN 4 🔴: …and a serve body's `close` is the `close` of the agent sessions it opened",
  );
  const agentSession = read("execution/agent-sessions/session.js");
  ok(
    /close:async\(\)=>\{(\w+)\.length!==0&&await endAgentSessionsStep\(\{sessions:\1\}\)\}/.test(agentSession),
    "PIN 4: …and that close ends every agent session the run opened",
  );
  const agentSteps = read("execution/agent-sessions/steps.js");
  ok(
    /await dispatchWorkflowSessionCommand\(\{command:\{kind:`reset`,reason:RUN_FINISHED_REASON\},sessionId:\w+\.sessionId\}\)/.test(agentSteps),
    "PIN 4 🔴: ending a LOCAL worker session dispatches a `reset` to it BY ITS SESSION ID — the worker is retired, not just its task",
  );
}

{
  const timeout = read("execution/session/timeout.js");
  ok(
    /function sessionTimeoutDeadline\((\w+),\w+\)\{return \1===!1\?void 0:/.test(timeout),
    "PIN 5 🔴: `sessionTimeoutMs: false` still yields NO deadline",
  );
  ok(/(\w+)=\w+\.sessionTimeoutMs\?\?DEFAULT_SESSION_TIMEOUT_MS/.test(read("execution/session/entry.js")), "PIN 5: the session entry passes the configured `sessionTimeoutMs` through, and defaults only when it is ABSENT — `false` is not absent");
  ok(
    /\w+=\w+\.sessionTimeoutDeadline===void 0\?void 0:createSessionTimeoutControl\(/.test(read("execution/session/program.js")),
    "PIN 5: …and with no deadline the session loop arms NO timeout control — so no OE session reaches the `expired` arm on a clock",
  );
  const agentSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent", "agent.ts"), "utf8");
  ok(
    /sessionTimeoutMs\s*:\s*false/.test(agentSource),
    "PIN 5: the shipped agent definition still sets `limits.sessionTimeoutMs: false` — the OPE-281 ruling this one depends on",
  );
}

{
  const program = read("execution/session/program.js");
  const finalization = read("execution/session/finalization.js");
  ok(
    program.split("case`expired`:case`reset`:case`closed`:return{kind:`terminal`,outcome:{kind:`expired`}}").length - 1 === 2,
    "PIN 6 🔴: BOTH park points of the session loop (the prewarmed wait and the post-turn wait) fold `expired`, `reset` and `closed` into one `expired` outcome",
  );
  ok(/=await finalizeSession\(\w+\.outcome,/.test(program), "PIN 6: …and the loop's terminal outcome goes to `finalizeSession`");
  const finalize = fnBody(finalization, "finalizeSession");
  ok(finalize !== undefined, "PIN 6: eve still finalizes every session in `finalizeSession`");
  ok(
    /^let\{serializedContext:\w+,sessionState:(\w+)\}=\w+\.cursor;\1!==void 0&&(?:liveTaskRuns\(readTaskTable\(\1\.snapshot\?\.session\?\.state\)\)\.length>0&&)?await terminateChildSessionsStep\(/.test(finalize ?? ""),
    "PIN 6 🔴: the finalizer's FIRST act is the reap, for every outcome kind (gated only on a live task run)",
  );
  ok(
    /(\w+)\.kind===`expired`\?await emitTerminalSessionCompletionStep\([^)]*\):\1\.kind===`failed`&&await emitTerminalSessionFailureStep\(/.test(finalize ?? ""),
    "PIN 6 🔴: …then it emits `session.completed` for the `expired` outcome — which `reset` reaches — with no flag in between",
  );
  ok(!finalization.includes("notifyCaller") && !program.includes("notifyCaller"), "PIN 6: no `notifyCaller` flag exists on either module — no arm can ask for a quiet retirement");
  const publish = fnBody(read("execution/publish-session-events.js"), "publishTerminalSessionEvent");
  ok(publish !== undefined, "PIN 6: eve still publishes the terminal event through `publishTerminalSessionEvent`");
  ok(
    /let publish=async (\w+)=>\{await \w+\.emit\(\1\)\}/.test(publish ?? "") && !(publish ?? "runHooks").includes("runHooks"),
    "PIN 6 ⚠️: the terminal publisher writes through `emit` and never calls `runHooks` — no authored hook receives `session.completed`",
  );
}

{
  const program = read("execution/session/program.js");
  const finalization = read("execution/session/finalization.js");
  ok(
    /case`expired`:case`reset`:case`closed`:return\{kind:`terminal`,outcome:\{kind:`expired`\}\}/.test(program),
    "PIN 7 🔴: a `reset` leaves the session loop as the `expired` outcome — the same finalizer, the same reaper (pin 6)",
  );
  ok(
    /case`cancel-turn`:await \w+\.cancelTurnWork\(\),await settleCancelledTurn\(!1\),[^;]*;continue;/.test(program),
    "PIN 7 negative control: a `cancel-turn` at the park cancels the turn's work and CONTINUES — it is not a retirement, so the arm above reads `reset`'s own bytes",
  );
  ok(
    /async cancelTurnWork\(\)\{let\{cursor:\w+\}=this\.input;[^;{}]*await cancelDescendantTurnsStep\(\{[^}]*\}\),await cancelWorkingTasks\(\w+,`turn_cancelled`\)\}/.test(read("execution/session/turn.js")),
    "PIN 7 negative control: …and `cancelTurnWork` cancels the descendant turns (behind its one guard) and the working tasks, nothing more",
  );
  ok(
    /return \w+\.kind===`done`\?\{isError:/.test(finalization) && !/`done`[^;]*emitTerminalSessionCompletionStep/.test(finalization),
    "PIN 7: the `done` outcome reaps (pin 6) and emits no `session.completed` — the one quiet exit, and only the session's own turn can take it",
  );
  ok(
    /claimSessionHook\(sessionCommandHookToken\((\w+)\)\)/.test(read("execution/session/entry.js")),
    "PIN 7 🔴: every session claims `eve:session:<id>:inbox` at boot — so a worker hears the run-exit `reset` and finalizes ITSELF, emitting its own `session.completed`",
  );
}

{
  ok(
    /case`reset`:return (\w+)\.queue\.enqueueControl\(`reset`\),\{kind:`cancel`\}/.test(read("execution/session/admission.js")),
    "PIN 8 🔴: an admitted `reset` is QUEUED as a control for the next park AND answered as a `cancel` — the retirement is buffered, never dropped",
  );
  const activeTurn = read("execution/session/active-turn.js");
  const cancelsThisTurn = fnBody(activeTurn, "cancelsThisTurn", true);
  ok(cancelsThisTurn !== undefined, "PIN 8: the running turn still decides what cancels it in `cancelsThisTurn`");
  ok(
    /^return (\w+)\.kind===`reset`\?!0:/.test(cancelsThisTurn ?? ""),
    "PIN 8 🔴: the running turn treats EVERY `reset` as cancelling it, with no further test — retirement is destructive, never a soft handoff",
  );
  ok(
    /(\w+)\.kind===`cancel`\?\1\.turnId===void 0\|\|\1\.turnId===this\.expectedTurnId:!1$/.test(cancelsThisTurn ?? ""),
    "PIN 8 negative control: a plain `cancel` cancels the running turn only when its `turnId` is absent or matches — `reset` alone is unconditional");
  ok(/case`cancel`:return this\.cancelsThisTurn\((\w+)\)&&this\.abort\(\),!1/.test(activeTurn), "PIN 8: …and the admitted `cancel` answer aborts the running turn through that test");
  ok(
    /if\((\w+)\?\.kind===`control`\)return\{kind:\1\.control\}/.test(read("execution/session/next-input.js")),
    "PIN 8: a PARKED session surfaces the queued `reset` control from its wait — a retired generation does not need a live turn to hear it",
  );
}

{
  const runtime = read("execution/workflow-runtime.js");
  ok(
    /dispatchSession\((\w+)\)\{return await dispatchWorkflowSessionCommand\(\1\)\}/.test(runtime) &&
      /async function dispatchWorkflowSessionCommand\((\w+)\)\{return await dispatchWorkflowCommand\(\{sessionId:\1\.sessionId\},\1\.command\)\}/.test(runtime),
    "PIN 9a 🔴: `Session.reset()` dispatches on a `{sessionId}` address — never on a continuation token",
  );
  ok(
    /function logicalToken\((\w+)\)\{if\(typeof \1==`string`\)return \1;[^}]*return sessionCommandHookToken\(\1\.sessionId\)\}/.test(read("execution/session-inbox/resume.js")),
    "PIN 9a 🔴: …and a `{sessionId}` address resolves to the STABLE `sessionCommandHookToken` — the one channel-AGNOSTIC retirement door",
  );
  ok(
    /dispatchContinuation\((\w+)\)\{return await dispatchWorkflowCommand\(\1\.continuationToken/.test(runtime),
    "PIN 9c: …while the continuation door still dispatches on the channel ALIAS string — a different address space",
  );

  const session = read("channel/session.d.ts");
  ok(session.includes("Terminally retires this exact session ID"), "PIN 9a: `Session.reset()` still exists and still means terminal retirement");

  const routes = read("channel/routes.d.ts");
  ok(/^\s*attachSession: AttachSessionFn;/m.test(routes), "PIN 9a: `attachSession` is still a member of `RouteHandlerArgs`");

  const ops = read("channel/channel-operations.d.ts");
  ok(!ops.includes("attachSession"), "PIN 9a: a channel `receive` context still gets NO `attachSession` — the session-id door stays route-only");
  ok(
    /reset\(options\?: \{\s*readonly reason\?: string;\s*\}\): Promise<ResetSessionResult>;/.test(ops),
    "PIN 9b 🔴: `ChannelSource` — what `from(address)` returns — still carries `reset`",
  );
  ok(
    /interface ChannelReceiveContext<TState = undefined> \{\s*readonly from: ChannelFrom<TState>;/.test(ops),
    "PIN 9b 🔴: an authored channel's `receive` context still gets `from` — so a `receive` CAN retire, contrary to the pre-OPE-627 reading",
  );
  ok(
    /export type ChannelFrom<TState = undefined> = \(address: string\) => ChannelSource<TState>;/.test(ops),
    "PIN 9b: …and `from` still returns exactly that `ChannelSource`, so the two facts above join up",
  );

  const address = read("channel/channel-address.js");
  ok(
    /`\$\{[A-Za-z_$]+\.channelName\}:\$\{[A-Za-z_$]+\.continuationToken\}`/.test(address),
    "PIN 9c 🔴: the dispatched address is still `${channelName}:${continuationToken}` — the continuation door is CHANNEL-LOCAL",
  );
  ok(
    /reset\([A-Za-z_$]+\)\{return await [A-Za-z_$]+\.runtime\.dispatchContinuation\(\{command:\{kind:`reset`/.test(address),
    "PIN 9c: …and `from(address).reset()` still dispatches through that namespaced address, never through a session id",
  );
}

{
  const opened = readAgentStarted({
    callId: "call_parked",
    name: "agent",
    sessionId: "wrun_CHILD",
    streamPath: "/sessions/wrun_CHILD/stream",
    taskId: "agent-abcdef012345",
    turnId: "turn_parent",
  });
  ok(opened !== null, "OE reads eve's `agent.started`");
  ok(
    opened!.sessionId === "wrun_CHILD",
    "🔴 OPE-566 RE-OPENED: OE now holds the parked worker's OWN SESSION ID. The retired claim was that eve stripped it before OE ever saw it; it is on `agent.started`, and the dispatch row records it",
  );
  ok(opened!.taskId === "agent-abcdef012345", "…joined to the task, which is what makes the census countable from one row");
  ok(
    readAgentStarted({ callId: "call_exec", name: "agent", sessionId: "wrun_EXEC", streamPath: "/x", turnId: "turn_parent" })!.taskId === null,
    "negative control: an `execute` call opens a session with NO task, so it joins to no dispatch row and is not part of the parked census",
  );

  ok(TERMINAL_TASK_STATUSES.includes("completed"), "`completed` is terminal for the TASK");
  ok(TERMINAL_TASK_STATUSES.includes("cancelled"), "…and `cancelled` is terminal too — a cancelled task's worker parks exactly the same way");
  ok(!TERMINAL_TASK_STATUSES.includes("working"), "negative control: `working` is not terminal — and at 0.70 it is not a `task.settled` status at all");
  ok(!TERMINAL_TASK_STATUSES.includes("input_required"), "negative control: `input_required` is not terminal either, and it was a task-VIEW status");
}

{
  const turnCancel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "channels", "turn-cancel.ts"), "utf8");
  const shape = /export type AttachSessionForCancel = \(sessionId: string\) => \{([\s\S]*?)\n\};/.exec(turnCancel)?.[1];
  ok(shape !== undefined, "OE still narrows eve's session handle through `AttachSessionForCancel` — the turn-cancel entry point a route's `attachSession` enters core by");
  ok(shape!.includes("cancel("), "…and that narrowed handle still carries `cancel`");
  ok(
    !shape!.includes("reset("),
    "🔴 OE's session handle now carries `reset` — the seat retirement is being built, so re-read OPE-627 and rewrite this file's ruling",
  );
}

console.log(`parked-child-lifecycle: ${String(n)} assertions passed (eve ${eveVersion})`);
