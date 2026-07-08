import assert from "node:assert/strict";
import {
  fetchDiscordBackscroll,
  linesFromDiscordMessages,
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

console.log(`✓ discord-backscroll: ${n} assertions passed (before=<trigger> + since-last-agent slice + cold-thread + base last-N + N cap + system/empty skip + agent self-attribution + untrusted wrap + no-hint + fail-soft)`);
