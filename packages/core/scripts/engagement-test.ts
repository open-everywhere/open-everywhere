process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { isStopRequest, shouldDeliverReply } from "../agent/channels/engagement.js";
import {
  parseMessageEvent,
  routeMessageEvent,
  renderWakeMessage,
  isNoReply,
  finalMessageAction,
  NO_REPLY_SENTINEL,
  nameDropPattern,
  shouldNameDropWake,
  routeNameDropEvent,
  renderNameDropMessage,
  type MessageRouteDeps,
  type NameDropRouteDeps,
} from "../agent/channels/slack-events.js";
import { nameDropWakeEnabled } from "../agent/memory/domain.js";
import { createHmac } from "node:crypto";
import { classifyEnvelope, verifySlackSignature, EventDedupe, ThreadFifo } from "../agent/channels/slack-front.js";
import { allowedChannelIds, assertChannelAllowed, ChannelScopeError, readableChannelList } from "../agent/channels/slack-read.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "transactions", channels: ["slack/T_ENG/C_TXN", "slack/T_ENG/C_TXN_EMEA"], memory: "txn" }),
  ],
  loadSilos: () => [{ name: "txn", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (["C_TXN", "C_TXN_EMEA"].includes(surface) ? ["transactions"] : []),
});

{
  const store = getOperationalStore();
  await store.markEngaged("org1", "slack/T_ENG/C_TXN", "1700.1", "2026-06-30T10:00:00Z");
  let row = await store.getEngagement("org1", "slack/T_ENG/C_TXN", "1700.1");
  ok(row !== null && row.engagedAt === "2026-06-30T10:00:00Z", "engagement persists with engagedAt");

  await store.markEngaged("org1", "slack/T_ENG/C_TXN", "1700.1", "2026-06-30T11:00:00Z");
  row = await store.getEngagement("org1", "slack/T_ENG/C_TXN", "1700.1");
  ok(row !== null && row.engagedAt === "2026-06-30T10:00:00Z" && row.lastTurnAt === "2026-06-30T11:00:00Z", "engagedAt sticks, lastTurnAt advances");

  ok((await store.getEngagement("org2", "slack/T_ENG/C_TXN", "1700.1")) === null, "engagement is org-isolated");

  await store.markEngaged("org1", "slack/T_ENG/C_TXN", "1800.2", "2026-06-30T12:00:00Z");
  ok((await store.listEngagements("org1")).length === 2, "listEngagements returns both engaged threads");

  ok((await store.disengage("org1", "slack/T_ENG/C_TXN", "1700.1")) === true, "disengage removes the record");
  ok((await store.getEngagement("org1", "slack/T_ENG/C_TXN", "1700.1")) === null, "thread is gone after disengage");
  ok((await store.disengage("org1", "slack/T_ENG/C_TXN", "1700.1")) === false, "disengage is idempotent (false when absent)");
}

{
  for (const t of ["stop", "Stop.", "stand down", "STAND DOWN", "stop following", "you can stop now", "that's all thanks", "disengage", "leave this thread", "please stop"]) {
    ok(isStopRequest(t), `stop verb: "${t}"`);
  }
  for (const t of ["don't stop the deploy", "we should stop doing X", "stop the build then retry", "can you stop the job and report", "stopwatch", "stops here is wrong"]) {
    ok(!isStopRequest(t), `NOT a stop verb: "${t}"`);
  }
}

{
  const base = { isEngaged: true, authorIsBot: false, isAppMention: false, inThread: true } as const;
  ok(shouldDeliverReply(base).deliver, "engaged human thread reply → deliver");
  ok(!shouldDeliverReply({ ...base, subtype: "channel_join" }).deliver, "subtype → drop");
  ok(!shouldDeliverReply({ ...base, authorIsBot: true }).deliver, "bot author → drop (no self-trigger)");
  ok(!shouldDeliverReply({ ...base, isAppMention: true }).deliver, "app_mention → drop (mention path owns it)");
  ok(!shouldDeliverReply({ ...base, inThread: false }).deliver, "not in a thread → drop");
  ok(!shouldDeliverReply({ ...base, isEngaged: false }).deliver, "not engaged → drop");
  ok(/subtype/.test(shouldDeliverReply({ ...base, subtype: "x", authorIsBot: true }).reason), "first disqualifier wins (subtype before bot)");
}

