process.env.OE_SQLITE_PATH = ":memory:";
overrideSettingsForTest({ discord: { autoThread: false } });
overrideSettingsForTest({ discord: { statusUx: false } });

import assert from "node:assert/strict";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
registerDiscordProvider();
registerSlackProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { shouldDeliverReply } from "@open-everywhere/core/agent/channels/engagement.js";
import { bindFrom } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import standDown, { STAND_DOWN_ACTION, DM_REFUSAL, GROUP_REFUSAL } from "@open-everywhere/core/agent/tools/stand_down.js";
import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import {
  dispatchTurn,
  authForRelayMessage,
  engagementCoordsFor,
  type DiscordRelayMessage,
  type DiscordGatewaySend,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { resolveGitHubEngagement } from "@open-everywhere/provider-github/agent/channels/github-engagement.js";
import { resolveLinearEngagement } from "@open-everywhere/provider-linear/agent/channels/linear-engagement.js";
import { markNotionEngaged, resolveNotionEngagement } from "@open-everywhere/provider-notion/agent/channels/notion-engagement.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const store = getOperationalStore();

type StandDownResult = { standingDown: boolean; note: string };
const runStandDown = (ctx: unknown, reason?: string): Promise<StandDownResult> =>
  (standDown as unknown as { execute: (i: { reason?: string }, c: unknown) => Promise<StandDownResult> }).execute(
    reason === undefined ? {} : { reason },
    ctx,
  );

const windowCtx = (platform: string, attributes: Record<string, string>, principalId: string) => ({
  channel: { kind: "unified" },
  session: { auth: { current: { attributes: { ...attributes, oe_platform: platform, oe_wake_id: "wake_1" }, principalId, principalType: `${platform}-user` } } },
});

function relay(over: Partial<DiscordRelayMessage>): DiscordRelayMessage {
  return {
    id: "m1",
    content: "hello",
    channelId: "TH_SD",
    channelType: "11",
    guildId: "G1",
    author: { id: "U1", username: "human", bot: false },
    mentionsBot: false,
    botName: "Ada",
    botId: "BOT",
    ...over,
  };
}

function fakeSend(): { send: DiscordGatewaySend; calls: unknown[] } {
  const calls: unknown[] = [];
  const send: DiscordGatewaySend = async (message, options) => {
    calls.push({ message, options });
    return {};
  };
  return { send, calls };
}

const noThread = async () => null;
const noParent = async () => undefined;

async function wake(over: Partial<DiscordRelayMessage>): Promise<number> {
  const msg = relay(over);
  const { send, calls } = fakeSend();
  await dispatchTurn(msg, authForRelayMessage(msg)!, send, noThread, noParent);
  return calls.length;
}

const discordAttrs = { guild_id: "G1", channel_id: "TH_SD", channel_type: "11", user_id: "U1" };
const discordCtx = windowCtx("discord", discordAttrs, "U1");

{
  const b = bindFrom(discordCtx);
  const coords = engagementCoordsFor({ channelId: "TH_SD", guildId: "G1" })!;
  ok(b.engagementKey === "TH_SD", "a Discord thread binding publishes the thread's channel id as the engagement key");
  ok(b.threadTs === undefined, "…and carries NO threadTs — the slot the tool used to read, empty on every Discord turn");
  ok(resolvePartition(discordCtx).surfaceKey === coords.p.surfaceKey, "the tool's partition surface key is the gateway's own (discord/G1/TH_SD)");
  ok(b.engagementKey === coords.key, "the tool's anchor is byte-identical to the gateway's engagement key");
}

{
  ok((await wake({ id: "mention1", mentionsBot: true, content: "<@BOT> hi" })) === 1, "the @mention dispatched a turn and engaged the thread");
  ok((await wake({ id: "follow1", content: "and another thing" })) === 1, "🔴 NEGATIVE CONTROL: a non-mention follow-up in the engaged thread DOES dispatch before any stand-down");
}

{
  const coords = engagementCoordsFor({ channelId: "TH_SD", guildId: "G1" })!;
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key))?.stopped === false, "precondition: the engaged thread is NOT stopped");

  const res = await runStandDown(discordCtx, "asked me to stop following");
  ok(res.standingDown === true, "stand_down succeeds on a Discord thread turn (it threw here before OPE-661)");

  const row = await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key);
  ok(row !== null && row.stopped === true, "the mark landed on the EXACT (org, discord/G1/TH_SD, TH_SD) row the wake gate reads");
}

