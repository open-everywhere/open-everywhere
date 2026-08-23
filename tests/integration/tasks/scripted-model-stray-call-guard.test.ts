import { expect, test } from "vitest";

import {
  afterThisTest,
  armSettlement,
  bootAgent,
  consumeSettlement,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

async function dispatchOneWorker(tag: string): Promise<{ dispatched: ScriptedHandle; taskId: string }> {
  const dispatched = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: `do the ${tag} thing` }, id: `${tag}-delegate` }] }, { say: "dispatched" }],
      child: [{ say: "done" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${tag}, please` });
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: `the ${tag} delegated worker's own step` });
  const taskId = taskIdOfDelegation(dispatched, `the ${tag} delegation`);
  return { dispatched, taskId };
}

test("OPE-995 — a session's own straggler is faulted, never served from the next registration's script", async () => {
  await bootAgent();

  const { dispatched, taskId } = await dispatchOneWorker("ope995a");

  const settlement = armSettlement(dispatched, {
    parent: [
      { calls: [{ tool: "task_cancel", input: { taskIds: [taskId] }, id: "ope995-peek" }], delayMs: 60_000 },
      { say: "noted" },
    ],
  });
  afterThisTest(() => settlement.releaseHolds());

  const notification = await consumeSettlement({
    armed: settlement,
    dispatched,
    taskId,
    label: "the settlement turn's own step 0 to arrive (held open by delayMs)",
  });
  expect(notification.fault).toBeUndefined();
  expect(notification.stepIndex).toBe(0);
  const sessionId = notification.sessionId;
  expect(sessionId).toBeDefined();

  settlement.dispose();

  const next = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "task_cancel", input: { taskIds: [taskId] }, id: "next-peek" }] }, { say: "next done" }],
    }),
  );

  settlement.releaseHolds();

  const strayFault = await waitFor(
    () => next.requests.find((r) => r.fault?.includes("OPE-995") === true),
    "the straggler to be faulted on the entry it fell through to, instead of silently served",
  );
  expect(strayFault.fault).toContain(`session "${String(sessionId)}"`);
  expect(strayFault.fault).toContain(String(notification.turnId));
  expect(strayFault.stepIndex).toBe(-1);

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> a brand new message" });
  const served = await waitFor(
    () => next.requests.find((r) => r.role === "parent" && r.stepIndex === 0 && r.fault === undefined),
    "next's own real wake to be served step 0 cleanly, unaffected by the earlier straggler",
  );
  expect(served.sessionId).toBe(sessionId);
  expect(served.turnId).not.toBe(notification.turnId);

  expect(next.requests.filter((r) => r.fault !== undefined)).toHaveLength(1);
});

test("OPE-995 negative control — a genuinely new wake on a reused session, with NO incomplete turn behind it, is unaffected", async () => {
  await bootAgent();

  const { dispatched, taskId } = await dispatchOneWorker("ope995c");
  const settlement = armSettlement(dispatched, { parent: [{ say: "acknowledged" }] });
  const notification = await consumeSettlement({
    armed: settlement,
    dispatched,
    taskId,
    label: "the settlement turn's own (single) step",
  });
  expect(notification.fault).toBeUndefined();
  settlement.dispose();

  const next = disposeLater(registerScript({ parent: [{ say: "clean" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> another new message" });

  const served = await waitFor(
    () => next.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the fresh registration's own wake to be served normally",
  );
  expect(served.fault).toBeUndefined();
  expect(next.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
