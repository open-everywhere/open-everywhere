import assert from "node:assert/strict";
import {
  fetchWakeBackscroll,
  fetchWakeEnvelopeBackscroll,
  fetchSlackBackscrollWindow,
  isBackscrollVisible,
  RAW_FETCH_REACHBACK_HOURS,
  WAKE_BACKSCROLL_MAX,
  type SlackRequester,
  type WakeBackscrollDeps,
} from "../agent/channels/slack-wake-backscroll.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

type Msg = Record<string, unknown>;
const ids = { userId: "UBOT", botId: "BBOT" };

function stub(method: string, messages: Msg[], recorder?: { method?: string; params?: Record<string, string> }): SlackRequester {
  return async (m: string, params: Record<string, string>) => {
    if (recorder) {
      recorder.method = m;
      recorder.params = params;
    }
    return m === method ? { ok: true, messages } : { ok: false, error: "unexpected_method" };
  };
}
const deps = (request: SlackRequester): WakeBackscrollDeps => ({ request, identity: async () => ids });

{
  const messages: Msg[] = [
    { ts: "1.0", user: "UA", text: "root question" },
    { ts: "2.0", user: "UB", text: "a detail" },
    { ts: "3.0", user: "UBOT", text: "agent answer" },
    { ts: "4.0", user: "UC", text: "follow-up after agent" },
    { ts: "5.0", user: "UD", text: "the name-drop trigger" },
  ];
  const rec: { method?: string; params?: Record<string, string> } = {};
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "5.0", threadTs: "1.0" }, deps(stub("conversations.replies", messages, rec)));
  ok(rec.method === "conversations.replies" && rec.params?.ts === "1.0", "in-thread wake calls conversations.replies on the thread root");
  ok(out.length === 1 && out[0].startsWith(UNTRUSTED_OPEN), "returns one untrusted-wrapped entry");
  ok(out[0].includes("follow-up after agent"), "includes the message after the agent's last reply");
  ok(
    !out[0].includes("root question") && !out[0].includes("a detail") && !out[0].includes("agent answer"),
    "excludes everything up to & including the agent's last reply",
  );
  ok(!out[0].includes("the name-drop trigger"), "excludes the triggering message itself (its text rides on the wake message)");
}

{
  const messages: Msg[] = [
    { ts: "1.0", user: "UA", text: "first" },
    { ts: "2.0", user: "UB", text: "second" },
    { ts: "3.0", user: "UC", text: "third" },
    { ts: "4.0", user: "UD", text: "the trigger" },
  ];
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "4.0", threadTs: "1.0" }, deps(stub("conversations.replies", messages)));
  ok(out.length === 1 && out[0].includes("first") && out[0].includes("second") && out[0].includes("third"), "cold thread → all prior messages");
  ok(!out[0].includes("the trigger"), "cold thread still excludes the trigger");
}

{
  const messages: Msg[] = [
    { ts: "1.0", bot_id: "BBOT", text: "my own post" },
    { ts: "2.0", user: "UD", text: "trigger" },
  ];
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "2.0", threadTs: "1.0" }, deps(stub("conversations.replies", messages)));
  ok(out.length === 0, "a thread whose only prior content is the agent's own last reply → nothing new to add");
}
{
  const messages: Msg[] = [{ ts: "1.0", bot_id: "BBOT", text: "my own post" }];
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "9.9" }, deps(stub("conversations.history", messages)));
  ok(out[0].includes("[sender_type=agent] my own post") && !out[0].includes("sender_id=BBOT"), "own post → sender_type=agent, no foreign sender_id");
}

{
  const messages: Msg[] = [
    { ts: "9.0", user: "UC", text: "newest" },
    { ts: "8.0", user: "UB", text: "middle" },
    { subtype: "channel_join", user: "UD", ts: "7.5", text: "joined" },
    { ts: "7.0", user: "UA", text: "" },
    { ts: "6.0", user: "UA", text: "oldest" },
  ];
  const rec: { method?: string; params?: Record<string, string> } = {};
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "9.9" }, deps(stub("conversations.history", messages, rec)));
  ok(rec.method === "conversations.history" && rec.params?.latest === "9.9" && rec.params?.inclusive === "false", "top-level wake calls conversations.history strictly older than the trigger");
  ok(out.length === 1 && out[0].startsWith(UNTRUSTED_OPEN), "one untrusted-wrapped entry");
  ok(out[0].indexOf("oldest") < out[0].indexOf("middle") && out[0].indexOf("middle") < out[0].indexOf("newest"), "rendered oldest-first");
  ok(!out[0].includes("joined"), "system subtype messages are dropped");
  ok(!out[0].includes("sender_type=user sender_id=UA] \n") && out[0].split("sender_type").length - 1 === 3, "empty-text messages are dropped (3 attributed lines, not 4)");
  ok(!out[0].includes("read_slack_channel"), "only 3 lines rendered (below the cap) → no 'fetch more' hint");
}

