import { mkdtempSync, rmSync } from "node:fs";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

const tmp = mkdtempSync(join(tmpdir(), "oe-chat-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}
overrideSettingsForTest({ audit: { silences: false } });
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

const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { markRepliedThisTurn } = await import("@open-everywhere/core/agent/channels/reply-signal.js");
const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/turn-delivery.js");

async function replyPosts(platform: string): Promise<Array<{ detail?: Record<string, unknown> }>> {
  return (await readAudit({ action: "reply.post" })).filter((r) => r.platform === platform);
}

{
  const discordChannel = (await import("@open-everywhere/provider-discord/agent/channels/discord.js")).default as unknown as AdapterChannel;
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
  const gateway = (await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => gateway.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const ctx = { channelId: "C_G1", state: { channelId: "C_G1", guildId: "G_G1" } };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ action: "discord.no_reply" })).length === 0, "discord gateway: an ambient judged silence writes NO discord.no_reply row (actions-only)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`chat-audit tests passed (${passed})`);
