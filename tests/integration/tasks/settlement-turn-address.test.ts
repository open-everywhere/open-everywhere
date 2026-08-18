import { expect, test } from "vitest";

import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  sleep,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type RecordedRequest,
} from "../harness";

const CHILD_ANSWER = "the worker finished the addressed job";

const MADE_UP_WAKE = "wake-that-never-existed-0597";

const STEER = "task_peek";

function replyResultOf(request: RecordedRequest | undefined): { isError: boolean; text: string } | undefined {
  const results = request?.toolResults.filter((t) => t.name === "reply") ?? [];
  const result = results[results.length - 1];
  if (!result) return undefined;
  return { isError: result.isError, text: JSON.stringify(result.output) };
}

function disclosedTurnWake(text: string): string | undefined {
  return /delivered under is .([0-9a-f-]{36})./.exec(text)?.[1];
}

test("a settlement turn holds no address until it reads the task view, and task_peek gives it one", async () => {
  await bootAgent();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "do the long job" }, id: "t597-delegate" }] },
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "control" }, id: "t597-reply-ingressed" }] },
        { say: "handing this off" },
      ],
      child: [{ say: CHILD_ANSWER }],
    }),
  );

  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate the long job" });

  const resumed = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation result",
  );
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(resumed.toolResults.find((t) => t.name === "agent")!.isError).toBe(false);

  const dispatchStep = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(new Set(dispatchStep.tools).has("reply")).toBe(true);

  const output = resumed.toolResults.find((t) => t.name === "agent")!.output as { taskId?: unknown };
  const taskMode = typeof output?.taskId === "string";

  const ingressedReply = await waitFor(
    () => replyResultOf(dispatched.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "reply"))),
    "the dispatch turn's reply result",
  );
  expect(ingressedReply.isError).toBe(true);
  expect(ingressedReply.text).not.toContain(STEER);
  const dispatchWake = disclosedTurnWake(ingressedReply.text);
  expect(dispatchWake).toBeDefined();

  if (!taskMode) {
    expect(JSON.stringify(output)).toContain(CHILD_ANSWER);
    const before = dispatched.requests.length;
    await sleep(5_000);
    expect(dispatched.requests.length).toBe(before);
    return;
  }

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated child's last step" });
  const taskId = taskIdOfDelegation(dispatched, "t597-delegate");
  const dispatchedRequests: readonly RecordedRequest[] = [...dispatched.requests];

  const { handle: settlement } = await awaitTaskSettlement({
    dispatched,
    taskId,
    script: {
      parent: [
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "too early" }, id: "t597-reply-unread" }] },
        { calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "t597-peek" }] },
        { calls: [{ tool: "reply", input: { wake: MADE_UP_WAKE, text: "too late" }, id: "t597-reply-recovered" }] },
        { say: "the worker is done" },
      ],
    },
    label: "the settled worker's completion, delivered as a new message naming the task id",
  });
  disposeLater(settlement);

  const early = await waitFor(
    () => replyResultOf(settlement.requests.find((r) => r.role === "parent" && r.stepIndex === 1)),
    "the settlement turn's FIRST reply result — the call made before any task view",
  );
  expect(early.isError).toBe(true);
  expect(early.text).toContain(STEER);

  const peek = await waitFor(
    () => settlement.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_peek")),
    "the settlement turn's task_peek result",
  );
  const view = peek.toolResults.find((t) => t.name === "task_peek")!;
  expect(view.isError).toBe(false);
  expect(JSON.stringify(view.output)).toContain(CHILD_ANSWER);

  const recovered = await waitFor(
    () => replyResultOf(settlement.requests.find((r) => r.role === "parent" && r.stepIndex === 3)),
    "the settlement turn's SECOND reply result — the call made after the task view",
  );
  expect(recovered.isError).toBe(true);
  expect(recovered.text).not.toContain(STEER);
  const recoveredWake = disclosedTurnWake(recovered.text);
  expect(recoveredWake).toBeDefined();
  expect(recoveredWake).not.toBe(dispatchWake);

  await sleep(1_500);
  const refusals = await readAuditRows({ actions: ["reply.refused"], sinceIso });
  const reasons = refusals.map((r) => String(r.detail?.reason));
  expect(reasons.filter((r) => r === "task-wake-unread").length).toBe(1);
  expect(reasons.filter((r) => r === "mismatch").length).toBeGreaterThanOrEqual(2);

  const posts = await readAuditRows({ actions: ["reply.post"], sinceIso });
  const postWakes = [...new Set(posts.map((r) => String(r.detail?.wakeId)))].sort();
  expect(postWakes).toEqual([dispatchWake!, recoveredWake!].sort());

  expect(dispatchedRequests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
