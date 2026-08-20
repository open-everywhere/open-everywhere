import { expect, test } from "vitest";

import {
  afterThisTest,
  armSettlement,
  consumeSettlement,
  disposeLater,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  redeliveryRecoveryNote,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  toolSessionIdentity,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type ToolSessionIdentity,
} from "../harness";

test("two agent calls in one step start two workers that both run", async () => {
  await bootAgent();

  let workerToolCalls = 0;
  const workerIdentities: (ToolSessionIdentity | undefined)[] = [];
  const optionsBagKeys: string[][] = [];
  afterThisTest(
    wrapToolExecute("post_file", async (_input: unknown, options: unknown) => {
      workerToolCalls += 1;
      workerIdentities.push(toolSessionIdentity());
      optionsBagKeys.push(options !== null && typeof options === "object" ? Object.keys(options as object) : []);
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

  const terminalStep = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the dispatch turn's own terminal step — the earliest point the seat's session id is known",
  );
  const receipts = terminalStep.toolResults
    .filter((t) => t.name === "agent")
    .map((t) => (t.output as { taskId?: unknown } | undefined)?.taskId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const drain = receipts.length > 0 ? disposeLater(armSettlement(dispatched, SETTLEMENT_DRAIN_SCRIPT)) : undefined;

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

  expect(optionsBagKeys.length).toBeGreaterThanOrEqual(2);
  for (const keys of optionsBagKeys) {
    expect(keys).toContain("toolCallId");
    expect(keys).not.toContain("session");
  }

  const identities = workerIdentities.filter((i): i is ToolSessionIdentity => i !== undefined);
  expect(
    identities.length,
    `toolSessionIdentity() returned undefined for ${workerIdentities.length - identities.length} of ` +
      `${workerIdentities.length} worker tool calls — the harness reach into eve's context container ` +
      "is broken, not the product. Check harness.ts's sandboxIdentityKeyNames against eve's " +
      "context/keys.js and runtime/sessions/runtime-context-keys.js.",
  ).toBe(workerIdentities.length);
  expect(identities.length).toBeGreaterThanOrEqual(2);
  const seatSessionId = String(dispatchStep.sessionId);
  for (const worker of identities) {
    expect(worker.parentSessionId).toBe(seatSessionId);
    expect(worker.sessionId).not.toBe(seatSessionId);
    expect(worker.sandboxSessionId).toBe(seatSessionId);
    expect(worker.sandboxKey).toBe(seatSessionId);
    expect(worker.sandboxKey).not.toBe(worker.sessionId);
  }
  expect(new Set(identities.map((i) => i.sessionId)).size).toBeGreaterThanOrEqual(2);
  expect(new Set(identities.map((i) => i.sandboxKey)).size).toBe(1);

  if (drain !== undefined) {
    await consumeSettlement({
      armed: drain,
      dispatched,
      taskId: receipts[0]!,
      label: `the settled worker's completion wake for ${receipts[0]}`,
    });
    for (const taskId of receipts.slice(1)) {
      await waitFor(
        () => drain.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
        `the settled worker's completion wake for ${taskId}`,
      );
    }
    expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);

    const foreignTurns = dispatched.requests.filter((r) => r.role === "parent" && r.turnId !== terminalStep.turnId);
    expect(foreignTurns.map((r) => String(r.turnId))).toEqual([]);

    expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  }
});
