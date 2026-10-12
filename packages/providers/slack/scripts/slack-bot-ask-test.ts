process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.DATABASE_URL;

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildFrontHandler, ThreadFifo } from "../agent/channels/slack-front.js";
import { parseMessageEvent, type SlackEventEnvelope, type ParsedMessageEvent } from "../agent/channels/slack-events.js";
import { botReplyCandidate, mentionsUser, slackBotAskProbe, slackBotReplyFacts, type SlackBotAskDeps } from "../agent/channels/slack-bot-ask.js";
import {
  admitAskedBotReply,
  deploymentOrg,
  getOperationalStore,
  registerWakeOriginCodec,
  rememberBotAsk,
  BOT_ASK_WINDOW_MS,
  type BotAskRow,
  type BotAskStore,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackWakeOriginCodec } from "../agent/channels/slack-origin-codec.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerWakeOriginCodec("slack", slackWakeOriginCodec);

const TEAM = "T0ACME";
const SELF = { userId: "U0OE", botId: "B0OE" };

{
  ok(mentionsUser("hey <@U0VIK> roll back", "U0VIK"), "a plain mention");
  ok(mentionsUser("hey <@U0VIK|viktor> roll back", "U0VIK"), "a labelled mention");
  ok(!mentionsUser("hey U0VIK roll back", "U0VIK"), "a bare id is not a mention");
  ok(!mentionsUser("hey <@U0VIKTOR> roll back", "U0VIK"), "a longer id is not this one");

  const msg = (event: Record<string, unknown>): ParsedMessageEvent => parseMessageEvent({ type: "event_callback", team_id: TEAM, event: { type: "message", channel: "C0SHARED", ...event } } as SlackEventEnvelope)!;
  ok(botReplyCandidate(msg({ ts: "2.0", thread_ts: "1.0", bot_id: "B0VIK", user: "U0VIK" })), "a bot's thread reply is a candidate");
  ok(botReplyCandidate(msg({ ts: "2.0", thread_ts: "1.0", bot_id: "B0VIK", subtype: "bot_message" })), "a legacy bot_message thread reply is a candidate");
  ok(!botReplyCandidate(msg({ ts: "2.0", thread_ts: "1.0", user: "U0HUMAN" })), "a human's thread reply is not (it never pays a store read)");
  ok(!botReplyCandidate(msg({ ts: "2.0", bot_id: "B0VIK" })), "🔴 a bot's top-level post is not");
  ok(!botReplyCandidate(msg({ ts: "1.0", thread_ts: "1.0", bot_id: "B0VIK" })), "🔴 a thread's own root is not");
  const f = slackBotReplyFacts(msg({ ts: "2.0", thread_ts: "1.0", bot_id: "B0VIK", user: "U0VIK" }), "org1", SELF);
  eq(
    { org: f.org, platform: f.platform, workspace: f.workspace, channel: f.channel, threadTs: f.threadTs, messageTs: f.messageTs, authorUserId: f.authorUserId, authorBotId: f.authorBotId, selfUserId: f.selfUserId, selfBotId: f.selfBotId },
    { org: "org1", platform: "slack", workspace: TEAM, channel: "C0SHARED", threadTs: "1.0", messageTs: "2.0", authorUserId: "U0VIK", authorBotId: "B0VIK", selfUserId: "U0OE", selfBotId: "B0OE" },
    "the facts carry the envelope's workspace, the thread, the author's two ids and this app's own ids",
  );
}

