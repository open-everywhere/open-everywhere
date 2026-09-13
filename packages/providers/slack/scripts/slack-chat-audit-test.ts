import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

const tmp = mkdtempSync(join(tmpdir(), "oe-slack-chat-audit-"));
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
  c.set(SessionKey, { sessionId: "chat-audit-test", auth: null, turn: { id: "t1", sequence: 1 }, parent: undefined });
  return contextStorage.run(c, fn);
};

const { readAudit, deploymentOrg, markRepliedThisTurn, NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/adapter-api.js");

async function replyPosts(platform: string): Promise<Array<{ detail?: Record<string, unknown> }>> {
  return (await readAudit({ org: deploymentOrg(), action: "reply.post" })).filter((r) => r.platform === platform);
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
  ok((await readAudit({ org: deploymentOrg(), action: "slack.no_reply" })).length === 0, "slack: a supervisor judged silence writes NO slack.no_reply row (actions-only)");
  ok(posts.length === 0, "slack: the judged silence posts NOTHING (silence stays silence)");

  await completed("here's the answer", ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }));
  const sp = await replyPosts("slack");
  ok(sp.length === 1, "slack: a terminal-prose reply writes exactly ONE reply.post row (choke point)");
  ok(sp[0]!.detail?.route === "terminal" && sp[0]!.detail?.chars === "here's the answer".length, "slack: the reply.post row carries route:\"terminal\" + chars");
  ok(sp[0]!.detail?.sessionId === "chat-audit-test", "slack: the reply.post row STAMPS the eve sessionId (audit→transcript join key)");
  ok((await readAudit({ org: deploymentOrg(), action: "slack.replied" })).length === 0, "slack: the legacy slack.replied row is GONE (folded into reply.post)");

  await inSession(async () => {
    markRepliedThisTurn("t1");
    await slackChannel.adapter["message.completed"]!({ finishReason: "stop", message: "" }, ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }));
  });
  ok((await replyPosts("slack")).length === 1, "slack: a reply-tool turn's empty terminal writes NO terminal reply.post row");
  ok((await readAudit({ org: deploymentOrg(), action: "slack.no_reply" })).length === 0, "slack: a reply-tool turn's empty terminal writes NO slack.no_reply row");
}


console.log(`✓ slack-chat-audit: ${passed} assertions passed (judged silence rowless · one terminal reply.post row · reply-tool empty terminal rowless)`);