{
  const messages: Msg[] = Array.from({ length: 13 }, (_, i) => ({ ts: `${13 - i}.0`, user: "UA", text: `m${12 - i}` }));
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "99.0" }, deps(stub("conversations.history", messages)));
  ok(WAKE_BACKSCROLL_MAX === 10, "the cap constant is 10");
  const kept = out[0].split("\n").filter((l) => l.includes("sender_type=")).length;
  ok(kept === WAKE_BACKSCROLL_MAX, `capped at WAKE_BACKSCROLL_MAX lines (${WAKE_BACKSCROLL_MAX})`);
  ok(out[0].includes("m12") && out[0].includes("m3") && !out[0].includes("m2") && !out[0].includes("m0"), "cap keeps the most-recent N, drops the oldest");
  const untrustedEnd = out[0].indexOf(UNTRUSTED_CLOSE);
  ok(out[0].includes("read_slack_channel") && out[0].includes("read_slack_thread"), "hitting the cap names both read tools");
  ok(untrustedEnd > -1 && out[0].indexOf("read_slack_channel") > untrustedEnd, "the hint is appended AFTER the untrusted-wrapped block");
}

{
  const throwing = deps(async () => {
    throw new Error("slack down");
  });
  ok((await fetchWakeBackscroll({ channelId: "C", ts: "1.0", threadTs: "1.0" }, throwing)).length === 0, "a throwing requester → empty (never fails the wake)");
  ok((await fetchWakeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => ({ ok: false, error: "not_in_channel" })))).length === 0, "a not-ok response → empty");
  ok((await fetchWakeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => ({ ok: true, messages: [] })))).length === 0, "empty history → no context");
  ok((await fetchWakeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => undefined))).length === 0, "undefined response (no token) → empty");
  const badIdentity: WakeBackscrollDeps = {
    request: stub("conversations.history", [{ ts: "1.0", user: "UA", text: "hi" }]),
    identity: async () => {
      throw new Error("auth.test down");
    },
  };
  const out = await fetchWakeBackscroll({ channelId: "C", ts: "9.9" }, badIdentity);
  ok(out.length === 1 && out[0].includes("hi"), "a failing identity resolver still yields context (own-post attribution just degrades)");
}

const HOUR_S = 3600;
const routing = (
  history: Msg[],
  replies: Record<string, Msg[]> = {},
  rec?: { calls: Array<{ method: string; params: Record<string, string> }> },
): SlackRequester => {
  return async (method: string, params: Record<string, string>) => {
    rec?.calls.push({ method, params });
    if (method === "conversations.history") return { ok: true, messages: history };
    if (method === "conversations.replies") {
      const root = params.ts;
      return { ok: true, messages: replies[root] ?? [] };
    }
    return { ok: false, error: "unexpected_method" };
  };
};

{
  const T = 200 * HOUR_S;
  const s = (h: number) => `${(T - h * HOUR_S).toFixed(3)}`;
  const history: Msg[] = [
    { ts: s(0.5), user: "UB", text: "spine-newest" },
    { ts: s(0.7), bot_id: "BFOREIGN", text: "a foreign bot post" },
    { ts: s(0.9), ts_note: "no author", text: "orphan message" },
    { ts: s(1.0), bot_id: "BBOT", text: "my own spine post" },
    { ts: s(30), user: "UB", text: "older-burst-1" },
    { ts: s(30.2), user: "UC", text: "older-burst-2" },
  ];
  const rec = { calls: [] as Array<{ method: string; params: Record<string, string> }> };
  const out = await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: `${T + HOUR_S}` }, deps(routing(history, {}, rec)));

  const hist = rec.calls.find((c) => c.method === "conversations.history");
  ok(hist?.params.inclusive === "false" && hist?.params.latest === `${T + HOUR_S}`, "adapter fetches conversations.history strictly older than the trigger");
  ok(hist?.params.oldest === String(T + HOUR_S - RAW_FETCH_REACHBACK_HOURS * HOUR_S), `raw fetch reachback floor = latest - ${RAW_FETCH_REACHBACK_HOURS}h (covers a weekend spine gap)`);

  const bodies = out.map((m) => m.body);
  ok(bodies.includes("a foreign bot post"), "VISIBILITY GATE: an ATTRIBUTABLE foreign bot's message IS surfaced (marked awareness)");
  const foreignBot = out.find((m) => m.body === "a foreign bot post");
  ok(foreignBot?.from === "bot" && foreignBot?.author === "BFOREIGN" && foreignBot?.authorId === "BFOREIGN", "the foreign bot message is tagged from=bot with its bot id as author");
  ok(foreignBot?.trigger === undefined && foreignBot?.trust === "relay", "the foreign bot message is CONTEXT-ONLY (never a trigger) and a machine author → relay under the no-resolver default");
  ok(!bodies.includes("orphan message"), "VISIBILITY GATE: an unattributable (no author) message is STILL NOT surfaced (fail closed)");
  ok(bodies.includes("my own spine post"), "the bot's OWN prior post IS surfaced (tagged self)");
  ok(bodies.includes("older-burst-1") && bodies.includes("spine-newest"), "spine + the in-36h older burst both surface");

  ok(out[0].sentAt <= out[out.length - 1].sentAt, "entries are oldest-first");
  const sids = new Set(out.map((m) => m.sessionId));
  ok(sids.size === 2 && !sids.has(undefined), "two idle-gap clusters → each message carries its cluster sessionId (multi-cluster)");
  const self = out.find((m) => m.body === "my own spine post");
  ok(self?.from === "self" && self?.author === "unknown" && self?.authorId === undefined, "own post → from=self, no foreign author id");
  const human = out.find((m) => m.body === "older-burst-1");
  ok(human?.from === "human" && human?.author === "UB" && human?.authorId === "UB", "a human message → from=human with the raw id in author/author-id (name resolved later by the route)");
  ok(out.every((m) => m.trigger === undefined), "no backscroll entry carries the trigger flag");
  ok(out.every((m) => m.trust === (m.from === "human" ? "unauth" : "relay")), "with NO resolver wired, the fail-closed default tags humans unauth and machine authors (self/foreign-bot) relay");
  ok(out.every((m) => m.type === "channel"), "top-level messages are tagged type=channel");
}

