process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_TASK_STATUSES, taskViewsOf, terminalTaskViewsOf } from "../agent/access/background-tasks.js";

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

{
  const json = read("tasks/json.js");
  const base = /taskViewJsonBaseShape=\{([^}]*)\}/.exec(json)?.[1];
  ok(base !== undefined, "PIN 1: eve still projects task views through `taskViewJsonBaseShape`");
  ok(base!.includes("metadata:"), "PIN 1: the projected view still carries `metadata`");
  ok(base!.includes("taskId:"), "PIN 1: the projected view still carries `taskId`");
  ok(!json.includes("executor"), "PIN 1 🔴: the task-view JSON schema still names no `executor` — no worker session id reaches OE");
  ok(!json.includes("usage"), "PIN 1: the task-view JSON schema still names no `usage` either — the same strip, same projection");
}

{
  const index = read("tasks/session-index.js");
  const executor = ((): string | undefined => {
    const head = "executor:z.strictObject({";
    const at = index.indexOf(head);
    if (at < 0) return undefined;
    let depth = 0;
    for (let i = at + head.length - 1; i < index.length; i++) {
      if (index[i] === "{") depth++;
      else if (index[i] === "}") {
        depth--;
        if (depth === 0) return index.slice(at + head.length, i);
      }
    }
    return undefined;
  })();
  ok(executor !== undefined, "PIN 2: eve's INTERNAL task view still declares an `executor` shape");
  ok(
    executor?.includes("childSessionId:") === true,
    "PIN 2: eve's INTERNAL task view still carries `executor.childSessionId` — the id pin 1 proves OE never receives",
  );
  ok(
    /lifecycle:z\.enum\(\[`parked`,`terminal`\]\)/.test(executor ?? ""),
    "PIN 2: the internal executor shape still carries `lifecycle` (`parked` / `terminal`)",
  );
}

{
  const transitions = read("tasks/transitions.js");
  ok(
    transitions.includes("cannot change a terminal task"),
    "PIN 3 🔴: a terminal task still REJECTS every command but one — `cancel` at settlement changes nothing",
  );
  const terminalArm = /isTerminalTaskStatus\([A-Za-z_$]{1,2}\.status\)\)\{if\([A-Za-z_$]{1,2}\.kind===`settle-executor`\)/.test(transitions);
  ok(terminalArm, "PIN 3: `settle-executor` is still the ONE command a terminal task accepts");
}

{
  const reaper = read("execution/terminate-child-sessions-step.js");
  ok(reaper.includes("cancelOwnedTask"), "PIN 4: eve's reaper still cancels every task in the session index");
  ok(
    reaper.includes("cancelRun"),
    "PIN 4 🔴: eve's reaper still ALSO calls `cancelRun` per local child handle — proof that a task cancel does not end a worker session",
  );
}

{
  const entry = read("execution/workflow-entry.js");
  ok(entry.includes("terminateChildSessionsStep"), "PIN 5: eve's reaper is still called from the session workflow entry and nowhere a hook can reach");
  ok(
    entry.includes("sessionTimeoutMs===!1?void 0:"),
    "PIN 5 🔴: `sessionTimeoutMs: false` still yields NO deadline — so `finalizeExpiredSession`, and the reaper behind it, never runs",
  );

  const agentSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent", "agent.ts"), "utf8");
  ok(
    /sessionTimeoutMs\s*:\s*false/.test(agentSource),
    "PIN 5: the shipped agent definition still sets `limits.sessionTimeoutMs: false` — the OPE-281 ruling this one depends on",
  );
}

{
  const entry = read("execution/workflow-entry.js");
  ok(
    /function finalizeExpiredSession\([A-Za-z_$]+\)\{return await terminateChildSessionsStep\([^)]*\),await emitTerminalSessionCompletionStep\(/.test(entry),
    "PIN 6 🔴: session expiry still reaps AND emits a terminal completion — the event OPE-281 refuses to re-arm",
  );
  ok(
    entry.split("emitTerminalSessionCompletionStep(").length - 1 === 1,
    "PIN 6 🔴: the terminal-completion emit still has exactly ONE call site — so expiry is the only exit that fires it",
  );
}

{
  const entry = read("execution/workflow-entry.js");
  ok(
    /`reset`\)return await terminateChildSessionsStep\(\{serializedContext:[^)]*\}\),\{kind:`result`,result:\{output:``\}\}/.test(entry),
    "PIN 7 🔴: the `reset` arm is still exactly `terminateChildSessionsStep` then an EMPTY result — the reaper with no terminal-completion emit",
  );
}

