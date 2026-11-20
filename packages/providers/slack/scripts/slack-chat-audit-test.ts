// proves: slack.replied, slack.no_reply

import { __setTestValveForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

const tmp = mkdtempSync(join(tmpdir(), "oe-slack-chat-audit-"));
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
const { emptySessionView: rawEmptyView } = (await import(abs("dist/src/protocol/session-projection/fold.js"))) as { emptySessionView: () => unknown };
const replyEvent = (message: string | null) => ({ type: "content.completed", scope: { turnId: "t1" }, data: { partId: "p1", kind: "text", phase: "reply", value: message ?? "" } });
const inSession = <T>(fn: () => Promise<T>): Promise<T> => {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "chat-audit-test", auth: null, turn: { id: "t1", sequence: 1 }, parent: undefined });
  return contextStorage.run(c, fn);
};

const { readAudit, deploymentOrg, markRepliedThisTurn, NO_REPLY_SENTINEL, resolvePartition, getThreadEngagement } = await import("@open-everywhere/core/agent/adapter-api.js");

async function replyPosts(platform: string): Promise<Array<{ detail?: Record<string, unknown> }>> {
  return (await readAudit({ org: deploymentOrg(), action: "reply.post" })).filter((r) => r.platform === platform);
}

{
  const slackChannel = (await import("../agent/channels/slack.js")).default as unknown as AdapterChannel;
  const completed = (message: string | null, ctx: unknown) => inSession(() => slackChannel.adapter["content.completed"]!(replyEvent(message), { ...(ctx as object), view: rawEmptyView() }));
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
  ok((await replyPosts("slack")).length === 0, "🔴 OPE-2006: a slack turn that ends in prose writes NO reply.post row — that row counts DELIVERED messages, and nothing was delivered");
  ok(posts.length === 0, "🔴 OPE-2006: …and the raw channel.thread.post fallback posted nothing either — the drop has no second door");
  const dropped = (await readAudit({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "slack");
  ok(dropped.length === 1, "🔴 OPE-2006: …and ONE drop row records the lost answer, so a silence the host chose stays countable");
  ok(dropped[0]!.detail?.chars === "here's the answer".length && dropped[0]!.detail?.threadTs === "1752501000.000100", "slack: the drop row carries the char count and the thread the answer was owed to");
  ok(dropped[0]!.detail?.sessionId === "chat-audit-test", "slack: the drop row STAMPS the eve sessionId (audit→transcript join key)");
  ok(!JSON.stringify(dropped[0]!.detail).includes("the answer"), "🔴 OPE-2006: …and NOT the model's words — the drop row is taint-clean");
  ok((await readAudit({ org: deploymentOrg(), action: "slack.replied" })).length === 0, "slack: the legacy slack.replied row is GONE");

  await inSession(async () => {
    markRepliedThisTurn("t1");
    await slackChannel.adapter["content.completed"]!(replyEvent(""), { ...ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }), view: rawEmptyView() });
  });
  ok((await replyPosts("slack")).length === 0, "slack: a reply-tool turn's empty terminal writes no reply.post row here — the tool's own door wrote its row");
  ok((await readAudit({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "slack").length === 1, "🔴 negative control: an EMPTY terminal writes NO second drop row — a drop is prose that was lost, never every turn");
  ok((await readAudit({ org: deploymentOrg(), action: "slack.no_reply" })).length === 0, "slack: a reply-tool turn's empty terminal writes NO slack.no_reply row");

  const engPartition = resolvePartition({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T_AUD", channel_id: "C_AUD" }, principalId: "", principalType: "slack-user" } } },
  });
  ok(
    (await getThreadEngagement(engPartition, "1752501000.000100")) === null,
    "🔴 OPE-2006: a turn whose only output was DROPPED prose leaves the thread unengaged — nothing reached the room, so nothing was earned",
  );
  await inSession(async () => {
    markRepliedThisTurn("t1");
    await slackChannel.adapter["content.completed"]!(replyEvent("here's the answer"), { ...ctxFor({ channelId: "C_AUD", teamId: "T_AUD", threadTs: "1752501000.000100" }), view: rawEmptyView() });
  });
  const engaged = await getThreadEngagement(engPartition, "1752501000.000100");
  ok(engaged !== null, "🔴 POSITIVE CONTROL: a turn that DID deliver through the `reply` tool engages the thread — the promotion is still wired");
  ok(engaged?.participating === true, "POSITIVE CONTROL: …and it is the participating promotion, the one the drop must not earn");
}

console.log(`✓ slack-chat-audit: ${passed} assertions passed (judged silence rowless · closing prose dropped and rowed, never posted · reply-tool empty terminal rowless)`);
