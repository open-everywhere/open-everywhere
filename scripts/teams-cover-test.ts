// proves: cover.wake, cover.answered

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-teams-cover-")), "ops.sqlite3");

const { resolvePartition, registerFriendlyNameResolver } = await import("@open-everywhere/core/agent/adapter-api.js");
const { turnCoverOff, turnCoverOn, readPersonalCover } = await import("@open-everywhere/core/agent/cover/state.js");
const { coveredOnWake } = await import("@open-everywhere/core/agent/cover/wake.js");
const { readableEntries, coverRoomLabels, renderCoverRecapBody } = await import("@open-everywhere/core/agent/cover/recap.js");
const { postUnifiedReply } = await import("@open-everywhere/core/agent/channels/unified-reply.js");
const { replyAuditFor } = await import("@open-everywhere/core/agent/channels/reply-post.js");
const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
const { buildTeamsAuth } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");
const { handleTeamsSingleWindowDispatch, planTeamsSingleWindow, teamsMentionedPersonIds } = await import(
  "@open-everywhere/provider-teams/agent/channels/teams-supervisor.js"
);
const { teamsCoverFacts } = await import("@open-everywhere/provider-teams/agent/channels/teams-front.js");
const { teamsRosterHasMember } = await import("@open-everywhere/provider-teams/agent/channels/teams-roster.js");
const { teamsAnswerActivity } = await import("@open-everywhere/provider-teams/agent/channels/teams-reply-feedback.js");
type TeamsSupervisorDeps = import("@open-everywhere/provider-teams/agent/channels/teams-supervisor.js").TeamsSupervisorDeps;
type TeamsCoverFacts = import("@open-everywhere/provider-teams/agent/channels/teams-supervisor.js").TeamsCoverFacts;
type PostIntent = Parameters<NonNullable<import("@open-everywhere/core/agent/channels/unified-reply.js").UnifiedReplyDeps["postTeams"]>>[2];

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

registerTeamsProvider();

const TENANT = "TEN_COV";
const BOT = "28:bot-cover";
const ANA = "29:ana-cover";
const BO = "29:bo-cover";
const CHANNEL = "19:launch@thread.tacv2";
const CONVERSATION = `${CHANNEL};messageid=1700`;
const SERVICE = "https://smba.trafficmanager.net/emea/";
const TEAM = "19:team-cov@thread.tacv2";
const CY = "29:cy-cover";
const auth = buildTeamsAuth({ userId: BO, userName: "Bo", tenantId: TENANT, conversationId: CONVERSATION, channelId: CHANNEL, teamId: "team-cov", serviceUrl: SERVICE, scope: "channel" });
const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } } as never);
const ORG = partition.org;
const anaKey = `teams/${ANA}`;

console.log("§1 the mention parser");
{
  const mentions = [BOT, ANA, CHANNEL, "tag-123", BO].map((id) => ({ mentioned: { id } }));
  ok(JSON.stringify(teamsMentionedPersonIds(mentions, BOT)) === JSON.stringify([ANA, BO]), "the parser keeps the `29:` people in order, and drops the bot, a channel and a tag");
}

const activity = (membershipType: string | undefined, mentionIds: readonly string[]) =>
  ({
    type: "message",
    id: "1701",
    serviceUrl: SERVICE,
    conversation: { id: CONVERSATION, tenantId: TENANT, conversationType: "channel" },
    from: { id: BO, name: "Bo" },
    teamId: TEAM,
    teamsChannelId: CHANNEL,
    recipient: { id: BOT },
    channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL, ...(membershipType ? { membershipType } : {}) } },
    mentions: mentionIds.map((id) => ({ mentioned: { id }, text: "<at>x</at>", type: "mention" })),
    text: "@Ana is the launch still on Friday?",
    scope: "channel",
    attachments: [],
    isBotMentioned: false,
  }) as never;
let rosterCalls = 0;
const roster = () => async (path: string) => {
  rosterCalls++;
  return path === `/v3/conversations/${encodeURIComponent(TEAM)}/members/${encodeURIComponent(ANA)}` ? { ok: true, body: { id: ANA, name: "Ana" } } : { ok: false, body: null };
};

interface Captured {
  readonly message: string;
  readonly auth: unknown;
  readonly wakeId: string;
}
const wakes: Captured[] = [];
const deps: TeamsSupervisorDeps = {
  getOrCreateSession: async () => ({ token: "oe-sup:teams:g1", generation: 1, freshGeneration: true, tail: [] }),
  wake: async (input) => {
    wakes.push({ message: input.message, auth: input.auth, wakeId: input.window.wakeId });
  },
  now: () => "2026-06-18T09:30:00.000Z",
};
const facts = { scope: "channel" as const, membershipType: "standard", tenantId: TENANT, vouched: true };
const dispatch = async (text: string, cover: TeamsCoverFacts | undefined) => {
  const window = planTeamsSingleWindow(true, false, facts, { serviceUrl: SERVICE, conversationId: CONVERSATION, replyToActivityId: "1700", tenantId: TENANT })!;
  await handleTeamsSingleWindowDispatch(
    {
      surfaceKey: `teams/${TENANT}/${CHANNEL}`,
      containerKey: partition.surfaceKey,
      channelId: CHANNEL,
      auth,
      ingested: [{ trust: "peer" as const }],
      trigger: { id: "1701", authorId: BO, authorName: "Bo", sentAt: "2026-06-18T09:30:00.000Z", text, trust: "peer" },
      window,
      ...(cover ? { cover } : {}),
    },
    deps,
  );
  return wakes.at(-1)!;
};

