import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  slackDmWake,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
} from "../harness";

const OPERATOR_ID = "U0EXOWNER";

const DM_CHANNEL_ID = "D0OPE1751DMSEAT";

const CHILD_ANSWER = "ope1751 the worker finished its arm";

test("a DM seat's delegated worker settles completed, with no delegation.task_failed row", async () => {
  await bootAgent();

  const cursor = await auditCursor();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "ope1751 look this up for me" }, id: "ope1751-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, say: CHILD_ANSWER }],
    }),
  );

  const ts = slackTs(Date.now(), 175_100);
  const res = await slackDmWake({
    channelId: DM_CHANNEL_ID,
    userId: OPERATOR_ID,
    text: "ope1751 please look this up",
    ts,
    eventId: `EvOPE1751${ts.replace(".", "")}`,
  });
  expect(res.status, `the DM wake POST was not accepted at all — a signature or route failure: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the DM seat's forwarding turn to serve its own terminal step");

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the DM seat's delegated worker to serve its arm" });
  const taskId = await workTaskIdOfCall(cursor, dispatched, "ope1751-delegate", "the OPE-1751 DM forward");
  const closing = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  dispatched.releaseHolds();

  expect(dispatched.requests.filter((r) => r.fault !== undefined), "the scripted model faulted on the DM seat's own handle").toEqual([]);
  const resultStep = await awaitWorkResult({ handle: closing, taskId, label: "the DM seat's step that read the worker's result" });
  expect(resultStep.fault).toBeUndefined();
  expect(closing.requests.filter((r) => r.fault !== undefined), "the scripted model faulted on the DM seat's result turn").toEqual([]);

  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((r) => r.detail?.task === taskId),
    "the DM seat's delegation.task_started row",
  );
  const settled = await waitFor(
    async () => {
      const rows = (await rowsSinceCursor(cursor, ["delegation.task_settled"])).filter((r) => r.detail?.task === taskId);
      return rows.length > 0 ? rows : undefined;
    },
    "the DM seat's delegation.task_settled row",
  );

  const failures = await rowsSinceCursor(cursor, ["delegation.task_failed"]);
  expect(
    failures.map((r) => ({ task: r.detail?.task, errorClass: r.detail?.errorClass, error: r.detail?.error, outcome: r.detail?.outcome })),
    "🔴 the DM seat's delegated worker DIED — this is the two live runs shape (SUBAGENT_EXECUTION_FAILED)",
  ).toEqual([]);

  expect([...new Set(settled.map((r) => r.detail?.status))], "the settlement edge wrote a completed row and nothing else").toEqual(["completed"]);

  expect(Object.keys(settled[0]!.detail ?? {}).sort()).toEqual(["adopted", "agent", "kinds", "marker", "session", "status", "task"]);
});
