import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  taskResultsInPrompt,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type ScriptedHandle,
} from "../harness";

let live: ScriptedHandle | undefined;
let liveSettlement: ScriptedHandle | undefined;
afterAll(() => {
  liveSettlement?.dispose();
  live?.dispose();
  live = undefined;
  liveSettlement = undefined;
});

const CHILD_ANSWER = "the child answered, and read nothing untrusted";

test("a clean delegation taints nothing — a parked receipt is not a settlement", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" } });
  expect(settings.getSettings().taint.mode).toBe("on");

  const handle = (live = registerScript({
    parent: [{ calls: [{ tool: "work", input: { message: "count to three" }, id: "b1-delegate" }] }, { say: NO_REPLY_SENTINEL }],
    child: [{ delayMs: 120_000, say: CHILD_ANSWER }],
  }));

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate this" });

  const resumed = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "work")),
    "the parent's resumed step carrying the forward receipt",
  );
  expect(resumed.stepIndex).toBe(1);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const result = resumed.toolResults.find((t) => t.name === "work")!;
  expect(result.isError).toBe(false);
  const settlement = (liveSettlement = armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const requestId = /"requestId"\s*:\s*"([^"]+)"/.exec(typeof result.output === "string" ? result.output : JSON.stringify(result.output) ?? "")?.[1];
  expect(typeof requestId, "the work receipt names its request").toBe("string");
  const taskId = await workTaskIdOfCall(cursor, handle, "b1-delegate", "the b1 forward");
  expect(JSON.stringify(result.output)).not.toContain(CHILD_ANSWER);
  expect(taskResultsInPrompt(resumed.messages)).toEqual([]);

  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the child's own model call" });
  await waitFor(() => (handle.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");
  const childSessionId = String(handle.requests.find((r) => r.role === "child")!.sessionId);

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the worker's result" });
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(resumed.turnId);
  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }

  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_settled"])).find((r) => r.detail?.task === taskId),
    "the delegation.task_settled row for this task",
  );
  const mine = await rowsSinceCursor(cursor, ["taint.forward", "delegation.task_started", "delegation.task_settled"]);

  expect(mine.filter((r) => r.action === "taint.forward").map((r) => ({ leg: r.detail?.leg, session: r.detail?.session }))).toEqual([]);

  const started = mine.filter((r) => r.action === "delegation.task_started");
  expect(started.length).toBe(1);
  expect(started[0].detail?.task).toBe(taskId);
  expect(started[0].detail?.request).toBe(requestId);
  expect(typeof started[0].detail?.call).toBe("string");
  expect(typeof started[0].detail?.session).toBe("string");
  expect(started[0].detail?.session).not.toBe(resumed.sessionId);
  expect(started[0].detail?.continuation).toBe(false);
  expect(JSON.stringify(started[0].detail)).not.toContain("count to three");
  expect(JSON.stringify(started[0].detail)).not.toContain(CHILD_ANSWER);

  const settledRows = mine.filter((r) => r.action === "delegation.task_settled");
  expect(settledRows.length).toBe(1);
  expect(settledRows[0].detail?.task).toBe(taskId);
  expect(settledRows[0].detail?.agent).toBe(childSessionId);
  expect(settledRows[0].detail?.marker).toBe("clean");
  expect(settledRows[0].detail?.adopted).toBe(false);
  expect(JSON.stringify(settledRows[0].detail)).not.toContain(CHILD_ANSWER);
});