{
  const calls: { method: string; body: Record<string, string> }[] = [];
  const deps = (over: { replies?: Record<string, unknown> | undefined; info?: Record<string, unknown> | undefined; self?: { userId?: string; botId?: string }; throws?: boolean } = {}): SlackBotAskDeps => ({
    call: async (method, body) => {
      calls.push({ method, body });
      if (over.throws) throw new Error("network");
      if (method === "conversations.replies") return "replies" in over ? over.replies : { ok: true, messages: [{ ts: "1700.1", user: "U0ME", text: "<@U0VIK> roll back the deploy for me" }] };
      if (method === "users.info") return "info" in over ? over.info : { ok: true, user: { id: "U0VIK", is_bot: true, real_name: "Viktor", profile: { bot_id: "B0VIK" } } };
      return undefined;
    },
    self: async () => over.self ?? SELF,
  });
  const q = { workspaceKey: `slack/${TEAM}`, personId: "U0ME", channel: "C0SHARED", messageTs: "1700.1", bot: "U0VIK" };

  const yes = await slackBotAskProbe(deps())(q);
  eq(yes, { ok: true, threadTs: "1700.1", botUserId: "U0VIK", botId: "B0VIK", botLabel: "Viktor", askText: "<@U0VIK> roll back the deploy for me" }, "the person's own top-level ask to a bot is proved, and its thread is the ask itself");
  const replyCall = calls.find((c) => c.method === "conversations.replies");
  eq(replyCall?.body, { channel: "C0SHARED", ts: "1700.1", limit: "1", inclusive: "true" }, "it reads the ask message itself, with the bot token");

  const inThread = await slackBotAskProbe(deps({ replies: { ok: true, messages: [{ ts: "1700.1", thread_ts: "1600.0", user: "U0ME", text: "<@U0VIK> and you?" }] } }))(q);
  ok(inThread.ok && inThread.threadTs === "1600.0", "an ask posted as a thread reply keeps that thread's root");

  eq(await slackBotAskProbe(deps({ replies: { ok: false, error: "not_in_channel" } }))(q), { ok: false, reason: "unreadable" }, "🔴 a channel the app is not in is unreadable — it could not hear the reply anyway");
  eq(await slackBotAskProbe(deps({ replies: { ok: true, messages: [{ ts: "1699.9", user: "U0ME", text: "<@U0VIK>" }] } }))(q), { ok: false, reason: "unreadable" }, "a different message is not the named one");
  eq(await slackBotAskProbe(deps({ replies: { ok: true, messages: [{ ts: "1700.1", user: "U0SOMEONE", text: "<@U0VIK> do it" }] } }))(q), { ok: false, reason: "not-yours" }, "🔴 a message someone else wrote is not the person's ask");
  eq(await slackBotAskProbe(deps({ replies: { ok: true, messages: [{ ts: "1700.1", user: "U0ME", text: "roll back please" }] } }))(q), { ok: false, reason: "bot-not-named" }, "🔴 an ask that does not mention the bot is refused");
  eq(await slackBotAskProbe(deps({ info: { ok: true, user: { id: "U0VIK", is_bot: false } } }))(q), { ok: false, reason: "not-a-bot" }, "🔴 a person named as the bot is refused");
  eq(await slackBotAskProbe(deps({ self: { userId: "U0VIK" } }))(q), { ok: false, reason: "self" }, "🔴 this app named as the bot (by user id) is refused");
  eq(await slackBotAskProbe(deps({ self: { userId: "U0OE", botId: "B0VIK" } }))(q), { ok: false, reason: "self" }, "🔴 …and by bot id");
  eq(await slackBotAskProbe(deps({ self: {} }))(q), { ok: false, reason: "unreadable" }, "🔴 an unknown own identity refuses: it cannot prove the bot is not this app (fail-closed)");
  eq(await slackBotAskProbe(deps({ info: { ok: false, error: "user_not_found" } }))(q), { ok: false, reason: "unreadable" }, "a failed users.info is not a yes");
  eq(await slackBotAskProbe(deps({ throws: true }))(q), { ok: false, reason: "unreadable" }, "a throwing call refuses; the probe never throws");
  eq(await slackBotAskProbe(deps())({ ...q, workspaceKey: "teams/x" }), { ok: false, reason: "unreadable" }, "a non-Slack workspace is refused");
}

