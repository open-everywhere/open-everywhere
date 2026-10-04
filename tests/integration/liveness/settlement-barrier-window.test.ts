import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  BARRIER_QUIET_MS,
  BARRIER_QUIET_UNDISPATCHED_MS,
  DISCORD_LISTED_CHANNEL_ID,
  SETTLEMENT_DRAIN_SCRIPT,
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  disposeLater,
  lastBarrierSpend,
  registerScript,
  seatReply,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";

test("① an ordinary seat turn, answered through the reply tool — the floor the next test is measured from", async () => {
  await bootAgent();
  const seat = disposeLater(registerScript({ parent: [seatReply("ope2265 ack", "ope2265-reply-a"), { say: NO_REPLY_SENTINEL }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2265 a`, messageId: "ope2265-a" });
  const served = await waitFor(() => seat.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's own terminal step");
  expect(served.fault).toBeUndefined();
});

test("② a test that dispatches nothing and drives no turn", () => {
  const first = lastBarrierSpend();
  expect(first, "the fork's first barrier left no record — see harness.ts drainOutstandingSettlements").toBeDefined();
  expect(first!.dispatched, "① answered through the reply tool and ended in judged silence, so nothing is owed to it").toBe(false);
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

test("④ a test that dispatches a real worker leaves its settlement turn owed", async () => {
  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "count the files in the repo" }, id: "ope2265-delegate" }] },
        { say: "handing this off" },
      ],
      child: [{ say: "there are twelve files" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2265 delegate`, messageId: "ope2265-d" });
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker to serve its whole arm" });
  const taskId = taskIdOfDelegation(dispatched, "ope2265-delegate");
  const { handle } = await awaitTaskSettlement({ dispatched, taskId, script: SETTLEMENT_DRAIN_SCRIPT, label: "ope2265's settlement wake" });
  disposeLater(handle);
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("⑤ …so the barrier after it paid the FULL window", () => {
  const spend = lastBarrierSpend();
  expect(spend, "the barrier after ④ left no record — see harness.ts drainOutstandingSettlements").toBeDefined();
  expect(spend!.dispatched, "④ dispatched a worker, so a turn was owed to it").toBe(true);
  expect(spend!.window).toBe("full");
  expect(spend!.ms).toBeGreaterThanOrEqual(BARRIER_QUIET_MS);
});
