import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { mkdtempSync } from "node:fs";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _resetDeploymentIdentityForTest, deploymentOrg } from "@open-everywhere/core/agent/identity/deployment-identity.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";
// eve 1.x's channel wrapper reads the session view from the adapter context, or else from a live
// projection. A direct call carries an empty view.
const v27Completed = (adapter: object) => async (event: unknown, ctx: unknown): Promise<void> => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = createRequire(import.meta.url).resolve("eve/package.json").replace(/package\.json$/u, "");
  const fold = (await import(pathToFileURL(`${eveRoot}dist/src/protocol/session-projection/fold.js`).href)) as { emptySessionView: () => unknown };
  const handler = (adapter as Record<string, (e: unknown, c: unknown) => Promise<unknown>>)["content.completed"]!;
  await handler(event, { ...(ctx as object), view: fold.emptySessionView() });
};
// eve 1.x delivers a final message as `content.completed` (a text part in the "reply" phase).
const asV27Content = (f: { readonly finishReason: string; readonly message: string | null; readonly turnId?: string }) => ({
  type: "content.completed" as const,
  ...(f.turnId !== undefined ? { scope: { turnId: f.turnId } } : {}),
  data: { partId: "part-1", kind: "text", phase: f.finishReason === "stop" ? "reply" : "narration", value: f.message ?? "" },
});


const tmp = mkdtempSync(join(tmpdir(), "oe-chat-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}
__setTestValveForTest("egress-spoof", true);
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
  return (await readAudit({ org: deploymentOrg(), action: "reply.post" })).filter((r) => r.platform === platform);
}

{
  const discordChannel = (await import("@open-everywhere/provider-discord/agent/channels/discord.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => v27Completed(discordChannel.adapter)(asV27Content({ finishReason: "stop", message }), ctx));
  const posts: string[] = [];
  const ctx = { state: { channelId: "C_D1", guildId: "G_D1", conversationId: null }, discord: { post: async (t: string) => void posts.push(t) } };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ org: deploymentOrg(), action: "discord.no_reply" })).length === 0, "discord: a judged silence writes NO discord.no_reply row (actions-only)");

  await completed("rolled back to v42", ctx);
  ok((await replyPosts("discord")).length === 0, "🔴 OPE-2006: a discord turn that ends in prose writes NO reply.post row — nothing left the host, so nothing may be counted as delivered");
  const ddrop = (await readAudit({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "discord");
  ok(
    ddrop.length === 1 && ddrop[0]!.detail?.chars === "rolled back to v42".length && ddrop[0]!.detail?.channelId === "C_D1",
    "🔴 OPE-2006: …and ONE drop row records it, with the char count and the channel the answer was owed to",
  );
  ok(posts.length === 0, "🔴 OPE-2006: …and the raw channel.discord.post fallback posted nothing either — the drop has no second door");
  ok((await readAudit({ org: deploymentOrg(), action: "discord.replied" })).length === 0, "discord: the legacy discord.replied row is GONE");
}

{
  const gateway = (await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => v27Completed(gateway.adapter)(asV27Content({ finishReason: "stop", message }), ctx));
  const ctx = { channelId: "C_G1", state: { channelId: "C_G1", guildId: "G_G1" } };

  await completed(NO_REPLY_SENTINEL, ctx);
  ok((await readAudit({ org: deploymentOrg(), action: "discord.no_reply" })).length === 0, "discord gateway: an ambient judged silence writes NO discord.no_reply row (actions-only)");
}

await removeTempDir(tmp);
console.log(`chat-audit tests passed (${passed})`);
