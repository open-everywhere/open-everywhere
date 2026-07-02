import assert from "node:assert/strict";
import { loadConversationContext, _resetBotIdentityCache } from "../agent/channels/slack-context.js";
import { UNTRUSTED_OPEN } from "../agent/access/untrusted.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

type ThreadMsg = { ts: string; threadTs: string; user?: string; botId?: string; text: string; markdown: string; isMe: boolean; raw: Record<string, unknown> };
const tm = (ts: string, user: string, text: string, isMe = false): ThreadMsg => ({ ts, threadTs: "1.1", user, text, markdown: text, isMe, raw: {} });

function fakeCtx(opts: { recent?: ThreadMsg[]; history?: Array<Record<string, unknown>>; authTest?: Record<string, unknown> }) {
  _resetBotIdentityCache();
  return {
    thread: {
      recentMessages: opts.recent ?? [],
      refresh: async () => {},
    },
    slack: {
      channelId: "C_TXN",
      threadTs: "",
      teamId: "T_ENG",
      request: async (op: string) => {
        if (op === "conversations.history") return { ok: true, messages: opts.history ?? [] };
        if (op === "auth.test") return opts.authTest ?? { ok: false, error: "unexpected_op" };
        return { ok: false, error: "unexpected_op" };
      },
    },
  } as never;
}

const msg = (ts: string, threadTs: string) => ({ ts, threadTs, channelId: "C_TXN", text: "", markdown: "", teamId: "T_ENG", author: undefined, attachments: [], raw: {} }) as never;

{
  const recent = [tm("1.1", "UA", "root question"), tm("1.2", "UB", "a detail"), tm("1.3", "BOT", "agent answer", true), tm("1.4", "UC", "a follow-up")];
  const ctx = fakeCtx({ recent });
  const out = await loadConversationContext(ctx, msg("1.5", "1.1"));
  ok(out.length === 1, "thread path returns one context entry");
  ok(out[0].startsWith(UNTRUSTED_OPEN), "thread context is untrusted-wrapped");
  ok(out[0].includes("a follow-up"), "includes the message after the agent's last reply");
  ok(!out[0].includes("root question") && !out[0].includes("agent answer"), "excludes everything up to & including the agent's last reply");
}

{
  const recent = [tm("1.1", "UA", "first"), tm("1.2", "UB", "second")];
  const out = await loadConversationContext(fakeCtx({ recent }), msg("1.3", "1.1"));
  ok(out.length === 1 && out[0].includes("first") && out[0].includes("second"), "fresh thread → all prior messages (thread-root behavior)");
}

{
  const history = [
    { type: "message", user: "UC", ts: "0.3", text: "newest" },
    { type: "message", user: "UB", ts: "0.2", text: "middle" },
    { subtype: "channel_join", user: "UD", ts: "0.15", text: "joined" },
    { type: "message", user: "UA", ts: "0.1", text: "oldest" },
  ];
  const out = await loadConversationContext(fakeCtx({ history }), msg("0.4", "0.4"));
  ok(out.length === 1 && out[0].startsWith(UNTRUSTED_OPEN), "channel path returns one untrusted entry");
  ok(out[0].indexOf("oldest") < out[0].indexOf("middle") && out[0].indexOf("middle") < out[0].indexOf("newest"), "rendered oldest-first");
  ok(!out[0].includes("joined"), "system subtype messages are dropped");
}

{
  const history = [
    { type: "message", user: "UH", ts: "0.1", text: "human says hi" },
    { type: "message", bot_id: "BOTHER", ts: "0.2", text: "another bot" },
    { type: "message", user: "UME", ts: "0.3", text: "my post by user id" },
    { type: "message", bot_id: "BME", ts: "0.4", text: "my post by bot id" },
  ];
  const out = await loadConversationContext(fakeCtx({ history, authTest: { ok: true, user_id: "UME", bot_id: "BME" } }), msg("0.5", "0.5"));
  ok(out.length === 1, "attribution: one entry");
  ok(out[0].includes("[sender_type=user sender_id=UH] human says hi"), "human → sender_type=user with id");
  ok(out[0].includes("[sender_type=bot sender_id=BOTHER] another bot"), "other bot → sender_type=bot with id");
  ok(out[0].includes("[sender_type=agent] my post by user id"), "own post (by user id) → sender_type=agent");
  ok(out[0].includes("[sender_type=agent] my post by bot id"), "own post (by bot id) → sender_type=agent");
  ok(!out[0].includes("sender_id=UME") && !out[0].includes("sender_id=BME"), "agent lines carry no sender_id (not flattened to a foreign speaker)");
}

{
  const history = [{ type: "message", bot_id: "BME", ts: "0.1", text: "mine but unresolved" }];
  const out = await loadConversationContext(fakeCtx({ history }), msg("0.5", "0.5"));
  ok(out[0].includes("[sender_type=bot sender_id=BME] mine but unresolved"), "unresolved identity → own post attributed as bot (best-effort)");
}

{
  ok((await loadConversationContext(fakeCtx({ history: [] }), msg("0.4", "0.4"))).length === 0, "empty channel history → no context");
  ok((await loadConversationContext(fakeCtx({ recent: [] }), msg("1.3", "1.1"))).length === 0, "empty thread → no context");
}

console.log(`✓ slack-context: ${n} assertions passed (thread catch-up + channel backscroll + untrusted wrap)`);
