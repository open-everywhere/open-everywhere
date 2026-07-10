import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-reply-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.DISCORD_BOT_TOKEN = "discord-test-token";
process.env.NOTION_API_KEY = "ntn-test-key";

const reply = (await import("../agent/tools/reply.js")).default;
const updateReply = (await import("../agent/tools/update_reply.js")).default;
const { resolveReplyTarget } = await import("../agent/channels/reply-post.js");
const { markRepliedThisTurn, consumeRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const { isBareStop, finalMessageActionForTurn } = await import("../agent/channels/slack-events.js");
const { renderSupervisorPersona } = await import("../agent/instructions/access.js");
const { readAudit } = await import("../agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let slackResponse: Record<string, unknown> = { ok: true, ts: "9999.0001" };
let discordResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "d-9001" } };
let notionResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "notion-comment-1" } };
const realFetch = globalThis.fetch;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url: u, method: init?.method ?? "GET", body });
    if (u.includes("discord.com")) {
      return { ok: discordResponse.status >= 200 && discordResponse.status < 300, status: discordResponse.status, json: async () => discordResponse.body } as Response;
    }
    if (u.includes("api.notion.com")) {
      return { ok: notionResponse.status >= 200 && notionResponse.status < 300, status: notionResponse.status, json: async () => notionResponse.body } as Response;
    }
    return { ok: true, status: 200, json: async () => slackResponse } as Response;
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

