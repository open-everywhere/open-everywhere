import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { bindFrom, proposingGrantKey, proposingGrantScope, registerIdentityMapper, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { conversationGrantKey, grantButtonLabel, grantReach } from "@open-everywhere/core/agent/approvals/session-grant.js";
import type { PendingActionRow } from "@open-everywhere/core/agent/approvals/types.js";
import { isWorkSessionChildContext } from "@open-everywhere/core/agent/access/work-session.js";
import { adoptDelegatedAuthority } from "@open-everywhere/core/agent/identity/delegated-binding.js";
import { routineFireAttributes } from "@open-everywhere/core/agent/routines/fire-auth.js";
import { routinePermissionKey, type Routine } from "@open-everywhere/core/agent/routines/routine.js";
import { bindSlack } from "@open-everywhere/provider-slack/agent/channels/slack-identity.js";
import { bindDiscord } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import { bindGitHub } from "@open-everywhere/provider-github/agent/channels/github-identity.js";
import { bindLinear } from "@open-everywhere/provider-linear/agent/channels/linear-identity.js";
import { bindNotion } from "@open-everywhere/provider-notion/agent/channels/notion-identity.js";
import { bindTeams } from "@open-everywhere/provider-teams/agent/channels/teams-identity.js";

registerIdentityMapper("slack", bindSlack);
registerIdentityMapper("discord", bindDiscord);
registerIdentityMapper("github", bindGitHub);
registerIdentityMapper("linear", bindLinear);
registerIdentityMapper("notion", bindNotion);
registerIdentityMapper("teams", bindTeams);

const { pendingCardBlocks } = await import("@open-everywhere/core/agent/approvals/card.js");
const { pendingDiscordCard } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string): void => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

function turn(platform: string, attributes: Record<string, string>, principalId = "U_ASKER"): BindableContext {
  return { channel: { kind: `channel:${platform}` }, session: { auth: { current: { principalId, attributes } } } } as unknown as BindableContext;
}
const keyOf = (ctx: BindableContext): string | undefined => conversationGrantKey(bindFrom(ctx));

