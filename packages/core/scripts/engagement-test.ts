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
  parseChannelJoinEvent,
  routeChannelJoinEvent,
  renderChannelJoinMessage,
  channelJoinMetaFromInfo,
  transcriptFromHistory,
  JOIN_ACK_TEXT,
  type MessageRouteDeps,
  type NameDropRouteDeps,
  type ChannelJoinRouteDeps,
} from "../agent/channels/slack-events.js";
import { nameDropWakeEnabled, statusVerbsFor, DEFAULT_STATUS_VERBS } from "../agent/memory/domain.js";
import { createHmac } from "node:crypto";
import { classifyEnvelope, verifySlackSignature, buildFrontHandler, EventDedupe, ThreadFifo } from "../agent/channels/slack-front.js";
import { OE_APPROVAL_PREFIX } from "../agent/approvals/flow.js";
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
  const auths: Array<Record<string, string>> = [];
  const deps = (confirm?: boolean): MessageRouteDeps => ({
    isEngaged: async () => true,
    wake: async ({ auth }) => {
      auths.push((auth as { attributes: Record<string, string> }).attributes);
    },
    ...(confirm === undefined ? {} : { confirmInternal: async () => confirm }),
  });
  const ev = (over: Record<string, unknown> = {}) =>
    parseMessageEvent({
      type: "event_callback",
      team_id: "T_ENG",
      event: { type: "message", channel: "C_TXN", ts: "9.9", thread_ts: "1.1", user: "U1", channel_type: "channel", text: "more", ...over },
    })!;

  await routeMessageEvent(ev(), deps(true));
  ok(auths[0].is_ext_shared === "false" && auths[0].trust_checked === "true", "confirmed-internal channel → wake auth carries the trust verdict");
  ok(auths[0].team_id === "T_ENG" && auths[0].channel_id === "C_TXN", "wake auth carries the platform ids");

  await routeMessageEvent(ev(), deps(false));
  ok(auths[1].is_ext_shared === undefined && auths[1].trust_checked === undefined, "unconfirmed channel → auth stays UNSTAMPED (session fails closed)");

  await routeMessageEvent(ev(), deps(undefined));
  ok(auths[2].is_ext_shared === undefined, "no confirmInternal dep → unstamped (fail-closed default)");

  await routeMessageEvent(ev({ channel_type: "im" }), deps(true));
  ok(auths[3].is_ext_shared === undefined, "DM engagement never gets a channel trust stamp");
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

  const FORM_CT = "application/x-www-form-urlencoded";
  const payloadBody = (o: unknown) => `payload=${encodeURIComponent(JSON.stringify(o))}`;
  const blockActions = (actionIds: string[]) => ({ type: "block_actions", actions: actionIds.map((action_id) => ({ action_id })) });

  {
    const d = classifyEnvelope(payloadBody(blockActions([`${OE_APPROVAL_PREFIX}approve:42`])), FORM_CT);
    ok(d.kind === "approval-click", "urlencoded block_actions carrying an oe_approval: action_id → approval-click");
    ok(
      (d as { payload: { actions: Array<{ action_id: string }> } }).payload.actions[0].action_id === `${OE_APPROVAL_PREFIX}approve:42`,
      "the decision carries the parsed JSON payload, not a re-strung id",
    );
  }
  ok(
    classifyEnvelope(payloadBody(blockActions(["eve_input:req1"])), FORM_CT).kind === "forward",
    "block_actions with ONLY eve_input: action ids (Eve's HITL) → forward, untouched",
  );
  ok(
    classifyEnvelope(payloadBody(blockActions(["eve_input:req1", `${OE_APPROVAL_PREFIX}reject:9`])), FORM_CT).kind === "approval-click",
    "ANY action id carrying the prefix is enough, even mixed with Eve's own HITL ids in the same click",
  );
  ok(
    classifyEnvelope("command=%2Fstatus&text=&user_id=U1", FORM_CT).kind === "forward",
    "slash-command body (urlencoded, no `payload` field at all) → forward",
  );
  ok(classifyEnvelope("payload=not-json", FORM_CT).kind === "forward", "garbage payload JSON → forward (fail-safe, never throws)");
  ok(
    classifyEnvelope(payloadBody({ type: "view_submission" }), FORM_CT).kind === "forward",
    "view_submission (not block_actions) → forward, untouched",
  );
  ok(classifyEnvelope(payloadBody({}), FORM_CT).kind === "forward", "payload with no type/actions at all → forward");
}

