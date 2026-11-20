import { createHash, randomBytes } from "node:crypto";

const INJECT_TOKEN = "step-boundary-inject-token";
process.env.OE_CONTROL_INJECT_TOKENS = `it-step-boundary:${createHash("sha256").update(INJECT_TOKEN, "utf8").digest("hex")}`;

import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  WAKE_FROM_ENVELOPE,
  wrapToolExecute,
} from "./harness";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

test("a turn that runs past its step budget trips the soft and then the hard boundary, with one audit row per crossing", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 2, stepBackstopMultiple: 2 } });
  expect(settings.getSettings().turn.stepBudget).toBe(2);
  expect(settings.getSettings().turn.stepBackstopMultiple).toBe(2);
  afterThisTest(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "s1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s2" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s3" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s4" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s5" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s6" }] },
        { say: "should never be reached — the hard backstop ends the turn first" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> loop please" });

  const rows = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
    return found.length > 0 ? found : undefined;
  }, "at least one turn.step_boundary audit row");

  const byTier = new Map(rows.map((r) => [(r.detail ?? {}).tier as string, r]));
  expect(byTier.has("soft")).toBe(true);
  const soft = byTier.get("soft")!;
  expect(soft.detail?.steps).toBe(3);
  expect(soft.detail?.budget).toBe(2);
  expect(soft.detail?.backstop).toBe(4);

  const hard = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
    return found.find((r) => (r.detail ?? {}).tier === "hard");
  }, "a hard turn.step_boundary audit row");
  expect(hard.detail?.steps).toBe(5);
  expect(hard.detail?.budget).toBe(2);
  expect(hard.detail?.backstop).toBe(4);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests.some((r) => r.stepIndex >= 5)).toBe(false);
});

test("a turn that stays within budget never writes a turn.step_boundary row", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 50, stepBackstopMultiple: 3 } });
  afterThisTest(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "n1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "n2" }] },
        { say: "done, well within budget" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> short please" });

  await waitFor(() => handle.requests.find((r) => r.stepIndex === 2), "the parent's terminal step to be served");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await rowsSinceCursor(cursor, ["turn.step_boundary"]);
  expect(rows.filter((r) => r.surface === channelId)).toEqual([]);
});

test("a turn that closes its reply obligation ends at that step: a second no_reply arms the closeout, and no later step is requested", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } });
  expect(settings.getSettings().turn.stepBudget).toBe(120);
  const silenceAudit = await import("@open-everywhere/core/agent/audit/audit.js");
  silenceAudit.setSilenceAuditForTest(true);
  afterThisTest(() => silenceAudit.setSilenceAuditForTest(false));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            { tool: "no_reply", input: { reason: "not_relevant" }, id: "c1" },
            { tool: "no_reply", input: { reason: "not_relevant" }, id: "c2" },
            { tool: "list_routines", input: {}, id: "c1b" },
          ],
        },
        { calls: [{ tool: "list_routines", input: {}, id: "c3" }] },
        { say: "should never be reached — the turn ends at the step that closed the obligation" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> quiet please" });

  const redundant = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["reply.no_reply_redundant"])).filter((r) => r.surface === channelId);
    return found.at(0);
  }, "the second no_reply's reply.no_reply_redundant row (the call that arms the closeout)");
  expect(redundant.detail?.reason).toBe("not_relevant");
  await awaitWindowQuiet();

  const observed = (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).filter((r) => r.surface === channelId);
  expect(observed, "one silence row per turn").toHaveLength(1);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests.map((r) => r.stepIndex), "the turn ends at the closing step: no later model call").toEqual([0]);
  const boundary = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
  expect(boundary, "the turn ended natively, before the step budget or the closeout boundary had to act").toEqual([]);
});

