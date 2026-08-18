import { expect, test } from "vitest";
import {
  afterThisTest,
  disposeLater,
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  wrapToolExecute,
} from "../harness";

test("a settlement turn that arrives before the script swap is held, then served by the swapped-in script", async () => {
  await bootAgent();
  afterThisTest(wrapToolExecute("post_file", async () => ({ posted: true, count: 1 })));

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "write race-probe.txt and post it here" }, id: "ope750-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        {
          calls: [
            {
              tool: "post_file",
              input: { files: [{ source: { path: "race-probe.txt" }, filename: "race-probe.txt" }], comment: "here it is" },
              id: "ope750-post",
            },
          ],
        },
        { say: "posted the file" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });

  const dispatchTurnId = dispatched.requests.find((r) => r.role === "parent")?.turnId;
  expect(dispatchTurnId).toBeDefined();

  const held = await waitFor(
    () => dispatched.resolves.find((r) => r.role === "parent" && r.turnId !== dispatchTurnId),
    "the settlement turn's model call to reach the still-registered dispatch entry",
  );
  expect(held.fault).toBeUndefined();
  expect(dispatched.requests.some((r) => r.turnId === held.turnId)).toBe(false);

  const taskId = taskIdOfDelegation(dispatched, "the OPE-750 delegation");
  const { handle: drain, notification } = await awaitTaskSettlement({
    dispatched,
    taskId,
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the settled worker's completion wake",
  });
  afterThisTest(() => drain.dispose());

  expect(dispatched.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  expect(notification.fault).toBeUndefined();
  expect(notification.role).toBe("parent");
  expect(notification.stepIndex).toBe(0);
  expect(notification.turnId).toBe(held.turnId);
  expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
