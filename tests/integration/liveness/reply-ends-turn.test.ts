import { afterAll, expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  sleep,
  waitFor,
  waitForChildren,
  type RecordedRequest,
} from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";

const discord = installDiscordWebApiStub({ captureMessages: true });

function egressSpoof(on: boolean): void {
  if (on) process.env.OE_EGRESS_SPOOF = "1";
  else delete process.env.OE_EGRESS_SPOOF;
}

afterAll(() => {
  discord.uninstall();
  egressSpoof(true);
});

const TURN_FAILED_ACTION = "unified.supervisor_turn_failed";

function firstTurnRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  const parent = requests.filter((r) => r.role === "parent");
  const turnId = parent[0]?.turnId;
  return parent.filter((r) => r.turnId === turnId);
}

function trail(requests: readonly RecordedRequest[]): string {
  return JSON.stringify(
    requests.map((r) => ({ role: r.role, turn: r.turnId, step: r.stepIndex, reissue: r.emptyReissue === true, results: r.toolResults.map((t) => `${t.id}:${t.isError ? "err" : "ok"}`), fault: r.fault })),
  );
}

async function settle(): Promise<void> {
  await awaitWindowQuiet();
  await sleep(1_500);
}

test("a successful reply ends the turn — eve makes no further model call", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        seatReply("the whole answer", "ends-turn-reply"),
        { say: "a step the turn must never request" },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> one quick question" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.post"])).at(0), "the reply's own reply.post row");
  await settle();

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const turn = firstTurnRequests(handle.requests);
  expect(handle.requests.flatMap((r) => r.toolResults).some((t) => t.id === "ends-turn-reply"), trail(handle.requests)).toBe(false);
  expect(turn.map((r) => r.stepIndex), `one model call: the reply step, and nothing after it — ${trail(handle.requests)}`).toEqual([0]);
  expect(await rowsSinceCursor(cursor, [TURN_FAILED_ACTION])).toEqual([]);
});

test("negative control: a react does not end the turn, so the next model call is made", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "react", input: { emoji: "eyes" }, id: "control-react" }] },
        { calls: [{ tool: "no_reply", input: { reason: "reacted_instead" }, id: "control-no-reply" }] },
        { say: "a step the turn must never request" },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> nice work, thanks" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), "the closing no_reply's observed row", 120_000).catch((err: unknown) => {
    throw new Error(`${String(err)} — trail: ${trail(handle.requests)}`);
  });
  await settle();

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const react = handle.requests.flatMap((r) => r.toolResults).find((t) => t.id === "control-react");
  expect(react?.isError ?? true).toBe(false);
  expect(firstTurnRequests(handle.requests).map((r) => r.stepIndex)).toEqual([0, 1]);
});

test("negative control: a REFUSED reply does not end the turn — eve never ends on a failed call", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "reply", input: { wake: "wake-that-never-existed-2252", text: "misaddressed" }, id: "refused-reply" }] },
        { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "after-refusal" }] },
        { say: "a step the turn must never request" },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> are you there" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), "the closing no_reply's observed row", 120_000).catch((err: unknown) => {
    throw new Error(`${String(err)} — trail: ${trail(handle.requests)}`);
  });
  await settle();

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const refused = handle.requests.flatMap((r) => r.toolResults).find((t) => t.id === "refused-reply");
  expect(refused?.isError).toBe(true);
  expect(firstTurnRequests(handle.requests).map((r) => r.stepIndex)).toEqual([0, 1]);
});

test("an EMPTY step takes eve's own reissue, and a reissue that answers ends the turn without turn.failed", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        { onEmptyReissue: { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "reissue-no-reply" }] } },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> fyi the build is green" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), "the reissued step's no_reply", 120_000).catch((err: unknown) => {
    throw new Error(`${String(err)} — trail: ${trail(handle.requests)}`);
  });
  await settle();

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const turn = firstTurnRequests(handle.requests);
  expect(turn.map((r) => [r.stepIndex, r.emptyReissue === true])).toEqual([
    [0, false],
    [0, true],
  ]);
  expect(await rowsSinceCursor(cursor, [TURN_FAILED_ACTION]), "native recovery ended the turn cleanly").toEqual([]);
});

test("negative control: a reissue that is empty again DOES fail the turn", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(registerScript({ parent: [{}] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> fyi the deploy finished" });
  const failed = await waitFor(async () => (await rowsSinceCursor(cursor, [TURN_FAILED_ACTION])).at(0), "the unified seat's turn-failed row");
  expect(failed.action).toBe(TURN_FAILED_ACTION);
  expect(firstTurnRequests(handle.requests).some((r) => r.emptyReissue === true), trail(handle.requests)).toBe(true);
  await settle();
});

test("text the seat writes before a wait does not post; only the reply tool posts", async () => {
  await bootAgent();
  egressSpoof(false);
  try {
    const PRE_WAIT = "PRE-WAIT narration 2252: let me check with a worker";
    const ANSWER = "ANSWER 2252: the worker found the figure";
    const cursor = await auditCursor();
    const before = discord.messages.length;
    const handle = disposeLater(
      registerScript({
        parent: [
          { calls: [{ tool: "work", input: { message: "find the figure for ope-2252" }, id: "prewait-delegate" }] },
          { say: PRE_WAIT },
        ],
        child: [{ delayMs: 120_000, say: "the figure is 42" }],
      }),
    );
    await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> what is the figure" });
    await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the pre-wait step");
    const answer = disposeLater(armSettlement(handle, { parent: [seatReply(ANSWER, "prewait-reply")] }));
    handle.releaseHolds();
    await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the worker's one step" });
    await waitFor(() => discord.messages.slice(before).find((m) => m.content.includes(ANSWER)), "the reply on the Discord wire");
    await settle();

    expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(answer.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    const replyStep = answer.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === "prewait-delegate") && r.messages.some((m) => m.text.includes(PRE_WAIT)));
    expect(replyStep, "the pre-wait text is in the seat's own history").toBeDefined();

    const posted = discord.messages.slice(before).map((m) => m.content);
    expect(posted.filter((c) => c.includes(ANSWER)), "the reply tool posted exactly once").toHaveLength(1);
    expect(posted.filter((c) => c.includes(PRE_WAIT)), "the pre-wait text reached NO channel").toEqual([]);
    const posts = await rowsSinceCursor(cursor, ["reply.post"]);
    expect(posts, "one reply.post row: the tool is the only delivery").toHaveLength(1);
    expect(await rowsSinceCursor(cursor, ["unified.turn.redrive"]), "no corrective re-drive for pre-wait text").toEqual([]);
  } finally {
    egressSpoof(true);
  }
});
