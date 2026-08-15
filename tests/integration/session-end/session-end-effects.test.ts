import { randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

const OBSERVATION_ACTION = "memory.observation";
const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

function observationKey(detail: Record<string, unknown> | undefined): string {
  const key = detail?.["key"];
  return typeof key === "string" ? key : "";
}

test("no session-end effect fires for a delegated worker that settles, nor for the seat that dispatched it", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const seatNonce = `seatask${randomBytes(4).toString("hex")}`;
  const workerNonce = `workertask${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: `${workerNonce} reconcile the quarterly ledger` }, id: "se-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "reconciled" }],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${seatNonce} reconcile the quarterly ledger`,
  });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const taskId = taskIdOfDelegation(handle, "the session-end delegation");
  const settlement = await awaitTaskSettlement({
    dispatched: handle,
    taskId,
    script: { parent: [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "se-peek" }] }, { say: "acknowledged" }] },
    label: "the worker's completion, delivered as a new message naming the task id",
  });
  perTest.push(() => settlement.handle.dispose());

  const peeked = await waitFor(
    () => settlement.handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_peek")),
    "the parent's step carrying the task_peek result — eve's own terminal view of the worker",
  );
  expect(peeked.toolResults.find((t) => t.name === "task_peek")!.isError).toBe(false);
  expect(settlement.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const seatFirst = handle.requests[0];
  expect(seatFirst.role).toBe("parent");
  expect(seatFirst.tools).toContain("agent");
  expect(seatFirst.messages.map((m) => m.text).join("\n")).toContain(seatNonce);
  const workerRequests = handle.requests.filter((r) => r.role === "child");
  expect(workerRequests.length).toBeGreaterThanOrEqual(1);
  expect(workerRequests[0].messages.map((m) => m.text).join("\n")).toContain(workerNonce);

  const rows = await waitFor(async () => {
    const found = await readAuditRows({ actions: [SETTLEMENT_FLUSH_ACTION, OBSERVATION_ACTION], sinceIso, limit: 100 });
    return found.some((r) => r.action === SETTLEMENT_FLUSH_ACTION) ? found : undefined;
  }, `a ${SETTLEMENT_FLUSH_ACTION} row for the settled task — control (b), that this reader sees rows written in this window`);

  const flushes = rows.filter((r) => r.action === SETTLEMENT_FLUSH_ACTION);
  expect(flushes.length).toBeGreaterThanOrEqual(1);
  expect(flushes.some((r) => r.detail?.["edge"] === "task-settled")).toBe(true);

  const observations = rows.filter((r) => r.action === OBSERVATION_ACTION);
  expect(observations).toEqual([]);
  for (const r of rows) expect(observationKey(r.detail)).not.toContain(workerNonce);
  for (const r of rows) expect(observationKey(r.detail)).not.toContain(seatNonce);
});