{
  ok((await wake({ id: "follow2", content: "still talking" })) === 0, "🔴 ROUND TRIP: the same non-mention follow-up is now SUPPRESSED by the real Discord wake gate");
}

{
  const coords = engagementCoordsFor({ channelId: "TH_SD", guildId: "G1" })!;
  ok((await wake({ id: "revive1", mentionsBot: true, content: "<@BOT> back please" })) === 1, "an @mention wakes a stood-down thread — the re-invitation path is unchanged");
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key))?.stopped === false, "…and the re-invitation CLEARS the stopped marker");
}

{
  const slackAttrs = { team_id: "T_S", channel_id: "C_S", thread_ts: "1700.5", channel_type: "channel", user_id: "US" };
  const slackCtx = windowCtx("slack", slackAttrs, "US");
  const b = bindFrom(slackCtx);
  ok(b.engagementKey === undefined, "🔴 REGRESSION PIN: the Slack mapper publishes NO engagementKey — its anchor stays binding.threadTs");
  ok(b.threadTs === "1700.5", "the Slack binding still anchors on the thread ts");

  const p = resolvePartition(slackCtx);
  ok(p.surfaceKey === "slack/T_S/C_S", "the Slack partition still keys by the CHANNEL, with the thread ts as the registry key beside it");
  await store.markEngaged(p.org, p.surfaceKey, "1700.5", "2026-08-16T10:00:00Z", { participating: true });

  const res = await runStandDown(slackCtx, "asked me to stop following");
  ok(res.standingDown === true, "stand_down still succeeds on a Slack thread turn");
  const row = await store.getEngagement(p.org, p.surfaceKey, "1700.5");
  ok(row !== null && row.stopped === true, "the Slack mark lands on the thread-ts key slack-events.ts reads");

  const base = { isEngaged: true, authorIsBot: false, isAppMention: false, inThread: true };
  ok(shouldDeliverReply({ ...base, stopped: row!.stopped }).deliver === false, "🔴 ROUND TRIP: shouldDeliverReply refuses the follow-up on the stopped Slack thread");
  ok(shouldDeliverReply({ ...base, stopped: false }).deliver === true, "🔴 NEGATIVE CONTROL: the same input with stopped === false DOES deliver");
}

