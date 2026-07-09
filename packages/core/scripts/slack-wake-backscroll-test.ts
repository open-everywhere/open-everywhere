import assert from "node:assert/strict";
import {
  fetchWakeBackscroll,
  fetchWakeEnvelopeBackscroll,
  FIRST_WAKE_BACKSCROLL_WINDOW_HOURS,
  WAKE_BACKSCROLL_MAX,
  type SlackRequester,
  type WakeBackscrollDeps,
} from "../agent/channels/slack-wake-backscroll.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../agent/access/untrusted.js";

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

{
  ok(FIRST_WAKE_BACKSCROLL_WINDOW_HOURS === 24, "default first-wake window is 24h");

  const rec: { method?: string; params?: Record<string, string> } = {};
  const messages: Msg[] = [
    { ts: "9.0", user: "UC", text: "newest" },
    { ts: "8.0", user: "UB", text: "middle" },
    { ts: "6.0", bot_id: "BBOT", text: "own post" },
  ];
  let out = await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "10.0" }, deps(stub("conversations.history", messages, rec)));
  ok(rec.method === "conversations.history" && rec.params?.latest === "10.0" && rec.params?.inclusive === "false", "windowed fetch still bounds by latest/inclusive like the string-context fetcher");
  const expectedOldest = String(10.0 - FIRST_WAKE_BACKSCROLL_WINDOW_HOURS * 3600);
  ok(rec.params?.oldest === expectedOldest, `oldest = latest - ${FIRST_WAKE_BACKSCROLL_WINDOW_HOURS}h (a rolling TIME window, not a fixed message count)`);

  ok(out.length === 3, "returns one entry per message (not a rolled-up context string)");
  ok(out.every((m) => m.trust === "peer" && m.trigger === undefined), "every backscroll entry is trust=peer with no trigger flag");
  ok(out[0].body === "own post" && out[1].body === "middle" && out[2].body === "newest", "oldest-first order (conversations.history is newest-first on the wire)");
  ok(out[0].from === "agent" && out[0].author === "unknown", "the bot's own post maps to from:agent, no foreign author id");
  ok(out[1].from === "human" && out[1].author === "UB", "a human message maps to from:human with its user id as author");
  ok(out.every((m) => typeof m.sentAt === "string" && !Number.isNaN(Date.parse(m.sentAt))), "sentAt is a valid ISO-8601 string");

  const rec2: { method?: string; params?: Record<string, string> } = {};
  await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "10.0", windowHours: 1 }, deps(stub("conversations.history", messages, rec2)));
  ok(rec2.params?.oldest === String(10.0 - 3600), "a custom windowHours narrows the oldest bound accordingly");

  const many: Msg[] = Array.from({ length: 13 }, (_, i) => ({ ts: `${13 - i}.0`, user: "UA", text: `m${12 - i}` }));
  out = await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "99.0" }, deps(stub("conversations.history", many)));
  ok(out.length === WAKE_BACKSCROLL_MAX, `capped at WAKE_BACKSCROLL_MAX entries (${WAKE_BACKSCROLL_MAX}) even though the window held 13`);
  ok(out[0].body === "m3" && out[out.length - 1].body === "m12", "cap keeps the most-recent N, drops the oldest, order preserved");

  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => { throw new Error("slack down"); }))).length === 0, "a throwing requester → empty (never fails the first wake)");
  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => ({ ok: false, error: "not_in_channel" })))).length === 0, "a not-ok response → empty");
  ok((await fetchWakeEnvelopeBackscroll({ channelId: "C", ts: "1.0" }, deps(async () => undefined))).length === 0, "undefined response (no token) → empty");
}

console.log(`✓ slack-wake-backscroll: ${n} assertions passed (since-last-agent slice + cold-thread + top-level + N cap + subtype/empty skip + untrusted wrap + fail-soft + T1.5 envelope-shaped windowed backscroll)`);