console.log("§2 the note, §3 the room's auth");
const baseline = await dispatch("@Ana is the launch still on Friday?", teamsCoverFacts(activity("standard", [ANA]), partition, roster));
ok(!baseline.message.includes("Out-of-office cover"), "with cover off, a mention of the person carries no cover note");

await turnCoverOn({ org: ORG, platform: "teams", workspace: TENANT, surface: "a:ana-dm", principalKey: anaKey }, { via: "command", name: "Ana" }, "2026-10-14T09:00:00.000Z");
const covered = await dispatch("@Ana is the launch still on Friday?", teamsCoverFacts(activity("standard", [BOT, ANA]), partition, roster));
ok(new RegExp(`<system-note>Out-of-office cover: this message mentions person ${ANA.replace(":", "\\:")}, and they are away with cover on\\.`).test(covered.message), "🔴 the Teams wake carries OE's cover note as a trusted system note");
ok(!/<system-note>[^<]*\bAna\b/.test(covered.message), "the trusted note names the person by id, never by their chosen display name");
const pointer = await coveredOnWake(ORG, covered.wakeId);
ok(pointer !== undefined && pointer.length === 1 && pointer[0]!.principalKey === anaKey, "the pointer the reply choke point reads names the covered person under the window's wake id");
ok(JSON.stringify(covered.auth) === JSON.stringify(baseline.auth) && JSON.stringify(covered.auth) === JSON.stringify(auth), "🔴 the cover wake's auth is the room's auth, byte for byte: the turn runs as the room");
ok(!JSON.stringify(covered.auth).includes(ANA), "🔴 the auth names nothing of the absent person — they are never the principal");

console.log("§4 the room check");
{
  const entry = (await readPersonalCover(ORG, anaKey)).state!.entries.at(-1)!;
  ok(entry.wakeId === covered.wakeId && entry.inRoom === true && entry.roomPublic === false, "🔴 on a standard channel the roster confirms the person, and the question is marked in-room");
  ok(entry.platform === "teams" && entry.channelId === CHANNEL && entry.surfaceKey === partition.surfaceKey, "the entry names the channel and the room key the reply files under");
  ok(entry.askerName === "Bo" && entry.question === "@Ana is the launch still on Friday?", "the entry keeps the asker's name and the question as the person wrote it");
  ok((await teamsRosterHasMember(roster(), TEAM, ANA)) === true, "the team roster confirms a person it holds");
  ok((await teamsRosterHasMember(roster(), CONVERSATION, ANA)) === false, "the fake answers only on the team's roster path, so §2's confirmation proves the seam addressed the team");
  ok((await teamsRosterHasMember(roster(), TEAM, BO)) === false, "🔴 a non-2xx (a person outside the roster) confirms nothing");
  ok((await teamsRosterHasMember(async () => ({ ok: true, body: { id: BO } }), CONVERSATION, ANA)) === false, "🔴 a 2xx that names another person confirms nothing");
  ok((await teamsRosterHasMember(async () => { throw new Error("connector down"); }, CONVERSATION, ANA)) === false, "a transport throw confirms nothing");
  ok((await teamsRosterHasMember(undefined, CONVERSATION, ANA)) === false, "no probe (an untrusted serviceUrl) confirms nothing");
  const before = rosterCalls;
  const priv = await dispatch("@Ana a private question", teamsCoverFacts(activity("private", [ANA]), partition, roster));
  ok(rosterCalls === before, "a private channel asks no roster: its roster is not the team's");
  const privEntry = (await readPersonalCover(ORG, anaKey)).state!.entries.find((e) => e.wakeId === priv.wakeId)!;
  ok(privEntry !== undefined && privEntry.inRoom === undefined, "…and its question is not marked in-room");
  const unnamed = await dispatch("@Ana no membership type", teamsCoverFacts(activity(undefined, [ANA]), partition, roster));
  ok((await readPersonalCover(ORG, anaKey)).state!.entries.find((e) => e.wakeId === unnamed.wakeId)?.inRoom === undefined, "an activity that names no membership type confirms nobody");
  const { shown, leftOut } = await readableEntries(anaKey, (await readPersonalCover(ORG, anaKey)).state!.entries);
  ok(shown.length === 1 && shown[0]!.wakeId === covered.wakeId && leftOut === 2, `🔴 the recap shows the confirmed question and leaves the other two out (shown ${shown.length}, left out ${leftOut})`);

  const cyKey = `teams/${CY}`;
  await turnCoverOn({ org: ORG, platform: "teams", workspace: TENANT, surface: "a:cy-dm", principalKey: cyKey }, { via: "command", name: "Cy" }, "2026-10-14T09:00:00.000Z");
  const cyWake = await dispatch("@Cy can you check the budget?", teamsCoverFacts(activity("standard", [CY]), partition, roster));
  ok(cyWake.message.includes("Out-of-office cover"), "precondition: Cy's wake is covered");
  const cyEntry = (await readPersonalCover(ORG, cyKey)).state!.entries.find((e) => e.wakeId === cyWake.wakeId)!;
  ok(cyEntry !== undefined && cyEntry.inRoom === undefined, "🔴 on a standard channel, a person outside the team's roster is NOT marked in-room");
  const cyRecap = await readableEntries(cyKey, [cyEntry]);
  ok(cyRecap.shown.length === 0 && cyRecap.leftOut === 1, "🔴 …and the recap leaves their question out and only counts it");
  await turnCoverOff({ org: ORG, platform: "teams", workspace: TENANT, surface: "a:cy-dm", principalKey: cyKey }, "command");
}