const SECRET = "shhh-signing-secret";
const NOW_MS = Date.now();
function mkReq(body: string): Request {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}
let eventSeq = 0;
function messageEnvelope(event: Record<string, unknown>): SlackEventEnvelope {
  eventSeq++;
  return { type: "event_callback", team_id: TEAM, event_id: `Ev_${eventSeq}`, event: { type: "message", channel: "C0SHARED", channel_type: "channel", ...event } } as SlackEventEnvelope;
}

interface Drive {
  readonly status: number;
  readonly admitCalls: number;
  readonly relayed: number;
  readonly seatChecks: number;
  readonly forwarded: number;
  readonly logs: readonly string[];
}

async function drive(env: SlackEventEnvelope, admit?: (ev: ParsedMessageEvent, self: { userId?: string; botId?: string }) => Promise<{ relay: () => Promise<unknown> } | null>): Promise<Drive> {
  let admitCalls = 0;
  let relayed = 0;
  let seatChecks = 0;
  let forwarded = 0;
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
  const handler = buildFrontHandler(
    () => {
      forwarded++;
      return Promise.resolve(new Response("inner"));
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => SELF,
      fifo: new ThreadFifo(() => {}),
      seatedSurfaceFor: () => {
        seatChecks++;
        return false;
      },
      ambientEnabledFor: () => false,
      ...(admit
        ? {
            admitBotReply: async (ev: ParsedMessageEvent, self: { userId?: string; botId?: string }) => {
              admitCalls++;
              const r = await admit(ev, self);
              return r ? { relay: async () => { relayed++; return r.relay(); } } : null;
            },
          }
        : {}),
    },
  );
  const res = await handler(mkReq(JSON.stringify(env)), {
    from: () => ({ send: async () => ({}) }),
    to: () => ({ send: async () => ({}) }),
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  } as never);
  await Promise.allSettled(pending);
  return { status: res.status, admitCalls, relayed, seatChecks, forwarded, logs };
  } finally {
    console.log = realLog;
  }
}

const droppedAsBot = (d: Drive): boolean => d.seatChecks > 0 && d.logs.some((l) => l.includes("no wake") && l.includes("author is a bot"));

{
  const yes = async () => ({ relay: async () => "dm-seat" });
  const no = async () => null;
  const admitted = await drive(messageEnvelope({ ts: "1700159720.000200", thread_ts: "1700159720.000100", bot_id: "B0VIK", user: "U0VIK", text: "done" }), yes);
  ok(admitted.status === 200 && admitted.admitCalls === 1 && admitted.relayed === 1, "an admitted bot reply is relayed");
  ok(admitted.seatChecks === 0, "🔴 an admitted reply stops at the exception: it never reaches the channel's wake routing");
  ok(admitted.forwarded === 0, "…and is not forwarded to eve");

  const refused = await drive(messageEnvelope({ ts: "1700159720.000300", thread_ts: "1700159720.000100", bot_id: "B0VIK", user: "U0VIK", text: "done" }), no);
  ok(refused.admitCalls === 1 && refused.relayed === 0 && droppedAsBot(refused), "a refused bot reply falls through to the ordinary routing, where the bot-author drop runs and nothing wakes");

  const human = await drive(messageEnvelope({ ts: "1700159720.000400", thread_ts: "1700159720.000100", user: "U0HUMAN", text: "thanks" }), yes);
  ok(human.admitCalls === 0 && human.relayed === 0, "🔴 a human's thread message never takes the exception, even when it would say yes");
  const topLevel = await drive(messageEnvelope({ ts: "1700159720.000500", bot_id: "B0VIK", user: "U0VIK", text: "hello all" }), yes);
  ok(topLevel.admitCalls === 0 && topLevel.relayed === 0 && droppedAsBot(topLevel), "🔴 a bot's top-level post never takes the exception, even when it would say yes");
}

