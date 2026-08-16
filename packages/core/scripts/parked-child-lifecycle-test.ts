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
  ok(
    /executor:z\.strictObject\(\{childSessionId:/.test(index),
    "PIN 2: eve's INTERNAL task view still carries `executor.childSessionId` — the id pin 1 proves OE never receives",
  );
  ok(index.includes("lifecycle"), "PIN 2: the internal executor shape still carries `lifecycle` (`parked` / `terminal`)");
}

{
  const transitions = read("tasks/transitions.js");
  ok(
    transitions.includes("cannot change a terminal task"),
    "PIN 3 🔴: a terminal task still REJECTS every command but one — `cancel` at settlement changes nothing",
  );
  const terminalArm = /isTerminalTaskStatus\(n\.status\)\)\{if\(r\.kind===`settle-executor`\)/.test(transitions);
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
  const session = read("channel/session.d.ts");
  ok(session.includes("Terminally retires this exact session ID"), "PIN 6: `Session.reset()` still exists and still means terminal retirement");

  const routes = read("channel/routes.d.ts");
  ok(/^\s*attachSession: AttachSessionFn;/m.test(routes), "PIN 6: `attachSession` is still a member of `RouteHandlerArgs`");

  const ops = read("channel/channel-operations.d.ts");
  ok(
    !ops.includes("attachSession"),
    "PIN 6 🔴: a channel `receive` context still gets NO `attachSession` — the retirement door stays route-only",
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

console.log(`parked-child-lifecycle: ${String(n)} assertions passed (eve ${eveVersion})`);
