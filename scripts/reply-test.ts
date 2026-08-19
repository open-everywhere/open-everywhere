import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
import { registerSlackProvider as __regSlack } from "@open-everywhere/provider-slack/agent/register.js";
__regDiscord();
__regSlack();
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
process.env.MICROSOFT_APP_ID = "teams-app-id";
process.env.MICROSOFT_APP_PASSWORD = "teams-app-secret";
process.env.LINEAR_API_KEY = "linear-test-key";

const reply = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");
const { markRepliedThisTurn, consumeRepliedThisTurn } = await import("@open-everywhere/core/agent/channels/reply-signal.js");
const { isBareStop, finalMessageActionForTurn } = await import("@open-everywhere/core/agent/channels/turn-delivery.js");
const { renderSupervisorPersona } = await import("@open-everywhere/core/agent/instructions/access.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");

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
const TEAMS_SERVICE_URL = "https://smba.trafficmanager.net/uk/";
let calls: FetchCall[] = [];
let slackResponse: Record<string, unknown> = { ok: true, ts: "9999.0001" };
let discordResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "d-9001" } };
let teamsResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "" } };
let linearResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { data: { agentActivityCreate: { success: true, agentActivity: { id: "" } } } } };
const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url: u, method: init?.method ?? "GET", body });
    if (u.includes("discord.com")) return resp(discordResponse.status, discordResponse.body);
    if (u.includes("login.microsoftonline.com")) return resp(200, { token_type: "Bearer", expires_in: 3600, access_token: "teams-connector-token" });
    if (u.includes("smba.trafficmanager.net")) return resp(teamsResponse.status, teamsResponse.body);
    if (u.includes("api.linear.app")) return resp(linearResponse.status, linearResponse.body);
    return resp(200, slackResponse);
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