{
  const receiver = read("execution/turn-control-receiver.js");
  ok(
    /kind===`reset`\)\{await forwardTurnCancellationStep\(\{payload:\{\},token:turnCancellationHookToken\(/.test(receiver),
    "PIN 8 🔴: a mid-turn `reset` still forwards a turn CANCELLATION before it retires — retirement is destructive, never a soft handoff",
  );
  ok(
    /this\.bufferedSessionControls\.push\(`reset`\)/.test(receiver),
    "PIN 8: …and the retirement itself is then buffered, so it lands at the next park rather than being dropped",
  );
  const parked = read("execution/parked-delivery-wait.js");
  ok(
    /`reset`\)return\{kind:[A-Za-z_$]+(?:\.value)?\.kind\}/.test(parked),
    "PIN 8: a PARKED session still surfaces `reset` from its wait — a retired generation does not need a live turn to hear it",
  );
}

{
  const runtime = read("execution/workflow-runtime.js");
  ok(
    /dispatchSession\([A-Za-z_$]+\)\{return await dispatchWorkflowCommand\(sessionCommandHookToken\([A-Za-z_$]+\.sessionId\)/.test(runtime),
    "PIN 9a 🔴: `Session.reset()` still dispatches on the STABLE session hook — the one channel-AGNOSTIC retirement door",
  );
  ok(
    /dispatchContinuation\([A-Za-z_$]+\)\{return await dispatchWorkflowCommand\([A-Za-z_$]+\.continuationToken/.test(runtime),
    "PIN 9c: …while the continuation door still dispatches on the channel ALIAS — a different address space",
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
  const withExecutor = {
    kind: "tool-result",
    toolName: "task_peek",
    output: {
      tasks: [
        {
          taskId: "task_abc",
          status: "completed",
          metadata: { agentId: "ag_agent:abcdef012345", kind: "subagent", mode: "local", name: "agent" },
          executor: { childSessionId: "wrun_CHILD", lifecycle: "parked" },
        },
      ],
    },
  };
  const views = taskViewsOf(withExecutor);
  ok(views.length === 1, "OE reads the one view off the payload");
  ok(views[0]!.agentId === "ag_agent:abcdef012345", "OE reads the AGENT HANDLE id — which is not a session id and cannot address the parked worker");
  ok(
    !Object.prototype.hasOwnProperty.call(views[0]!, "childSessionId"),
    "🔴 OE's task summary carries NO worker session id — do not add one without re-opening OPE-566",
  );
  ok(views[0]!.agentId !== "wrun_CHILD", "negative control: the handle id is NOT the worker's session id, even when eve hands both over");

  ok(terminalTaskViewsOf(withExecutor).length === 1, "a `completed` view is terminal for the TASK");
  ok(TERMINAL_TASK_STATUSES.includes("cancelled"), "…and `cancelled` is terminal too — a cancelled task's worker parks exactly the same way");
  ok(!TERMINAL_TASK_STATUSES.includes("working"), "negative control: `working` is not terminal");
  ok(!TERMINAL_TASK_STATUSES.includes("input_required"), "negative control: `input_required` is not terminal");
}

{
  const turnCancel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "channels", "turn-cancel.ts"), "utf8");
  const shape = /export type AttachSessionForCancel = \(sessionId: string\) => \{([\s\S]*?)\n\};/.exec(turnCancel)?.[1];
  ok(shape !== undefined, "OE still narrows eve's session handle through `AttachSessionForCancel` — the one place a route's `attachSession` enters core");
  ok(shape!.includes("cancel("), "…and that narrowed handle still carries `cancel`");
  ok(
    !shape!.includes("reset("),
    "🔴 OE's session handle now carries `reset` — the seat retirement is being built, so re-read OPE-627 and rewrite this file's ruling",
  );
}

console.log(`parked-child-lifecycle: ${String(n)} assertions passed (eve ${eveVersion})`);
