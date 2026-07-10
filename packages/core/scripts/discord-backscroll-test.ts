import assert from "node:assert/strict";
import {
  fetchDiscordBackscroll,
  fetchDiscordBackscrollWindow,
  fetchDiscordWakeEnvelopeBackscroll,
  isDiscordBackscrollVisible,
  linesFromDiscordMessages,
  snowflakeToMs,
  type DiscordRequester,
  type DiscordBackscrollDeps,
} from "../agent/channels/discord-backscroll.js";
import { WAKE_BACKSCROLL_MAX } from "../agent/channels/context-render.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../agent/access/untrusted.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

type Msg = Record<string, unknown>;
const BOT = "BOT_AUTHOR";
const m = (id: string, authorId: string, content: string, bot = false): Msg => ({
  id,
  type: 0,
  content,
  author: { id: authorId, bot },
});

function stub(messages: Msg[] | unknown, recorder?: { channelId?: string; query?: Record<string, string> }): DiscordRequester {
  return async (channelId: string, query: Record<string, string>) => {
    if (recorder) {
      recorder.channelId = channelId;
      recorder.query = query;
    }
    return messages;
  };
}
const deps = (request: DiscordRequester): DiscordBackscrollDeps => ({ request });

{
  const rec: { channelId?: string; query?: Record<string, string> } = {};
  const messages = [m("30", "UC", "newest"), m("20", "UB", "middle"), m("10", "UA", "oldest")];
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "40", isThread: false, botId: BOT }, deps(stub(messages, rec)));
  ok(rec.channelId === "CH" && rec.query?.before === "40" && rec.query?.limit === String(WAKE_BACKSCROLL_MAX), "reads the channel with before=<trigger> and the shared limit");
  ok(out.length === 1 && out[0].startsWith(UNTRUSTED_OPEN), "one untrusted-wrapped entry");
  ok(out[0].indexOf("oldest") < out[0].indexOf("middle") && out[0].indexOf("middle") < out[0].indexOf("newest"), "rendered oldest-first (Discord newest-first is reversed)");
  ok(!out[0].includes("read_discord") && !out[0].includes("read_slack"), "base channel below cap → NO read-tool hint (Discord has no read tools)");
}

{
  const messages = [
    m("40", "UC", "follow-up after agent"),
    m("30", BOT, "agent answer", true),
    m("20", "UB", "a detail"),
    m("10", "UA", "root question"),
  ];
  const out = await fetchDiscordBackscroll({ channelId: "TH", triggerMessageId: "50", isThread: true, botId: BOT }, deps(stub(messages)));
  ok(out.length === 1 && out[0].includes("follow-up after agent"), "in-thread keeps the message after the agent's last reply");
  ok(!out[0].includes("root question") && !out[0].includes("a detail") && !out[0].includes("agent answer"), "in-thread excludes everything up to & including the agent's last reply");
  ok(out[0].includes("[sender_type=agent]") === false, "the agent line itself was sliced out (nothing agent-attributed remains)");
}

{
  const messages = [m("30", "UC", "third"), m("20", "UB", "second"), m("10", "UA", "first")];
  const out = await fetchDiscordBackscroll({ channelId: "TH", triggerMessageId: "40", isThread: true, botId: BOT }, deps(stub(messages)));
  ok(out.length === 1 && out[0].includes("first") && out[0].includes("second") && out[0].includes("third"), "cold thread (agent never spoke) → all prior messages");
}

{
  const messages = [m("10", BOT, "my own post", true)];
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false, botId: BOT }, deps(stub(messages)));
  ok(out[0].includes("[sender_type=agent] my own post") && !out[0].includes(`sender_id=${BOT}`), "own post → sender_type=agent, no foreign sender_id");
}
{
  const messages = [m("20", "OTHERBOT", "another bot", true), m("10", "UH", "human hi")];
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false, botId: BOT }, deps(stub(messages)));
  ok(out[0].includes("[sender_type=bot sender_id=OTHERBOT] another bot"), "other bot → sender_type=bot with id");
  ok(out[0].includes("[sender_type=user sender_id=UH] human hi"), "human → sender_type=user with id");
}
{
  const messages = [m("10", BOT, "unlabelled own post", true)];
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false }, deps(stub(messages)));
  ok(out[0].includes(`[sender_type=bot sender_id=${BOT}] unlabelled own post`), "absent botId → own post attributed as bot (best-effort, no boundary)");
}