{
  const env = (event: Record<string, unknown>) => ({ type: "event_callback", team_id: "T_ENG", event });
  const reply = parseMessageEvent(env({ type: "message", channel: "C_TXN", ts: "2.2", thread_ts: "1.1", user: "U1", text: "hi" }));
  ok(reply !== null && reply.channelId === "C_TXN" && reply.threadTs === "1.1" && reply.userId === "U1" && !reply.isAppMention, "parses a threaded reply");

  const mention = parseMessageEvent(env({ type: "app_mention", channel: "C_TXN", ts: "3.3", thread_ts: "1.1", user: "U1", text: "<@B> hey" }));
  ok(mention !== null && mention.isAppMention, "app_mention sets isAppMention");

  const bot = parseMessageEvent(env({ type: "message", channel: "C_TXN", ts: "4.4", thread_ts: "1.1", bot_id: "B9", text: "beep" }));
  ok(bot !== null && bot.botId === "B9", "captures bot_id");

  ok(parseMessageEvent(env({ type: "message", ts: "5.5" }) as never) === null, "missing channel → null");
  ok(parseMessageEvent({ type: "url_verification" } as never) === null, "non-event_callback → null");
  ok(parseMessageEvent(env({ type: "reaction_added", channel: "C", ts: "6.6" })) === null, "non-message event → null");
}

{
  const woke: string[] = [];
  const touched: string[] = [];
  const deps = (engaged: boolean): MessageRouteDeps => ({
    isEngaged: async () => engaged,
    wake: async ({ message }) => {
      woke.push(message);
    },
    touch: async (_p, threadTs) => {
      touched.push(threadTs);
    },
    now: () => "2026-06-30T13:00:00Z",
  });
  const ev = (over: Record<string, unknown> = {}) =>
    parseMessageEvent({ type: "event_callback", team_id: "T_ENG", event: { type: "message", channel: "C_TXN", ts: "9.9", thread_ts: "1.1", user: "U1", text: "more please", ...over } })!;

  let out = await routeMessageEvent(ev(), deps(true));
  ok(out.deliver && out.woke && woke.length === 1 && touched.length === 1, "engaged human reply → wakes + touches");

  woke.length = 0;
  out = await routeMessageEvent(ev(), deps(false));
  ok(!out.woke && woke.length === 0, "not engaged → no wake");

  out = await routeMessageEvent(ev({ bot_id: "B9", user: undefined }), deps(true));
  ok(!out.woke, "bot author short-circuits BEFORE the engagement lookup");

  out = await routeMessageEvent(ev({ thread_ts: undefined }), deps(true));
  ok(!out.woke && /thread/.test(out.reason), "no thread_ts → not delivered");
}

{
  const ctxFor = (channelId: string): BindableContext =>
    ({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: "T_ENG", channel_id: channelId }, principalId: "U1", principalType: "slack-user" } } },
    }) as BindableContext;

  const inDomain = allowedChannelIds(ctxFor("C_TXN"));
  ok(inDomain.domain === "transactions" && inDomain.ids.has("C_TXN") && inDomain.ids.has("C_TXN_EMEA"), "domain channel → both siblings allowed");
  ok(readableChannelList(ctxFor("C_TXN")).length === 2, "readable list exposes both channels");

  assert.doesNotThrow(() => assertChannelAllowed(ctxFor("C_TXN"), "C_TXN_EMEA"), "sibling read allowed");
  ok(true, "sibling read allowed (no throw)");
  assert.throws(() => assertChannelAllowed(ctxFor("C_TXN"), "C_OTHER"), ChannelScopeError, "foreign channel refused");
  ok(true, "foreign channel refused (ChannelScopeError)");

  const lone = allowedChannelIds(ctxFor("C_RANDOM"));
  ok(lone.domain === undefined && lone.ids.has("C_RANDOM") && lone.ids.size === 1, "unassigned channel → only itself readable");
  assert.throws(() => assertChannelAllowed(ctxFor("C_RANDOM"), "C_TXN"), ChannelScopeError, "unassigned channel can't read a domain channel");
  ok(true, "unassigned channel can't reach into a domain (fail closed)");
}

