import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  registerScript,
  rowsSinceCursor,
  sleep,
  slackDmWake,
  slackTs,
  SLACK_TEAM_ID,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";
import { installSlackWebApiStub, type SlackWebApiStub } from "../slack-web-api";

const discord = installDiscordWebApiStub();

function egressSpoof(on: boolean): void {
  if (on) __setTestValveForTest("egress-spoof", true);
  else __setTestValveForTest("egress-spoof", false);
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

const STOP_HAND_SLACK = "raised_hand";
const DM_CHANNEL_ID = "D0OPE1188GLYPH";
const DM_USER_ID = "U0EXOWNER";

function slackHandCalls(stub: SlackWebApiStub): { readonly on: boolean; readonly channelId: string | null; readonly messageId: string | null }[] {
  return stub.calls
    .filter((c) => (c.method === "reactions.add" || c.method === "reactions.remove") && c.params.get("name") === STOP_HAND_SLACK)
    .map((c) => ({ on: c.method === "reactions.add", channelId: c.params.get("channel"), messageId: c.params.get("timestamp") }));
}

function armSlackStub(): SlackWebApiStub {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "U0OPE1188BOT", bot_id: "B0OPE1188BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope1188-operator" } } };
      case "reactions.add":
      case "reactions.remove":
        return { ok: true };
      default:
        return undefined;
    }
  });
}

test("a forwarded job puts the ✋ on its anchor message while the work session works, and takes it off when the job settles", async () => {
  await bootAgent();
  const slack = armSlackStub();
  egressSpoof(false);
  try {
    const cursor = await auditCursor();
    const dispatched = open(
      registerScript({
        parent: [
          { calls: [{ tool: "work", input: { message: "ope-1188 do the long job" }, id: "ope1188-delegate" }] },
          { say: NO_REPLY_SENTINEL },
        ],
        child: [{ delayMs: 120_000, say: "the worker answered" }],
      }),
    );

    expect(slackHandCalls(slack)).toEqual([]);

    const rootTs = slackTs(Date.now() - 60_000, 118_700);
    const ts = slackTs(Date.now(), 118_800);
    const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: DM_USER_ID, text: "ope1188 start the long job", ts, threadTs: rootTs, eventId: `EvOPE1188${ts.replace(".", "")}` });
    expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);

    const receiptStep = await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the forwarding turn's receipt step");
    const dispatch = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
    expect(dispatch.tools).toContain("work");
    expect(dispatch.tools).not.toContain("agent");
    const settlement = open(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
    const taskId = await workTaskIdOfCall(cursor, dispatched, "ope1188-delegate", "the OPE-1188 forward");

    const placed = await waitFor(() => slackHandCalls(slack).find((r) => r.on), "the ✋ reactions.add — the job's ✋ reaching Slack");
    expect(placed.channelId).toBe(DM_CHANNEL_ID);
    expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

    await waitFor(() => dispatched.requests.find((r) => r.role === "child"), "the held worker's own model call");
    await sleep(3_000);
    expect(slackHandCalls(slack).map((r) => r.on), "the ✋ is still on while the job's worker works").toEqual([true]);
    dispatched.releaseHolds();
    await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the job's worker to serve its arm" });
    await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");
    const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the job's result" });
    expect(resultStep.turnId, "the result arrives in a seat turn of its own").not.toBe(receiptStep.turnId);

    const removed = await waitFor(() => slackHandCalls(slack).find((r) => !r.on), "the ✋ reactions.remove when the job's task settled");
    expect(removed.channelId).toBe(DM_CHANNEL_ID);
    expect(removed.messageId).toBe(placed.messageId);
    expect(slackHandCalls(slack).map((r) => r.on)).toEqual([true, false]);
    for (const h of [dispatched, settlement]) {
      expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
      expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
    }
    for (const h of [dispatched, settlement]) {
      live.delete(h);
      h.dispose();
    }
  } finally {
    slack.uninstall();
  }
});

const STRANGER_ID = "9000000000000000077";
const BOT_ID = "9000000000000000001";