{
  const org = deploymentOrg();
  const store = getOperationalStore() as unknown as BotAskStore;
  const row: BotAskRow = {
    id: "ask-live",
    org,
    platform: "slack",
    workspace: TEAM,
    channel: "C0SHARED",
    threadTs: "1700159820.000100",
    askTs: "1700159820.000100",
    botUserId: "U0VIK",
    botId: "B0VIK",
    botLabel: "Viktor",
    asker: "U0ME",
    dmSurfaceKey: `slack/${TEAM}/D0ME`,
    dmOrigin: { platform: "slack", channelId: "D0ME" },
    dmAudit: { platform: "slack", workspace: TEAM, surface: "D0ME" },
    askText: "<@U0VIK> roll back the deploy for me",
    atIso: new Date(NOW_MS).toISOString(),
    expiresAtIso: new Date(NOW_MS + BOT_ASK_WINDOW_MS).toISOString(),
  };
  await rememberBotAsk(store, row);
  const relayedRoutes: unknown[] = [];
  const liveAdmit = async (ev: ParsedMessageEvent, self: { userId?: string; botId?: string }) => {
    const r = await admitAskedBotReply(slackBotReplyFacts(ev, org, self), ev.authoredText, {
      edges: {
        dmSeat: async (_o, key) => (key === row.dmSurfaceKey ? { token: "oe-dom:dm:oe-sup:g1", domain: "dm" } : null),
        dispatch: async (input) => {
          relayedRoutes.push(input.origin);
          return true;
        },
        post: async () => undefined,
        mintWakeId: () => "w",
        appendAudit: async () => undefined,
      },
    });
    return r ? { relay: r.relay } : null;
  };

  const reply = await drive(messageEnvelope({ ts: "1700159820.000200", thread_ts: "1700159820.000100", bot_id: "B0VIK", user: "U0VIK", text: "Rolled back to v41." }), liveAdmit);
  ok(reply.relayed === 1 && reply.seatChecks === 0, "🔴 ASK-AND-REPORT: the asked bot's reply in the asked thread is relayed, and the channel's routing never sees it");
  eq(relayedRoutes, [{ platform: "slack", channelId: "D0ME" }], "…to the asker's DM only");

  const startsConversation = await drive(messageEnvelope({ ts: "1700159820.000300", bot_id: "B0VIK", user: "U0VIK", text: "Hi all, I can help" }), liveAdmit);
  ok(startsConversation.relayed === 0 && droppedAsBot(startsConversation), "🔴 REFUSAL: the same bot starting a conversation is never relayed, and the ordinary bot drop wakes nothing");
  const otherThread = await drive(messageEnvelope({ ts: "1700159920.000200", thread_ts: "1700159920.000100", bot_id: "B0VIK", user: "U0VIK", text: "Unasked" }), liveAdmit);
  ok(otherThread.relayed === 0 && droppedAsBot(otherThread), "🔴 REFUSAL: the same bot in a thread nobody asked it in falls through to the ordinary bot drop");
  const otherBot = await drive(messageEnvelope({ ts: "1700159820.000400", thread_ts: "1700159820.000100", bot_id: "B0DOTS", user: "U0DOTS", text: "Me too" }), liveAdmit);
  ok(otherBot.relayed === 0 && droppedAsBot(otherBot), "🔴 REFUSAL: another bot in the asked thread falls through to the ordinary bot drop");
  const edit = await drive(messageEnvelope({ ts: "1700159820.000500", subtype: "message_changed", message: { ts: "1700159820.000200", thread_ts: "1700159820.000100", bot_id: "B0VIK", user: "U0VIK", text: "edited" } }), liveAdmit);
  ok(edit.relayed === 0, "an edit of the bot's reply is not relayed again");
  eq(relayedRoutes.length, 1, "exactly one relay in the whole run");
}

console.log(`✓ slack-bot-ask: ${n} assertions passed`);