console.log("§5 the reply");
{
  const posted: Array<{ text: string; intent?: PostIntent }> = [];
  const origin = { platform: "teams", serviceUrl: SERVICE, conversationId: CONVERSATION, replyToActivityId: "1700", tenantId: TENANT } as never;
  const ctx = { channel: { kind: "teams" }, session: { id: "sess-teams-cover", auth: { current: auth } } } as never;
  await postUnifiedReply(origin, "The launch is still on Friday, per this channel.", { postTeams: async (_o, text, intent) => (posted.push({ text, intent }), "act-1") }, replyAuditFor(ctx, "tool", covered.wakeId));
  const out = posted[0]!;
  ok(out.text === "Cover for Ana, who is away:\nThe launch is still on Friday, per this channel.", `🔴 a Teams reply on a cover wake starts with the HOST's cover label (got ${JSON.stringify(out.text)})`);
  const activityOut = teamsAnswerActivity(out.text, out.intent) as { text?: string; entities?: Array<{ additionalType?: string[] }> };
  ok(JSON.stringify(activityOut.entities?.[0]?.additionalType) === JSON.stringify(["AIGeneratedContent"]), "🔴 the activity the live arm renders carries Teams' own AI label: a cover answer is model text (OPE-2542)");
  ok(activityOut.text?.startsWith("Cover for Ana, who is away:") === true, "…and the label a person reads is the first line of the activity");
  const entry = (await readPersonalCover(ORG, anaKey)).state!.entries.find((e) => e.wakeId === covered.wakeId)!;
  ok(entry.answer === "The launch is still on Friday, per this channel.", "the reply's own text, without the label, becomes the answer in the recap log");
  posted.length = 0;
  await postUnifiedReply(origin, "Plain answer.", { postTeams: async (_o, text, intent) => (posted.push({ text, intent }), "act-2") }, replyAuditFor(ctx, "tool", baseline.wakeId));
  ok(posted[0]!.text === "Plain answer.", "a reply on a wake that covered nobody is byte-identical");
}

console.log("§6 the recap's room name");
{
  const entry = (await readPersonalCover(ORG, anaKey)).state!.entries.find((e) => e.wakeId === covered.wakeId)!;
  ok(!renderCoverRecapBody([entry], 0, undefined).includes("19:"), "with no name found, the recap names the room in plain words, never by its id");
  registerFriendlyNameResolver("teams", async (id) => (id === CHANNEL ? { label: "#Launch", kind: "channel" as const } : undefined));
  const body = renderCoverRecapBody([entry], 0, undefined, await coverRoomLabels([entry]));
  ok(body.includes("Bo in #Launch") && !body.includes("19:"), `🔴 the recap names the Teams channel by the name the resolver found (got ${JSON.stringify(body)})`);
}

console.log("§7 no note");
ok(!(await dispatch("@Bo any news?", teamsCoverFacts(activity("standard", [BO]), partition, roster))).message.includes("Out-of-office cover"), "a mention of somebody without cover carries no note");
ok(!(await dispatch("@Ana any news?", undefined)).message.includes("Out-of-office cover"), "a dispatch with no cover facts asks nothing, and the wake is the one it always built");
await turnCoverOff({ org: ORG, platform: "teams", workspace: TENANT, surface: "a:ana-dm", principalKey: anaKey }, "command");
ok(!(await dispatch("@Ana still there?", teamsCoverFacts(activity("standard", [ANA]), partition, roster))).message.includes("Out-of-office cover"), "🔴 after `/oe cover off`, a mention of the person carries no note");

console.log(`✓ teams-cover: ${n} assertions`);
