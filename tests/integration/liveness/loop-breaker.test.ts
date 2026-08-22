import { expect, test } from "vitest";
import {
  afterThisTest,
  disposeLater,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  wrapToolExecute,
} from "../harness";

const READER = "read_notion_page";
const FIXED_MESSAGE_TEXT = "nothing new in the doc";
const NUDGE_MARKER = "LOOP BREAKER";

function readChannelCall(id: string): { tool: string; input: unknown; id: string } {
  return { tool: READER, input: { page: "11111111-2222-3333-4444-555555555555" }, id };
}

test("a worker's identical read repeats trip the loop breaker within a turn, and a RESUMED turn starts fresh", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  afterThisTest(
    wrapToolExecute(READER, async () => ({
      page: "11111111-2222-3333-4444-555555555555",
      blocks: 1,
      truncated: false,
      text: FIXED_MESSAGE_TEXT,
    })),
  );

  const asking = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "read the doc a few times and ask if unsure" }, id: "lb-delegate" }] }, { say: "handing this off" }],
      child: [
        { calls: [readChannelCall("lb-read-1")] },
        { calls: [readChannelCall("lb-read-2")] },
        { calls: [readChannelCall("lb-read-3")] },
        {
          calls: [
            {
              tool: "ask_question",
              input: { prompt: "the channel looks quiet three times running — should I stop checking?", options: [{ id: "stop", label: "Stop checking" }, { id: "keep", label: "Keep checking" }] },
              id: "lb-ask",
            },
          ],
        },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> keep reading the channel until something changes" });

  await waitFor(
    () => asking.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation receipt",
  );
  const taskId = taskIdOfDelegation(asking, "the loop-breaker probe delegation");

  const childRoster = await waitFor(() => asking.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's own first model call");
  expect(childRoster.tools).toContain(READER);
  expect(childRoster.tools).toContain("ask_question");

  const stepAfterThird = await waitFor(
    () => asking.requests.find((r) => r.role === "child" && r.stepIndex === 3),
    "the worker's fourth call (step 3) — its prompt carries the third read's result",
  );
  expect(asking.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const thirdReadCarriers = stepAfterThird.messages.filter((m) => m.text.includes(FIXED_MESSAGE_TEXT));
  expect(thirdReadCarriers.length, "no prompt message carried the third read's body").toBeGreaterThan(0);
  const thirdReadCarrier = thirdReadCarriers[thirdReadCarriers.length - 1]!;
  expect(thirdReadCarrier.text).toContain(NUDGE_MARKER);

  const bridged = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["turn.question_bridged"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "the question bridge's turn.question_bridged row — the worker parked on ask_question");
  expect(String(bridged[0]!.detail?.requestId ?? "").startsWith(`${taskId}:`)).toBe(true);

  asking.dispose();
  const answering = disposeLater(
    registerScript({
      parent: [{ say: "acknowledged" }],
      child: [{ calls: [readChannelCall("lb-read-4")] }, { say: "checked once more, still quiet" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> stop checking" });

  const routed = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["input_response.routed"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "the input_response.routed row — the room's message delivered as the answer");
  expect(routed[0]!.detail?.taskId).toBe(taskId);

  const resumedNext = await waitFor(
    () => answering.requests.find((r) => r.role === "child" && r.stepIndex === 1),
    "the resumed worker's step after its fourth (post-reset) read",
  );
  expect(answering.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const fourthReadCarriers = resumedNext.messages.filter((m) => m.text.includes(FIXED_MESSAGE_TEXT));
  expect(fourthReadCarriers.length, "no prompt message carried the fourth (resumed-turn) read's body").toBeGreaterThan(0);
  const fourthReadCarrier = fourthReadCarriers[fourthReadCarriers.length - 1]!;

  expect(fourthReadCarrier.text).not.toContain(NUDGE_MARKER);
});