{
  const T = 200 * HOUR_S;
  const s = (h: number) => `${(T - h * HOUR_S).toFixed(3)}`;
  const rootTs = s(1.0);
  const history: Msg[] = [
    { ts: s(0.5), user: "UB", text: "top-level after" },
    { ts: rootTs, user: "UA", text: "thread root", thread_ts: rootTs, reply_count: 2 },
  ];
  const replies: Record<string, Msg[]> = {
    [rootTs]: [
      { ts: rootTs, user: "UA", text: "thread root", thread_ts: rootTs },
      { ts: s(0.8), user: "UC", text: "reply one", thread_ts: rootTs },
      { ts: s(0.7), user: "UD", text: "reply two", thread_ts: rootTs },
    ],
  };
  const rec = { calls: [] as Array<{ method: string; params: Record<string, string> }> };
  const out = await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: `${T + HOUR_S}` }, deps(routing(history, replies, rec)));
  ok(rec.calls.some((c) => c.method === "conversations.replies" && c.params.ts === rootTs), "a thread root with replies triggers a conversations.replies enrichment fetch");
  const reply = out.find((m) => m.body === "reply one");
  ok(reply?.type === "thread" && reply?.threadRoot === rootTs, "an in-window thread reply is tagged type=thread + threadRoot=<root ts>");
  ok(out.filter((m) => m.body === "thread root").length === 1, "the thread root is not double-counted (history + replies deduped by id)");
}

{
  ok(isBackscrollVisible({ senderType: "agent", ts: "1.0", text: "x" }), "gate: the bot's own posts (agent) are visible");
  ok(isBackscrollVisible({ senderType: "user", senderId: "U1", ts: "1.0", text: "x" }), "gate: identifiable humans are visible");
  ok(isBackscrollVisible({ senderType: "bot", senderId: "B1", ts: "1.0", text: "x" }), "gate: ATTRIBUTABLE foreign bots ARE visible now (marked awareness → from=bot)");
  ok(!isBackscrollVisible({ senderType: "bot", ts: "1.0", text: "x" }), "gate: a foreign bot with NO bot id is dropped (unattributable → fail closed)");
  ok(!isBackscrollVisible({ senderType: "unknown", ts: "1.0", text: "x" }), "gate: unattributable senders are NOT visible (fail closed)");
}

{
  const T = 100 * HOUR_S;
  const history: Msg[] = [{ ts: `${T - 1800}`, user: "UA", text: "hello" }];
  const window = await fetchSlackBackscrollWindow({ channelId: "C", ts: `${T}` }, deps(routing(history)));
  ok(window.length === 1 && window[0].text === "hello" && typeof window[0].ms === "number", "fetchSlackBackscrollWindow returns NormalizedMessage[] (the neutral-core seam)");

  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => { throw new Error("slack down"); }))).length === 0, "a throwing requester → empty (never fails the first wake)");
  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => ({ ok: false, error: "not_in_channel" })))).length === 0, "a not-ok response → empty");
  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => undefined))).length === 0, "undefined response (no token) → empty");
  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "not-a-number" }, deps(routing([{ ts: "1.0", user: "UA", text: "hi" }])))).length === 0, "an unparseable trigger ts → empty (fail-soft)");
}

console.log(`✓ slack-wake-backscroll: ${n} assertions passed (since-last-agent slice + cold-thread + top-level + N cap + subtype/empty skip + untrusted wrap + fail-soft + supervisor cluster-aware adapter: visibility gate + thread enrichment + session grouping)`);