function slackCtx(channelId: string | undefined, threadTs?: string) {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: "T1",
            ...(channelId ? { channel_id: channelId } : {}),
            ...(threadTs ? { thread_ts: threadTs } : {}),
            channel_type: "channel",
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  };
}
function discordCtx(channelId: string | undefined) {
  return {
    channel: { kind: "discord" },
    session: {
      auth: {
        current: {
          attributes: { guild_id: "G1", ...(channelId ? { channel_id: channelId } : {}), channel_type: "0" },
          principalId: "U2",
          principalType: "discord-user",
        },
      },
    },
  };
}
function notionCtx(discussionId: string | undefined) {
  return {
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: {
            workspace_id: "W1",
            page_id: "P1",
            ...(discussionId ? { discussion_id: discussionId } : {}),
          },
          principalId: "U3",
          principalType: "notion-user",
        },
      },
    },
  };
}

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ArmedTool {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}
const armReply = (react: unknown, ctx: unknown): ArmedTool | null =>
  (react as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as ArmedTool | null;

ok(armReply(reply, { channel: { kind: "slack" } }) !== null, "reply arms on a Slack session");
ok(armReply(reply, { channel: { kind: "discord" } }) !== null, "reply arms on a Discord session");
ok(armReply(reply, { channel: { kind: "discord-gateway" } }) !== null, "reply arms on a Discord gateway session (alias → discord)");
ok(armReply(reply, { channel: { kind: "teams" } }) === null, "reply is hidden on Teams (no silent-edit primitive)");
ok(armReply(reply, { channel: { kind: "telegram" } }) === null, "reply is hidden on Telegram");
ok(armReply(reply, { channel: { kind: "notion" } }) !== null, "reply arms on a Notion session (mid-turn post via createCommentReply)");
ok(armReply(updateReply, { channel: { kind: "slack" } }) !== null, "update_reply arms on a Slack session");
ok(armReply(updateReply, { channel: { kind: "discord" } }) !== null, "update_reply arms on a Discord session");
ok(armReply(updateReply, { channel: { kind: "teams" } }) === null, "update_reply is hidden on Teams");
ok(armReply(updateReply, { channel: { kind: "notion" } }) === null, "update_reply is hidden on Notion (no silent-edit primitive)");

{
  const notionArmed = armReply(reply, { channel: { kind: "notion" } });
  ok(notionArmed !== null && /FINAL/.test(notionArmed.description) && !/edit a status message with/.test(notionArmed.description), "reply: Notion description says posts are FINAL, no update_reply");
  const slackArmed = armReply(reply, { channel: { kind: "slack" } });
  ok(slackArmed !== null && /`update_reply` to silently edit/.test(slackArmed.description), "reply: Slack description points at update_reply for silent status edits");
}

{
  const slackTarget = resolveReplyTarget(slackCtx("C1", "111.222") as never);
  ok(slackTarget?.platform === "slack" && slackTarget.channelId === "C1" && slackTarget.threadTs === "111.222", "resolveReplyTarget: slack carries channel + thread");
  const slackTop = resolveReplyTarget(slackCtx("C1") as never);
  ok(slackTop?.platform === "slack" && slackTop.threadTs === undefined, "resolveReplyTarget: a top-level slack trigger has no threadTs (posts top-level)");
  const discordTarget = resolveReplyTarget(discordCtx("D1") as never);
  ok(discordTarget?.platform === "discord" && discordTarget.channelId === "D1" && (discordTarget as { threadTs?: string }).threadTs === undefined, "resolveReplyTarget: discord carries channel, never a threadTs");
  const notionTarget = resolveReplyTarget(notionCtx("disc-1") as never);
  ok(notionTarget?.platform === "notion" && (notionTarget as { discussionId: string }).discussionId === "disc-1", "resolveReplyTarget: notion carries the discussion id (the reply anchor)");
  ok(resolveReplyTarget(notionCtx(undefined) as never) === null, "resolveReplyTarget: a discussion-less notion ctx → null (no anchor to post to)");
  ok(resolveReplyTarget({ channel: { kind: "teams" } } as never) === null, "resolveReplyTarget: off-surface → null");
  ok(resolveReplyTarget(slackCtx(undefined) as never) === null, "resolveReplyTarget: a channel-less slack ctx → null");
}

{
  markRepliedThisTurn();
  ok(consumeRepliedThisTurn() === false, "reply-signal: outside an Eve context, mark/consume are no-ops (fail-soft)");
  await inSession(async () => {
    markRepliedThisTurn();
    ok(consumeRepliedThisTurn() === true, "reply-signal: mark then consume in the SAME session reads true");
    ok(consumeRepliedThisTurn() === false, "reply-signal: consuming resets it");
  });
  await inSession(async () => {
    ok(consumeRepliedThisTurn() === false, "reply-signal: a fresh session never sees a prior session's mark");
  });
}

calls = [];
slackResponse = { ok: true, ts: "222.333" };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, slackCtx("C1", "111.222"))!;
  const res = await armed.execute({ text: "here's the answer" }, slackCtx("C1", "111.222"));
  ok(res.posted === true && res.id === "222.333", "reply: returns the posted message ts as `id`");
  ok(calls.length === 1 && calls[0].url.endsWith("/chat.postMessage"), "reply: posts via chat.postMessage");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("channel") === "C1" && params.get("thread_ts") === "111.222" && params.get("text") === "here's the answer", "reply: posts channel/thread_ts/text");
  ok(consumeRepliedThisTurn() === true, "reply: marks the per-turn reply-signal");
  ok(
    isBareStop({ kind: "silent", reason: "empty final message" }, true) === false,
    "reply: a mid-turn reply then an empty completion is NOT a bare stop (posting didn't end the turn)",
  );
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.length === 1 && audit[0]?.detail?.id === "222.333" && audit[0]?.detail?.platform === "slack", "reply: audits one reply.post row with id + platform");
});
restoreHttp();

ok(isBareStop({ kind: "silent", reason: "empty final message" }, false) === true, "isBareStop: an empty completion with no action IS a bare stop");
{
  const act = finalMessageActionForTurn("stop", "the final answer");
  ok(act.kind === "post" && act.text === "the final answer", "dual-mode: eve's terminal completion text still posts (fallback preserved)");
}

calls = [];
slackResponse = { ok: true };
fakeHttp();
await inSession(async () => {
  const armed = armReply(updateReply, slackCtx("C1", "111.222"))!;
  const res = await armed.execute({ id: "222.333", text: "updated status" }, slackCtx("C1", "111.222"));
  ok(res.updated === true && res.id === "222.333", "update_reply: returns the edited message id");
  ok(calls.length === 1 && calls[0].url.endsWith("/chat.update"), "update_reply: edits via chat.update (silent — no notification)");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("channel") === "C1" && params.get("ts") === "222.333" && params.get("text") === "updated status", "update_reply: targets the prior ts with new text");
  ok(consumeRepliedThisTurn() === true, "update_reply: also marks the reply-signal (a silent edit still acted)");
});
restoreHttp();