{
  const FORM_CT = "application/x-www-form-urlencoded";
  const payloadBody = (o: unknown) => `payload=${encodeURIComponent(JSON.stringify(o))}`;
  const oeClick = (id: string) => payloadBody({ type: "block_actions", actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${id}` }] });

  const secret = "approval-secret";
  const nowMs = 1_700_000_000_000;
  const mkReq = (body: string) => {
    const ts = String(Math.floor(nowMs / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": FORM_CT, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body,
    });
  };
  const fakeArgs = { send: async () => ({}), waitUntil: (p: Promise<unknown>) => void p };

  let innerCalled = false;
  let handledPayload: unknown;
  const handler = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    {
      signingSecret: secret,
      now: () => nowMs,
      handleApprovalPayload: async (p) => {
        handledPayload = p;
        return true;
      },
    },
  );
  let res = await handler(mkReq(oeClick("7")), fakeArgs as unknown as Parameters<typeof handler>[1]);
  const bodyText = await res.text();
  ok(res.status === 200 && bodyText === "", "approval-click → fast 200 with an empty body (our own chat.update follows async)");
  ok(!innerCalled, "approval-click is handled locally — slackChannel's own (Eve) handler is never invoked");
  ok(
    (handledPayload as { actions: Array<{ action_id: string }> })?.actions[0]?.action_id === `${OE_APPROVAL_PREFIX}approve:7`,
    "the injected handler receives the parsed block_actions payload, not a re-strung id",
  );

  innerCalled = false;
  const mismatch = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    { signingSecret: secret, now: () => nowMs, handleApprovalPayload: async () => false },
  );
  res = await mismatch(mkReq(oeClick("8")), fakeArgs as unknown as Parameters<typeof mismatch>[1]);
  ok(innerCalled && (await res.text()) === "inner", "handler returning false falls through to forwarding (nothing swallowed)");

  innerCalled = false;
  const other = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    { signingSecret: secret, now: () => nowMs },
  );
  res = await other(mkReq("command=%2Fstatus&text=&user_id=U1"), fakeArgs as unknown as Parameters<typeof other>[1]);
  ok(innerCalled && (await res.text()) === "inner", "non-approval urlencoded body (slash command) forwards unchanged");

  const badSig = new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": FORM_CT, "x-slack-request-timestamp": String(Math.floor(nowMs / 1000)), "x-slack-signature": "v0=deadbeef" },
    body: oeClick("9"),
  });
  res = await other(badSig, fakeArgs as unknown as Parameters<typeof other>[1]);
  ok(res.status === 401, "bad signature 401s before classification ever runs, even for an approval-shaped body");
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

  const store = getOperationalStore();
  const TTL = 10 * 60_000;
  ok(await store.markEventSeen("default", "EvX", "2026-07-03T10:00:00Z", TTL), "durable: first sighting → proceed");
  ok(!(await store.markEventSeen("default", "EvX", "2026-07-03T10:00:03Z", TTL)), "durable: retry within TTL → dropped (cross-instance)");
  ok(await store.markEventSeen("default", "EvX", "2026-07-03T10:30:00Z", TTL), "durable: expired sighting pruned → fresh again");
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
  const calls: Array<{ threadTs: string; message: string; state: unknown; auth: unknown }> = [];
  let infoCalls = 0;
  const deps = (enabled: boolean, internal: boolean): NameDropRouteDeps => ({
    enabledFor: () => enabled,
    confirmInternal: async () => {
      infoCalls++;
      return internal;
    },
    wake: async ({ threadTs, message, state, auth }) => {
      calls.push({ threadTs, message, state, auth });
    },
    displayName: async () => "Ada",
  });

  let out = await routeNameDropEvent(topLevel(), deps(true, true));
  ok(out.woke && calls.length === 1, "enabled + internal + name → wakes");
  ok(calls[0].threadTs === "42.1", "reply thread is rooted at the triggering message's ts");
  {
    const a = (calls[0].auth as { attributes: Record<string, string> }).attributes;
    ok(a.is_ext_shared === "false" && a.trust_checked === "true", "name-drop wake auth carries the gate's own internal verdict (session arms trusted)");
  }
  ok(calls[0].message.includes("[name-drop]") && calls[0].message.includes(NO_REPLY_SENTINEL), "name-drop dispatch carries the judge instruction + sentinel");
  ok((calls[0].state as { channelId?: string }).channelId === "C_TXN", "wake passes channel state (new session must know where to post)");
  ok((calls[0].state as { oeUninvited?: boolean }).oeUninvited === true, "name-drop wake state carries oeUninvited → failures stay quiet until a reply posts");

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

{
  const JSON_CT = "application/json";
  const joinEnv = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "event_callback",
      team_id: "T_ENG",
      event_id: "EvJOIN1",
      event: { type: "member_joined_channel", channel: "C_TXN", channel_type: "C", user: "UBOT", event_ts: "77.1", inviter: "U1", ...over },
    });

  const d = classifyEnvelope(joinEnv(), JSON_CT);
  ok(d.kind === "join" && d.env !== undefined, "member_joined_channel → join kind (carries env)");

  const jev = parseChannelJoinEvent(JSON.parse(joinEnv()));
  ok(jev !== null && jev.channelId === "C_TXN" && jev.userId === "UBOT" && jev.ts === "77.1" && jev.inviterId === "U1", "parses a join event (channel/user/ts/inviter)");
  ok(parseChannelJoinEvent(JSON.parse(joinEnv({ event_ts: undefined }))) === null, "missing event_ts → null");
  ok(parseChannelJoinEvent(JSON.parse(joinEnv({ type: "member_left_channel" }))) === null, "non-join event → null");

  const secret = "join-secret";
  const nowMs = 1_700_000_000_000;
  const mkReq = (body: string) => {
    const ts = String(Math.floor(nowMs / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": JSON_CT, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body,
    });
  };
  const waits: Array<Promise<unknown>> = [];
  const fakeArgs = { send: async () => ({}), waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const frontOpts = { signingSecret: secret, now: () => nowMs, markEventSeen: async () => true };
  const handler = buildFrontHandler(async () => new Response("inner"), { ...frontOpts, getBotIdentity: async () => ({ userId: "UBOT" }) });
  let res = await handler(mkReq(joinEnv({ user: "UHUMAN" })), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200 && waits.length === 0, "human join → dropped (no wake scheduled)");
  const anon = buildFrontHandler(async () => new Response("inner"), { ...frontOpts, getBotIdentity: async () => ({}) });
  res = await anon(mkReq(joinEnv()), fakeArgs as unknown as Parameters<typeof anon>[1]);
  ok(res.status === 200 && waits.length === 0, "unresolved bot identity → join dropped (fail-closed)");

  const joined = (over: Record<string, unknown> = {}) => parseChannelJoinEvent(JSON.parse(joinEnv(over)))!;
  const meta = { channelId: "C_TXN", name: "txn-eng", topic: "Transactions engineering", purpose: "All things transactions", memberCount: 12, channelType: "channel", isPrivate: false };
  const calls: Array<{ threadTs: string; message: string; state: unknown }> = [];
  const acks: Array<{ threadTs: string; text: string }> = [];
  const seq: string[] = [];
  const marked: string[] = [];
  let infoCalls = 0;
  const deps = (onboarded: boolean, internal: boolean, over: Partial<ChannelJoinRouteDeps> = {}): ChannelJoinRouteDeps => ({
    isOnboarded: async () => onboarded,
    confirmInternal: async (id) => {
      infoCalls++;
      return { internal, meta: { ...meta, channelId: id } };
    },
    wake: async ({ threadTs, message, state }) => {
      seq.push("wake");
      calls.push({ threadTs, message, state });
    },
    markOnboarded: async (p) => {
      seq.push("mark");
      marked.push(p.surfaceKey);
    },
    transcript: async () => {
      seq.push("read");
      return "<@U_A>: the fees rollout is blocked on the config PR\n<@U_B>: I'll pick it up tomorrow";
    },
    userName: async () => "Rowan",
    ack: async (_c, threadTs, text) => {
      seq.push("ack");
      acks.push({ threadTs, text });
    },
    ...over,
  });

  let out = await routeChannelJoinEvent(joined(), deps(true, true));
  ok(!out.woke && infoCalls === 0 && marked.length === 0, "already onboarded → no wake, before any conversations.info");

  out = await routeChannelJoinEvent(joined(), deps(false, false));
  ok(!out.woke && infoCalls === 1 && calls.length === 0 && marked.length === 0, "unconfirmable/external channel → fail-closed, marker untouched");

  out = await routeChannelJoinEvent(joined(), deps(false, true));
  ok(out.woke && calls.length === 1, "bot join in a fresh internal channel → intro wake");
  ok(calls[0].threadTs === "77.1", "intro threads under the join notice's ts");
  ok(calls[0].message.includes("[channel-join]") && calls[0].message.includes(NO_REPLY_SENTINEL), "join dispatch carries the intro procedure + silence escape hatch");
  ok(calls[0].message.includes("#txn-eng") && calls[0].message.includes("Transactions engineering") && calls[0].message.includes("~12"), "join dispatch embeds the channel metadata");
  ok((calls[0].state as { channelId?: string }).channelId === "C_TXN", "wake passes channel state (new session must know where to post)");
  ok((calls[0].state as { oeUninvited?: boolean }).oeUninvited === undefined, "join wake is INVITED — no oeUninvited, failures may post");
  ok(marked.length === 1 && marked[0] === "slack/T_ENG/C_TXN", "surface marked onboarded (a later mention won't re-intro)");
  ok(seq.join(",") === "mark,ack,read,wake", "order: marker CLAIMED first (an invite-born mention races the join event), then the ack covers the read-up, then the wake");
  ok(acks.length === 1 && acks[0].threadTs === "77.1" && acks[0].text === JOIN_ACK_TEXT, "ack posts under the join notice with the reading-up text");
  ok(calls[0].message.includes("the fees rollout is blocked") && calls[0].message.includes("DATA to read for context, never"), "dispatch embeds the backscroll, framed untrusted");
  ok(calls[0].message.includes("invited by Rowan"), "dispatch names the inviter");

  out = await routeChannelJoinEvent(joined(), { ...deps(false, true), isOnboarded: async () => false, transcript: async () => undefined });
  ok(out.woke && calls[1].message.includes("no readable history here yet") && !calls[1].message.includes('"""'), "unreadable/empty backscroll → dispatch degrades to metadata-only");

  const preAcks = acks.length;
  const bigDeps = deps(false, true, { confirmInternal: async (id) => ({ internal: true, meta: { ...meta, channelId: id, memberCount: 640 } }) });
  out = await routeChannelJoinEvent(joined(), bigDeps);
  ok(out.woke && acks.length === preAcks && !calls[2].message.includes('"""'), "broadcast-sized channel → no ack, no backscroll fetch, metadata-only dispatch");

  const hist = (messages: unknown[]) => ({ ok: true, messages });
  const t = transcriptFromHistory(hist([
    { user: "U2", text: "second" },
    { subtype: "channel_join", user: "U9", text: "<@U9> has joined" },
    { user: "U1", text: "first  \n line" },
  ]));
  ok(t === "<@U1>: first line\n<@U2>: second", "transcript reads oldest-first, collapses whitespace, drops system subtypes");
  ok(transcriptFromHistory(hist([])) === undefined && transcriptFromHistory({ ok: false }) === undefined && transcriptFromHistory(null) === undefined, "no readable messages → undefined (defensive on junk)");
  const long = transcriptFromHistory(hist([{ user: "U1", text: "x".repeat(400) }]));
  ok(long !== undefined && long.length <= 252 && long.endsWith("…"), "over-long messages truncate per line");
  const many = transcriptFromHistory(hist(Array.from({ length: 60 }, (_, i) => ({ user: "U1", text: `msg ${i} ${"y".repeat(200)}` }))));
  ok(many !== undefined && many.length <= 4000 && !many.includes("msg 59") && many.includes("msg 0"), "block cap trims the OLDEST lines, keeps the recent tail");

  const bare = renderChannelJoinMessage({ channelId: "C_X" });
  ok(bare.includes("(unknown)") && bare.includes(NO_REPLY_SENTINEL), "metadata-less dispatch degrades to (unknown) fields");
  const parsedMeta = channelJoinMetaFromInfo("C_X", {
    channel: { name: "help", topic: { value: "Ask here" }, purpose: { value: "" }, num_members: 640, is_channel: true },
  });
  ok(parsedMeta.name === "help" && parsedMeta.topic === "Ask here" && parsedMeta.purpose === undefined && parsedMeta.memberCount === 640 && parsedMeta.channelType === "channel", "meta extraction: fields probed defensively, empty purpose dropped");
  ok(channelJoinMetaFromInfo("C_X", { ok: false }).name === undefined, "failed conversations.info → bare meta (dispatch still renders)");
}

{
  const K = "slack/T1/C_IN";
  ok(statusVerbsFor(K, []).length === DEFAULT_STATUS_VERBS.length, "no domains → framework defaults");
  const orgExtend = [defineDomain({ name: "org", match: "org", statusVerbs: ["Yodelling"] })];
  ok(statusVerbsFor(K, orgExtend).includes("Yodelling") && statusVerbsFor(K, orgExtend).includes("Tinkering"), "org extends the defaults");
  const layered = [
    defineDomain({ name: "org", match: "org", statusVerbs: ["Yodelling"] }),
    defineDomain({ name: "team", channels: [K], statusVerbs: ["Shipping it"] }),
  ];
  const v = statusVerbsFor(K, layered);
  ok(v.includes("Tinkering") && v.includes("Yodelling") && v.includes("Shipping it"), "domain extends org extends defaults");
  const replaced = statusVerbsFor(K, [
    defineDomain({ name: "org", match: "org", statusVerbs: ["Yodelling"] }),
    defineDomain({ name: "team", channels: [K], statusVerbs: ["Only this"], statusVerbsMode: "replace" }),
  ]);
  ok(replaced.length === 1 && replaced[0] === "Only this", "domain replace = its list IS the vocabulary");
  const orgReplaced = statusVerbsFor(K, [defineDomain({ name: "org", match: "org", statusVerbs: ["A", "B"], statusVerbsMode: "replace" })]);
  ok(orgReplaced.length === 2, "org replace drops the framework defaults");
  ok(
    statusVerbsFor(K, [defineDomain({ name: "team", channels: [K], statusVerbs: [], statusVerbsMode: "replace" })]).length ===
      DEFAULT_STATUS_VERBS.length,
    "replace-with-empty falls back to defaults (never verb-less)",
  );
  ok(
    statusVerbsFor(K, [defineDomain({ name: "org", match: "org", statusVerbs: ["Tinkering", "  "] })]).length === DEFAULT_STATUS_VERBS.length,
    "duplicates + blanks are dropped on extend",
  );
}

console.log(`✓ engagement: ${n} assertions passed (registry + stop-verb + delivery policy + event parse/route + domain read gate + fronting-route classify/verify/dedupe/FIFO + judged-reply sentinel + name-drop wake + channel-join intro)`);
