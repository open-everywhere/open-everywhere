import { expect, test } from "vitest";

import { __setStaleTurnParkMsForTest } from "../../../agent/model/scripted-model";

import {
  afterThisTest,
  disposeLater,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  auditCursor,
  waitFor,
  type ScriptedHandle,
} from "../harness";

async function serveTurnOne(tag: string): Promise<{ handle: ScriptedHandle; turnOneId: string }> {
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "react", input: { emoji: "eyes" }, id: `${tag}-react` }] },
        { calls: [{ tool: "no_reply", input: { reason: "reacted_instead" }, id: `${tag}-quiet` }] },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${tag} first message` });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), `turn 1 of ${tag} to end in silence`);
  const turnOneId = handle.requests.find((r) => r.role === "parent")?.turnId;
  expect(turnOneId).toBeDefined();
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  return { handle, turnOneId: String(turnOneId) };
}

test("a WILDCARD swap made by the same test serves the held later turn", async () => {
  await bootAgent();
  const { handle: first, turnOneId } = await serveTurnOne("ope777a");

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope777a second message" });

  const held = await waitFor(
    () => first.resolves.find((r) => r.role === "parent" && r.turnId !== turnOneId),
    "turn 2's model call to reach the still-registered turn-1 entry",
  );
  expect(held.fault).toBeUndefined();
  expect(first.requests.some((r) => r.turnId === held.turnId)).toBe(false);

  first.dispose();
  const second = disposeLater(registerScript({ parent: [{ calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope777a-second-quiet" }] }] }));

  const served = await waitFor(
    () => second.requests.find((r) => r.role === "parent" && r.turnId === held.turnId),
    "the held turn 2, served by the same test's WILDCARD swap",
    90_000,
  );
  expect(served.fault).toBeUndefined();
  expect(served.stepIndex).toBe(0);
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(second.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("an EXPIRED hold names itself in every later waitFor timeout", async () => {
  await bootAgent();

  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(/timed out after 500ms/);
  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.not.toThrow(/STALE-TURN HOLD/);

  __setStaleTurnParkMsForTest(1_000);
  afterThisTest(() => __setStaleTurnParkMsForTest(undefined));

  const { handle: first, turnOneId } = await serveTurnOne("ope629b");
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope629b second message" });
  const faulted = await waitFor(
    () => first.requests.find((r) => r.fault !== undefined && r.turnId !== turnOneId),
    "the held turn-2 call to give up and record its stale fault",
    60_000,
  );
  expect(faulted.fault).toContain("stale script");

  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(/STALE-TURN HOLD\(S\) EXPIRED/);
  await expect(waitFor<string>(() => undefined, "a thing that never arrives", 500)).rejects.toThrow(
    new RegExp(`held turn "${String(faulted.turnId)}"`),
  );
});