test("a turn held on its own task keeps stepping after its no_reply: a refused reply arms the closeout, and the closeout boundary ends the turn", async () => {
  const { base } = await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } });
  expect(settings.getSettings().turn.stepBudget).toBe(120);
  settings.overrideSettingsForTest({ wake: { testWakeRoute: true } });
  afterThisTest(() => settings.overrideSettingsForTest({ wake: { testWakeRoute: false } }));
  expect(settings.getSettings().wake.testWakeRoute).toBe(true);

  // The turn must hold on the seat's OWN task, with a wake id that `no_reply` can decline. Under the
  // seat cut no real seat has both: a lean seat (standing, thread or DM) holds no declared subagent
  // and its `agent` verdict is never `allow`, and a wide seat or a worker has no wake id. So this test
  // drives a forged wake through the test-wake route: an unattended-fire stamp on a standing seat
  // makes the seat non-lean (`fireDelivery`), so it holds `fresh_eyes_review`, while the unified
  // window still stamps a wake id. The claim under test, the held-turn closeout, does not depend on
  // which seat holds the turn.
  const opener = registerScript({ parent: [{ calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "h-opener-silence" }] }, { say: NO_REPLY_SENTINEL }] });
  const openerCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> hello", userId: DISCORD_USER_ID });
  await waitFor(
    async () => (await rowsSinceCursor(openerCursor, ["reply.no_reply_observed"])).find((r) => r.detail?.reason === "nothing_to_add"),
    "the opener mention to open the listed channel's standing seat",
  );
  await awaitWindowQuiet();
  opener.dispose();

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "fresh_eyes_review", input: { message: "look up the figure for the held-turn probe" }, id: "h-agent" }] },
        { calls: [{ tool: "no_reply", input: { reason: "not_relevant" }, id: "h-no-reply" }] },
        { say: "never served — the task result delivery takes this script index" },
        { calls: [{ tool: "reply", input: { text: "late answer to a declined wake", wake: WAKE_FROM_ENVELOPE }, id: "h-reply" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "h-list" }] },
        { say: "should never be reached — the closeout boundary ends the turn first" },
      ],
      child: [{ delayMs: 120_000, say: "the figure is 42" }],
    }),
  );

  const channelId = DISCORD_LISTED_CHANNEL_ID;
  const cursor = await auditCursor();
  const res = await fetch(`${base}/control/v1/test/wake`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INJECT_TOKEN}` },
    body: JSON.stringify({
      domain: "e2e-unified",
      platform: "discord",
      surfaceKey: `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`,
      text: "held please",
      mention: true,
      author: "a held-turn asker",
      authorId: DISCORD_USER_ID,
      origin: { platform: "discord", guildId: DISCORD_GUILD_ID, channelId: DISCORD_LISTED_CHANNEL_ID },
      authAttributes: { guild_id: DISCORD_GUILD_ID, channel_id: DISCORD_LISTED_CHANNEL_ID, user_id: DISCORD_USER_ID, oe_fire_unattended: "true" },
    }),
  });
  expect(res.status, `the test-wake route refused the forged wake: ${(await res.text()).slice(0, 300)}`).toBe(200);

  await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).filter((r) => r.surface === channelId);
    return found.at(0);
  }, "the no_reply's own row, written while the task still works");
  const seatFirst = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0);
  expect(seatFirst?.tools, "the forged non-lean seat holds the declared subagent it starts its own task with").toContain("fresh_eyes_review");
  handle.releaseHolds();

  const closed = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
    return found.find((r) => (r.detail ?? {}).tier === "closed");
  }, "a closed turn.step_boundary audit row").catch((err: unknown) => {
    const trail = handle.requests.map((r) => ({ role: r.role, turn: r.turnId, step: r.stepIndex, results: r.toolResults.map((t) => `${t.id}:${t.isError ? "err" : "ok"}`), fault: r.fault }));
    throw new Error(`${String(err)} — trail: ${JSON.stringify(trail)}`);
  });

  expect(closed.detail?.reason).toBe("declined-this-turn");
  expect(closed.detail?.budget).toBe(120);
  await awaitWindowQuiet();

  const parent = handle.requests.filter((r) => r.role === "parent");
  expect(new Set(parent.map((r) => r.turnId)).size, "every parent step ran in the one held turn").toBe(1);
  const refused = (await rowsSinceCursor(cursor, ["reply.refused"])).filter((r) => r.surface === channelId && r.detail?.reason === "declined-this-turn");
  expect(refused, "the reply to the declined wake was refused once, and that refusal armed the closeout").toHaveLength(1);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const child = handle.requests.filter((r) => r.role === "child");
  expect(
    child.map((r) => r.stepIndex),
    "the declared subagent's turn answers from its child script: its model is the root's dynamic model, so the scripted valve in that model serves it",
  ).toEqual([0]);
  expect(new Set(child.map((r) => r.sessionId)).size, "the child step ran in the subagent's own session").toBe(1);
  expect(child[0]!.sessionId, "the child session is not the parent's").not.toBe(parent[0]!.sessionId);
  const delivered = parent.find((r) => r.stepIndex === 3)!;
  expect(
    delivered.messages.map((m) => m.text).join("\n"),
    "the parent resumes on the subagent's own answer, not on a failed task",
  ).toContain("the figure is 42");
  expect(parent.map((r) => r.stepIndex), "the turn resumes on the task result, and the closeout boundary ends it before the scripted list step").toEqual([0, 1, 3]);
  const all = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
  expect(all.map((r) => (r.detail ?? {}).tier)).toEqual(["closed"]);
});

type WorkerReplyInput = { text: string };

type StandDownOrder = "none" | "forwarded-before" | "forwarded-after";

function delegatedReplyScript(opts: { readonly order: StandDownOrder; readonly brief: string; readonly first: WorkerReplyInput; readonly second: WorkerReplyInput }) {
  const work = { calls: [{ tool: "work", input: { message: opts.brief }, id: `d-work-${opts.order}` }] };
  const stand = { calls: [{ tool: "stand_down", input: { reason: "asked me to stop following" }, id: "d-stand" }] };
  const opening = opts.order === "none" ? [work] : opts.order === "forwarded-before" ? [work, stand] : [stand, work];
  return registerScript({
    parent: [
      ...opening,
      { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: "the figure will follow", done: false }, id: "d-pending" }] },
      { say: NO_REPLY_SENTINEL },
      { say: NO_REPLY_SENTINEL },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [
      { delayMs: 120_000, calls: [{ tool: "reply", input: opts.first, id: "w-reply-1" }] },
      { calls: [{ tool: "reply", input: opts.second, id: "w-reply-2" }] },
      { calls: [{ tool: "list_routines", input: {}, id: "w-list" }] },
      { say: "the worker's terminal step" },
    ],
  });
}

async function driveDelegatedReplies(opts: { readonly order: StandDownOrder }) {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } });
  expect(settings.getSettings().turn.stepBudget).toBe(120);

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const channelId = freshUnlistedChannelId();
  const handle = disposeLater(
    delegatedReplyScript({
      order: opts.order,
      brief: `post the figure into room ${channelId}`,
      first: { text: "the figure is 42" },
      second: { text: "the figure is still 42" },
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> figure please" });

  const held = await waitFor(() => handle.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the delegated worker's first step, held");
  const parentSession = handle.requests.find((r) => r.role === "parent")?.sessionId;
  expect(held.sessionId, "the worker runs in its own delegated session").not.toBe(parentSession);
  expect(held.tools, "a worker keeps the per-surface reply").toContain("reply");
  expect(held.tools, "a worker withholds no_reply and stand_down").not.toContain("no_reply");
  expect(held.tools).not.toContain("stand_down");
  const replyArgs = Object.keys(((held.toolDefinitions.find((d) => d.name === "reply")?.inputSchema ?? {}) as { properties?: object }).properties ?? {});
  expect(replyArgs, "the worker's reply schema was read").toContain("text");
  for (const arg of ["wake", "done", "force"]) {
    expect(replyArgs, "the worker's reply has no wake, done or force argument, so it can never arm forced-override-repeat").not.toContain(arg);
  }

  if (opts.order !== "none") {
    await waitFor(
      () => handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === "d-stand" && !t.isError)),
      "the seat's stand_down result, before the worker replies",
    );
  }
  handle.releaseHolds();

  const worker = String(held.sessionId);
  const ofWorker = (rows: Awaited<ReturnType<typeof rowsSinceCursor>>) => rows.filter((r) => r.surface === channelId && r.detail?.sessionId === worker);
  const settled = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["delegation.task_settled"]);
    return rows.find((r) => r.detail?.agent === worker);
  }, "the worker's delegation.task_settled row");
  await awaitWindowQuiet();

  const child = handle.requests.filter((r) => r.role === "child");
  const ofRoom = (rows: Awaited<ReturnType<typeof rowsSinceCursor>>) => rows.filter((r) => r.surface === channelId);
  return {
    settled,
    child,
    parentSession: String(parentSession),
    roomPosts: ofRoom(await rowsSinceCursor(cursor, ["reply.post"])),
    roomAcks: ofRoom(await rowsSinceCursor(cursor, ["reply.stand_down_ack"])),
    faults: handle.requests.filter((r) => r.fault !== undefined),
    boundary: ofWorker(await rowsSinceCursor(cursor, ["turn.step_boundary"])),
    posts: ofWorker(await rowsSinceCursor(cursor, ["reply.post"])),
    refused: ofWorker(await rowsSinceCursor(cursor, ["reply.refused"])),
    acks: ofWorker(await rowsSinceCursor(cursor, ["reply.stand_down_ack"])),
  };
}

for (const order of ["forwarded-before", "forwarded-after"] as const) {
  test(`a delegated worker whose job was ${order === "forwarded-before" ? "forwarded BEFORE" : "forwarded AFTER"} the stand-down posts nothing into the stood-down room: its first reply is refused, and the closeout boundary ends its turn`, async () => {
    const run = await driveDelegatedReplies({ order });

    expect(run.faults).toEqual([]);
    expect(run.roomAcks.map((r) => r.detail?.sessionId), "the room gets ONE stand-down acknowledgement, and it is the seat's").toEqual([run.parentSession]);
    expect(run.roomPosts, "the seat's acknowledgement is the only post the stood-down room receives").toHaveLength(1);
    expect(run.acks, "the worker spends no acknowledgement — the one the room allows belongs to the turn that stood down").toEqual([]);
    expect(run.posts, "nothing the worker writes reaches the stood-down room").toEqual([]);
    expect(run.refused.map((r) => r.detail?.reason), "the worker's FIRST reply is refused, and that refusal arms the closeout").toEqual(["stopped"]);
    expect(run.boundary.map((r) => (r.detail ?? {}).tier), "one closeout row for the worker's turn").toEqual(["closed"]);
    const closed = run.boundary[0]!;
    expect(closed.detail?.reason).toBe("stopped");
    expect(closed.detail?.budget).toBe(120);
    expect(closed.detail?.steps, "the closeout acts on the step after the refused reply").toBe(2);
    expect(new Set(run.child.map((r) => r.turnId)).size, "every worker step ran in one turn").toBe(1);
    expect(run.child.map((r) => r.stepIndex), "the closeout boundary ends the worker's turn before its second reply").toEqual([0]);
  });
}

test("NEGATIVE CONTROL — a delegated worker in a room that did not stand down posts both replies, and its turn runs to its own end with no closeout", async () => {
  const run = await driveDelegatedReplies({ order: "none" });

  expect(run.faults).toEqual([]);
  expect(run.acks).toEqual([]);
  expect(run.roomAcks).toEqual([]);
  expect(run.refused).toEqual([]);
  expect(run.posts, "eve does not end a delegated turn on a successful reply, so both replies post").toHaveLength(2);
  expect(run.boundary, "nothing arms the closeout, so no boundary acts on the worker's turn").toEqual([]);
  expect(new Set(run.child.map((r) => r.turnId)).size).toBe(1);
  expect(run.child.map((r) => r.stepIndex), "the worker steps past both replies to its terminal step").toEqual([0, 1, 2, 3]);
});
