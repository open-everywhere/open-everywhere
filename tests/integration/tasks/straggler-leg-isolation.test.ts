import { expect, test } from "vitest";

import {
  afterThisTest,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type SeatScript,
} from "../harness";

function legScript(tag: string): SeatScript {
  return {
    parent: [
      { calls: [{ tool: "agent", input: { message: `write ${tag}.txt and post it here` }, id: `${tag}-delegate` }] },
      { say: "NO_REPLY" },
    ],
    child: [
      {
        calls: [
          {
            tool: "post_file",
            input: { files: [{ source: { path: `${tag}.txt` }, filename: `${tag}.txt` }], comment: "here it is" },
            id: `${tag}-post`,
          },
        ],
      },
      { say: "posted the file" },
    ],
  };
}

test("a settlement straggler from the previous leg is silenced, and the next leg still reaches its own step 0", async () => {
  await bootAgent();
  afterThisTest(wrapToolExecute("post_file", async () => ({ posted: true, count: 1 })));

  const legOne = disposeLater(registerScript(legScript("ope2240a")));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> leg one, write a file and post it" });
  await waitForChildren(legOne, { count: 1, lastStepIndex: 1, label: "leg 1's delegated worker to serve its whole arm" });
  const legOneTurnId = legOne.requests.find((r) => r.role === "parent")?.turnId;
  expect(legOneTurnId, "leg 1's own dispatch turn must be on the record — every assertion below is relative to it").toBeDefined();
  taskIdOfDelegation(legOne, "leg 1's delegation");

  legOne.dispose();
  const legTwo = disposeLater(registerScript(legScript("ope2240b")));

  const silenced = await waitFor(
    () => legTwo.requests.find((r) => r.role === "parent" && r.foreignWakeSilence === true),
    "leg 1's straggler turn to reach leg 2's script and be silenced by the OPE-2240 fence",
  );
  expect(silenced.fault, "the fence answers SILENCE, never a fault").toBeUndefined();
  expect(silenced.stepIndex, "a silenced straggler spends no script step").toBe(-1);
  expect(silenced.turnId, "the silenced turn is a DIFFERENT turn from leg 1's own dispatch turn").not.toBe(legOneTurnId);
  expect(
    silenced.messages.some((m) => m.text.includes("leg one, write a file and post it")),
    "the silenced turn carries no leg-1 wake text, so it is not the straggler this test means",
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
  await waitForChildren(legTwo, { count: 1, lastStepIndex: 1, label: "leg 2's OWN delegated worker to serve its whole arm" });
});