calls = [];
discordResponse = { status: 200, body: { id: "d-42" } };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, discordCtx("D1"))!;
  const res = await armed.execute({ text: "discord answer" }, discordCtx("D1"));
  ok(res.posted === true && res.id === "d-42", "reply: on Discord returns the created message id");
  ok(calls.length === 1 && calls[0].method === "POST" && calls[0].url.includes("/channels/D1/messages"), "reply: on Discord POSTs to /channels/{id}/messages");
  ok(calls[0].body.includes("discord answer"), "reply: Discord body carries the content");
});
restoreHttp();

calls = [];
discordResponse = { status: 200, body: {} };
fakeHttp();
await inSession(async () => {
  const armed = armReply(updateReply, discordCtx("D1"))!;
  const res = await armed.execute({ id: "d-42", text: "edited" }, discordCtx("D1"));
  ok(res.updated === true, "update_reply: on Discord resolves ok");
  ok(calls.length === 1 && calls[0].method === "PATCH" && calls[0].url.includes("/channels/D1/messages/d-42"), "update_reply: on Discord PATCHes /channels/{id}/messages/{messageId} (silent edit)");
});
restoreHttp();

calls = [];
notionResponse = { status: 200, body: { id: "notion-comment-42" } };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, notionCtx("disc-1"))!;
  const res = await armed.execute({ text: "notion answer" }, notionCtx("disc-1"));
  ok(res.posted === true && res.id === "notion-comment-42", "reply: on Notion returns the created comment id");
  ok(calls.length === 1 && calls[0].method === "POST" && calls[0].url.includes("api.notion.com") && calls[0].url.endsWith("/v1/comments"), "reply: on Notion POSTs to /v1/comments");
  const payload = JSON.parse(calls[0].body) as { discussion_id?: string; rich_text?: Array<{ text?: { content?: string } }> };
  ok(payload.discussion_id === "disc-1", "reply: on Notion posts into the SAME discussion (the thread it was woken on)");
  ok(payload.rich_text?.[0]?.text?.content === "notion answer", "reply: on Notion carries the model text as rich text");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "notion" && r.detail?.id === "notion-comment-42"), "reply: audits a reply.post row stamped platform=notion");
});
restoreHttp();

await inSession(async () => {
  const armed = armReply(reply, notionCtx(undefined))!;
  await assert.rejects(() => armed.execute({ text: "x" }, notionCtx(undefined)), /couldn't resolve/, "reply: a Notion ctx with no discussion id throws an honest error");
  n++;
});

calls = [];
slackResponse = { ok: false, error: "channel_not_found" };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, slackCtx("C1", "111.222"))!;
  await assert.rejects(() => armed.execute({ text: "x" }, slackCtx("C1", "111.222")), /channel_not_found/, "reply: a Slack API error surfaces as a real tool error");
  n++;
  ok(consumeRepliedThisTurn() === false, "reply: a failed post never marks the signal");
});
restoreHttp();

{
  const supervisorCtx = { channel: { kind: "slack", continuationToken: "oe-sup:g3" } };
  const persona = renderSupervisorPersona(supervisorCtx as never);
  ok(persona.includes("### Reporting") && persona.includes("`update_reply`"), "persona: the reply/silent-edit paragraph renders for a supervisor session");
  ok(persona.includes("edits silently") && persona.includes("Never edit a result into a status"), "persona: the paragraph carries the notify-vs-silent-edit discipline");
  ok(renderSupervisorPersona({ channel: { kind: "slack" } } as never) === "", "persona: renders NOTHING for a non-supervisor Slack session");
  ok(renderSupervisorPersona({ channel: { kind: "discord" } } as never) === "", "persona: renders nothing for a non-supervisor session on another surface");
}

console.log(`\n✓ reply: ${n} assertions passed (gate, target, signal, reply/update on slack+discord, dual-mode, persona)\n`);