function slackCtx(channelId: string | undefined, threadTs?: string) {
  return {
    channel: { kind: "slack" },
    session: {
      turn: { id: "t1", sequence: 1 },
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
      turn: { id: "t1", sequence: 1 },
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
function teamsCtx(conversationId: string | undefined, serviceUrl: string | null = TEAMS_SERVICE_URL) {
  const svc = serviceUrl === null ? undefined : serviceUrl;
  return {
    channel: { kind: "teams" },
    session: {
      auth: {
        current: {
          attributes: {
            tenant_id: "TEN1",
            ...(conversationId ? { conversation_id: conversationId } : {}),
            ...(svc ? { service_url: svc } : {}),
            scope: "channel",
          },
          principalId: "U5",
          principalType: "teams-user",
        },
      },
    },
  };
}
function linearCtx(agentSessionId: string | undefined) {
  return {
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: {
            organization_id: "ORG1",
            ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
          },
          principalId: "LU1",
          principalType: "linear-user",
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
ok(armReply(reply, { channel: { kind: "notion" } }) === null, "reply is hidden on notion in core alone (bundle-registered manifest — fail-closed NONE default)");
ok(armReply(reply, { channel: { kind: "teams" } }) === null, "reply is hidden on teams in core alone (bundle-registered manifest — fail-closed NONE default)");
ok(armReply(reply, { channel: { kind: "linear" } }) === null, "reply is hidden on linear in core alone (bundle-registered manifest — fail-closed NONE default)");
ok(armReply(reply, { channel: { kind: "github" } }) === null, "reply is hidden on GitHub (eve exports no public proactive comment seam)");
ok(armReply(reply, { channel: { kind: "local" } }) === null, "reply is hidden on an unwired surface (local → NONE)");
{
  const discordArmed = armReply(reply, { channel: { kind: "discord" } });
  const slackArmed = armReply(reply, { channel: { kind: "slack" } });
  ok(discordArmed !== null && /FINAL/.test(discordArmed.description), "reply: description says posts are FINAL (no edit verb exists)");
  ok(slackArmed !== null && slackArmed.description === discordArmed!.description, "reply: ONE description on every surface (no per-surface silent-edit variant)");
  ok(!/update_reply/.test(discordArmed!.description), "reply: description never mentions the dropped update_reply verb");
}

{
  const slackTarget = resolveReplyTarget(slackCtx("C1", "111.222") as never);
  ok(slackTarget?.platform === "slack" && slackTarget.channelId === "C1" && slackTarget.threadTs === "111.222", "resolveReplyTarget: slack carries channel + thread");
  const slackTop = resolveReplyTarget(slackCtx("C1") as never);
  ok(slackTop?.platform === "slack" && slackTop.threadTs === undefined, "resolveReplyTarget: a top-level slack trigger has no threadTs (posts top-level)");
  const discordTarget = resolveReplyTarget(discordCtx("D1") as never);
  ok(discordTarget?.platform === "discord" && discordTarget.channelId === "D1" && (discordTarget as { threadTs?: string }).threadTs === undefined, "resolveReplyTarget: discord carries channel, never a threadTs");
  ok(resolveReplyTarget({ channel: { kind: "notion" } } as never) === null, "resolveReplyTarget: notion → null in core alone (arm is bundle-registered)");

  ok(resolveReplyTarget(teamsCtx("conv-1") as never) === null, "resolveReplyTarget: teams → null in core alone (arm is bundle-registered)");

  ok(resolveReplyTarget({ channel: { kind: "github" } } as never) === null, "resolveReplyTarget: github → null (midTurnPost gate is false)");

  ok(resolveReplyTarget(linearCtx("as-1") as never) === null, "resolveReplyTarget: linear → null in core alone (arm is bundle-registered)");

  ok(resolveReplyTarget({ channel: { kind: "local" } } as never) === null, "resolveReplyTarget: an unwired surface → null");
  ok(resolveReplyTarget(slackCtx(undefined) as never) === null, "resolveReplyTarget: a channel-less slack ctx → null");
}

{
  markRepliedThisTurn("t1");
  ok(consumeRepliedThisTurn("t1") === false, "reply-signal: outside an Eve context, mark/consume are no-ops (fail-soft)");
  await inSession(async () => {
    markRepliedThisTurn("t1");
    ok(consumeRepliedThisTurn("t1") === true, "reply-signal: mark then consume for the SAME turn id reads true");
    ok(consumeRepliedThisTurn("t1") === false, "reply-signal: consuming resets it");
  });
  await inSession(async () => {
    ok(consumeRepliedThisTurn("t1") === false, "reply-signal: a fresh session never sees a prior session's mark");
  });
  await inSession(async () => {
    markRepliedThisTurn("t1");
    ok(consumeRepliedThisTurn("t2") === false, "🔴 OPE-805: a DIFFERENT turn id (t2, same session) never reads an earlier turn's unconsumed mark as its own");
  });
  await inSession(async () => {
    markRepliedThisTurn(undefined);
    ok(consumeRepliedThisTurn(undefined) === false, "reply-signal: no turn id to mark with, no turn id to read against — never a false true");
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
  ok(consumeRepliedThisTurn("t1") === true, "reply: marks the per-turn reply-signal");
  ok(
    isBareStop({ kind: "silent", reason: "empty final message" }, true) === false,
    "reply: a mid-turn reply then an empty completion is NOT a bare stop (posting didn't end the turn)",
  );
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.length === 1 && audit[0]?.detail?.id === "222.333" && audit[0]?.detail?.platform === "slack", "reply: audits one reply.post row with id + platform");
  ok(audit[0]?.detail?.route === "tool" && audit[0]?.detail?.chars === 17, "reply: the choke-point reply.post row carries route:\"tool\" + chars (single owner, no tool-layer duplicate)");
});
restoreHttp();

ok(isBareStop({ kind: "silent", reason: "empty final message" }, false) === true, "isBareStop: an empty completion with no action IS a bare stop");
{
  const act = finalMessageActionForTurn("stop", "the final answer");
  ok(act.kind === "post" && act.text === "the final answer", "dual-mode: eve's terminal completion text still posts (fallback preserved)");
}

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
slackResponse = { ok: false, error: "channel_not_found" };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, slackCtx("C1", "111.222"))!;
  await assert.rejects(() => armed.execute({ text: "x" }, slackCtx("C1", "111.222")), /channel_not_found/, "reply: a Slack API error surfaces as a real tool error");
  n++;
  ok(consumeRepliedThisTurn("t1") === false, "reply: a failed post never marks the signal");
});
restoreHttp();

{
  const supervisorCtx = { channel: { kind: "slack", continuationToken: "oe-sup:g3" } };
  const persona = renderSupervisorPersona(supervisorCtx as never);
  ok(persona.includes("### Reporting") && persona.includes("`reply`"), "persona: the Reporting paragraph renders for a supervisor session");
  ok(persona.includes("never a mere progress tick") && persona.includes("one curated message"), "persona: the paragraph carries the result/question/blocker + don't-stack discipline");
  ok(!persona.includes("update_reply"), "persona: never mentions the dropped update_reply verb");
  ok(renderSupervisorPersona({ channel: { kind: "slack" } } as never) === "", "persona: renders NOTHING for a non-supervisor Slack session");
  ok(renderSupervisorPersona({ channel: { kind: "discord" } } as never) === "", "persona: renders nothing for a non-supervisor session on another surface");
}

{
  const { registerPostArm, postArm } = await import("@open-everywhere/core/agent/channels/post-arms.js");
  const { postReply } = await import("@open-everywhere/core/agent/channels/reply-post.js");
  type ReplyTargetT = Parameters<typeof postReply>[0];
  let fakeGot: string | undefined;
  registerPostArm({ platform: "fake-surface", dispatchReply: async (_t, text) => { fakeGot = text; return `fake-${text.length}`; } });
  ok(postArm("fake-surface") !== undefined, "post-arms: a registered fake arm is retrievable by platform key");
  const fakeId = await postReply({ platform: "fake-surface" } as unknown as ReplyTargetT, "hi");
  ok(fakeId === "fake-2" && fakeGot === "hi", "post-arms: postReply dispatches a mid-turn reply to the registered fake arm (returns its id)");
  let threw = false;
  try {
    await postReply({ platform: "no-such-surface" } as unknown as ReplyTargetT, "x");
  } catch {
    threw = true;
  }
  ok(threw, "post-arms: an UNREGISTERED platform refuses (throws) — never a silent/mis-routed post");
}

console.log(`\n✓ reply: ${n} assertions passed (gate, target, signal, reply on all wired surfaces, dual-mode, persona, post-arm registry)\n`);