const SLACK = { team_id: "T1", channel_id: "C1", channel_type: "channel", trust_checked: "true", is_ext_shared: "false" };
const slackThreadA = turn("slack", { ...SLACK, thread_ts: "1700159720.000100" });
const slackThreadB = turn("slack", { ...SLACK, thread_ts: "1700159720.000200" });
{
  const a = keyOf(slackThreadA);
  const b = keyOf(slackThreadB);
  eq(a, "oe-grant:slack/T1/C1:thread:1700159720.000100", "§1 Slack: a thread keys on the channel and the thread root");
  ok(a !== b, "🔴 §1 Slack: two threads of ONE channel are two keys — an approval in A is never spent in B");
  eq(grantReach(a), "thread", "§1 …and the key reads back as a thread key");
  eq(keyOf(turn("slack", { ...SLACK, oe_reply_anchor: "1700159720.000300" })), "oe-grant:slack/T1/C1:thread:1700159720.000300", "§1 Slack: a top-level mention keys on the thread its reply and card post into");
  eq(keyOf(turn("slack", SLACK)), undefined, "🔴 §1 Slack: the TOP LEVEL of a channel, with no thread, has no conversation key");
  const dm = keyOf(turn("slack", { team_id: "T1", channel_id: "D1", channel_type: "im", dm_partner_trust: "internal" }));
  eq(dm, "oe-grant:slack/T1/D1:dm", "§1 Slack: a DM keys on the DM");
  eq(keyOf(turn("slack", { team_id: "T1", channel_id: "D1", channel_type: "im", dm_partner_trust: "internal", thread_ts: "1700159720.000400" })), dm, "§1 Slack: a thread INSIDE a DM is still the DM's one key");
}
{
  const GUILD = { guild_id: "G1", user_id: "U9", message_id: "M1" };
  const thread = keyOf(turn("discord", { ...GUILD, channel_id: "TH1", channel_type: "11", parent_channel_id: "CH1" }));
  eq(thread, "oe-grant:discord/G1/CH1:thread:TH1", "§1 Discord: a thread keys on its PARENT channel's room and the thread channel");
  eq(keyOf(turn("discord", { ...GUILD, channel_id: "CH1", channel_type: "0" })), undefined, "🔴 §1 Discord: a channel's top level has no conversation key");
  eq(keyOf(turn("discord", { user_id: "U9", channel_id: "DM1", channel_type: "1" })), "oe-grant:discord/U9/DM1:dm", "§1 Discord: a DM keys on the DM");
}
{
  const GH = { owner: "acme", repo: "app", conversation_kind: "issue" };
  const i12 = keyOf(turn("github", { ...GH, issue_number: "12" }));
  const i13 = keyOf(turn("github", { ...GH, issue_number: "13" }));
  ok(i12 !== undefined && i12.startsWith("oe-grant:github/acme/app:thread:") && grantReach(i12) === "thread", "§1 GitHub: an issue is a thread of its repo");
  ok(i12 !== i13, "§1 GitHub: two issues of one repo are two keys");
  const pr = keyOf(turn("github", { owner: "acme", repo: "app", conversation_kind: "pull_request", pull_request_number: "12" }));
  ok(pr !== undefined && grantReach(pr) === "thread", "§1 GitHub: a pull request is a thread too");
}
{
  const LIN = { organization_id: "ORG1", team_id: "TEAM1" };
  const k = keyOf(turn("linear", { ...LIN, issue_id: "ISS1" }));
  eq(k, "oe-grant:linear/ORG1/TEAM1:thread:ISS1", "§1 Linear: an issue is a thread of its team");
}
{
  const k = keyOf(turn("notion", { workspace_id: "W1", page_id: "P1", discussion_id: "D1" }));
  ok(k !== undefined && k.startsWith("oe-grant:notion/W1/P1:thread:") && grantReach(k) === "thread", "§1 Notion: a page's comments are a thread");
  const other = keyOf(turn("notion", { workspace_id: "W1", page_id: "P2", discussion_id: "D9" }));
  ok(k !== other, "§1 Notion: another page is another key");
}
{
  const TEAMS = { tenant_id: "TEN1", service_url: "https://smba.example/" };
  const chain = keyOf(turn("teams", { ...TEAMS, scope: "channel", channel_id: "19:chan", conversation_id: "19:chan;messageid=111" }));
  ok(chain !== undefined && grantReach(chain) === "thread", "§1 Teams: a reply chain in a channel is a thread");
  ok(chain !== keyOf(turn("teams", { ...TEAMS, scope: "channel", channel_id: "19:chan", conversation_id: "19:chan;messageid=222" })), "§1 Teams: two reply chains are two keys");
  eq(keyOf(turn("teams", { ...TEAMS, scope: "groupChat", conversation_id: "19:group" })), undefined, "🔴 §1 Teams: a GROUP chat is a room, not a thread, so it has no conversation key");
  const personal = keyOf(turn("teams", { ...TEAMS, scope: "personal", conversation_id: "a:personal1" }));
  ok(personal !== undefined && grantReach(personal) === "dm", "§1 Teams: a personal chat is a DM");
}

