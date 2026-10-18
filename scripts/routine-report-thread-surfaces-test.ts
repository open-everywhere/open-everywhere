import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";

registerSlackProvider();
registerTeamsProvider();
registerLinearProvider();
registerDiscordProvider();

const { reportReplyThreads, originOfReplyTarget } = await import("@open-everywhere/core/agent/routines/report-thread.js");
const { isThreadScopedWakeOrigin, unifiedThreadRef } = await import("@open-everywhere/core/agent/channels/unified-window.js");
type UnifiedWakeOrigin = import("@open-everywhere/core/agent/channels/unified-window.js").UnifiedWakeOrigin;
type ReplyTarget = import("@open-everywhere/core/agent/channels/reply-post.js").ReplyTarget;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function covers(post: UnifiedWakeOrigin, messageId: string, reply: UnifiedWakeOrigin): boolean {
  if (!isThreadScopedWakeOrigin(reply)) return false;
  const want = unifiedThreadRef(reply);
  return reportReplyThreads(post, messageId).some((r) => r.channelKey === want.channelKey && r.threadKey === want.threadKey);
}

const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const CHANNEL = "19:abcdef@thread.tacv2";

{
  const replyIn = (root: string): UnifiedWakeOrigin => ({ platform: "teams", serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=${root}`, replyToActivityId: root, tenantId: "t-1" });
  const top: UnifiedWakeOrigin = { platform: "teams", serviceUrl: SERVICE_URL, conversationId: CHANNEL };
  ok(covers(top, "1700000000001", replyIn("1700000000001")), "🔴 teams: a report at channel grain records the reply chain it opens");
  ok(!covers(top, "1700000000001", replyIn("1700000000999")), "teams: a reply in another chain is not covered");
  const inChain: UnifiedWakeOrigin = { platform: "teams", serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=1600000000000` };
  ok(covers(inChain, "1700000000002", replyIn("1600000000000")), "🔴 teams: a report sent into a chain id records that chain, not one under the post");
  ok(!covers(inChain, "1700000000002", replyIn("1700000000002")), "teams: …and no chain under the post, because a chain does not nest");
  const answered: UnifiedWakeOrigin = { ...inChain, replyToActivityId: "1600000000000" };
  ok(reportReplyThreads(answered, "1700000000003").length === 1 && covers(answered, "1700000000003", replyIn("1600000000000")), "teams: a report that names its chain root records that chain once");
  const groupChat: UnifiedWakeOrigin = { platform: "teams", serviceUrl: SERVICE_URL, conversationId: "19:group@thread.v2" };
  ok(reportReplyThreads(groupChat, "1700000000004").length === 0, "teams: a group chat has no reply chains, so a report there records nothing");
  const personal: UnifiedWakeOrigin = { platform: "teams", serviceUrl: SERVICE_URL, conversationId: "a:1personal" };
  ok(reportReplyThreads(personal, "1700000000005").length === 0, "teams: a personal chat records nothing");
}

{
  const report: UnifiedWakeOrigin = { platform: "linear", ambient: true, issueId: "iss-1", organizationId: "org-1" };
  const nested: UnifiedWakeOrigin = { platform: "linear", ambient: true, issueId: "iss-1", parentId: "cmt-report", organizationId: "org-1" };
  ok(covers(report, "cmt-report", nested), "🔴 linear: a reply nested under a top-level report comment is covered");
  ok(covers(report, "cmt-report", { platform: "linear", ambient: true, issueId: "iss-1" }), "linear: a top-level comment on the issue is still covered (the issue key, unchanged)");
  ok(!covers(report, "cmt-report", { ...nested, parentId: "cmt-other" }), "linear: a reply under another comment is not covered");
  ok(reportReplyThreads(report, "comment").length === 1, "linear: the placeholder id of a create that returned no id records no comment thread");
  const threaded: UnifiedWakeOrigin = { ...report, parentId: "cmt-root" };
  ok(reportReplyThreads(threaded, "cmt-new").length === 1 && covers(threaded, "cmt-new", { ...nested, parentId: "cmt-root" }), "linear: a report inside a thread records that thread once");
  const mention: UnifiedWakeOrigin = { platform: "linear", agentSessionId: "as-1", issueId: "iss-1" };
  ok(!covers(mention, "act-1", { ...nested, parentId: "act-1" }), "linear: an agent-activity post records no comment thread under its activity id");
}

{
  const report: UnifiedWakeOrigin = { platform: "discord", guildId: "g-1", channelId: "c-1" };
  ok(covers(report, "m-report", { platform: "discord", guildId: "g-1", channelId: "m-report", thread: true }), "🔴 discord: a thread opened off the report (its id is the report's) is covered");
  ok(!covers(report, "m-report", { platform: "discord", guildId: "g-1", channelId: "c-1" }), "discord: a plain message in the channel is not covered");
  ok(reportReplyThreads({ platform: "discord", dm: true, channelId: "dm-1" }, "m-dm").length === 0, "discord: a DM records nothing");
  ok(reportReplyThreads({ ...report, messageId: "m-ask", autoThreadName: "ask" }, "m-report").length === 0, "discord: an auto-thread post records nothing");
}

{
  const slackPost = originOfReplyTarget({ platform: "slack", channelId: "C1" });
  const slackReply = originOfReplyTarget({ platform: "slack", channelId: "C1", threadTs: "1751.000001" });
  ok(slackPost !== undefined && slackReply !== undefined && covers(slackPost, "1751.000001", slackReply), "🔴 slack native: the report's target and the reply's target key on one thread");

  const teamsPost = originOfReplyTarget({ platform: "teams", serviceUrl: SERVICE_URL, conversationId: CHANNEL });
  const teamsReply = originOfReplyTarget({ platform: "teams", serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=1700000000010` });
  ok(teamsPost !== undefined && teamsReply !== undefined && covers(teamsPost, "1700000000010", teamsReply), "🔴 teams native: a channel report and a reply in its chain key on one thread");
  const teamsChained = originOfReplyTarget({ platform: "teams", serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=1600000000000` });
  ok(teamsChained !== undefined && covers(teamsChained, "1700000000011", teamsChained), "teams native: a report into a chain and a reply in that chain key on one thread");
  ok(originOfReplyTarget({ platform: "teams", serviceUrl: "https://evil.example/", conversationId: CHANNEL }) === undefined, "teams native: a target whose serviceUrl fails the codec names no origin");

  const linearPost = originOfReplyTarget({ platform: "linear", issueId: "iss-2" });
  const linearReply = originOfReplyTarget({ platform: "linear", issueId: "iss-2", parentId: "cmt-native" });
  ok(linearPost !== undefined && linearReply !== undefined && covers(linearPost, "cmt-native", linearReply), "🔴 linear native: a top-level report and a reply nested under it key on one thread");
  ok(originOfReplyTarget({ platform: "linear", agentSessionId: "as-2" }) === undefined, "linear native: an agent-session target names no origin");

  ok(originOfReplyTarget({ platform: "discord", channelId: "c-2" } as ReplyTarget) === undefined, "discord native: a target with no guild names no origin");
}

console.log(`✓ routine-report-thread-surfaces: ${passed} assertions passed`);
process.exit(0);
