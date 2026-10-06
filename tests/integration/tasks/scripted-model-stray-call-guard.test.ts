import { expect, test } from "vitest";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type ScriptedHandle,
  type SeatScript,
} from "../harness";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

async function dispatchOneWorker(tag: string, afterResult: readonly SeatScript["parent"][number][]): Promise<{ dispatched: ScriptedHandle; resultTurn: ScriptedHandle; taskId: string }> {
  const cursor = await auditCursor();
  const dispatched = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: `do the ${tag} thing` }, id: `${tag}-delegate` }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, say: "done" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${tag}, please` });
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `the ${tag} dispatch turn's own terminal step to be served`);
  const taskId = await workTaskIdOfCall(cursor, dispatched, `${tag}-delegate`, `the ${tag} forward receipt`);
  const resultTurn = disposeLater(armSettlement(dispatched, { parent: [...afterResult] }));
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: `the ${tag} delegated worker's own step` });
  return { dispatched, resultTurn, taskId };
}

test("OPE-995 — a session's own straggler is faulted, never served from the next registration's script", async () => {
  await bootAgent();

  const { dispatched, resultTurn, taskId } = await dispatchOneWorker("ope995a", [
    { calls: [{ tool: "react", input: { emoji: "eyes" }, id: "ope995-peek" }], delayMs: 60_000 },
    { say: "noted" },
  ]);
  afterThisTest(() => resultTurn.releaseHolds());

  const resultStep = await awaitWorkResult({
    handle: resultTurn,
    taskId,
    label: "the step that read the worker's result (held open by delayMs)",
  });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.stepIndex).toBe(0);
  const sessionId = resultStep.sessionId;
  expect(sessionId).toBeDefined();

  dispatched.dispose();
  resultTurn.dispose();

  const next = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "react", input: { emoji: "eyes" }, id: "next-peek" }] }, { say: "next done" }],
    }),
  );

  resultTurn.releaseHolds();

  const strayFault = await waitFor(
    () => next.requests.find((r) => r.fault?.includes("OPE-995") === true),
    "the straggler to be faulted on the entry it fell through to, instead of silently served",
  );
  expect(strayFault.fault).toContain(`session "${String(sessionId)}"`);
  expect(strayFault.fault).toContain(String(resultStep.turnId));
  expect(strayFault.stepIndex).toBe(-1);

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> a brand new message" });
  const served = await waitFor(
    () => next.requests.find((r) => r.role === "parent" && r.stepIndex === 0 && r.fault === undefined),
    "next's own real wake to be served step 0 cleanly, unaffected by the earlier straggler",
  );
  expect(served.sessionId).toBe(sessionId);
  expect(served.turnId).not.toBe(resultStep.turnId);

  expect(next.requests.filter((r) => r.fault !== undefined)).toHaveLength(1);
});

test("OPE-995 negative control — a genuinely new wake on a reused session, with NO incomplete turn behind it, is unaffected", async () => {
  await bootAgent();

  const { dispatched, resultTurn, taskId } = await dispatchOneWorker("ope995c", [{ say: NO_REPLY_SENTINEL }]);
  const resultStep = await awaitWorkResult({ handle: resultTurn, taskId, label: "the step that read the worker's result" });
  expect(resultStep.fault).toBeUndefined();
  dispatched.dispose();
  resultTurn.dispose();

  const next = disposeLater(registerScript({ parent: [{ say: "clean" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> another new message" });

  const served = await waitFor(
    () => next.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the fresh registration's own wake to be served normally",
  );
  expect(served.fault).toBeUndefined();
  expect(next.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