{
  const messages: Msg[] = [
    m("40", "UC", "keep me"),
    { id: "35", type: 7, content: "UD joined", author: { id: "UD", bot: false } },
    { id: "30", type: 0, content: "", author: { id: "UA", bot: false } },
    { id: "20", type: 19, content: "a reply", author: { id: "UB", bot: false } },
    { id: "10", type: 6, content: "pinned", author: { id: "UA", bot: false } },
  ];
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false, botId: BOT }, deps(stub(messages)));
  ok(out[0].includes("keep me") && out[0].includes("a reply"), "keeps DEFAULT (0) and REPLY (19) messages");
  ok(!out[0].includes("joined") && !out[0].includes("pinned"), "drops system message types (join/pin)");
  const lines = out[0].split("\n").filter((l) => l.includes("sender_type=")).length;
  ok(lines === 2, "empty-content message dropped (2 attributed lines, not 3)");
}

{
  const messages = Array.from({ length: 13 }, (_, i) => m(`${13 - i}`, "UA", `msg${12 - i}`));
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false, botId: BOT }, deps(stub(messages)));
  ok(WAKE_BACKSCROLL_MAX === 10, "the shared cap constant is 10");
  const kept = out[0].split("\n").filter((l) => l.includes("sender_type=")).length;
  ok(kept === WAKE_BACKSCROLL_MAX, `capped at WAKE_BACKSCROLL_MAX lines (${WAKE_BACKSCROLL_MAX})`);
  ok(out[0].includes("msg12") && out[0].includes("msg3") && !out[0].includes("msg2") && !out[0].includes("msg0"), "cap keeps the most-recent N, drops the oldest");
}

{
  const out = await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "99", isThread: false, botId: BOT }, deps(stub([m("10", "UA", "hi")])));
  ok(out[0].startsWith(UNTRUSTED_OPEN) && out[0].includes(UNTRUSTED_CLOSE), "the block is untrusted-wrapped (open + close)");
}

{
  const throwing = deps(async () => {
    throw new Error("discord down");
  });
  ok((await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "1", isThread: true, botId: BOT }, throwing)).length === 0, "a throwing requester → empty (never fails the wake)");
  ok((await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "1", isThread: false }, deps(async () => undefined))).length === 0, "undefined response (no token) → empty");
  ok((await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "1", isThread: false }, deps(async () => ({ not: "an array" })))).length === 0, "non-array junk → empty");
  ok((await fetchDiscordBackscroll({ channelId: "CH", triggerMessageId: "1", isThread: false }, deps(async () => []))).length === 0, "empty history → no context");
}

{
  const lines = linesFromDiscordMessages([m("10", "UA", "hi"), m("20", BOT, "mine", true)], BOT);
  ok(lines.length === 2 && lines[0].senderType === "user" && lines[1].senderType === "agent", "linesFromDiscordMessages maps user + own-agent by id");
  ok(linesFromDiscordMessages([{ id: "1", type: 7, content: "x", author: { id: "U", bot: false } }], BOT).length === 0, "linesFromDiscordMessages drops a system type");
}

const DISCORD_EPOCH = 1_420_070_400_000;
const sf = (ms: number): string => String((BigInt(Math.round(ms) - DISCORD_EPOCH) << 22n));
const mts = (ms: number, authorId: string | undefined, content: string, bot = false): Msg => ({
  id: sf(ms),
  type: 0,
  content,
  timestamp: new Date(ms).toISOString(),
  author: authorId === undefined ? { bot } : { id: authorId, bot },
});