function prRow(sessionId: string | undefined, kind = "pr.open"): PendingActionRow {
  return {
    id: "p-ope-2363",
    org: "default",
    kind,
    argsJson: JSON.stringify(sessionId === undefined ? { repo: "acme/app" } : { repo: "acme/app", sessionId }),
    scopeKey: "slack/T1/C1",
    domain: null,
    requestedBy: "U_ASKER",
    channelId: "C1",
    threadTs: null,
    messageTs: null,
    postedTo: "slack/T1/C1",
    status: "pending",
    createdAt: "2026-10-06T00:00:00.000Z",
    expiresAt: "2026-10-07T00:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
  };
}
function middleButtons(row: PendingActionRow): { slack: string | undefined; discord: string | undefined } {
  const slackActions = pendingCardBlocks(row, ["a line"]).blocks.find((b) => b.type === "actions") as unknown as { elements: { action_id: string; text: { text: string } }[] };
  const slack = slackActions.elements.find((e) => e.action_id.includes(":approve_session:"))?.text.text;
  const buttons = pendingDiscordCard(row, ["a line"]).components[0]!.components as { custom_id?: string; label?: string }[];
  const discord = buttons.find((b) => (b.custom_id ?? "").includes("approve_session"))?.label;
  return { slack, discord };
}
const ROUTINE: Routine = {
  id: "r-2363",
  org: "default",
  surfaceKey: "slack/T1/C1",
  trigger: { kind: "cron", expr: "0 3 * * *" },
  prompt: "open the weekly PR",
  createdAt: "2026-10-06T00:00:00.000Z",
  status: "active",
  consecutiveFailures: 0,
};
const TABLE: readonly { readonly row: string; readonly key: string | undefined; readonly label: string | undefined }[] = [
  { row: "a Slack thread", key: keyOf(slackThreadA), label: undefined },
  { row: "a GitHub issue", key: keyOf(turn("github", { owner: "acme", repo: "app", conversation_kind: "issue", issue_number: "12" })), label: undefined },
  { row: "a Notion page", key: keyOf(turn("notion", { workspace_id: "W1", page_id: "P1", discussion_id: "D1" })), label: undefined },
  { row: "a Discord thread", key: keyOf(turn("discord", { guild_id: "G1", user_id: "U9", message_id: "M1", channel_id: "TH1", channel_type: "11", parent_channel_id: "CH1" })), label: undefined },
  { row: "a DM", key: keyOf(turn("slack", { team_id: "T1", channel_id: "D1", channel_type: "im", dm_partner_trust: "internal" })), label: undefined },
  { row: "a routine fire", key: routinePermissionKey(ROUTINE), label: "Approve for this routine (up to 24 h)" },
  { row: "the top level of a shared channel", key: keyOf(turn("slack", SLACK)), label: undefined },
];
for (const r of TABLE) {
  const got = middleButtons(prRow(r.key));
  eq(got.slack, r.label, `§2 ${r.row}: the Slack card's middle button is ${r.label === undefined ? "ABSENT" : `"${r.label}"`}`);
  eq(got.discord, got.slack, `§2 ${r.row}: the Discord card renders the SAME middle button as Slack`);
  eq(grantButtonLabel(prRow(r.key), 24), r.label, `§2 ${r.row}: both read the one core label`);
}
ok(TABLE.slice(0, 5).every((r) => r.key !== undefined && r.key.startsWith("oe-grant:")), "§2 precondition: every conversation row carries a real conversation key");
{
  const legacy = middleButtons(prRow("oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g1"));
  ok(legacy.slack === undefined && legacy.discord === undefined, "🔴 §2 a card frozen with a WORK-SESSION token (before OPE-2363) offers NO middle button on either surface");
  const notGrantable = middleButtons(prRow(routinePermissionKey(ROUTINE), "routine.create"));
  ok(notGrantable.slack === undefined && notGrantable.discord === undefined, "§2 negative control: a non-grantable kind offers no middle button even on a routine's card");
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const W_TOKEN = "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g1";
const workChild = {
  channel: { kind: "subagent" },
  session: {
    id: "sess-child",
    turn: { id: "turn_child", sequence: 0 },
    parent: { sessionId: "sess-w", callId: "call_1", rootSessionId: "sess-w" },
    auth: { current: { principalId: "U_LATER", attributes: { ...SLACK, thread_ts: "1700159720.000200", oe_platform: "slack", oe_window_token: W_TOKEN } } },
  },
} as unknown as BindableContext;
contextStorage.run(new ContextContainer(), () => {
  ok(isWorkSessionChildContext(workChild), "§3 precondition: the context is a CHILD OF THE WORK SESSION");
  ok(adoptDelegatedAuthority({ binding: bindFrom(slackThreadA), requester: { kind: "requester", principalId: "U_ASKER" }, nonMemberWake: false }, "turn_child"), "§3 precondition: the child adopted thread A's dispatch binding");
  eq(proposingGrantKey(workChild), undefined, "🔴 §3 a work-session child has NO grant key: a click in its conversation keeps no grant");
  const key = proposingGrantScope(workChild)?.key;
  eq(key, keyOf(slackThreadA), "🔴 §3 its one-call approvals wait under the ASKING thread's key (thread A)");
  ok(key !== W_TOKEN && !String(key).startsWith("oe-dom:"), "🔴 §3 …never under the work session's token, which serves the whole domain");
  ok(key !== keyOf(slackThreadB), "§3 …and never under the later sibling's thread that W's raw bag carries");
});
contextStorage.run(new ContextContainer(), () => {
  const dmBinding = bindFrom(turn("slack", { team_id: "T1", channel_id: "D1", channel_type: "im", dm_partner_trust: "internal" }));
  adoptDelegatedAuthority({ binding: dmBinding, requester: { kind: "requester", principalId: "U_ASKER" }, nonMemberWake: false }, "turn_child");
  eq(proposingGrantScope(workChild)?.key, "oe-grant:slack/T1/D1:dm", "§3 a work-session child of a DM seat keeps its one-call approvals under the DM's key");
});
contextStorage.run(new ContextContainer(), () => {
  adoptDelegatedAuthority({ binding: bindFrom(turn("slack", SLACK)), requester: { kind: "requester", principalId: "U_ASKER" }, nonMemberWake: false }, "turn_child");
  eq(proposingGrantScope(workChild)?.key, "oe-grant:slack/T1/C1:call", "§3 a work-session child of a channel's top level keeps them under the room's one-call key");
  eq(proposingGrantScope(workChild)?.reach, "call", "§3 …and its reach is ONE CALL, like every conversation's");
});

{
  const fire = routineFireAttributes(ROUTINE, { ...SLACK, thread_ts: "1700159720.000100" }, "channel", true);
  const fireCtx = turn("slack", fire, "");
  eq(proposingGrantKey(fireCtx), routinePermissionKey(ROUTINE), "🔴 §4 a routine FIRE keys on its routine, even when its bag names a human thread");
  ok(proposingGrantKey(fireCtx) !== keyOf(slackThreadA), "🔴 §4 …never on the human thread its bag names");
  eq(proposingGrantKey(turn("slack", { ...SLACK, thread_ts: "1700159720.000100" }, "")), undefined, "🔴 §4 an unattended non-routine turn keeps NO grant, even inside a thread");
  eq(proposingGrantScope(turn("slack", { ...SLACK, thread_ts: "1700159720.000100" }, "")), undefined, "§4 …and no one-call approval can be kept for it either");
  eq(proposingGrantScope(slackThreadA)?.key, keyOf(slackThreadA), "§4 negative control: the same thread with an acting person keeps one-call approvals under the thread");
  eq(proposingGrantKey(slackThreadA), undefined, "🔴 §4 …and still has NO grant key: a human thread never keeps a grant");
}

{
  await import("@open-everywhere/core/agent/approvals/connector-op.js");
  const { actionKind } = await import("@open-everywhere/core/agent/approvals/actions.js");
  const kind = actionKind("op.connector")!;
  const base = { org: "default", scopeKey: "slack/T1/C1", tool: "notion__create_page", connection: "notion", memoKind: "connector.approved:notion__create_page", inputPreview: "{}", requestedBy: "U_ASKER" };
  const line = (grain: string, sessionKey: string): string => kind.summarize({ ...base, grain, sessionKey } as never)[0] ?? "";
  for (const [where, key] of [["a thread", keyOf(slackThreadA)!], ["a DM", "oe-grant:slack/T1/D1:dm"], ["a channel's top level", "oe-grant:slack/T1/C1:call"]] as const) {
    ok(line("call", key).includes("this one call, with exactly this input"), `🔴 §5 the connector card in ${where} says it approves ONE call`);
    ok(!/in this thread|in this DM|for up to/.test(line("call", key)), `§5 …and names no thread, DM or clock reach in ${where}`);
  }
  ok(line("write", keyOf(slackThreadA)!).includes("this one call, with exactly this input"), "§5 a legacy write-grain card also says it approves one call");
}

console.log(`✓ conversation-grant-scope: ${n} assertions passed (per-surface keys · only a routine card has a middle button, Slack = Discord · work-session child · routine and unattended · connector card copy)`);
