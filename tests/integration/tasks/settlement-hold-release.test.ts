import { expect, test } from "vitest";

import { __setStaleTurnParkMsForTest } from "../../../agent/model/scripted-model";

import {
  afterThisTest,
  disposeLater,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type ScriptedHandle,
  type SeatScript,
} from "../harness";

function dispatchScript(tag: string): SeatScript {
  return {
    parent: [
      { calls: [{ tool: "agent", input: { message: `write ${tag}.txt and post it here` }, id: `${tag}-delegate` }] },
      { say: "handing this off" },
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

async function dispatchOneWorker(tag: string): Promise<{ handle: ScriptedHandle; dispatchTurnId: string | undefined }> {
  const dispatched = disposeLater(registerScript(dispatchScript(tag)));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });
  const dispatchTurnId = dispatched.requests.find((r) => r.role === "parent")?.turnId;
  expect(dispatchTurnId).toBeDefined();
  return { handle: dispatched, dispatchTurnId };
}

test("a WILDCARD swap made by the same test serves the held settlement turn", async () => {
  await bootAgent();
  afterThisTest(wrapToolExecute("post_file", async () => ({ posted: true, count: 1 })));

  const { handle: dispatched, dispatchTurnId } = await dispatchOneWorker("ope777a");

  const held = await waitFor(
    () => dispatched.resolves.find((r) => r.role === "parent" && r.turnId !== dispatchTurnId),
    "the settlement turn's model call to reach the still-registered dispatch entry",
  );
  expect(held.fault).toBeUndefined();
  expect(dispatched.requests.some((r) => r.turnId === held.turnId)).toBe(false);

  const taskId = taskIdOfDelegation(dispatched, "the OPE-777 delegation");

  dispatched.dispose();
  const settlement = disposeLater(registerScript({ parent: [{ say: "acknowledged" }] }));

  const notification = await waitFor(
    () => settlement.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
    "the settled worker's completion, served by the same test's WILDCARD swap",
    90_000,
  );
  expect(notification.fault).toBeUndefined();
  expect(notification.role).toBe("parent");
  expect(notification.stepIndex).toBe(0);
  expect(notification.turnId).toBe(held.turnId);
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("an EXPIRED hold names itself in every later waitFor timeout", async () => {
  await bootAgent();
  afterThisTest(wrapToolExecute("post_file", async () => ({ posted: true, count: 1 })));

  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(/timed out after 500ms/);
  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.not.toThrow(/STALE-TURN HOLD/);

  __setStaleTurnParkMsForTest(1_000);
  afterThisTest(() => __setStaleTurnParkMsForTest(undefined));

  const { handle: dispatched, dispatchTurnId } = await dispatchOneWorker("ope629b");
  const faulted = await waitFor(
    () => dispatched.requests.find((r) => r.fault !== undefined && r.turnId !== dispatchTurnId),
    "the held settlement call to give up and record its stale fault",
    60_000,
  );
  expect(faulted.fault).toContain("stale script");

  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(/STALE-TURN HOLD\(S\) EXPIRED/);
  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(
    new RegExp(`held turn "${String(faulted.turnId)}"`),
  );
});
