import { afterAll, afterEach, expect, test } from "vitest";

import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  redeliveryRecoveryNote,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type ScriptedHandle,
} from "../harness";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

test("two agent calls in one step start two workers that both run", async () => {
  await bootAgent();

  let workerToolCalls = 0;
  cleanups.push(
    wrapToolExecute("post_file", async () => {
      workerToolCalls += 1;
      return { posted: true, count: 1 };
    }),
  );

  const dispatched = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            { tool: "agent", input: { message: "worker ALPHA: work only inside ./alpha" }, id: "ope584-alpha" },
            { tool: "agent", input: { message: "worker BRAVO: work only inside ./bravo" }, id: "ope584-bravo" },
          ],
        },
        { say: "both workers are running" },
      ],
      child: [
        {
          calls: [
            {
              tool: "post_file",
              input: { files: [{ source: { path: "probe.txt" }, filename: "probe.txt" }], comment: "probe" },
              id: "ope584-probe",
            },
          ],
        },
        { say: "worker done" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> run two jobs at once" });

  await waitForChildren(dispatched, { count: 2, lastStepIndex: 1, label: "both delegated workers to serve their whole arm" });

  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const dispatchStep = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(dispatchStep.tools).toContain("agent");
  const delegations = dispatched.requests
    .filter((r) => r.role === "parent" && r.sessionId === dispatchStep.sessionId)
    .flatMap((r) => r.toolResults)
    .filter((t) => t.name === "agent");
  const delegationTaskIds = new Set(delegations.map((t) => String((t.output as { taskId?: unknown } | undefined)?.taskId)));
  expect(delegationTaskIds.has("undefined")).toBe(false);
  expect(delegationTaskIds.size).toBeGreaterThanOrEqual(2);
  if (delegationTaskIds.size > 2) {
    const note = redeliveryRecoveryNote();
    expect(
      note,
      `${delegationTaskIds.size} distinct delegation receipts on the seat's own session, but this ` +
        "fork observed no inline-step recovery to explain the excess — this looks like a real " +
        "double-dispatch defect, not the known OPE-582 redelivery artifact.",
    ).not.toBe("");
  }
  expect(delegations.filter((t) => t.isError)).toEqual([]);

  const workerSessions = new Set(dispatched.requests.filter((r) => r.role === "child").map((r) => String(r.sessionId)));
  expect(workerSessions.size).toBeGreaterThanOrEqual(2);
  if (workerSessions.size > 2) {
    const note = redeliveryRecoveryNote();
    expect(
      note,
      `${workerSessions.size} distinct worker sessions, but this fork observed no inline-step ` +
        "recovery to explain the excess — this looks like a real double-dispatch defect, not the " +
        "known OPE-582 redelivery artifact.",
    ).not.toBe("");
  }
  expect(workerSessions.has(String(dispatchStep.sessionId))).toBe(false);

  expect(workerToolCalls).toBeGreaterThanOrEqual(2);

  const receipts = delegations
    .map((t) => (t.output as { taskId?: unknown } | undefined)?.taskId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (receipts.length > 0) {
    const { handle: drain } = await awaitTaskSettlement({
      dispatched,
      taskId: receipts[0]!,
      script: SETTLEMENT_DRAIN_SCRIPT,
      label: `the settled worker's completion wake for ${receipts[0]}`,
    });
    perTest.push(() => drain.dispose());
    for (const taskId of receipts.slice(1)) {
      await waitFor(
        () => drain.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
        `the settled worker's completion wake for ${taskId}`,
      );
    }
    expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);

    expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  }
});