async function stopHandClick(base: string, input: { readonly channelId: string; readonly messageId: string; readonly reactorId: string }): Promise<void> {
  const { signDiscordRelayRequest } = await import("../../../packages/core/scripts/e2e/discord-synthetic");
  const secret = process.env.OE_RELAY_SECRET;
  if (secret === undefined || secret.length === 0) throw new Error("the fork published no relay secret — bootAgent did not run");
  const body = JSON.stringify({
    source: "discord-gateway-relay",
    event: "MESSAGE_REACTION_ADD",
    reaction: { messageId: input.messageId, channelId: input.channelId, guildId: DISCORD_GUILD_ID, reactorId: input.reactorId, emoji: STOP_HAND_UNICODE, botId: BOT_ID, messageAuthorId: DISCORD_USER_ID },
  });
  const res = await fetch(`${base}/eve/v1/discord-gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oe-relay-signature": signDiscordRelayRequest(body, secret) },
    body,
  });
  expect(res.status, `the relay refused the ✋ reaction: ${(await res.text()).slice(0, 200)}`).toBe(200);
}

test("D17 — a forwarded job's ✋ sits on the asking message while the work session works; only the requester's click stops it", async () => {
  const { base } = await bootAgent();
  egressSpoof(false);
  const cursor = await auditCursor();
  const ASKING = "d17-forward-wake";
  const forwarding = open(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "ope-2343 d17 do the long job" }, id: "d17-forward" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, holdUntilCancelled: true, say: "the worker answered" }],
    }),
  );
  const handsOnListed = () => handCalls().filter((r) => r.channelId === DISCORD_LISTED_CHANNEL_ID);
  expect(handsOnListed()).toEqual([]);

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> start the long job, forwarded",
    messageId: ASKING,
  });

  const receiptStep = await waitFor(() => forwarding.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the forwarding turn's receipt step");
  const dispatchStep = forwarding.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(dispatchStep.tools).toContain("work");
  expect(dispatchStep.tools).not.toContain("agent");
  const settlement = open(armSettlement(forwarding, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, forwarding, "d17-forward", "the D17 forward");
  await waitFor(() => forwarding.requests.find((r) => r.role === "child"), "the forwarded worker's own model call");

  const placed = await waitFor(() => handsOnListed().find((r) => r.on), "🔴 the ✋ PUT on the asking message when the work session started the job (D17)");
  expect(placed.messageId, "the ✋ went on a message other than the one that asked").toBe(ASKING);
  await sleep(2_000);
  expect(handsOnListed().map((r) => r.on), "the ✋ came off, or went on twice, while the job still works").toEqual([true]);

  await stopHandClick(base, { channelId: DISCORD_LISTED_CHANNEL_ID, messageId: ASKING, reactorId: STRANGER_ID });
  const refused = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.cancel_relayed"], { limit: 50 })).find((r) => r.detail?.taskId === taskId && r.detail?.via === "reaction"),
    "the work.cancel_relayed row for the stranger's click",
  );
  expect(refused.detail?.outcome, "🔴 a stranger's ✋ click was not refused").toBe("refused");
  expect(forwarding.holdsCancelDelivered(), "🔴 a stranger's click reached the job").toBe(0);
  expect(handsOnListed().map((r) => r.on), "the ✋ came off after a refused click").toEqual([true]);

  forwarding.releaseHolds();
  await stopHandClick(base, { channelId: DISCORD_LISTED_CHANNEL_ID, messageId: ASKING, reactorId: DISCORD_USER_ID });
  await waitFor(
    async () => ((await rowsSinceCursor(cursor, ["work.cancel_relayed"], { limit: 50 })).some((r) => r.detail?.taskId === taskId && r.detail?.via === "reaction" && r.detail?.outcome === "relayed") ? true : undefined),
    "🔴 the requester's click to relay a cancel for the job's task",
  );
  await waitFor(
    async () => ((await rowsSinceCursor(cursor, ["work.cancel_redeemed"], { limit: 50 })).some((r) => r.detail?.taskId === taskId && r.detail?.outcome === "admitted") ? true : undefined),
    "the work session's fenced eve__task_cancel to be ADMITTED for the job's task",
  );
  await waitFor(() => (forwarding.holdsCancelDelivered() === 1 ? true : undefined), "🔴 the job's running child to see its abort");
  expect((await rowsSinceCursor(cursor, ["turn.cancel_requested"], { limit: 50 })).filter((r) => r.detail?.via === "reaction"), "🔴 the ✋ click cancelled a TURN").toEqual([]);

  const removed = await waitFor(() => handsOnListed().find((r) => !r.on), "the ✋ DELETE when the job's task settled");
  expect(removed.messageId, "the ✋ came off a message it never went on").toBe(placed.messageId);
  expect(handsOnListed().map((r) => r.on)).toEqual([true, false]);
  const status = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.status"], { limit: 50 })).find((r) => r.detail?.taskId === taskId && r.detail?.state !== "working"),
    "the job's settled status row",
  );
  expect(status.detail?.state, "the job did not settle as a stop").toBe("cancelled");
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the stopped job's result" });
  expect(resultStep.turnId).not.toBe(receiptStep.turnId);
  for (const h of [forwarding, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }
});
