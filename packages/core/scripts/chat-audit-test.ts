import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "oe-chat-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST"]) {
  delete process.env[k];
}
delete process.env.OE_AUDIT_SILENCES;
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.VERCEL;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

type AdapterChannel = { adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>> };

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "chat-audit-test", auth: null, turn: 1, parent: undefined });
  return contextStorage.run(c, fn);
};

const { readAudit } = await import("../agent/audit/audit.js");
const { markRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const { NO_REPLY_SENTINEL } = await import("../agent/channels/turn-delivery.js");

async function replyPosts(platform: string): Promise<Array<{ detail?: Record<string, unknown> }>> {
  return (await readAudit({ action: "reply.post" })).filter((r) => r.platform === platform);
}

{
  const slackChannel = (await import("../agent/channels/slack.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => slackChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const posts: string[] = [];
  const fakeSlack = { channelId: "C_AUD", threadTs: "1752501000.000100", request: async () => ({}) };
  const ctxFor = (state: Record<string, unknown>) => ({
    state,
    thread: { post: async (t: string) => void posts.push(t), startTyping: async () => undefined },
    slack: fakeSlack,
  });

  await completed(NO_REPLY_SENTINEL, ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "oe-sup:g1", oeSupervisor: true, oeUninvited: true }));
  ok((await readAudit({ action: "slack.no_reply" })).length === 0, "slack: a supervisor judged silence writes NO slack.no_reply row (actions-only)");
  ok(posts.length === 0, "slack: the judged silence posts NOTHING (silence stays silence)");

  await completed("here's the answer", ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }));
  const sp = await replyPosts("slack");
  ok(sp.length === 1, "slack: a terminal-prose reply writes exactly ONE reply.post row (choke point)");
  ok(sp[0]!.detail?.route === "terminal" && sp[0]!.detail?.chars === "here's the answer".length, "slack: the reply.post row carries route:\"terminal\" + chars");
  ok(sp[0]!.detail?.sessionId === "chat-audit-test", "slack: the reply.post row STAMPS the eve sessionId (audit→transcript join key)");
  ok((await readAudit({ action: "slack.replied" })).length === 0, "slack: the legacy slack.replied row is GONE (folded into reply.post)");

  await inSession(async () => {
    markRepliedThisTurn();
    await slackChannel.adapter["message.completed"]!({ finishReason: "stop", message: "" }, ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }));
  });
  ok((await replyPosts("slack")).length === 1, "slack: a reply-tool turn's empty terminal writes NO terminal reply.post row");
  ok((await readAudit({ action: "slack.no_reply" })).length === 0, "slack: a reply-tool turn's empty terminal writes NO slack.no_reply row");
}

{
  const discordChannel = (await import("../agent/channels/discord.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => discordChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const posts: string[] = [];
  const ctx = { state: { channelId: "C_D1", guildId: "G_D1", conversationId: null }, discord: { post: async (t: string) => void posts.push(t) } };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ action: "discord.no_reply" })).length === 0, "discord: a judged silence writes NO discord.no_reply row (actions-only)");

  await completed("rolled back to v42", ctx);
  const dp = await replyPosts("discord");
  ok(dp.length === 1 && dp[0]!.detail?.route === "terminal" && dp[0]!.detail?.chars === "rolled back to v42".length, "discord: a terminal-prose reply writes ONE reply.post row (route:terminal)");
  ok((await readAudit({ action: "discord.replied" })).length === 0, "discord: the legacy discord.replied row is GONE");
}

{
  const gateway = (await import("../agent/channels/discord-gateway.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => gateway.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const ctx = { channelId: "C_G1", state: { channelId: "C_G1", guildId: "G_G1" } };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ action: "discord.no_reply" })).length === 0, "discord gateway: an ambient judged silence writes NO discord.no_reply row (actions-only)");
}

{
  const teamsChannel = (await import("../agent/channels/teams.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => teamsChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const posts: string[] = [];
  const ctx = {
    state: { conversationId: "19:conv1", tenantId: "TEN1", channelId: "19:chan1", teamId: "TEAM1", conversationType: "channel", serviceUrl: "https://smba.test.local", replyToActivityId: "act-root-1" },
    thread: { post: async (t: string) => void posts.push(t) },
  };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ action: "teams.no_reply" })).length === 0, "teams: a judged silence writes NO teams.no_reply row (actions-only)");

  await completed("done — deployed", ctx);
  const tp = await replyPosts("teams");
  ok(tp.length === 1 && tp[0]!.detail?.route === "terminal" && tp[0]!.detail?.chars === "done — deployed".length, "teams: a terminal-prose reply writes ONE reply.post row (route:terminal, choke point via serviceUrl+replyToActivityId)");
  ok((await readAudit({ action: "teams.replied" })).length === 0, "teams: the legacy teams.replied row is GONE");
}

{
  const telegramChannel = (await import("../agent/channels/telegram.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => telegramChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const posts: string[] = [];
  const ctx = {
    state: { chatId: "-100555", chatType: "supergroup", messageThreadId: null },
    telegram: { chatId: "-100555", post: async (t: string) => void posts.push(t) },
  };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ action: "telegram.no_reply" })).length === 0, "telegram: a judged silence writes NO telegram.no_reply row (actions-only)");

  await completed("watch fired: build green", ctx);
  const gp = await replyPosts("telegram");
  ok(gp.length === 1 && gp[0]!.detail?.route === "terminal" && gp[0]!.detail?.chars === "watch fired: build green".length, "telegram: a terminal-prose reply writes ONE reply.post row (route:terminal)");
  ok((await readAudit({ action: "telegram.replied" })).length === 0, "telegram: the legacy telegram.replied row is GONE");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`chat-audit tests passed (${passed})`);
