import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  readUsageWindow,
  registerScript,
  rowsSinceCursor,
  taskResultsInPrompt,
  waitFor,
  workSessionCalls,
  waitForChildren,
  workTaskIdOfCall,
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

const CHILD_ANSWER = "the worker finished the background job";

test("a forwarded job returns a receipt at once, ends the seat's turn, comes back as a message of its own, and bills the seat's surface", async () => {
  await bootAgent();

  const cursor = await auditCursor();
  const first = open(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "do the long job" }, id: "t3-delegate" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, say: CHILD_ANSWER }],
    }),
  );
  afterThisTest(() => first.releaseHolds());

  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  const workMark = workSessionCalls().length;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate the long job" });

  const resumed = await waitFor(
    () => first.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "work")),
    "the seat's step carrying the forward receipt",
  );
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const delegation = resumed.toolResults.find((t) => t.name === "work")!;
  expect(delegation.isError).toBe(false);

  const taskId = await workTaskIdOfCall(cursor, first, "t3-delegate", "the t3 forward");
  const settlement = open(armSettlement(first, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const dispatchStep = first.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  const offered = new Set(dispatchStep.tools);
  expect(offered.has("work")).toBe(true);
  // On eve 1.x eve mounts its built-in `agent`, and the `eve__task_*` verbs with it, on every root
  // session, so the seat is OFFERED them. The guarantee moved to call time: the seat's `agent` call
  // is refused before a task starts, so its task verbs reach no `agent` task. They still reach a
  // declared subagent's task (tests/integration/tasks/seat-native-agent-gate.test.ts). This test's own work session starts
  // its worker through `agent`, so it is that gate's negative control.

  {
    expect(offered.has("cancel_work")).toBe(true);
    expect(offered.has("task_update")).toBe(false);
    expect(offered.has("task_sleep")).toBe(false);
    expect(offered.has("task_peek")).toBe(false);
  }

  const receipt = (typeof delegation.output === "string" ? JSON.parse(delegation.output) : delegation.output) as { requestId?: unknown };
  expect(typeof receipt.requestId).toBe("string");
  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((r) => r.detail?.task === taskId);
  expect(started?.detail?.request, "W's task_started row does not name the forward's request").toBe(receipt.requestId);
  expect(JSON.stringify(delegation.output)).not.toContain(CHILD_ANSWER);

  expect(resumed.stepIndex).toBe(1);
  expect(taskResultsInPrompt(resumed.messages)).toEqual([]);
  first.releaseHolds();
  await waitForChildren(first, { count: 1, lastStepIndex: 0, label: "the child's own model call" });
  await waitFor(() => (first.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the settled worker's result, delivered as a result wake naming the task id" });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result arrives in a seat turn of its own").not.toBe(resumed.turnId);

  const resultText = resultStep.messages.map((m) => m.text).join("\n");
  expect(resultText).toContain(CHILD_ANSWER);
  const arc = [...first.requests, ...settlement.requests];
  expect(arc.flatMap((r) => r.toolResults.map((t) => t.name)).filter((t) => t.startsWith("task_"))).toEqual([]);

  const cancels = arc.flatMap((r) => r.toolResults.filter((t) => t.name === "eve__task_cancel" || t.name === "cancel_work"));
  expect(cancels).toEqual([]);
  expect(arc.filter((r) => r.fault !== undefined)).toEqual([]);
  expect([...first.resolves, ...settlement.resolves].filter((r) => r.fault !== undefined)).toEqual([]);

  const parentSurfaceKey = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;
  const workStarted = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 200 })).find((r) => r.detail?.task === taskId);
  const workSession = workStarted?.detail?.session;
  expect(typeof workSession, "W's task_started row for this task").toBe("string");
  const usage = await waitFor(async () => {
    const seatOwnCalls = [...first.requests, ...settlement.requests].filter((r) => r.role === "parent").length;
    const workCalls = workSessionCalls()
      .slice(workMark)
      .filter((c) => c.sessionId === workSession).length;
    const got = await readUsageWindow({ sinceIso, workspaceKeys: [`discord/${DISCORD_GUILD_ID}`] });
    return workCalls > 0 && got.rows.reduce((sum, r) => sum + r.calls, 0) > seatOwnCalls + workCalls ? got : undefined;
  }, "the usage window to account for MORE calls than the seat and the work session made — the surplus is the worker's");

  expect([...new Set(usage.rows.map((r) => r.surfaceKey))]).toEqual([parentSurfaceKey]);
});
