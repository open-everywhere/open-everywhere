import { afterAll, expect, test } from "vitest";

import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";

const discord = installDiscordWebApiStub();

function egressSpoof(on: boolean): void {
  if (on) process.env.OE_EGRESS_SPOOF = "1";
  else delete process.env.OE_EGRESS_SPOOF;
}

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
  discord.uninstall();
  egressSpoof(true);
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}

const STOP_HAND_UNICODE = "✋";

function handCalls() {
  return discord.reactions.filter((r) => r.emoji === STOP_HAND_UNICODE);
}

test("a delegating turn puts the ✋ on its anchor message, and takes it off when the turn ends", async () => {
  await bootAgent();
  egressSpoof(false);

  const dispatched = open(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "ope-1188 do the long job" }, id: "ope1188-delegate" }] },
        { say: "handing this off" },
      ],
      child: [{ say: "the worker answered" }],
    }),
  );

  expect(handCalls()).toEqual([]);

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> start the long job",
    messageId: "ope1188-glyph-wake",
  });

  const placed = await waitFor(
    () => handCalls().find((r) => r.on),
    "the ✋ PUT — `placeStopHand` reaching the Discord REST call on the delegating turn",
  );
  expect(placed.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);

  const dispatch = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the parent's dispatching model call",
  );
  expect(dispatch.tools).toContain("agent");
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const removed = await waitFor(() => handCalls().find((r) => !r.on), "the ✋ DELETE — `removeStopHand` on the turn-ended arm");
  expect(removed.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(removed.messageId).toBe(placed.messageId);

  expect(handCalls().map((r) => r.on)).toEqual([true, false]);

  await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the dispatch turn's own terminal step to be served",
  );
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker to serve its arm" });
  const { handle: drain } = await awaitTaskSettlement({
    dispatched,
    taskId: taskIdOfDelegation(dispatched, "the OPE-1188 delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the settled worker's completion wake",
  });
  open(drain);
  expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  expect(handCalls().map((r) => r.on)).toEqual([true, false]);
});
