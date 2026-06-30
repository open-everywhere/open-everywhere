process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { isStopRequest, shouldDeliverReply } from "../agent/channels/engagement.js";
import { parseMessageEvent, routeMessageEvent, type MessageRouteDeps } from "../agent/channels/slack-events.js";
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

console.log(`✓ engagement: ${n} assertions passed (registry + stop-verb + delivery policy + event parse/route + domain read gate)`);
