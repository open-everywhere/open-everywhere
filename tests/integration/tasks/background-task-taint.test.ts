import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  sleep,
  waitFor,
  type ScriptedHandle,
} from "../harness";

let live: ScriptedHandle | undefined;
afterAll(() => {
  live?.dispose();
  live = undefined;
});

const CHILD_ANSWER = "the child answered, and read nothing untrusted";

test("a clean delegation taints nothing — a parked receipt is not a settlement", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" } });
  expect(settings.getSettings().taint.mode).toBe("on");

  const handle = (live = registerScript({
    parent: [{ calls: [{ tool: "agent", input: { message: "count to three" }, id: "b1-delegate" }] }, { say: "dispatched" }],
    child: [{ say: CHILD_ANSWER }],
  }));

  const wakeAt = Date.now();
  const sinceIso = new Date(wakeAt - 1_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate this" });

  const resumed = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation result",
  );
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const result = resumed.toolResults.find((t) => t.name === "agent")!;
  expect(result.isError).toBe(false);

  await waitFor(() => handle.requests.find((r) => r.role === "child"), "the child's own model call");

  const output = result.output as { taskId?: unknown; status?: unknown; agentId?: unknown };
  expect(typeof output?.taskId).toBe("string");

  expect(String(output.taskId)).toMatch(/^task_/);
  expect(output.status).toBe("working");
  expect(String(output.agentId)).toMatch(/^ag_/);
  expect(JSON.stringify(result.output)).not.toContain(CHILD_ANSWER);

  handle.dispose();
  live = registerScript({ parent: [{ say: "noted" }], child: [{ say: "noted" }] });
  await sleep(8_000);

  const rows = await readAuditRows({
    actions: ["taint.forward", "delegation.task_started", "delegation.task_settled"],
    sinceIso,
  });
  const mine = rows.filter((r) => new Date(r.ts).getTime() >= wakeAt);

  expect(mine.filter((r) => r.action === "taint.forward").map((r) => ({ leg: r.detail?.leg, session: r.detail?.session }))).toEqual([]);

  const started = mine.filter((r) => r.action === "delegation.task_started");
  expect(started.length).toBe(1);
  expect(started[0].detail?.task).toBe(output.taskId);
  expect(started[0].detail?.agent).toBe(output.agentId);
  expect(started[0].detail?.session).toBe(resumed.sessionId);
  expect(started[0].detail?.continuation).toBe(false);
  expect(JSON.stringify(started[0].detail)).not.toContain("count to three");
  expect(JSON.stringify(started[0].detail)).not.toContain(CHILD_ANSWER);

  const settledRows = mine.filter((r) => r.action === "delegation.task_settled");
  expect(settledRows.length).toBe(1);
  expect(settledRows[0].detail?.task).toBe(output.taskId);
  expect(settledRows[0].detail?.agent).toBe(output.agentId);
  expect(settledRows[0].detail?.marker).toBe("clean");
  expect(settledRows[0].detail?.adopted).toBe(false);
  expect(JSON.stringify(settledRows[0].detail)).not.toContain(CHILD_ANSWER);
});