const T = Date.UTC(2024, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;
function pagingStub(pages: Msg[][], rec?: { calls: number }): DiscordRequester {
  let i = 0;
  return async (_channelId, _query) => {
    if (rec) rec.calls++;
    return i < pages.length ? pages[i++] : [];
  };
}

{
  const ms = T;
  ok(snowflakeToMs(sf(ms)) === ms, "snowflakeToMs decodes the creation time encoded in the id");
  ok(snowflakeToMs("not-a-snowflake") === undefined, "snowflakeToMs → undefined for a non-numeric id");
  ok(snowflakeToMs("0") === undefined, "snowflakeToMs → undefined for a non-positive id");
}

{
  ok(isDiscordBackscrollVisible({ senderType: "agent", ts: "1", text: "x" }), "gate: the bot's own posts (agent) are visible");
  ok(isDiscordBackscrollVisible({ senderType: "user", senderId: "U1", ts: "1", text: "x" }), "gate: identifiable humans are visible");
  ok(isDiscordBackscrollVisible({ senderType: "bot", senderId: "B1", ts: "1", text: "x" }), "gate: ATTRIBUTABLE foreign bots are visible (marked awareness → from=bot)");
  ok(!isDiscordBackscrollVisible({ senderType: "bot", ts: "1", text: "x" }), "gate: a foreign bot with NO id is dropped (unattributable → fail closed)");
  ok(!isDiscordBackscrollVisible({ senderType: "unknown", ts: "1", text: "x" }), "gate: unattributable senders are NOT visible (fail closed)");
}

{
  const messages: Msg[] = [
    mts(T, "UH", "human newest"),
    mts(T - HOUR, "OTHERBOT", "another bot", true),
    mts(T - 2 * HOUR, BOT, "my own post", true),
    { id: sf(T - 3 * HOUR), type: 0, content: "no author id", author: { bot: false } },
    { id: sf(T - 4 * HOUR), type: 7, content: "UD joined", author: { id: "UD", bot: false } },
  ];
  const window = await fetchDiscordBackscrollWindow(
    { channelId: "CH", triggerMessageId: sf(T + HOUR), isThread: false, botId: BOT },
    deps(pagingStub([messages])),
  );
  ok(window.length === 3, "base window: 3 visible NormalizedMessages (unknown + system dropped)");
  ok(window.every((m) => m.type === "channel" && m.threadId === undefined), "base window: every message tagged type=channel, no threadId");
  ok(window.every((m) => typeof m.ms === "number" && m.ms > DISCORD_EPOCH), "base window: each carries a real epoch ms");
  const byText = Object.fromEntries(window.map((m) => [m.text, m]));
  ok(byText["human newest"].sender === "human" && byText["human newest"].authorId === "UH", "human → sender=human with author id");
  ok(byText["another bot"].sender === "bot" && byText["another bot"].authorId === "OTHERBOT", "attributable foreign bot → sender=bot with id");
  ok(byText["my own post"].sender === "self" && byText["my own post"].authorId === undefined, "the bot's own post → sender=self, no author id");
}

{
  const messages = [mts(T, "UA", "in thread")];
  const window = await fetchDiscordBackscrollWindow(
    { channelId: "TH", triggerMessageId: sf(T + HOUR), isThread: true, botId: BOT },
    deps(pagingStub([messages])),
  );
  ok(window.length === 1 && window[0].type === "thread" && window[0].threadId === "TH", "thread window: type=thread, threadId=the thread's own channel id");
}

{
  const messages = [mts(T, "UB", "third"), mts(T - HOUR, "UA", "second"), mts(T - 2 * HOUR, BOT, "first", true)];
  const out = await fetchDiscordWakeEnvelopeBackscroll(
    { channelId: "CH", triggerMessageId: sf(T + HOUR), isThread: false, botId: BOT },
    deps(pagingStub([messages])),
  );
  ok(out.length === 3, "single-cluster envelope backscroll: all 3 messages");
  ok(out.every((m) => m.sessionId === undefined), "single cluster → NO sessionId (renders flat)");
  ok(out.every((m) => m.trust === "peer" && !m.trigger), "backscroll messages are trust=peer and never the trigger");
  ok(out[0].body === "first" && out[2].body === "third", "emitted oldest-first (core sorts by ms)");
  ok(out[0].from === "self" && out[1].from === "human", "sender kinds map onto envelope `from` (self/human/bot)");
}

{
  const messages = [
    mts(T, "UB", "recent-2"),
    mts(T - HOUR, "UA", "recent-1"),
    mts(T - 30 * HOUR, "UB", "older-2"),
    mts(T - 31 * HOUR, "UA", "older-1"),
  ];
  const out = await fetchDiscordWakeEnvelopeBackscroll(
    { channelId: "CH", triggerMessageId: sf(T + HOUR), isThread: false, botId: BOT },
    deps(pagingStub([messages])),
  );
  ok(out.length === 4, "multi-cluster: all 4 messages selected (spine + one bolted cluster)");
  const ids = new Set(out.map((m) => m.sessionId));
  ok(!ids.has(undefined) && ids.size === 2, "an idle gap produced TWO distinct <session> ids (none undefined)");
  ok(out[0].body === "older-1" && out[3].body === "recent-2", "oldest cluster renders first, newest last");
}

{
  const rec = { calls: 0 };
  const page1 = Array.from({ length: 100 }, (_, k) => mts(T - k * 60_000, "UA", `p1-${k}`));
  const page2 = [mts(T - 200 * 60_000, "UA", "p2-only")];
  const window = await fetchDiscordBackscrollWindow(
    { channelId: "CH", triggerMessageId: sf(T + HOUR), isThread: false, botId: BOT },
    deps(pagingStub([page1, page2], rec)),
  );
  ok(rec.calls === 2, "a full page triggers a second fetch; the short page ends pagination");
  ok(window.some((m) => m.text === "p2-only") && window.length === 101, "both pages normalized + deduped (101 messages)");
}

{
  const rec = { calls: 0 };
  const page1 = Array.from({ length: 100 }, (_, k) => mts(T - k * 60_000, "UA", `f-${k}`));
  const window = await fetchDiscordBackscrollWindow(
    { channelId: "CH", triggerMessageId: sf(T), isThread: false, botId: BOT, reachbackHours: 1 },
    deps(pagingStub([page1, page1], rec)),
  );
  ok(rec.calls === 1, "pagination stops once a page reaches past the reachback floor");
  ok(window.every((m) => m.ms >= T - 1 * HOUR), "messages older than the reachback floor are excluded from the window");
}

{
  const throwing = deps(async () => {
    throw new Error("discord down");
  });
  ok((await fetchDiscordBackscrollWindow({ channelId: "CH", triggerMessageId: sf(T), isThread: false, botId: BOT }, throwing)).length === 0, "window: throwing requester → [] (never fails the wake)");
  ok((await fetchDiscordWakeEnvelopeBackscroll({ channelId: "CH", triggerMessageId: sf(T), isThread: false, botId: BOT }, throwing)).length === 0, "envelope backscroll: throwing requester → []");
  ok((await fetchDiscordBackscrollWindow({ channelId: "CH", triggerMessageId: sf(T), isThread: false }, deps(async () => undefined))).length === 0, "window: undefined response (no token) → []");
  ok((await fetchDiscordBackscrollWindow({ channelId: "CH", triggerMessageId: sf(T), isThread: false }, deps(async () => ({ not: "an array" })))).length === 0, "window: non-array junk → []");
  ok((await fetchDiscordWakeEnvelopeBackscroll({ channelId: "CH", triggerMessageId: sf(T), isThread: false }, deps(pagingStub([[]])))).length === 0, "envelope backscroll: empty history → []");
}

console.log(`✓ discord-backscroll: ${n} assertions passed (flat name-drop path + neutral-core window/envelope adapter: snowflake time + visibility gate + sender mapping + thread tagging + single/multi cluster <session> + pagination + reachback floor + fail-soft)`);
