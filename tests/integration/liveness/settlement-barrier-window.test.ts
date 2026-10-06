import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  BARRIER_QUIET_MS,
  BARRIER_QUIET_UNDISPATCHED_MS,
  DISCORD_LISTED_CHANNEL_ID,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  lastBarrierSpend,
  registerScript,
  seatReply,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";

test("① an ordinary seat turn, answered through the reply tool — the floor the next test is measured from", async () => {
  await bootAgent();
  const seat = disposeLater(registerScript({ parent: [seatReply("ope2265 ack", "ope2265-reply-a")] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2265 a`, messageId: "ope2265-a" });
  const served = await waitFor(() => seat.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's own terminal (reply) step");
  expect(served.fault).toBeUndefined();
});

test("② a test that dispatches nothing and drives no turn", () => {
  const first = lastBarrierSpend();
  expect(first, "the fork's first barrier left no record — see harness.ts drainOutstandingSettlements").toBeDefined();
  expect(first!.dispatched, "① answered through the reply tool and ended by the reply step (native `endsTurn`), so nothing is owed to it").toBe(false);
  expect(first!.window, "the boot seed gives the FIRST barrier a real floor — without it this reads 'full'").toBe("fast");
});

test("③ …so the barrier after it took the SHORT window", () => {
  const spend = lastBarrierSpend();
  expect(spend, "the barrier after ② left no record — see harness.ts drainOutstandingSettlements").toBeDefined();
  expect(spend!.dispatched, "② left no worker and no unanswered drop, so nothing is owed to it").toBe(false);
  expect(spend!.window).toBe("fast");
  expect(spend!.ms).toBeLessThan(BARRIER_QUIET_MS);
  expect(spend!.polls).toBeGreaterThanOrEqual(2);
  expect(spend!.rows).toBe(0);
  expect(BARRIER_QUIET_UNDISPATCHED_MS).toBeLessThan(BARRIER_QUIET_MS);
});

test("④ a test that dispatches a real worker leaves a worker dispatched in its slice", async () => {
  const cursor = await auditCursor();
  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "count the files in the repo" }, id: "ope2265-delegate" }] },
        { say: "handing this off" },
      ],
      child: [{ delayMs: 120_000, say: "there are twelve files" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2265 delegate`, messageId: "ope2265-d" });
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's step that read the receipt");
  const taskId = await workTaskIdOfCall(cursor, dispatched, "ope2265-delegate", "ope2265's forward receipt");
  const settlement = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker to serve its whole arm" });
  dispatched.releaseHolds();
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "ope2265's seat step that read the worker's result" });
  expect(resultStep.fault).toBeUndefined();
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("⑤ …so the barrier after it paid the FULL window", () => {
  const spend = lastBarrierSpend();
  expect(spend, "the barrier after ④ left no record — see harness.ts drainOutstandingSettlements").toBeDefined();
  expect(spend!.dispatched, "④ dispatched a worker, so a turn was owed to it").toBe(true);
  expect(spend!.window).toBe("full");
  expect(spend!.ms).toBeGreaterThanOrEqual(BARRIER_QUIET_MS);
});
