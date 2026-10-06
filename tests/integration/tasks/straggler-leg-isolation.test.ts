import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
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
  wrapToolExecute,
  type SeatScript,
} from "../harness";

function legScript(tag: string, shape: "leg-1" | "leg-2"): SeatScript {
  const post = {
    calls: [
      {
        tool: "post_file",
        input: { files: [{ source: { path: `${tag}.txt` }, filename: `${tag}.txt` }], comment: "here it is" },
        id: `${tag}-post`,
      },
    ],
  };
  return {
    parent: [
      { calls: [{ tool: "work", input: { message: `write ${tag}.txt and post it here` }, id: `${tag}-delegate` }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child:
      shape === "leg-1"
        ? [post, { delayMs: 120_000, say: "posted the file" }]
        : [{ delayMs: 120_000, ...post }, { say: "posted the file" }],
  };
}

test("a settlement straggler from the previous leg is silenced, and the next leg still reaches its own step 0", async () => {
  await bootAgent();
  afterThisTest(wrapToolExecute("post_file", async () => ({ posted: true, count: 1 })));

  const legOne = disposeLater(registerScript(legScript("ope2240a", "leg-1")));
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> leg one, write a file and post it" });
  await waitFor(() => legOne.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "leg 1's receipt step to be served");
  await waitForChildren(legOne, { count: 1, lastStepIndex: 1, label: "leg 1's delegated worker to reach its held last step" });
  const legOneTurnId = legOne.requests.find((r) => r.role === "parent")?.turnId;
  expect(legOneTurnId, "leg 1's own dispatch turn must be on the record — every assertion below is relative to it").toBeDefined();
  const legOneTaskId = await workTaskIdOfCall(cursor, legOne, "ope2240a-delegate", "leg 1's forward");

  legOne.dispose();
  const legTwo = disposeLater(registerScript(legScript("ope2240b", "leg-2")));
  legOne.releaseHolds();
  expect(
    await waitFor(() => (legOne.holdsCutShort() === 1 ? true : undefined), "leg 1's worker hold to end on the release"),
  ).toBe(true);

  const silenced = await waitFor(
    () => legTwo.requests.find((r) => r.role === "parent" && r.foreignWakeSilence === true),
    "leg 1's straggler result wake to reach leg 2's script and be silenced by the OPE-2240 fence",
  );
  expect(silenced.fault, "the fence answers SILENCE, never a fault").toBeUndefined();
  expect(silenced.stepIndex, "a silenced straggler spends no script step").toBe(-1);
  expect(silenced.turnId, "the silenced step is leg 1's result wake, a turn of its own").not.toBe(legOneTurnId);
  expect(
    silenced.messages.some((m) => m.text.includes(`work-result-${legOneTaskId}`)),
    "the silenced step carries leg 1's result wake, so it is the straggler this test means",
  ).toBe(true);
  expect(
    silenced.messages.some((m) => m.text.includes("leg one, write a file and post it")),
    "the silenced step carries no leg-1 wake text, so it is not the straggler this test means",
  ).toBe(true);

  expect(legTwo.requests.filter((r) => r.stepIndex === 0), "the silenced straggler must have served NO step of leg 2's script").toEqual([]);

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> leg two, write a file and post it" });
  const legTwoCall = await waitFor(
    () => legTwo.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "leg 2's own turn to be served its own step 0",
  );
  expect(legTwoCall.foreignWakeSilence, "leg 2's own turn is not a straggler and must not be silenced").toBeUndefined();
  expect(legTwoCall.fault).toBeUndefined();
  expect(legTwoCall.turnId, "leg 2's own turn is a different turn from the straggler the fence silenced").not.toBe(silenced.turnId);
  expect(
    legTwoCall.messages.some((m) => m.text.includes("leg two, write a file and post it")),
    "the turn measured as leg 2's does not carry leg 2's own wake text — an earlier leg's turn was served this script",
  ).toBe(true);
  const legTwoReceipt = await waitFor(
    () => legTwo.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "leg 2's own receipt step to be served",
  );
  const legTwoSettlement = disposeLater(armSettlement(legTwo, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const legTwoTaskId = await workTaskIdOfCall(cursor, legTwo, "ope2240b-delegate", "leg 2's forward");
  legTwo.releaseHolds();
  await waitForChildren(legTwo, { count: 1, lastStepIndex: 1, label: "leg 2's OWN delegated worker to serve its whole arm" });
  expect(legTwoTaskId).not.toBe(legOneTaskId);
  const legTwoResult = await awaitWorkResult({ handle: legTwoSettlement, taskId: legTwoTaskId, label: "leg 2's own result wake" });
  expect(legTwoResult.stepIndex).toBe(0);
  expect(legTwoResult.foreignWakeSilence).toBeUndefined();
  expect(legTwoResult.turnId).not.toBe(legTwoReceipt.turnId);
  for (const h of [legTwo, legTwoSettlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
});
