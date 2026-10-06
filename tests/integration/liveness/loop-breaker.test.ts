import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  waitFor,
  workTaskIdOfCall,
  wrapToolExecute,
} from "../harness";
const READER = "read_notion_page";
const FIXED_MESSAGE_TEXT = "nothing new in the doc";
const NUDGE_MARKER = "LOOP BREAKER";

function readChannelCall(id: string): { tool: string; input: unknown; id: string } {
  return { tool: READER, input: { page: "11111111-2222-3333-4444-555555555555" }, id };
}

test("a worker's identical read repeats trip the loop breaker within a turn, and the worker's NEXT turn starts fresh", async () => {
  await bootAgent();

  afterThisTest(
    wrapToolExecute(READER, async () => ({
      page: "11111111-2222-3333-4444-555555555555",
      blocks: 1,
      truncated: false,
      text: FIXED_MESSAGE_TEXT,
    })),
  );

  const cursor = await auditCursor();
  const opening = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "read the doc a few times" }, id: "lb-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        { delayMs: 120_000, calls: [readChannelCall("lb-read-1")] },
        { calls: [readChannelCall("lb-read-2")] },
        { calls: [readChannelCall("lb-read-3")] },
        { say: "read it three times, still quiet" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> keep reading the doc until something changes" });

  await waitFor(
    () => opening.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "work")),
    "the parent's resumed step carrying the forward receipt",
  );
  const firstResult = disposeLater(armSettlement(opening, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, opening, "lb-delegate", "the loop-breaker probe forward");
  opening.releaseHolds();

  const childRoster = await waitFor(() => opening.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's own first model call");
  expect(childRoster.tools).toContain(READER);
  const worker = String(childRoster.sessionId);

  const stepAfterThird = await waitFor(
    () => opening.requests.find((r) => r.role === "child" && r.stepIndex === 3),
    "the worker's fourth call (step 3) — its prompt carries the third read's result",
  );
  const thirdReadCarriers = stepAfterThird.messages.filter((m) => m.text.includes(FIXED_MESSAGE_TEXT));
  expect(thirdReadCarriers.length, "no prompt message carried the third read's body").toBeGreaterThan(0);
  const thirdReadCarrier = thirdReadCarriers[thirdReadCarriers.length - 1]!;
  expect(thirdReadCarrier.text).toContain(NUDGE_MARKER);

  const resultStep = await awaitWorkResult({ handle: firstResult, taskId, label: "the seat's step that read the worker's turn-1 result" });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.stepIndex).toBe(0);
  expect(opening.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(firstResult.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  firstResult.dispose();
  opening.dispose();

  const continuing = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "check the doc once more", taskId }, id: "lb-continue" }] },
        { say: "asked it to check again" },
      ],
    }),
  );
  const runTwo = disposeLater(
    registerScript({ parent: [], child: [{ delayMs: 120_000, calls: [readChannelCall("lb-read-4")] }, { say: "checked once more, still quiet" }] }, worker),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> check the doc once more" });
  await waitFor(() => continuing.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the continuing turn's receipt step");
  const secondResultWake = disposeLater(armSettlement(continuing, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  runTwo.releaseHolds();

  const resumedNext = await waitFor(
    () => runTwo.requests.find((r) => r.role === "child" && r.stepIndex === 1),
    "the worker's turn-2 step after its fourth read",
  );
  expect(resumedNext.sessionId).toBe(worker);
  expect(resumedNext.turnId).not.toBe(stepAfterThird.turnId);
  const fourthReadCarriers = resumedNext.messages.filter((m) => m.text.includes(FIXED_MESSAGE_TEXT));
  expect(fourthReadCarriers.length, "no prompt message carried the fourth (turn-2) read's body").toBeGreaterThan(0);
  const fourthReadCarrier = fourthReadCarriers[fourthReadCarriers.length - 1]!;

  expect(fourthReadCarrier.text).not.toContain(NUDGE_MARKER);

  const secondResult = await awaitWorkResult({ handle: secondResultWake, taskId, label: "the seat's step that read the worker's turn-2 result" });
  expect(secondResult.stepIndex).toBe(0);
  expect(secondResult.messages.some((m) => m.text.includes("checked once more, still quiet"))).toBe(true);
  expect(secondResult.fault).toBeUndefined();
  expect(continuing.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(secondResultWake.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(runTwo.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
