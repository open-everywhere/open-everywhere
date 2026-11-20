import assert from "node:assert/strict";
import { readEveDist } from "./eve-dist-search.js";
import { TASK_PARENT_TOOL_NAMES } from "../agent/access/background-tasks.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

{
  const taskTools = readEveDist("protocol/task-tools.js");
  ok(/TASK_WAIT_TOOL_NAME=`eve__task_wait`/.test(taskTools), "🔴 TOOL NAMES: eve still names the wait tool `eve__task_wait`");
  ok(/TASK_CANCEL_TOOL_NAME=`eve__task_cancel`/.test(taskTools), "🔴 TOOL NAMES: eve still names the cancel tool `eve__task_cancel`");
  ok(
    /TASK_TOOL_NAMES=\[TASK_WAIT_TOOL_NAME,TASK_CANCEL_TOOL_NAME\]/.test(taskTools),
    "🔴 TOOL NAMES: eve's own `TASK_TOOL_NAMES` is exactly those two, in that order. A THIRD task tool added upstream reds HERE — and it must, because `access/untrusted-projection.ts` subtracts this list from a seat that may not delegate, and a name missing from it is a tool that survives the cut",
  );
  ok(/isTaskControlTool\(e\)\{return TASK_TOOL_NAMES\.includes\(e\)\}/.test(taskTools), "…and eve reserves those names against authored tools, so no authored tool can answer to one");

  const modelStep = readEveDist("execution/tasks/model-step.js");
  ok(
    /function withTaskTools\(e\)\{return new Map\(\[\.\.\.e,\[TASK_WAIT_TOOL_NAME,taskWaitTool\],\[TASK_CANCEL_TOOL_NAME,taskCancelTool\]\]\)\}/.test(modelStep),
    "🔴 TOOL NAMES THE PARENT SET: eve adds BOTH task tools together, in one map, with no root-only narrowing. This is why TASK_PARENT_TOOL_NAMES equals TASK_TOOL_NAMES",
  );
  const builtins = readEveDist("definitions/builtins.js");
  ok(
    /let r=once\(async\(\)=>t!==void 0&&\(hasRunningTask\(t\)\|\|sessionOffersTasks\(/.test(builtins) &&
      /tools:async\(\)=>\{let e=await n\.tools\(\);if\(!await r\(\)\)return e;[^}]*?withTaskTools\(/.test(builtins),
    "🔴 TOOL NAMES THE PARENT SET: eve calls `withTaskTools` only when the session offers tasks or has one running — keyed on the session, not on a root-only narrowing",
  );
  const advertised = readEveDist("execution/catalog/step-catalog.js");
  ok(
    /function isVisible\(e,t\)\{return e\.rootOnly!==!0&&e\.availableInSubagents!==!1&&e\.behavior\?\.availability\.includes\(`root-session`\)!==!0\|\|t\.rootSessionId===void 0\}/.test(advertised),
    "🔴 TOOL NAMES: `isVisible` reads exactly three fields — `rootOnly`, `availableInSubagents` and a `root-session` availability. Those are the only ways eve hides a tool from a child",
  );
  for (const [file, tool] of [
    ["tools/provided/task-wait.js", "taskWaitTool"],
    ["tools/provided/task-cancel.js", "taskCancelTool"],
  ] as const) {
    const body = readEveDist(file);
    ok(
      !/rootOnly/.test(body) && !/availableInSubagents/.test(body) && !/availability/.test(body),
      `🔴 TOOL NAMES: ${tool} declares NONE of the three fields \`isVisible\` reads, so eve never hides it from a child. The 0.54 parent/child SUBSET distinction has no bytes left behind it`,
    );

  const evesNames = /TASK_TOOL_NAMES=\[TASK_WAIT_TOOL_NAME,TASK_CANCEL_TOOL_NAME\]/.test(taskTools) ? ["eve__task_wait", "eve__task_cancel"] : null;
  eq(
    [...TASK_PARENT_TOOL_NAMES],
    evesNames,
    "🔴 TOOL NAMES: OE's `TASK_PARENT_TOOL_NAMES` equals eve's `TASK_TOOL_NAMES`, in eve's order. The seat cut subtracts exactly this list, so a mismatch is a task tool that survives the cut on a seat that may not delegate",
  );

  const render = readEveDist("execution/tasks/render.js");
  ok(
    /function renderTaskCancelResult\(e,t\)\{return t\.status===`already_finished`\?`\$\{e\} had no work to stop\.`/.test(render),
    "🔴 TOOL NAMES: `eve__task_cancel` answers a rendered SENTENCE at 0.70. The 0.54 reader accepted cancel results because cancelling an already-terminal task returned `lastOutput`; this is the byte that says it no longer does",
  );
  const session = readEveDist("execution/tasks/session.js");
  ok(
    /taskToolResult\(t\.callId,TASK_CANCEL_TOOL_NAME,renderTaskCancelResult\(t\.taskId,n\)\)/.test(session),
    "🔴 TOOL NAMES: and that sentence IS the whole tool output — `answerTaskCancel` passes the rendered string straight through, with no `tasks` array and no child output beside it. so no child output reaches the model by this road",
  );
  ok(
    /TASK_RESULT_TAG=`<task_result`/.test(render) && /function renderTaskResults\(e\)/.test(render),
    "…and the child's own output reaches the model as a `<task_result>` block instead, on the settlement `hooks/delegation-settlement.ts` handles",
  );
}
}

console.log(`task-tool-names: ${String(n)} assertions passed`);
