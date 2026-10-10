import { expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  WAKE_FROM_ENVELOPE,
  rowsSinceCursor,
  sleep,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type RecordedRequest,
} from "../harness";

const CHILD_ANSWER = "the worker finished the addressed job";

const MADE_UP_WAKE = "wake-that-never-existed-0597";

const NO_ADDRESS_COPY = "it has NO reply address";

function replyResultById(requests: readonly RecordedRequest[], callId: string): { isError: boolean; text: string } | undefined {
  for (const request of requests) {
    const result = request.toolResults.find((t) => t.id === callId && t.name === "reply");
    if (result !== undefined) return { isError: result.isError, text: JSON.stringify(result.output) };
  }
  return undefined;
}

function disclosedTurnWake(text: string): string | undefined {
  return /delivered under is .([0-9a-f-]{36})./.exec(text)?.[1];
}

test("after the worker's result, the seat's result-wake turn holds the address of the conversation that asked, and the settlement edge records it", async () => {
  await bootAgent();

  const cursor = await auditCursor();
  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "do the long job" }, id: "t597-delegate" }] },
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "control" }, id: "t597-reply-ingressed" }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: "handing this off", done: false }, id: "t597-dispatch-post" }] },
      ],
      child: [{ delayMs: 120_000, say: CHILD_ANSWER }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate the long job" });

  const ingressedReply = await waitFor(
    () => replyResultById(dispatched.requests, "t597-reply-ingressed"),
    "the dispatch turn's `t597-reply-ingressed` result",
  );
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(ingressedReply.isError).toBe(true);
  expect(ingressedReply.text).not.toContain(NO_ADDRESS_COPY);
  const dispatchWake = disclosedTurnWake(ingressedReply.text);
  expect(dispatchWake).toBeDefined();

  const dispatchStep = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(new Set(dispatchStep.tools).has("reply")).toBe(true);

  await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
    return rows.find((r) => r.detail?.chars === "handing this off".length);
  }, "the dispatch turn's hand-off note's reply.post row");
  const taskId = await workTaskIdOfCall(cursor, dispatched, "t597-delegate", "the t597 forward receipt");

  const resultWake = disposeLater(
    armSettlement(dispatched, {
      parent: [
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "too early" }, id: "t597-reply-unread" }] },
        { calls: [{ tool: "cancel_work", input: { taskId }, id: "t597-view" }] },
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "too late" }, id: "t597-reply-recovered" }] },
        { say: "NO_REPLY" },
      ],
    }),
  );
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker to enter its hold" });
  dispatched.releaseHolds();
  const resultStep = await awaitWorkResult({ handle: resultWake, taskId, label: "the seat step that read the worker's result" });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(dispatchStep.turnId);
  expect(replyResultById(resultWake.requests, "t597-dispatch-post")?.isError).toBe(false);

  const early = await waitFor(
    () => replyResultById(resultWake.requests, "t597-reply-unread"),
    "the result-wake turn's `t597-reply-unread` result — the call made before any task call",
  );
  expect(early.isError).toBe(true);
  expect(early.text).not.toContain(NO_ADDRESS_COPY);
  const earlyWake = disclosedTurnWake(early.text);
  expect(earlyWake).toBeDefined();
  expect(earlyWake, "the result-wake turn holds the dispatch delivery's wake — the 0.54 inheritance").not.toBe(dispatchWake);
  const resultWakeRow = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.result_wake"])).find((r) => r.detail?.taskId === taskId && r.detail?.outcome === "delivered"),
    "the work.result_wake row for this task",
  );
  expect(earlyWake).toBe(String(resultWakeRow.detail?.wakeId));
  expect(resultStep.messages.map((m) => m.text).join("\n")).toMatch(new RegExp(`^[ \\t]*for wake ${dispatchWake}$`, "m"));

  const viewStep = await waitFor(
    () => resultWake.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === "t597-view")),
    "the result-wake turn's cancel_work result",
  );
  const view = viewStep.toolResults.find((t) => t.id === "t597-view")!;
  expect(view.isError, `cancel_work was refused: ${JSON.stringify(view.output)}`).toBe(false);
  expect(JSON.stringify(view.output)).not.toContain("cannot be continued here");
  expect(JSON.stringify(view.output)).toContain(taskId);
  expect(resultWake.requests.some((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(CHILD_ANSWER)))).toBe(true);
  expect(JSON.stringify(view.output)).not.toContain(CHILD_ANSWER);

  const recovered = await waitFor(
    () => replyResultById(resultWake.requests, "t597-reply-recovered"),
    "the result-wake turn's `t597-reply-recovered` result — the call made after the task call",
  );
  expect(recovered.isError).toBe(true);
  expect(recovered.text).not.toContain(NO_ADDRESS_COPY);
  const recoveredWake = disclosedTurnWake(recovered.text);
  expect(recoveredWake).toBe(earlyWake);

  await sleep(1_500);
  const refusals = await rowsSinceCursor(cursor, ["reply.refused"]);
  const reasons = refusals.map((r) => String(r.detail?.reason));
  expect(reasons.filter((r) => r === "task-wake-unread").length).toBe(0);
  expect(reasons.filter((r) => r === "mismatch").length).toBeGreaterThanOrEqual(3);

  const posts = await rowsSinceCursor(cursor, ["reply.post"]);
  const postWakes = [...new Set(posts.map((r) => String(r.detail?.wakeId)))].sort();
  expect(postWakes).toEqual([dispatchWake!]);
  expect(posts).toHaveLength(1);
  expect(posts.map((r) => String(r.detail?.id)).filter((id) => !id.startsWith("spoof-unified-"))).toEqual([]);

  const wakeRows = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["unified.task_wake"])).filter((r) => String(r.detail?.task) === taskId);
    return rows.length > 0 ? rows : undefined;
  }, "the settlement edge's unified.task_wake row for this task");
  const outcomes = wakeRows.map((r) => String(r.detail?.outcome));
  expect(outcomes).toContain("ingressed");
  expect(outcomes).not.toContain("installed");

  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(resultWake.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(dispatched.requests.some((r) => r.role === "parent" && r.stepIndex < 0)).toBe(false);
});
