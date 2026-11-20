process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_TASK_STATUSES, readAgentStarted } from "../agent/access/background-tasks.js";
import { childOpenedData } from "../agent/hooks/delegation-settlement.js";
import { callViewWith, turnEvents } from "./_hook-view.js";

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
const here = dirname(fileURLToPath(import.meta.url));

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

// PIN 1 — the worker's own session id reaches an authored hook, on `child.opened`.
{
  ok(
    /function openChild\((\w+),\w+\)\{return commitOf\(\[\{\.\.\.fact\(`child\.opened`,\1\)/.test(read("harness/session-machine/children.js")),
    "PIN 1: eve commits `child.opened` in `openChild`, with the data it is handed",
  );
  const runMessages = read("execution/tools/workflow/apply-run-messages.js");
  ok(
    /async function childOpenedEvent\(\w+,\w+,\{from:(\w+),session:(\w+)\}\)\{[^]*?return openChild\(\{name:\2\.name,owner:\{callId:\1\.callId\},sessionId:\2\.sessionId,stream:\w+\}/.test(runMessages),
    "PIN 1 🔴: `child.opened` carries the OPENED session's own `sessionId` (the worker's id), and names the call that opened it",
  );
  ok(
    /let\{address:(\w+),deliveryId:\w+\}=await this\.#\w+\.host\.agentSessions\.open\([^]*?kind:`agent-started`,session:\1\}/.test(read("execution/agent-sessions/session.js")),
    "PIN 1: …and that session address is the one `agentSessions.open` returned for the worker, sent up as `agent-started`",
  );
  ok(
    /\w+\.kind===`agent-started`\?\w+\?await \w+\.stopLate\([^)]*\):(\w+)\.push\(await childOpenedEvent\(/.test(runMessages),
    "PIN 1: an `agent-started` message becomes a `child.opened` event, unless its task is no longer active (then eve stops the late child)",
  );
  ok(
    /let publish=async\(\)=>\{if\((\w+)\.length===0\)return;let \w+=await publishSessionEvents\(\w+,\1,/.test(runMessages),
    "PIN 1: …and those events go out through `publishSessionEvents`",
  );
  const publishEvents = read("execution/publish-session-events.js");
  const scope = fnBody(publishEvents, "publishInSessionScope");
  ok(
    scope !== undefined && /handleEvent:(\w+)\.publish,[^]*?\?\?\1\.publish;/.test(scope),
    "PIN 1 🔴: `publishSessionEvents` hands each event to the publisher's `publish`, not its bare `emit`",
  );
  ok(
    /let publish=async (\w+)=>\{let \w+=\w+\.cancelTurn;await (\w+)\.react\(await emit\(\1\)/.test(publishEvents),
    "PIN 1 🔴: …and that `publish` emits the event, then hands it to the dispatcher's `react`",
  );
  ok(
    /react\((\w+),(\w+)\)\{if\(\1\.length===0\)return Promise\.resolve\(\);let \w+=\w+\.then\(\(\)=>runEffects\(\w+,\{\.\.\.\2,written:\1\}\)\)/.test(publishEvents),
    "PIN 1 🔴: …and `react` runs the definition effects (`runEffects`) on the written events",
  );
  ok(
    /async function runEffects\([^]*?for\(let \w+ of await collectEffects\(\[\w+\]\)\)try\{await withUsageInEffect\(\(\)=>\w+\.run\(\)\)/.test(read("definitions/kernel.js")),
    "PIN 1: …`runEffects` runs every effect each definition contributes",
  );
  ok(
    /function hookDefinition\((\w+)\)\{[^]*?\(\w+\.commit\?\.written\?\?\[\]\)\.flatMap\([^]*?let \w+=\1\.events\[\w+\];[^]*?run:\(\)=>runHandler\(/.test(read("definitions/hooks.js")),
    "PIN 1 🔴: …and an authored hook's definition contributes one effect per written event its `events` map keys — so an OE hook receives the worker's session id",
  );
  const authoring = read("protocol/session-events/authoring.js");
  ok(authoring.includes("child.opened") && authoring.includes("task.started"), "PIN 1: `child.opened` and `task.started` are in eve's AUTHORED hook event list");
  ok(
    /export type HookEventMap = \{\s*readonly \[T in AuthoringEventType\]: ProtocolEvent<T>;\s*\};/.test(read("public/definitions/hook.d.ts")),
    "PIN 1: …and the authored hook map is built from exactly that list",
  );
  const childSchema = /"child\.opened":envelopeOf\(`child\.opened`,conforming\(\)\(z\.object\(\{([^]*?)\}\)\)\)/.exec(read("protocol/session-events/families/child.js"))?.[1];
  ok(childSchema !== undefined && /(?:^|,)sessionId:id(?:,|$)/.test(childSchema), "PIN 1: the `child.opened` schema carries `sessionId`");
  const taskSchema = /"task\.started":envelopeOf\(`task\.started`,conforming\(\)\(z\.object\(\{([^]*?)\}\)\)\)/.exec(read("protocol/session-events/families/task.js"))?.[1];
  ok(taskSchema !== undefined, "PIN 1: eve still declares the `task.started` schema");
  ok(
    taskSchema !== undefined && !/sessionId|runId|hookToken/.test(taskSchema),
    "PIN 1 negative control: `task.started` names no session, run or hook id — the worker id rides on `child.opened` alone",
  );
  for (const rel of ["execution/tasks/render.js", "execution/tasks/calls.js", "protocol/task-tools.js"]) {
    ok(!/sessionId|runId|hookToken/.test(read(rel)), `PIN 1: \`${rel}\` names no session, run or hook id — a task-tool result shows the model the task id only`);
  }
}

// PIN 2 — the task table, and the run address it holds per task.
{
  ok(read("harness/running-work.js").includes("RUNNING_WORK_STATE_KEY=`eve.work`"), "PIN 2: the session's running work lives in its durable state under `eve.work`");
  const table = read("execution/tasks/table.js");
  ok(/function readTaskTable\((\w+)\)\{let \w+=readRunningWork\(\1\)\.tasks;/.test(table), "PIN 2: …and the task table is that record's `tasks` list");
  const isTaskRun = fnBody(table, "isTaskRun");
  ok(isTaskRun !== undefined, "PIN 2: eve still validates a task's `run` record in `isTaskRun`");
  ok(
    /isNonEmptyString\(\w+\.runId\)&&isNonEmptyString\(\w+\.hookToken\)/.test(isTaskRun ?? ""),
    "PIN 2 🔴: a task's `run` record carries the run's `runId` AND its control `hookToken` — the per-worker road through the task record",
  );
  ok(
    /function liveTaskRuns\((\w+)\)\{return \1\.tasks\.flatMap\((\w+)=>\2\.run===void 0\?\[\]:\[toRunAddress\(\2\.run\)\]\)\}/.test(table),
    "PIN 2: `liveTaskRuns` enumerates the run address of every task that still holds a run — idle resumable tasks included",
  );
  ok(
    /function liveRuns\((\w+)\)\{return\[\.\.\.getBlockingWorkflowToolRuns\(\1\)\.map\(\w+=>\w+\.address\),\.\.\.liveTaskRuns\(readTaskTable\(\1\)\)\]\}/.test(table),
    "PIN 2: `liveRuns` is the blocking workflow-tool runs plus every live task run",
  );
  ok(!(isTaskRun ?? "sessionId").includes("sessionId"), "PIN 2 negative control: the `run` record names no `sessionId` — the worker session belongs to the run, not to the task record");
}

// PIN 3 — what `eve__task_cancel` does to a worker.
{
  const table = read("execution/tasks/table.js");
  const steps = read("execution/tasks/steps.js");
  ok(
    /status:isTaskWorking\(\w+\)\?`cancelled`:`already_finished`/.test(table),
    "PIN 3: `taskCancelResult` answers `already_finished` for a task that holds no working call",
  );
  ok(
    /\w+\.status===`cancelled`&&await \w+\.advance\(\w+=>cancelTasksStep\(/.test(read("execution/tasks/session.js")),
    "PIN 3 🔴: `answerTaskCancel` runs `cancelTasksStep` ONLY on a `cancelled` answer — a settled (parked) task's `eve__task_cancel` sends nothing",
  );
  ok(
    /function cancelTask\((\w+),(\w+)\)\{let (\w+)=findTask\(\1,\2\);if\(\3===void 0\)return\{settled:\[\],table:\1\};if\(\3\.resumable&&\3\.kind!==`agent`\)return cancelResumableTask\(\1,\3\);/.test(table),
    "PIN 3 🔴: `cancelTask` sends an `agent` task PAST the resumable arm — a worker is never cancelled as a resumable tool",
  );
  ok(/cancelled:!0/.test(fnBody(table, "cancelTask") ?? ""), "PIN 3: …and marks that task `cancelled`");
  ok(
    !/isTaskWorking/.test(fnBody(table, "cancelTask")?.split("return cancelResumableTask")[1] ?? "isTaskWorking"),
    "PIN 3: …and that `agent` arm has NO working check of its own — it would end an idle (parked) worker it is handed",
  );
  ok(
    /async function cancelWorkingTasks\((\w+),(\w+),\w+=\{\}\)\{let (\w+)=workingTasks\(sessionTaskTable\(\1\)\)\.map\(\w+=>\w+\.id\);[^}]*?cancelTasksStep\(\{\.\.\.\w+,reason:\2,taskIds:\3,/.test(read("execution/tasks/session.js")) &&
      /import\{[^}]*\bworkingTasks\b[^}]*\}from"#execution\/tasks\/table\.js"/.test(read("execution/tasks/session.js")) &&
      /function workingTasks\((\w+)\)\{return \1\.tasks\.filter\(isTaskWorking\)\}/.test(table) &&
      /function isTaskWorking\((\w+)\)\{return \1\.calls\.length>0\}/.test(table),
    "PIN 3 🔴: …so the guard for a parked worker is the CALLER's filter: a turn cancel, a `clear`, a `cancel-working-tasks` message and a turn that parks with settled calls all go through `cancelWorkingTasks`, which takes only tasks with a working call",
  );
  const cancelStepFiles = (readdirSync(distSrc, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith(".js") && read(rel).includes("cancelTasksStep"))
    .map((rel) => rel.split("\\").join("/"))
    .sort();
  ok(
    cancelStepFiles.join(",") === "execution/tasks/session.js,execution/tasks/steps.js" &&
      (read("execution/tasks/steps.js").match(/cancelTasksStep\(/g) ?? []).length === 1 &&
      (read("execution/tasks/session.js").match(/cancelTasksStep\(/g) ?? []).length === 2 &&
      (fnBody(read("execution/tasks/session.js"), "cancelWorkingTasks")?.match(/cancelTasksStep\(/g) ?? []).length === 1 &&
      (fnBody(read("execution/tasks/session.js"), "answerTaskCancel")?.match(/cancelTasksStep\(/g) ?? []).length === 1,
    `PIN 3: …and across eve's whole \`dist/src\`, \`cancelTasksStep\` is defined once and called only twice, in \`session.js\` — \`cancelWorkingTasks\` and the \`cancelled\`-gated \`answerTaskCancel\` — so no unfiltered caller exists (files: ${cancelStepFiles.join(", ")})`,
  );
  ok(
    /function isTaskAvailable\((\w+),\w+\)\{return \1!==void 0&&\1\.resumable&&!\1\.cancelled&&/.test(table),
    "PIN 3: …so a cancelled worker task is never available to a later `taskId` call",
  );
  ok(
    /\w+\.push\(\{ends:(\w+)\?\.resumable===!1\|\|\1\?\.kind===`agent`,run:\w+\.send\.run\}\)/.test(steps),
    "PIN 3 🔴: `cancelTasks` marks the run of every cancelled `agent` task as one that ENDS",
  );
  ok(
    /stopRuns\(\w+\.filter\(\w+=>\w+\.ends\),\{kind:`end`,reason:TASK_CANCEL_REASON\}/.test(steps) &&
      /stopRuns\(\w+\.filter\(\w+=>!\w+\.ends\),\{kind:`cancel`,reason:TASK_CANCEL_REASON\}/.test(steps),
    "PIN 3 🔴: …and sends those runs `end` (the reaper's control, pin 4), while a resumable tool run gets `cancel` — so a task cancel of a WORKING worker retires it",
  );
  ok(
    /\((\w+)\?\.resumable===!1\|\|\1\?\.kind===`agent`\)&&\w+\.push\(\w+=>endTask\(/.test(steps),
    "PIN 3: …and records `task.ended` for the cancelled worker task",
  );
  ok(
    /if\(\w+&&\w+\.kind===`started`\)return await ignoreGoneTarget\(resumeRoutedHook\(findTask\(\w+,\w+\)\.run\.hookToken,\{kind:`end`,reason:TASK_CANCEL_REASON\}\)\)/.test(steps),
    "PIN 3: a cancelled task's run that reports `started` late is sent `end` at once",
  );
  ok(steps.includes("TASK_CANCEL_REASON=`The task was cancelled.`"), "PIN 3: the task cancel reason text is `The task was cancelled.`");
  const resumable = fnBody(table, "cancelResumableTask");
  ok(resumable !== undefined, "PIN 3: eve still cancels a resumable TOOL task through `cancelResumableTask`");
  ok(
    /if\(\w+===void 0\|\|!isTaskWorking\(\w+\)\)return\{settled:\[\],table:\w+\}/.test(resumable ?? ""),
    "PIN 3 negative control: an IDLE resumable tool task returns from `cancelResumableTask` unchanged",
  );
  ok(
    !/finishTaskRun|removeTask|cancelled:/.test(resumable ?? "finishTaskRun"),
    "PIN 3 negative control: …and the cancel of a WORKING resumable tool task keeps the task and its run — the arm a worker no longer takes",
  );
  ok(/case`cancel`:return\{kind:`cancel`,reason:TASK_CANCEL_REASON\}/.test(steps), "PIN 3: a held `cancel` command becomes a `cancel` control");
  const toControl = fnBody(steps, "toControlMessage");
  ok(toControl !== undefined && !/case`end`|kind:`end`/.test(toControl), "PIN 3: …and `toControlMessage` has no `end` arm — the worker's `end` comes from `cancelTasks` itself, not from a held command");
  const serve = read("execution/tools/workflow/serve.js");
  const serveCancel = fnBody(serve, "cancel", true);
  const serveEnd = fnBody(serve, "end", true);
  ok(serveCancel !== undefined && !serveCancel.includes("this.run.abort("), "PIN 3: a serve run's `cancel` aborts the current call only — it does not abort the run");
  ok(serveEnd !== undefined && serveEnd.includes("this.run.abort("), "PIN 3 🔴: the serve run's `end` DOES abort the run — the arm a worker's task cancel now sends");
  const run = read("execution/tools/workflow/run.js");
  ok(
    /if\((\w+)===`cancel`\)\{if\(!(\w+)\.control\.unwinding\)\{\w+=void 0;continue\}\w+\.aborted\|\|\2\.control\.apply\(\{kind:`end`,reason:`The task was cancelled and its serve body didn't return to receive\(\) within 30 seconds\.`\}\);break\}/.test(run),
    "PIN 3 ⚠️: the run escalates an UNWINDING cancel to `end` itself when the serve body has not returned to `receive()` within the cleanup window",
  );
  ok(
    /\.control\.unwinding&&\((\w+)\?\?=\w+\.sleep\(WORKFLOW_CANCELLATION_CLEANUP_MS\)\.then\(\(\)=>`cancel`\)\)[^]*?=await raceChannelReads\(\w+,\1\)/.test(run),
    "PIN 3: …the escalation timer sleeps for `WORKFLOW_CANCELLATION_CLEANUP_MS`, and it is the timeout that `raceChannelReads` races",
  );
  ok(/WORKFLOW_CANCELLATION_CLEANUP_MS=3e4/.test(read("execution/tools/workflow/cancellation-policy.js")), "PIN 3: …and that cleanup window is 30 seconds");
}

// PIN 4 — the reaper, and the road from `end` to the worker session's retirement.
{
  ok(
    /async function terminateChildSessionsStep\(\w+\)\{"use step";let (\w+);try\{\1=liveRuns\(readDurableSession\(\w+\.sessionState\)\.state\)\}catch\([^]*?return\}await stopRuns\(\1\.map\(\w+=>\(\{ends:!0,run:\w+\}\)\),\{kind:`end`,reason:`The session ended\.`\}\)\}/.test(
      read("execution/terminate-child-sessions-step.js"),
    ),
    "PIN 4 🔴: eve's reaper sends `end` to EVERY live run once it can read the session — idle resumable workers included (pin 2)",
  );
  const stopRuns = read("execution/stop-runs.js");
  ok(/async function tell\((\w+),(\w+)\)\{try\{return await resumeRoutedHook\(\1\.hookToken,\2\),!0\}/.test(stopRuns), "PIN 4: `stopRuns` tells each run on its control `hookToken`");
  ok(
    /\.\.\.\w+,\.\.\.\w+\]\.map\(async \w+=>await cancelOutright\(\w+,\w+\.reason\)/.test(stopRuns),
    "PIN 4: …and cancels outright an ending run it could not tell, or one still running after the settle window",
  );
  ok(
    /let (\w+)=startWorkflowBody\([^]*?finally\{await \1\.close\(\)\}/.test(read("execution/tools/workflow/run.js")),
    "PIN 4 🔴: a task run closes its BODY in a `finally` — on every exit, the reaper's `end` included",
  );
  ok(
    /(\w+)=createAgentSessions\([^)]*\)[^]*?close:\1\.close/.test(read("execution/tools/workflow/serve.js")),
    "PIN 4 🔴: …and a serve body's `close` is the `close` of the agent sessions it opened",
  );
  ok(
    /close:async\(\)=>\{(\w+)\.length!==0&&await \w+\.host\.agentSessions\.end\(\{sessions:\1\}\)\}/.test(read("execution/agent-sessions/session.js")),
    "PIN 4: …and that close ends every agent session the run opened",
  );
  const over = read("execution/agent-sessions/sessions-over.js");
  ok(/await \w+\.command\(\{\.\.\.\w+,address:\w+\},agentSessionResetCommand\(/.test(over), "PIN 4: ending a LOCAL agent session sends it the reset command");
  ok(
    /function agentSessionResetCommand\(\w+\)\{return\{kind:`reset`,reason:AGENT_SESSION_RUN_FINISHED_REASON,/.test(read("execution/agent-sessions/start.js")),
    "PIN 4: …and that command is a `reset`",
  );
  ok(
    /async command\((\w+),(\w+)\)\{let\{continuationToken:\w+,sessionId:(\w+)\}=\1\.address;let \w+=await dispatchWorkflowSessionCommand\(\{command:\2,sessionId:\3\}\)/.test(read("execution/agent-sessions/steps.js")),
    "PIN 4 🔴: …dispatched to the worker BY ITS SESSION ID — the worker is retired, not just its task",
  );
  ok(
    /let \w+=\w+\.agent\(\w+\.toolName\);let \w+=sendToAgent\(/.test(read("runtime/subagents/workflow.js")),
    "PIN 4: the `agent` tool's serve body opens its worker through `ctx.agent()` — the agent sessions above",
  );
  ok(
    /function entryPointOf\((\w+)\)\{let (\w+)=dispatchTargetOf\(\1\);return \2===void 0\?`execute`:\2\.kind===`workflow-tool-call`\?\2\.entryPoint:`serve`\}/.test(read("execution/tasks/tool-entry-point.js")),
    "PIN 4: …and an agent tool always enters as `serve` — a resumable task with a run",
  );
  ok(/kind:isAgentTool\(\w+\.definition\)\?`agent`:`tool`/.test(read("execution/tasks/model-step.js")), "PIN 4: …whose task record is kind `agent` (the kind pin 3 ends)");
}

// PIN 5 — no OE session reaches the `expired` arm on a clock.
{
  ok(
    /function createSessionTimeoutControl\((\w+)\)\{let\{sessionId:\w+,timeoutMs:(\w+)\}=\1;if\(\2===!1\)return;/.test(read("execution/session/timeout-control.js")),
    "PIN 5 🔴: `sessionTimeoutMs: false` still yields NO timeout control",
  );
  const boot = read("execution/session/owner-boot.js");
  ok(/(\w+)=\w+\.sessionTimeoutMs\?\?DEFAULT_SESSION_TIMEOUT_MS/.test(boot), "PIN 5: the session boot defaults the timeout only when it is ABSENT — `false` is not absent");
  ok(/timeoutControl:\w+\.timeouts\(\{sessionId:\w+\.sessionId,timeoutMs:\w+\.sessionTimeoutMs\}\)/.test(boot), "PIN 5: …and builds its timeout control from that value");
  const entry = read("execution/session/entry.js");
  ok(
    entry.includes("timeouts:createSessionTimeoutControl") && /sessionTimeoutControl:createSessionTimeoutControl\(\{[^}]*timeoutMs:\w+\.sessionTimeoutMs\}\)/.test(entry),
    "PIN 5: …through `createSessionTimeoutControl`, on a first boot and on a handoff successor alike",
  );
  ok(
    /let (\w+)=\w+\.sessionTimeoutControl;[^]*?Promise\.allSettled\(\[runInitialAction\(\),\1\?\.start\(\)\]\)/.test(read("execution/session/program.js")),
    "PIN 5: …and the session loop arms the timer only through that control — with none, no timer runs",
  );
  ok(
    read("execution/session/admission.js").split("enqueueControl(`expired`)").length - 1 === 1 &&
      /case`session-timeout`:return \w+\.ownerRunId===\w+\.inbox\.ownerRunId\(\)&&\w+\.queue\.enqueueControl\(`expired`\)/.test(read("execution/session/admission.js")),
    "PIN 5: the `expired` control enters the queue only from the timer's `session-timeout` payload",
  );
  const agentSource = readFileSync(join(here, "..", "..", "..", "agent", "agent.ts"), "utf8");
  ok(/sessionTimeoutMs\s*:\s*false/.test(agentSource), "PIN 5: the shipped agent definition still sets `limits.sessionTimeoutMs: false`");
}

// PIN 6 — every retirement goes through one finalizer, which reaps first.
{
  const program = read("execution/session/program.js");
  const finalization = read("execution/session/finalization.js");
  ok(/let expired=\w+=>\(\{kind:`expired`,/.test(program), "PIN 6: the loop's `expired(...)` helper builds the `expired` outcome");
  ok(
    /case`reset`:return\{kind:`terminal`,outcome:expired\([^;]*\)\};case`closed`:return \w+\.takenOver\?await \w+\.adoptTakeover\(\):\{kind:`terminal`,outcome:expired\(\)\};case`transferred`:return \w+;case`expired`:return\{kind:`terminal`,outcome:expired\(\)\}/.test(program),
    "PIN 6 🔴: the PREWARMED park folds `reset`, an un-taken-over `closed` and `expired` into one `expired` outcome",
  );
  ok(
    /case`reset`:return\{kind:`terminal`,outcome:resetOutcome\(\w+\.origin\)\};case`closed`:return \w+\.takenOver\?await \w+\.adoptTakeover\(\):\{kind:`terminal`,outcome:\{kind:`expired`\}\};case`transferred`:return \w+;case`expired`:return\{kind:`terminal`,outcome:\{kind:`expired`\}\}/.test(program),
    "PIN 6 🔴: …and so does the POST-TURN park",
  );
  ok(
    /function resetOutcome\((\w+)\)\{return \1===void 0\?\{kind:`expired`\}:\{control:controlDeliveryOf\(\1\),kind:`expired`\}\}/.test(program),
    "PIN 6: …where `resetOutcome` is the `expired` outcome, with the reset's own control delivery",
  );
  ok(/=await finalizeSession\(\w+\.outcome,/.test(program), "PIN 6: …and the loop's terminal outcome goes to `finalizeSession`");
  const finalize = fnBody(finalization, "finalizeSession");
  ok(finalize !== undefined, "PIN 6: eve still finalizes every session in `finalizeSession`");
  ok(
    /^let\{serializedContext:\w+,sessionState:(\w+)\}=\w+\.cursor;if\(\1!==void 0&&mayHaveLiveRuns\(\1\)\)try\{await terminateChildSessionsStep\(\{sessionState:\1\}\)\}/.test(finalize ?? ""),
    "PIN 6 🔴: the finalizer's FIRST act is the reap, for every outcome kind (gated only on a live run)",
  );
  ok(
    /function mayHaveLiveRuns\((\w+)\)\{try\{return liveRuns\(\1\.snapshot\?\.session\?\.state\)\.length>0\}catch\{return!0\}\}/.test(finalization),
    "PIN 6: …and a session whose runs it cannot read is reaped anyway",
  );
  ok(
    /(\w+)\.kind===`expired`\?await emitTerminalSessionCompletionStep\([^]*?\):\1\.kind===`failed`\?await emitTerminalSessionFailureStep\([^]*?\):await closeSessionStreamStep\(/.test(finalize ?? ""),
    "PIN 6 🔴: …then it emits the terminal event for the `expired` outcome — which `reset` reaches — on its kind alone, with no flag in between",
  );
  ok(
    /publishTerminalSessionEvent\(\{\.\.\.\w+,ending:\{control:\w+,settles:\w+,outcome:`completed`\}\}\)/.test(read("execution/terminal-session-completion-step.js")),
    "PIN 6: …and that event is `session.ended` with `outcome: \"completed\"`",
  );
  ok(!finalization.includes("notifyCaller") && !program.includes("notifyCaller"), "PIN 6: no `notifyCaller` flag exists on either module — no arm can ask for a quiet retirement");
  const publishEvents = read("execution/publish-session-events.js");
  const terminal = fnBody(publishEvents, "publishTerminalSessionEvent");
  ok(terminal !== undefined, "PIN 6: eve still publishes the terminal event through `publishTerminalSessionEvent`");
  ok(
    /let publish=async (\w+)=>\{await (\w+)\.emit\(\1\),await \2\.writer\.close\(\)\}/.test(terminal ?? "") && !/\.react\(|runEffects/.test(terminal ?? "runEffects"),
    "PIN 6 ⚠️: the terminal publisher writes through `emit` and never reaches `react`/`runEffects` — no authored hook receives the `session.ended` of a retirement or of a run that threw",
  );
  const emitPath = /function openSessionEventPublisher\([^]*?let publish=async/.exec(publishEvents)?.[0];
  ok(
    emitPath !== undefined && !/\.react\(|runEffects/.test(emitPath),
    "PIN 6 ⚠️: …and the publisher's `emit` path itself reaches no `react`/`runEffects` — only `publish` does",
  );
  const deliver = /async deliver\(\w+\)\{([^]*?)\},react\(/.exec(publishEvents)?.[1];
  ok(deliver !== undefined && !/\.react\(|runEffects/.test(deliver), "PIN 6 ⚠️: …and `deliver`, which `emit` calls, reaches no `react`/`runEffects` either");
  ok(
    /return await \w+\.deliver\(\w+\),\w+\}/.test(publishEvents),
    "PIN 6: …while `emit` still delivers every line to the channel's own event handlers — a channel `session.ended` handler does run",
  );
  ok(
    /\w+\.terminal===void 0\?turnSettled\([^)]*\):sessionEndedFacts\(\w+\.projection,\{[^]*?outcome:`failed`\}\)\]/.test(read("harness/session-machine/transitions.js")) &&
      /async function commit\(\w+,\w+,\w+\)\{let\{published:\w+\}=await publishFromSessionStep\(/.test(publishEvents),
    "PIN 6: the one `session.ended` an authored hook DOES receive is a failed turn's terminal end — committed as an ordinary transition (pin 1's road)",
  );
}

// PIN 7 — a reset is a retirement; a turn cancel at the park is not.
{
  const program = read("execution/session/program.js");
  ok(
    /case`cancel-turn`:await \w+\.cancelTurnWork\(\),await settleCancelledTurn\(!1,[^;]*\),\w+\?\.recordActivity\(\),\w+=\{\.\.\.\w+,settled:void 0\};continue;/.test(program),
    "PIN 7 negative control: a `cancel-turn` at the park cancels the turn's work and CONTINUES — it is not a retirement",
  );
  ok(
    /async cancelTurnWork\(\)\{await cancelWorkingTasks\(this\.input\.cursor,`turn-cancelled`,\{turnCalls:!0\}\)\}/.test(read("execution/session/turn.js")),
    "PIN 7: …and `cancelTurnWork` hands off to `cancelWorkingTasks` (pin 3 pins its working-only filter) and the turn's waited calls, nothing more — a WORKING worker task among them ends, a parked one is untouched",
  );
  ok(
    /return \w+\.kind===`done`\?\{isError:/.test(read("execution/session/finalization.js")),
    "PIN 7: the `done` outcome reaps (pin 6) and closes the stream with no `session.ended` — the one quiet exit, and only the session's own turn can take it",
  );
  ok(
    /\w+\.claimSessionHook\(sessionCommandHookToken\(\w+\.sessionId\)/.test(read("execution/session/owner-boot.js")),
    "PIN 7 🔴: every session claims its session-command hook at boot — so a worker hears the run-exit `reset` and finalizes ITSELF",
  );
  ok(
    /function sessionCommandHookToken\((\w+)\)\{return`eve:session:\$\{\1\}:inbox`\}/.test(read("execution/session-inbox/address.js")),
    "PIN 7: …and that hook is `eve:session:<id>:inbox`",
  );
}

// PIN 8 — a reset is buffered, and it always cancels the running turn.
{
  ok(
    /case`reset`:return (\w+)\.queue\.enqueueControl\(`reset`,controlOrigin\(\w+\)\),\{kind:`cancel`\}/.test(read("execution/session/admission.js")),
    "PIN 8 🔴: an admitted `reset` is QUEUED as a control for the next park AND answered as a `cancel` — the retirement is buffered, never dropped",
  );
  const activeTurn = read("execution/session/active-turn.js");
  const cancelsThisTurn = fnBody(activeTurn, "cancelsThisTurn", true);
  ok(cancelsThisTurn !== undefined, "PIN 8: the running turn still decides what cancels it in `cancelsThisTurn`");
  ok(
    /^return (\w+)\.kind===`reset`\|\|\1\.kind===`session-failure`\?!0:this\.#\w+\?!1:/.test(cancelsThisTurn ?? ""),
    "PIN 8 🔴: the running turn treats EVERY `reset` as cancelling it, before any other test — even a control turn that ignores `clear` and `cancel`",
  );
  ok(
    /(\w+)\.kind===`cancel`\?\1\.turnId===void 0\|\|\1\.turnId===this\.expectedTurnId:!1$/.test(cancelsThisTurn ?? ""),
    "PIN 8 negative control: a plain `cancel` cancels the running turn only when its `turnId` is absent or matches — `reset` alone is unconditional",
  );
  ok(
    /case`cancel`:if\(\(!\w+\|\|\w+\.kind!==`cancel`\)&&this\.cancelsThisTurn\(\w+\)&&this\.#\w+===void 0\)this\.#\w+\?\?=\w+\.origin,this\.abort\(\);/.test(activeTurn),
    "PIN 8: …and the admitted `cancel` answer aborts the running turn through that test",
  );
  ok(/onInterrupt\((\w+)=>\{this\.cancelsThisTurn\(\1\)&&this\.abort\(\)\}\)/.test(activeTurn), "PIN 8: …as does an interrupt that arrives mid-turn");
  ok(
    /if\((\w+)\?\.kind===`control`\)return \1\.origin===void 0\?\{kind:\1\.control\}:\{kind:\1\.control,origin:\1\.origin\}/.test(read("execution/session/next-input.js")),
    "PIN 8: a PARKED session surfaces the queued `reset` control from its wait — a retired generation does not need a live turn to hear it",
  );
}

// PIN 9 — the two retirement doors.
{
  ok(
    /async end\((\w+)\)\{let (\w+)=controlCommand\(\{kind:`reset`,reason:\1\?\.reason\},\1\);let \w+=await \w+\.dispatchSession\(\{command:\2,sessionId:\w+\}\)/.test(read("channel/session.js")),
    "PIN 9a 🔴: `Session.end()` sends a `reset` through `dispatchSession` on a `{sessionId}` address",
  );
  const runtime = read("execution/workflow-runtime.js");
  ok(
    /async dispatchSession\((\w+)\)\{return await dispatchWorkflowSessionCommand\(\1\)\}/.test(runtime) &&
      /async function dispatchWorkflowSessionCommand\((\w+)\)\{let (\w+)=\{sessionId:\1\.sessionId,inbox:\1\.inbox\};let (\w+)=identifyCommand\(\1\.command\);try\{return await dispatchWorkflowCommand\(\2,\3\)\}/.test(runtime),
    "PIN 9a 🔴: …and `dispatchSession` dispatches on that `{sessionId}` address — never on a continuation token",
  );
  ok(
    /function logicalSessionToken\((\w+)\)\{if\(typeof \1==`string`\)return \1;if\(!isSessionInboxAddress\(\1\)\)throw [^;]*;return sessionCommandHookToken\(\1\.sessionId\)\}/.test(read("execution/session-inbox/address.js")) &&
      /async function resumeSessionInbox\((\w+),\w+\)\{[^]*?let \w+=logicalSessionToken\(\1\);/.test(read("execution/session-inbox/resume.js")),
    "PIN 9a 🔴: …and a `{sessionId}` address resolves to the STABLE session-command hook (pin 7) — the one channel-AGNOSTIC retirement door",
  );
  ok(
    /let dispatchContinuation=async (\w+)=>\{let\{continuationToken:(\w+),successor:\w+\}=\1;let (\w+)=identifyCommand\(\1\.command\);try\{return await dispatchWorkflowCommand\(\2,\3\)\}/.test(runtime),
    "PIN 9c: …while the continuation door dispatches on the channel ALIAS string — a different address space",
  );

  const session = read("channel/session.d.ts");
  ok(
    /\/\*\* Retires this session without creating a replacement or changing this handle's ID\. \*\/\s*end\(options\?: SessionControlOptions & \{\s*readonly reason\?: string;\s*\}\): Promise<Delivery>;/.test(session),
    "PIN 9a: `Session.end()` (the eve 1.x name of `reset()`) still exists and still means terminal retirement",
  );

  const routes = read("channel/routes.d.ts");
  ok(/^\s*attachSession: AttachSessionFn;/m.test(routes), "PIN 9a: `attachSession` is still a member of `RouteHandlerArgs`");

  const ops = read("channel/channel-operations.d.ts");
  ok(!ops.includes("attachSession"), "PIN 9a: a channel `receive` context still gets NO `attachSession` — the session-id door stays route-only");
  ok(
    /\/\*\* Retires the current owner without creating a replacement\. \*\/\s*end\(options\?: \{\s*readonly reason\?: string;\s*\} & SessionControlOptions\): Promise<Delivery>;/.test(ops),
    "PIN 9b 🔴: `ChannelSource` — what `from(address)` returns — still carries `end` (the eve 1.x name of `reset`)",
  );
  ok(
    /interface ChannelReceiveContext<TState = undefined> \{\s*readonly from: ChannelFrom<TState>;/.test(ops),
    "PIN 9b 🔴: an authored channel's `receive` context still gets `from` — so a `receive` CAN retire",
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
    /async end\(([A-Za-z_$]+)\)\{let ([A-Za-z_$]+)=controlCommand\(\{kind:`reset`,reason:\1\?\.reason\},\1\);let [A-Za-z_$]+=await [A-Za-z_$]+\.runtime\.dispatchContinuation\(\{command:\2,continuationToken:[A-Za-z_$]+\}\)/.test(address),
    "PIN 9c: …and `from(address).end()` still dispatches a `reset` command through that namespaced address, never through a session id",
  );
  ok(
    /function commandDelivery\([^)]*\)\{if\([A-Za-z_$]+\.status!==`accepted`&&[A-Za-z_$]+\.status!==`reset`\)throw new SessionNotActiveError;/.test(read("channel/delivery.js")),
    "PIN 9d 🔴: `end()` resolves only when eve retired a session, and THROWS `SessionNotActiveError` when none owns the address — the generation drain reads a resolve as retired and that error as a skip",
  );
}

// OE side — what OE reads from `child.opened`, and the task statuses it treats as settled.
{
  const opened = readAgentStarted(
    childOpenedData({ sessionId: "wrun_CHILD", owner: { callId: "call_parked" }, name: "agent" }, undefined, "turn_parent"),
  );
  ok(opened !== null, "OE reads eve's `child.opened` through `childOpenedData`");
  ok(
    opened!.sessionId === "wrun_CHILD" && opened!.callId === "call_parked" && opened!.turnId === "turn_parent",
    "🔴 OPE-566 RE-OPENED: OE holds the parked worker's OWN SESSION ID, joined to the call that opened it",
  );
  ok(opened!.taskId === null, "…and with no view to join through, OE names no task — it never guesses one");
  const view = callViewWith(turnEvents("turn_parent"), { callId: "call_parked", name: "agent", kind: "agent", turnId: "turn_parent", taskId: "agent-abcdef012345" });
  const joined = readAgentStarted(childOpenedData({ sessionId: "wrun_CHILD", owner: { callId: "call_parked" }, name: "agent" }, view, "turn_parent"));
  ok(joined?.taskId === "agent-abcdef012345" && joined.sessionId === "wrun_CHILD", "…and through the session view OE joins the worker's session id to its TASK, which is what makes the census countable from one row");
  const byTaskJoined = readAgentStarted(childOpenedData({ sessionId: "wrun_CHILD", owner: { taskId: "agent-abcdef012345" }, name: "agent" }, view, "turn_parent"));
  ok(byTaskJoined?.callId === "call_parked" && byTaskJoined.taskId === "agent-abcdef012345", "…and a `child.opened` owned by the task id resolves its opening call through the same view");
  const byTask = readAgentStarted(childOpenedData({ sessionId: "wrun_CHILD", owner: { taskId: "agent-abcdef012345" }, name: "agent" }, undefined, "turn_parent"));
  ok(byTask === null, "negative control: a `child.opened` owned by a task id with no view resolves no call, so OE records no dispatch row for it");

  ok(TERMINAL_TASK_STATUSES.includes("completed"), "`completed` is terminal for the TASK");
  ok(TERMINAL_TASK_STATUSES.includes("cancelled"), "…and `cancelled` is terminal too");
  ok(!TERMINAL_TASK_STATUSES.includes("working"), "negative control: `working` is not terminal");
  ok(!TERMINAL_TASK_STATUSES.includes("input_required"), "negative control: `input_required` is not terminal either");
}

{
  const turnCancel = readFileSync(join(here, "..", "agent", "channels", "turn-cancel.ts"), "utf8");
  const shape = /export type AttachSessionForCancel = \(sessionId: string\) => \{([\s\S]*?)\n\};/.exec(turnCancel)?.[1];
  ok(shape !== undefined, "OE still narrows eve's session handle through `AttachSessionForCancel` — the turn-cancel entry point a route's `attachSession` enters core by");
  ok(shape!.includes("cancel("), "…and that narrowed handle still carries `cancel`");
  ok(
    !shape!.includes("reset(") && !/\bend\(/.test(shape!),
    "🔴 OE's session handle now carries `end` (or `reset`) — a per-worker retirement is being built, so re-read OPE-627 and rewrite this file's ruling",
  );
}

console.log(`parked-child-lifecycle: ${String(n)} assertions passed (eve ${eveVersion})`);
