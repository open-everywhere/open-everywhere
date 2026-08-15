import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  readUsageWindow,
  registerScript,
  sleep,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});

function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}
function close(handle: ScriptedHandle): void {
  handle.dispose();
  live.delete(handle);
}

const CHILD_ANSWER = "the worker finished the background job";

const TASK_TOOLS = ["task_peek", "task_cancel", "task_sleep", "task_update"] as const;

test("a background delegation ends the parent's turn, comes back as a message, and bills the parent", async () => {
  await bootAgent();

  const first = open(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "do the long job" }, id: "t3-delegate" }] }, { say: "handing this off" }],
      child: [{ say: CHILD_ANSWER }],
    }),
  );

  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate the long job" });

  const resumed = await waitFor(
    () => first.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation result",
  );
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const delegation = resumed.toolResults.find((t) => t.name === "agent")!;
  expect(delegation.isError).toBe(false);

  await waitFor(() => first.requests.find((r) => r.role === "child"), "the child's own model call");

  const output = delegation.output as { taskId?: unknown; status?: unknown; agentId?: unknown };
  const taskMode = typeof output?.taskId === "string";

  const dispatchStep = first.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  const offered = new Set(dispatchStep.tools);
  expect(offered.has("agent")).toBe(true);

  if (taskMode) {
    expect(offered.has("task_peek")).toBe(true);
    expect(offered.has("task_cancel")).toBe(true);
    expect(offered.has("task_update")).toBe(false);
    expect(offered.has("task_sleep")).toBe(false);
  } else {
    for (const name of TASK_TOOLS) expect(offered.has(name)).toBe(false);
  }

  if (taskMode) {
    expect(String(output.taskId)).toMatch(/^task_/);
    expect(output.status).toBe("working");
    expect(String(output.agentId)).toMatch(/^ag_/);
    expect(JSON.stringify(delegation.output)).not.toContain(CHILD_ANSWER);
  } else {
    expect(JSON.stringify(delegation.output)).toContain(CHILD_ANSWER);
  }

  await waitFor(() => first.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step — the turn really ended");

  const taskId = taskMode ? String(output.taskId) : "";
  const firstRequests: readonly RecordedRequest[] = [...first.requests];
  close(first);
  const second = open(
    registerScript({
      parent: taskMode
        ? [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "t3-peek" }] }, { say: "the worker is done" }]
        : [{ say: "nothing to do" }],
      child: [{ say: "nothing to do" }],
    }),
  );

  if (taskMode) {
    const notification = await waitFor(
      () => second.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
      "the settled worker's completion, delivered as a new message naming the task id",
    );
    expect(notification.fault).toBeUndefined();

    const peek = await waitFor(
      () => second.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_peek")),
      "the parent's step carrying the task_peek result",
    );
    const view = peek.toolResults.find((t) => t.name === "task_peek")!;
    expect(view.isError).toBe(false);
    expect(JSON.stringify(view.output)).toContain(CHILD_ANSWER);

    const cancels = [...firstRequests, ...second.requests].flatMap((r) => r.toolResults.filter((t) => t.name === "task_cancel"));
    expect(cancels).toEqual([]);
  } else {
    await sleep(5_000);
    expect(second.requests.filter((r) => r.role === "parent")).toEqual([]);
  }

  const parentSurfaceKey = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;
  const usage = await waitFor(async () => {
    const got = await readUsageWindow({ sinceIso, workspaceKeys: [`discord/${DISCORD_GUILD_ID}`] });
    return got.rows.length > 0 ? got : undefined;
  }, "the usage window to carry this arc's rows");

  expect([...new Set(usage.rows.map((r) => r.surfaceKey))]).toEqual([parentSurfaceKey]);
  const parentOwnCalls = [...firstRequests, ...second.requests].filter((r) => r.role === "parent").length;
  const totalCalls = usage.rows.reduce((sum, r) => sum + r.calls, 0);
  expect(totalCalls).toBeGreaterThan(parentOwnCalls);
});