{
  const JSON_CT = "application/json";
  const body = (o: unknown) => JSON.stringify(o);
  const ev = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    body({ type: "event_callback", team_id: "T_ENG", event, ...extra });

  ok(classifyEnvelope(body({ type: "url_verification", challenge: "x" }), JSON_CT).kind === "forward", "url_verification → forward");
  ok(classifyEnvelope(ev({ type: "app_mention", channel: "C", ts: "1.1", text: "<@B> hi" }), JSON_CT).kind === "forward", "app_mention → forward");
  ok(classifyEnvelope(ev({ type: "message", channel: "D", ts: "1.1", channel_type: "im", text: "dm" }), JSON_CT).kind === "forward", "message.im (DM) → forward");
  ok(classifyEnvelope("payload=%7B%7D", "application/x-www-form-urlencoded").kind === "forward", "urlencoded interaction → forward");
  ok(classifyEnvelope("not json", JSON_CT).kind === "forward", "unparseable → forward (fail-safe)");
  ok(classifyEnvelope(ev({ type: "reaction_added", channel: "C", ts: "1.1" }), JSON_CT).kind === "forward", "non-message event → forward");

  for (const ct of ["channel", "group", "mpim"]) {
    const d = classifyEnvelope(ev({ type: "message", channel: "C", ts: "1.1", thread_ts: "1.0", channel_type: ct, user: "U1", text: "more" }), JSON_CT);
    ok(d.kind === "wake" && d.env !== undefined, `message.${ct} → wake (carries env)`);
  }
}