{
  const dmCtx = windowCtx("discord", { channel_id: "DM1", channel_type: "1", user_id: "U1" }, "U1");
  ok(bindFrom(dmCtx).engagementKey === undefined, "a Discord DM carries NO engagement anchor — a mark there would suppress nothing");

  let message = "";
  try {
    await runStandDown(dmCtx);
    ok(false, "stand_down must refuse a turn with no conversation anchor");
  } catch (err) {
    message = (err as Error).message;
  }
  ok(message.includes("nothing was marked"), "the anchorless error states that nothing was marked");
  ok(message.includes("could NOT stop following"), "🔴 the anchorless error tells the model to say it COULD NOT stop following");
  ok(!/say so in a reply/i.test(message), "🔴 NEGATIVE CONTROL: the old copy is gone — it steered the model into announcing a stop that never happened");
  ok(!/\bI'll stop\b|\bstanding down\b/i.test(message), "…and the copy offers no compliance phrasing for the model to echo");
  ok((message.match(/\./g) ?? []).length === 1 && message.trimEnd().endsWith("."), "the anchorless error stays ONE sentence (tool-instruction brevity)");
}

{
  const dmCtx = windowCtx("slack", { team_id: "T_S", channel_id: "D1", channel_type: "im", user_id: "US" }, "US");
  ok(bindFrom(dmCtx).mode === "dm", "a Slack im channel_type binds to SessionMode 'dm'");

  let message = "";
  try {
    await runStandDown(dmCtx);
    ok(false, "stand_down must refuse a Slack DM turn");
  } catch (err) {
    message = (err as Error).message;
  }
  ok(message.includes("direct message cannot be stood down"), "🔴 the DM refusal names the reason as the surface, not a missing anchor");
  ok(message.includes("could NOT stop following"), "the DM refusal still tells the model to say it COULD NOT stop following");
  ok(message.includes("nothing was marked"), "the DM refusal still states that nothing was marked");
}

{
  const threadedDmCtx = windowCtx(
    "slack",
    { team_id: "T_S", channel_id: "D2", channel_type: "im", thread_ts: "1800.9", user_id: "US" },
    "US",
  );
  const b = bindFrom(threadedDmCtx);
  ok(b.mode === "dm", "precondition: still a DM by mode");
  ok(b.threadTs === "1800.9", "🔴 precondition: an ANCHOR EXISTS — the case an anchor-presence check alone would miss");

  const p = resolvePartition(threadedDmCtx);
  await store.markEngaged(p.org, p.surfaceKey, "1800.9", "2026-08-16T10:00:00Z", { participating: true });

  let succeeded = false;
  try {
    const res = await runStandDown(threadedDmCtx);
    succeeded = res.standingDown === true;
  } catch {
    succeeded = false;
  }
  ok(succeeded === false, "🔴 stand_down refuses even though an anchor is present — mode wins over anchor");

  const row = await store.getEngagement(p.org, p.surfaceKey, "1800.9");
  ok(row !== null && row.stopped === false, "🔴 NEGATIVE CONTROL: the pre-existing row is still NOT stopped — pre-OPE-665 this same seed left it `stopped:true`, a mark scheduleDmWake never reads");
}

{
  const mpimCtx = windowCtx("slack", { team_id: "T_S", channel_id: "G_DM", channel_type: "mpim", thread_ts: "1900.1", user_id: "US" }, "US");
  ok(bindFrom(mpimCtx).mode === "mpim", "a Slack mpim channel_type binds to SessionMode 'mpim'");
  let message = "";
  try {
    await runStandDown(mpimCtx);
    ok(false, "stand_down must refuse a Slack group-DM turn");
  } catch (err) {
    message = (err as Error).message;
  }
  ok(!message.includes("no @mention to bring you back"), "🔴 the group-DM refusal does NOT reuse the 1:1 reason — a group DM CAN be @mentioned, so that sentence would be false about the platform");
  ok(message.includes("without checking whether you asked it to stop"), "the group-DM refusal names the REAL cause: this surface's group wake never consults the engagement registry");
  ok(message.includes("nothing was marked"), "…and still states that nothing was marked");
  ok(message.includes("could NOT stop following"), "…and still tells the model to report a FAILED stop (the §3 shape)");
  ok((message.match(/\./g) ?? []).length === 1 && message.trimEnd().endsWith("."), "the group refusal stays ONE sentence, like the other arms");
}

{
  const channelCtx = windowCtx("slack", { team_id: "T_S", channel_id: "C_G", thread_ts: "1950.1", channel_type: "channel", user_id: "US" }, "US");
  ok(bindFrom(channelCtx).mode === "channel", "precondition: a Slack channel binds to SessionMode 'channel', never 'dm'");
  const p = resolvePartition(channelCtx);
  await store.markEngaged(p.org, p.surfaceKey, "1950.1", "2026-08-16T10:00:00Z", { participating: true });
  const res = await runStandDown(channelCtx, "asked me to stop following");
  ok(res.standingDown === true, "🔴 NEGATIVE CONTROL: a channel-surface stand_down still succeeds — the DM guard never fires here");
  const row = await store.getEngagement(p.org, p.surfaceKey, "1950.1");
  ok(row !== null && row.stopped === true, "…and the channel row is still marked, exactly as LEG 6 already proved");
}

{
  const freshCtx = windowCtx("slack", { team_id: "T_S", channel_id: "C_NEW", thread_ts: "2100.7", channel_type: "channel", user_id: "US" }, "US");
  const b = bindFrom(freshCtx);
  ok(b.mode === "channel" && b.threadTs === "2100.7", "🔴 precondition: a real ANCHOR is present and the mode is not DM — neither existing refusal arm can fire here");
  const p = resolvePartition(freshCtx);
  ok((await store.getEngagement(p.org, p.surfaceKey, "2100.7")) === null, "🔴 precondition: the registry holds NO row for this conversation — the state `markStopped` answers false on");

  let message = "";
  try {
    await runStandDown(freshCtx, "asked me to stop following");
    ok(false, "stand_down must refuse when the mark landed on nothing");
  } catch (err) {
    message = (err as Error).message;
  }
  ok(message.includes("nothing was marked"), "🔴 OPE-1333: the unenrolled case states that nothing was marked, exactly as the anchorless arm does");
  ok(message.includes("could NOT stop following"), "🔴 OPE-1333: …and tells the model to report a FAILED stop — the §3 honest-absence rule this case used to escape");
  ok(/never enrolled/.test(message), "🔴 OPE-1333: the copy names the FIRST cause a false answer can mean — the conversation was never enrolled");
  ok(/could not be written/.test(message), "🔴 OPE-1333: …and the SECOND — a store read that threw answers false too, and naming only the first would diagnose an outage as an unenrolled thread");
  ok(/@mention/.test(message), "OPE-1333: …while still offering the one remedy a person in the room can act on");
  ok(!/\bstanding down\b|\bwon't be woken\b/i.test(message), "🔴 NEGATIVE CONTROL: the success note's compliance phrasing appears nowhere in the refusal for the model to echo");
  ok((message.match(/\./g) ?? []).length === 1 && message.trimEnd().endsWith("."), "the unenrolled error stays ONE sentence, like the other two arms");

  ok((await store.getEngagement(p.org, p.surfaceKey, "2100.7")) === null, "🔴 OPE-1333: …and the refusal INSERTED no row — the verb still never creates engagement, it only reports that it could not mark one");
}

{
  const freshCtx = windowCtx("slack", { team_id: "T_S", channel_id: "C_NEW2", thread_ts: "2200.4", channel_type: "channel", user_id: "US" }, "US");
  const p = resolvePartition(freshCtx);
  await store.markEngaged(p.org, p.surfaceKey, "2200.4", "2026-08-16T10:00:00Z", { participating: true });
  const res = await runStandDown(freshCtx, "asked me to stop following");
  ok(res.standingDown === true, "⭐ NEGATIVE CONTROL: the same ctx succeeds once an @mention has enrolled the conversation — the refusal is about the ROW, not the surface");
  const row = await store.getEngagement(p.org, p.surfaceKey, "2200.4");
  ok(row !== null && row.stopped === true, "…and the mark lands, so the honest-refusal guard costs the working path nothing");
}

{
  const unengagedCtx = windowCtx("discord", { guild_id: "G1", channel_id: "TH_NEVER", channel_type: "11", user_id: "U1" }, "U1");
  ok(bindFrom(unengagedCtx).engagementKey === "TH_NEVER", "precondition: the Discord binding publishes an anchor for a channel the gateway never engaged");
  const p = resolvePartition(unengagedCtx);
  ok((await store.getEngagement(p.org, p.surfaceKey, "TH_NEVER")) === null, "precondition: …and the registry holds no row for it");

  let threw = false;
  try {
    await runStandDown(unengagedCtx, "asked me to stop following");
  } catch {
    threw = true;
  }
  ok(threw, "🔴 OPE-1333: Discord refuses the unenrolled conversation too — the guard reads the store's answer, not the platform");

  const trail = (await readAudit({ org: p.org, action: STAND_DOWN_ACTION })).filter(
    (r) => (r.detail as Record<string, unknown> | undefined)?.anchor === "TH_NEVER",
  );
  ok(trail.length === 1, "OPE-1333: the refused attempt still wrote its audit row — the trail records what was tried, not only what worked");
  ok((trail[0]!.detail as Record<string, unknown>).marked === false, "🔴 OPE-1333: …stamped `marked: false`, which is the field the refusal is derived from");
}

{
  const chainCtx = windowCtx(
    "teams",
    { tenant_id: "T_MS", conversation_id: "19:chain@thread.tacv2", channel_id: "19:chan@thread.tacv2", scope: "channel", user_id: "29:u1" },
    "29:u1",
  );
  const b = bindFrom(chainCtx);
  ok(b.mode === "channel", "precondition: a Teams channel scope binds to SessionMode 'channel'");
  ok(b.engagementKey === "19:chain@thread.tacv2", "🔴 OPE-1500: the Teams binding publishes the reply chain as the engagement anchor — before this it published none and the verb threw");
  const p = resolvePartition(chainCtx);
  await store.markEngaged(p.org, p.surfaceKey, "19:chain@thread.tacv2", "2026-09-07T10:00:00Z", { participating: true });
  const res = await runStandDown(chainCtx, "asked me to stop following");
  ok(res.standingDown === true, "🔴 OPE-1500: stand_down SUCCEEDS on a Teams reply chain");
  const row = await store.getEngagement(p.org, p.surfaceKey, "19:chain@thread.tacv2");
  ok(row !== null && row.stopped === true, "…and the mark lands on the row the seam's wake gate reads (teams-engagement.ts), so the stop actually suppresses");
}

{
  const groupCtx = windowCtx("teams", { tenant_id: "T_MS", conversation_id: "19:group@thread.v2", scope: "groupChat", user_id: "29:u2" }, "29:u2");
  const gb = bindFrom(groupCtx);
  ok(gb.mode === "mpim", "precondition: a Teams groupChat binds to SessionMode 'mpim'");
  ok(gb.engagementKey === "19:group@thread.v2", "OPE-1500: …and publishes the chat id as its anchor");
  const gp = resolvePartition(groupCtx);
  await store.markEngaged(gp.org, gp.surfaceKey, "19:group@thread.v2", "2026-09-07T10:00:00Z", { participating: true });
  const gres = await runStandDown(groupCtx, "asked me to stop following");
  ok(gres.standingDown === true, "🔴 OPE-1500: a Teams GROUP CHAT can be stood down — its wake gate reads the row, so the mark is not a write nobody reads");
  const grow = await store.getEngagement(gp.org, gp.surfaceKey, "19:group@thread.v2");
  ok(grow !== null && grow.stopped === true, "…and the flag is set");

  const personalCtx = windowCtx("teams", { tenant_id: "T_MS", conversation_id: "19:1on1@thread.v2", scope: "personal", user_id: "29:u3" }, "29:u3");
  const pb = bindFrom(personalCtx);
  ok(pb.mode === "dm", "precondition: a Teams personal chat binds to SessionMode 'dm'");
  ok(pb.engagementKey === undefined, "🔴 NEGATIVE CONTROL: a Teams 1:1 publishes NO anchor — the mapper's own omission, not the tool's guard");
  let message = "";
  try {
    await runStandDown(personalCtx);
    ok(false, "stand_down must still refuse a Teams 1:1 chat");
  } catch (err) {
    message = (err as Error).message;
  }
  ok(message.includes("direct message cannot be stood down"), "🔴 the 1:1 refusal copy is unchanged — it is the same sentence LEG 8 pins on Slack");
  ok(message.includes("no @mention to bring you back"), "…including the reason clause, which is exactly what stops being true in a group chat");
  ok(message === DM_REFUSAL, "…byte-identical to the exported 1:1 string, so the group split above cannot drift it");

  const slackMpim = windowCtx("slack", { team_id: "T_S", channel_id: "G_DM2", channel_type: "mpim", thread_ts: "1975.2", user_id: "US" }, "US");
  ok(bindFrom(slackMpim).engagementKey === undefined, "🔴 NEGATIVE CONTROL: a Slack mpim carries a thread_ts but NO engagementKey — which is why it keeps refusing while Teams stops");
  const sp = resolvePartition(slackMpim);
  await store.markEngaged(sp.org, sp.surfaceKey, "1975.2", "2026-09-07T10:00:00Z", { participating: true });
  let slackThrew = false;
  let slackMessage = "";
  try {
    await runStandDown(slackMpim);
  } catch (err) {
    slackThrew = true;
    slackMessage = (err as Error).message;
  }
  ok(slackThrew, "🔴 the Slack group DM still refuses, with a seeded row present — the guard reads the ANCHOR, never the thread ts");
  ok(slackMessage === GROUP_REFUSAL, "…with the GROUP copy, not the 1:1 copy — two refusals, two true reasons");
  const srow = await store.getEngagement(sp.org, sp.surfaceKey, "1975.2");
  ok(srow !== null && srow.stopped === false, "…and nothing was marked there");
}

{
  const ctx = windowCtx(
    "github",
    { owner: "acme", repo: "widgets", repo_private: "true", conversation_kind: "issue", issue_number: "42", user_login: "dev1" },
    "dev1",
  );
  const b = bindFrom(ctx);
  ok(b.mode === "channel", "precondition: a GitHub issue binds to SessionMode 'channel'");
  ok(b.engagementKey === "acme/widgets#42", "🔴 OPE-1501: the GitHub binding publishes `owner/repo#N` as the engagement anchor — before this it published none and the verb threw");
  const p = resolvePartition(ctx);
  await store.markEngaged(p.org, p.surfaceKey, "acme/widgets#42", "2026-09-07T10:00:00Z", { participating: true });
  const res = await runStandDown(ctx, "asked me to stop following");
  ok(res.standingDown === true, "🔴 OPE-1501: stand_down SUCCEEDS on a GitHub issue thread");

  const facts = { owner: "acme", repo: "widgets", number: 42, isPrivate: true, actorLogin: "dev2", isMention: false, authorIsBot: false, conversationKind: "issue" };
  const verdict = await resolveGitHubEngagement(facts);
  ok(verdict.kind === "hold" && verdict.stopped, "🔴 OPE-1501: github-engagement.ts reads the mark back as a STOP — the write lands on the key the wake gate reads");
  ok(verdict.kind === "hold" && verdict.anchor === "acme/widgets#42", "…at the anchor the mapper published, so the two derivations agree byte for byte");

  const other = await resolveGitHubEngagement({ ...facts, number: 43 });
  ok(other.kind === "hold" && other.stopped === false, "🔴 NEGATIVE CONTROL: issue #43 is neither engaged nor stopped — the stop is per container, not per repo");
  await store.markEngaged(p.org, p.surfaceKey, "acme/widgets#43", "2026-09-07T10:05:00Z", { participating: true });
  const engaged = await resolveGitHubEngagement({ ...facts, number: 43 });
  ok(engaged.kind === "deliver", "🔴 NEGATIVE CONTROL: …and once #43 holds a row, a plain comment there DELIVERS");
}

{
  const ctx = windowCtx(
    "linear",
    { organization_id: "ORG_L", team_id: "TEAM_L", issue_id: "ISSUE_L", is_private: "true", creator_id: "u_l" },
    "u_l",
  );
  const b = bindFrom(ctx);
  ok(b.mode === "channel", "precondition: a Linear issue binds to SessionMode 'channel'");
  ok(b.engagementKey === "ISSUE_L", "🔴 OPE-1501: the Linear binding publishes the ISSUE id as the engagement anchor");
  const p = resolvePartition(ctx);
  await store.markEngaged(p.org, p.surfaceKey, "ISSUE_L", "2026-09-07T10:00:00Z", { participating: true });
  const res = await runStandDown(ctx, "asked me to stop following");
  ok(res.standingDown === true, "🔴 OPE-1501: stand_down SUCCEEDS on a Linear issue");

  const facts = { organizationId: "ORG_L", teamId: "TEAM_L", issueId: "ISSUE_L", principalId: "u_l2", isPrivate: true };
  const verdict = await resolveLinearEngagement(facts, false);
  ok(verdict.kind === "hold" && verdict.stopped, "🔴 OPE-1501: linear-engagement.ts reads the mark back as a STOP on the ambient comment path");
  const other = await resolveLinearEngagement({ ...facts, issueId: "ISSUE_OTHER" }, false);
  ok(other.kind === "hold" && other.stopped === false, "🔴 NEGATIVE CONTROL: a different issue in the same team is untouched — the stop is per issue");
}

{
  const ctx = windowCtx(
    "notion",
    { workspace_id: "WS_N", page_id: "PAGE_N", discussion_id: "DISC_N", user_id: "u_n" },
    "u_n",
  );
  const b = bindFrom(ctx);
  ok(b.mode === "channel", "precondition: a Notion page binds to SessionMode 'channel'");
  ok(b.engagementKey === "WS_N/PAGE_N", "🔴 OPE-1501: the Notion binding publishes `<workspace>/<page>` as the engagement anchor");
  const p = resolvePartition(ctx);
  await store.markEngaged(p.org, p.surfaceKey, "WS_N/PAGE_N", "2026-09-07T10:00:00Z", { participating: true });
  const res = await runStandDown(ctx, "asked me to stop following");
  ok(res.standingDown === true, "🔴 OPE-1501: stand_down SUCCEEDS on a Notion page");

  const facts = { workspaceId: "WS_N", pageId: "PAGE_N", principalId: "u_n2" };
  const verdict = await resolveNotionEngagement(facts, false);
  ok(verdict.kind === "hold" && verdict.stopped, "🔴 OPE-1501: notion-engagement.ts reads the mark back as a STOP");
  ok(verdict.kind === "hold" && verdict.anchor === "WS_N/PAGE_N", "…at the PAGE grain, the same one `anchorChannelId` already used");

  await markNotionEngaged(facts, "cmt-back-in");
  const back = await resolveNotionEngagement(facts, false);
  ok(back.kind === "deliver", "🔴 OPE-1501: a fresh addressed comment re-engages the page and lifts the stop — `participating: true` is the way back in");
}

console.log(`✓ stand-down-anchor: ${n} assertions passed (discord key chain + real wake-gate round trip + re-invitation + slack regression pin + anchorless copy + DM refusal + unenrolled refusal + the Teams anchor and its group-chat stop + the GitHub/Linear/Notion anchors and their own seams' round trips)`);