{
  const secret = "shhh";
  const raw = JSON.stringify({ type: "event_callback" });
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));
  const sign = (t: string, b: string) => `v0=${createHmac("sha256", secret).update(`v0:${t}:${b}`).digest("hex")}`;
  const hdr = (o: Record<string, string>) => new Headers(o);

  ok(verifySlackSignature(raw, hdr({ "x-slack-request-timestamp": ts, "x-slack-signature": sign(ts, raw) }), secret, nowMs), "valid signature verifies");
  ok(!verifySlackSignature(raw, hdr({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" }), secret, nowMs), "wrong signature rejected");
  ok(!verifySlackSignature(raw, hdr({ "x-slack-request-timestamp": ts, "x-slack-signature": sign(ts, raw) }), undefined, nowMs), "no signing secret → rejected");
  const staleTs = String(Math.floor(nowMs / 1000) - 60 * 10);
  ok(!verifySlackSignature(raw, hdr({ "x-slack-request-timestamp": staleTs, "x-slack-signature": sign(staleTs, raw) }), secret, nowMs), "stale timestamp → rejected (replay window)");
  ok(!verifySlackSignature(raw, hdr({ "x-slack-signature": sign(ts, raw) }), secret, nowMs), "missing timestamp header → rejected");
}

{
  const d = new EventDedupe(1_000, 3);
  ok(!d.seen("Ev1", 0), "unseen key → not seen");
  d.mark("Ev1", 0);
  ok(d.seen("Ev1", 100), "marked key within TTL → seen (a retry is squashed)");
  ok(!d.seen("Ev1", 2_000), "key past TTL → not seen (expired)");
  const d2 = new EventDedupe(10_000, 3);
  d2.mark("a", 0); d2.mark("b", 1); d2.mark("c", 2); d2.mark("dd", 3);
  ok(!d2.seen("a", 3) && d2.seen("dd", 3), "over-cap → oldest evicted, newest retained");
}

{
  const fifo = new ThreadFifo();
  const order: string[] = [];
  const gate: Array<() => void> = [];
  const mk = (label: string) => () =>
    new Promise<void>((resolve) => {
      order.push(`start:${label}`);
      gate.push(() => {
        order.push(`end:${label}`);
        resolve();
      });
    });
  const p1 = fifo.enqueue("T", mk("1"));
  const p2 = fifo.enqueue("T", mk("2"));
  const p3 = fifo.enqueue("T", mk("3"));
  await Promise.resolve();
  ok(order.join(",") === "start:1", "FIFO: only item 1 has started (2 and 3 wait for it to park)");
  gate.shift()!(); await p1; await Promise.resolve();
  ok(order.join(",") === "start:1,end:1,start:2", "FIFO: item 2 starts only after item 1 settles");
  gate.shift()!(); await p2; await Promise.resolve();
  gate.shift()!(); await p3;
  ok(order.join(",") === "start:1,end:1,start:2,end:2,start:3,end:3", "FIFO: strict arrival order preserved across the burst");

  const fifo2 = new ThreadFifo();
  const started: string[] = [];
  const hold = () => new Promise<void>((r) => setTimeout(r, 5));
  const a = fifo2.enqueue("A", async () => { started.push("A"); await hold(); });
  const b = fifo2.enqueue("B", async () => { started.push("B"); await hold(); });
  await Promise.resolve();
  ok(started.length === 2, "distinct threads start concurrently (not serialized against each other)");
  await Promise.all([a, b]);
  ok(fifo2.activeThreads === 0, "FIFO drops idle thread chains once settled");
}

{
  const ev = parseMessageEvent({
    type: "event_callback",
    team_id: "T_ENG",
    event: { type: "message", channel: "C_TXN", ts: "9.9", thread_ts: "1.1", user: "U1", text: "what do you reckon, Dave?" },
  })!;
  const wakeMsg = renderWakeMessage(ev);
  ok(wakeMsg.includes(NO_REPLY_SENTINEL) && wakeMsg.includes("what do you reckon, Dave?"), "wake message = judge instruction + raw reply");
  ok(wakeMsg.includes("[thread-follow]"), "wake message is marked as a thread-follow dispatch");

  const woke: string[] = [];
  const deps: MessageRouteDeps = {
    isEngaged: async () => true,
    wake: async ({ message }) => {
      woke.push(message);
    },
  };
  const out = await routeMessageEvent(ev, deps);
  ok(out.woke && woke[0].includes(NO_REPLY_SENTINEL), "wake delivery carries the judge instruction");

  ok(isNoReply("NO_REPLY"), "bare sentinel → silent");
  ok(isNoReply("  NO_REPLY."), "whitespace + trailing punctuation → silent");
  ok(isNoReply("NO_REPLY — they're talking among themselves"), "half-compliant rationale after the sentinel → still silent (never post the private judgment)");
  ok(!isNoReply("I checked — NO_REPLY is the sentinel we use"), "sentinel mid-message is a genuine reply, not silence");
  ok(!isNoReply("Sure, here's the summary…"), "ordinary reply → posts");

  ok(finalMessageAction("tool-calls", "Checking the repo…").kind === "buffer-tool-status", "tool-calls finish → buffer for typing status");
  ok(finalMessageAction("stop", null).kind === "silent", "empty final message → silent (default behaviour preserved)");
  ok(finalMessageAction("stop", "NO_REPLY").kind === "silent", "sentinel final message → swallowed, nothing posted");
  const post = finalMessageAction("stop", "Here's the answer.");
  ok(post.kind === "post" && post.text === "Here's the answer.", "genuine reply → posted verbatim");
}

{
  const re = nameDropPattern("Ada");
  ok(re.test("could ada take a look?"), "name matches case-insensitively");
  ok(re.test("Ada?"), "name at start with trailing punctuation matches");
  ok(!re.test("adamant refusal"), "name inside a longer word does NOT match");
  ok(nameDropPattern("Open Everywhere").test("ask open  everywhere about it"), "multi-word name tolerates whitespace runs");

  const base = {
    inThread: false,
    authorIsBot: false,
    isAppMention: false,
    subtype: undefined as string | undefined,
    channelType: "channel" as string | undefined,
    textMatchesName: true,
    domainEnabled: true,
    channelConfirmedInternal: true,
  };
  ok(shouldNameDropWake(base).deliver, "top-level human name-drop in an enabled internal channel → deliver");
  ok(!shouldNameDropWake({ ...base, inThread: true }).deliver, "thread reply → engagement path, not name-drop");
  ok(!shouldNameDropWake({ ...base, authorIsBot: true }).deliver, "bot author → never");
  ok(!shouldNameDropWake({ ...base, subtype: "channel_topic" }).deliver, "subtype → never");
  ok(!shouldNameDropWake({ ...base, channelType: "mpim" }).deliver, "group DM → never (channels/groups only)");
  ok(!shouldNameDropWake({ ...base, textMatchesName: false }).deliver, "no name in text → never");
  ok(!shouldNameDropWake({ ...base, domainEnabled: false }).deliver, "domain not opted in → never");
  ok(!shouldNameDropWake({ ...base, channelConfirmedInternal: false }).deliver, "unconfirmed/external channel → fail closed");

  const domains = [
    defineDomain({ name: "opted-in", channels: ["slack/T1/C_IN"], nameDropWake: true }),
    defineDomain({ name: "opted-out", channels: ["slack/T1/C_OUT"] }),
    defineDomain({ name: "org-default", match: "org", nameDropWake: true }),
  ];
  ok(nameDropWakeEnabled("slack/T1/C_IN", domains), "explicit domain with the flag → on");
  ok(!nameDropWakeEnabled("slack/T1/C_OUT", domains), "explicit domain WITHOUT the flag → off (no fall-through to org)");
  ok(nameDropWakeEnabled("slack/T1/C_UNASSIGNED", domains), "unassigned channel → org pseudo-domain's flag");
  ok(!nameDropWakeEnabled("slack/T1/C_ANY", [defineDomain({ name: "o", match: "org" })]), "org without the flag → off (default)");

  const topLevel = (over: Record<string, unknown> = {}) =>
    parseMessageEvent({
      type: "event_callback",
      team_id: "T_ENG",
      event: { type: "message", channel: "C_TXN", ts: "42.1", user: "U1", channel_type: "channel", text: "can Ada check the deploy?", ...over },
    })!;
  const calls: Array<{ threadTs: string; message: string; state: unknown }> = [];
  let infoCalls = 0;
  const deps = (enabled: boolean, internal: boolean): NameDropRouteDeps => ({
    enabledFor: () => enabled,
    confirmInternal: async () => {
      infoCalls++;
      return internal;
    },
    wake: async ({ threadTs, message, state }) => {
      calls.push({ threadTs, message, state });
    },
    displayName: async () => "Ada",
  });

  let out = await routeNameDropEvent(topLevel(), deps(true, true));
  ok(out.woke && calls.length === 1, "enabled + internal + name → wakes");
  ok(calls[0].threadTs === "42.1", "reply thread is rooted at the triggering message's ts");
  ok(calls[0].message.includes("[name-drop]") && calls[0].message.includes(NO_REPLY_SENTINEL), "name-drop dispatch carries the judge instruction + sentinel");
  ok((calls[0].state as { channelId?: string }).channelId === "C_TXN", "wake passes channel state (new session must know where to post)");

  calls.length = 0;
  infoCalls = 0;
  out = await routeNameDropEvent(topLevel({ text: "no bots were harmed" }), deps(true, true));
  ok(!out.woke && infoCalls === 0, "no name in text → dropped before any API call");

  out = await routeNameDropEvent(topLevel(), deps(false, true));
  ok(!out.woke && infoCalls === 0, "domain off → dropped before the conversations.info call");

  out = await routeNameDropEvent(topLevel(), deps(true, false));
  ok(!out.woke && infoCalls === 1 && calls.length === 0, "external/unconfirmed channel → checked once, then fail-closed drop");

  out = await routeNameDropEvent(topLevel({ thread_ts: "1.1" }), deps(true, true));
  ok(!out.woke, "threaded message never enters the name-drop path");

  ok(renderNameDropMessage(topLevel(), "Ada").includes("can Ada check the deploy?"), "dispatch includes the raw message text");

  calls.length = 0;
  out = await routeNameDropEvent(topLevel({ text: "Test Slack Bot, what's the ETA?" }), {
    ...deps(true, true),
    displayName: async () => "Test Slack Bot",
  });
  ok(out.woke && calls.length === 1, "the bot's Slack display name is the needle");
  ok(calls[0].message.includes('("Test Slack Bot")'), "dispatch names the display name that matched");
  out = await routeNameDropEvent(topLevel(), {
    ...deps(true, true),
    displayName: async () => undefined,
  });
  ok(!out.woke, "display-name lookup failure → no needle → no wake (fail-soft, never a crash)");
}

console.log(`✓ engagement: ${n} assertions passed (registry + stop-verb + delivery policy + event parse/route + domain read gate + fronting-route classify/verify/dedupe/FIFO + judged-reply sentinel + name-drop wake)`);
