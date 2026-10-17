import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-meetings-discord-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "meetings.sqlite3");

const { parseMeetingLink } = await import("../agent/meetings/link.js");
const { DEFAULT_MEETING_POLICY, meetingPolicyProblems, meetingJoinRefusal, nativeRecapRefusal } = await import("../agent/meetings/policy.js");
const lifecycle = await import("../agent/meetings/lifecycle.js");
const voice = await import("../agent/meetings/discord-voice.js");
const { registerMeetingCompletion, resetTranscriptionRoutesForTest } = await import("../agent/meetings/transcription.js");
const { meetingJoinSummary } = await import("../agent/approvals/meeting-join.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { standardWebhookSignature } = await import("../agent/webhooks/oe-standard-webhook.js");
const { getVoiceSession, transcriptOrder, putMeetingRow, getMeetingRow, readTranscript } = await import("../agent/meetings/store.js");
import type { MeetingPolicy } from "../agent/meetings/policy.js";
import type { BoxListing, BoxSpec, LongLivedBoxBackend } from "../agent/sandbox/long-lived-box.js";
import type { MeetingJoinArgs } from "../agent/meetings/lifecycle.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejects(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const GUILD = "111111111111111111";
const OTHER_GUILD = "999999999999999999";
const VOICE_CH = "222222222222222222";
const VOICE_CH2 = "222222222222222299";
const BOT = "333333333333333333";
const ANA = "444444444444444444";
const BEN = "555555555555555555";
const RELAY = BOT;

{
  const l = parseMeetingLink(`https://discord.com/channels/${GUILD}/${VOICE_CH}`);
  ok(l.ok && l.link.platform === "discord" && l.link.guildId === GUILD && l.link.channelId === VOICE_CH && l.link.roomId === `${GUILD}/${VOICE_CH}` && l.link.url === `https://discord.com/channels/${GUILD}/${VOICE_CH}`, "a voice channel link parses to its server and channel");
  for (const [raw, label] of [
    [`https://discord.com/channels/@me/${VOICE_CH}`, "a DM link"],
    [`https://discord.com/channels/${GUILD}/${VOICE_CH}/123456789012345678`, "a message link"],
    [`https://discord.com.evil.example/channels/${GUILD}/${VOICE_CH}`, "a look-alike host"],
    [`https://discord.com/invite/abc`, "an invite link"],
    [`https://discord.com/channels/12/34`, "ids that are not Discord ids"],
  ] as const) {
    ok(!parseMeetingLink(raw).ok, `refuses ${label}`);
  }
}

const POLICY: MeetingPolicy = {
  ...DEFAULT_MEETING_POLICY,
  enabled: true,
  hosts: [{ platform: "discord", host: "discord.com", guilds: [GUILD], why: "test" }],
  transcription: { route: "box" },
};
{
  const p = (over: Partial<MeetingPolicy>): readonly string[] => meetingPolicyProblems({ ...POLICY, ...over });
  ok(p({}).length === 0, "a Discord rule that lists its server is valid");
  ok(p({ hosts: [{ platform: "discord", host: "discord.com", why: "x" }] }).some((x) => x.includes("server (guild) ids")), "a Discord rule without servers is refused");
  ok(p({ hosts: [{ platform: "discord", host: "discord.com", guilds: ["abc"], why: "x" }] }).some((x) => x.includes("not a Discord server id")), "a server id that is not a Discord id is refused");
  ok(p({ hosts: [{ platform: "meet", host: "meet.google.com", owner: "unverifiable", guilds: [GUILD], why: "x" }] }).some((x) => x.includes("Discord only")), "servers on a non-Discord rule are refused");
  const ask = { trust: "internal" as const, nonMember: false, actingPrincipal: "discord/U1" };
  const here = parseMeetingLink(`https://discord.com/channels/${GUILD}/${VOICE_CH}`);
  const there = parseMeetingLink(`https://discord.com/channels/${OTHER_GUILD}/${VOICE_CH}`);
  if (!here.ok || !there.ok) throw new Error("fixture links must parse");
  ok(meetingJoinRefusal(POLICY, here.link, ask) === undefined, "a voice channel on a listed server may go to the card");
  ok((meetingJoinRefusal(POLICY, there.link, ask) ?? "").includes("may not join"), "a voice channel on another server is refused before any card");
  const nativeOn = { ...POLICY, native: { enabled: true, watchHours: 24, zoom: { accountId: "a", clientId: "c", clientSecretRef: "Z", why: "x" } } } as unknown as MeetingPolicy;
  ok((nativeRecapRefusal(nativeOn, here.link, ask) ?? "").includes("Discord keeps no transcript"), "a Discord link asks for no native recap: Discord keeps no transcript (it does not fall into the Zoom branch)");
}

{
  const { resolveMeetingLink, inviteRefusal } = await import("../agent/meetings/invite.js");
  const { discordInviteCode, DISCORD_INVITE_NOT_READ } = await import("../agent/meetings/link.js");
  type Lookup = import("../agent/meetings/invite.js").MeetingInviteLookup;
  const asked: string[] = [];
  const answering = (answer: Lookup | Error) =>
    new Map([["discord" as const, async (code: string) => { asked.push(code); if (answer instanceof Error) throw answer; return answer; }]]);
  const voiceHere = answering({ found: true, guildId: GUILD, channelId: VOICE_CH, channelKind: "voice" });
  const copyLink = parseMeetingLink(`https://discord.com/channels/${GUILD}/${VOICE_CH}`);
  if (!copyLink.ok) throw new Error("fixture link must parse");

  ok(discordInviteCode("https://discord.gg/aBc12-x") === "aBc12-x" && discordInviteCode("https://discord.com/invite/aBc12") === "aBc12", "both invite link shapes carry their code");
  for (const [raw, label] of [
    ["http://discord.gg/abc12", "plain http"],
    ["https://discord.gg.evil.example/abc12", "a look-alike host"],
    ["https://discord.gg/abc12/extra", "an extra path part"],
    ["https://discord.com/channels/abc12", "a channels path"],
    ["https://user:pw@discord.gg/abc12", "a user name and password"],
  ] as const) {
    ok(discordInviteCode(raw) === undefined, `an invite code is NOT read from ${label}`);
  }

  for (const raw of ["https://discord.gg/abc12", "https://discord.com/invite/abc12"]) {
    asked.length = 0;
    const r = await resolveMeetingLink(raw, voiceHere);
    ok(asked.length === 1 && asked[0] === "abc12", `🔴 ${raw} is LOOKED UP by its code (asked: ${asked.join(",")})`);
    ok(r.ok && r.link.platform === "discord" && r.link.roomId === copyLink.link.roomId && r.link.url === copyLink.link.url && r.link.guildId === GUILD && r.link.channelId === VOICE_CH, `🔴 ${raw} resolves to EXACTLY the voice channel's Copy Link result`);
    if (r.ok) ok(meetingJoinRefusal(POLICY, r.link, ask0()) === undefined, "the resolved channel on a listed server may go to the card");
  }
  const elsewhere = await resolveMeetingLink("https://discord.gg/abc12", answering({ found: true, guildId: OTHER_GUILD, channelId: VOICE_CH, channelKind: "voice" }));
  ok(elsewhere.ok && (meetingJoinRefusal(POLICY, elsewhere.link, ask0()) ?? "").includes("may not join"), "🔴 an invite to an UNLISTED server's voice channel is still refused by the policy before any card");

  const cases: readonly [Map<"discord", (code: string) => Promise<Lookup>> | Map<never, never>, string, string][] = [
    [new Map(), "no Discord connection", "no lookup registered"],
    [answering({ found: false, why: "unknown" }), "expired or does not exist", "an unknown code"],
    [answering({ found: false, why: "no-channel" }), "not to a server's voice channel", "an invite with no server channel"],
    [answering({ found: false, why: "unreachable" }), "couldn't reach Discord", "a failed lookup"],
    [answering(new Error("boom")), "couldn't reach Discord", "a lookup that throws"],
    [answering({ found: true, guildId: GUILD, channelId: VOICE_CH, channelKind: "stage" }), "stage channel", "a stage channel"],
    [answering({ found: true, guildId: GUILD, channelId: VOICE_CH, channelKind: "other" }), "text channel, not a voice channel", "a text channel"],
    [answering({ found: true, guildId: "12", channelId: VOICE_CH, channelKind: "voice" }), "couldn't reach Discord", "a lookup that answers a malformed id"],
  ];
  for (const [resolvers, needle, label] of cases) {
    const r = await resolveMeetingLink("https://discord.gg/abc12", resolvers as ReadonlyMap<"discord", (code: string) => Promise<Lookup>>);
    ok(!r.ok && r.reason.includes(needle), `${label} is refused with "${needle}" (got: ${r.ok ? "ok" : r.reason})`);
    ok(!r.ok && !/\d{17,20}/.test(r.reason), `${label}: the reason carries no raw Discord id`);
  }
  ok(inviteRefusal("no-resolver").includes("Copy Link"), "with no lookup, the person is told to paste the Copy Link link");
  const pure = parseMeetingLink("https://discord.gg/abc12");
  ok(!pure.ok && pure.reason === DISCORD_INVITE_NOT_READ && !pure.reason.includes("none of them"), "the pure parse names an invite as an invite, not as an unknown meeting host");
  asked.length = 0;
  const meet = await resolveMeetingLink("https://meet.google.com/abc-defg-hij", voiceHere);
  ok(meet.ok && meet.link.platform === "meet" && asked.length === 0, "a non-invite link is parsed directly and never looked up");
}
function ask0() {
  return { trust: "internal" as const, nonMember: false, actingPrincipal: "discord/U1" };
}

function fakeBackend(): { backend: LongLivedBoxBackend; opened: BoxSpec[]; stopped: string[] } {
  const opened: BoxSpec[] = [];
  const stopped: string[] = [];
  const boxes: BoxListing[] = [];
  const backend: LongLivedBoxBackend = {
    backend: "fake",
    metered: false,
    maxMinutesCeiling: 1440,
    async open(spec) {
      opened.push(spec);
      const name = `box-${opened.length}`;
      const createdAt = Date.now() - 10 * 60_000;
      boxes.push({ name, status: "running", createdAt, purpose: spec.purpose, ref: spec.ref });
      return { name, backend: "fake", createdAt, maxMinutes: spec.maxMinutes };
    },
    async status(name) {
      return boxes.find((b) => b.name === name);
    },
    async list(purpose) {
      return boxes.filter((b) => b.purpose === purpose);
    },
    async stop(name) {
      stopped.push(name);
    },
  };
  return { backend, opened, stopped };
}

const ORG = "default";
const partition = { org: ORG, platform: "discord", workspace: GUILD, surface: "C-text", workspaceKey: `discord/${GUILD}`, surfaceKey: `discord/${GUILD}/C-text`, key: `discord/${GUILD}/C-text` };
function args(channel = VOICE_CH): MeetingJoinArgs {
  return {
    org: ORG,
    scopeKey: partition.surfaceKey,
    meetingId: lifecycle.mintMeetingId(),
    url: `https://discord.com/channels/${GUILD}/${channel}`,
    platform: "discord",
    host: "discord.com",
    roomId: `${GUILD}/${channel}`,
    requestedBy: "discord/U1",
    origin: { platform: "discord", channelId: "C-text", threadTs: null },
    partition,
    maxMinutes: 120,
    transcriptDays: 30,
    transcriptionDisclosure: "box",
    backend: "fake",
  };
}
let msgSeq = 0;
function signed(secret: string, body: unknown): { raw: string; headers: Headers } {
  const raw = JSON.stringify(body);
  const id = `msg_d${++msgSeq}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return { raw, headers: new Headers({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": standardWebhookSignature(secret, id, ts, raw) }) };
}

{
  resetTranscriptionRoutesForTest();
  const fake = fakeBackend();
  const posts: { platform: string; channelId: string; text: string }[] = [];
  const post = async (platform: string, target: { channelId: string; text: string }): Promise<string> => {
    posts.push({ platform, channelId: target.channelId, text: target.text });
    return `m-${posts.length}`;
  };
  const prompts: string[] = [];
  registerMeetingCompletion(async (_scope, prompt) => {
    prompts.push(prompt);
    return '{"summary": "Ana and Ben agreed the plan.", "decisions": [], "actions": []}';
  });
  const deps = { policy: POLICY, backend: fake.backend, post };

  const a: MeetingJoinArgs = { ...args(), channelLabel: "#General", serverLabel: "the Acme server" };
  const summary = meetingJoinSummary(a).join("\n");
  ok(summary.includes("voice channel") && summary.includes("recording notice") && !summary.includes("lobby"), "the card says the bot shows in the channel and posts a recording notice, and names no lobby");
  ok(meetingJoinSummary(a)[0] === "Send OE's meeting bot into the voice channel #General on the Acme server on Discord", "the card names the voice channel and the server");
  const plain = actionKind("meeting.join")!.plainSummary!(a);
  ok(plain.includes("#General") && plain.includes("the Acme server"), "the card's plain summary names the voice channel and the server");
  ok(![summary, plain].some((t) => t.includes(GUILD) || t.includes(VOICE_CH)), "no raw server or channel id reaches the card's text");
  const consequence = actionKind("meeting.join")!.consequence!(a) ?? "";
  ok(plain === "Send the notetaker to the voice channel #General on the Acme server and post a recap here", `the Discord headline names the room in plain words (got ${JSON.stringify(plain)})`);
  ok(consequence === "It records everyone in the channel for up to 120 min, after a notice in its chat. OE keeps the transcript 30 days.", `the Discord consequence line names the notice and no host (got ${JSON.stringify(consequence)})`);
  const { personTextFaults } = await import("../agent/channels/person-text.js");
  ok([plain, consequence].every((t) => personTextFaults(t).length === 0), `the Discord headline and consequence pass the person-text detector (${JSON.stringify([plain, consequence].flatMap(personTextFaults))})`);
  const unnamed = meetingJoinSummary(args()).join("\n") + actionKind("meeting.join")!.plainSummary!(args());
  ok(unnamed.includes("a Discord voice channel") && !unnamed.includes(GUILD) && !unnamed.includes(VOICE_CH), "when the names did not resolve, the card says \"a Discord voice channel\", never the ids");
  const asked: string[] = [];
  const labels = await voice.discordRoomLabels(`${GUILD}/${VOICE_CH}`, async (key) => {
    asked.push(key);
    return key.split("/").length === 3 ? "#General" : "the Acme server";
  });
  ok(asked.includes(`discord/${GUILD}/${VOICE_CH}`) && asked.includes(`discord/${GUILD}`) && labels.channelLabel === "#General" && labels.serverLabel === "the Acme server", "the room's names come from the shared scope-label lookup, for the channel and the server");
  ok(JSON.stringify(await voice.discordRoomLabels(`${GUILD}/${VOICE_CH}`, async () => undefined)) === "{}" && voice.discordRoomWords({}) === "a Discord voice channel", "a failed lookup gives no label, and the words fall back without an id");
  const spec = lifecycle.meetingBoxSpec(a, POLICY, "https://oe.example", "whsec_x");
  ok(spec.command.join(" ") === "node /opt/oe-meeting-bot/discord.mjs", "a Discord meeting's box runs the voice program from the same image");
  ok(Object.keys(spec.env).every((k) => k.startsWith("OE_MEETING_")) && !JSON.stringify(spec.env).includes("DISCORD_BOT_TOKEN"), "the box env carries no bot token and no deployment credential");

  const idle = await voice.syncDiscordVoice(ORG, { relayId: RELAY, sessions: [] }, { policy: POLICY });
  ok(idle.voice.length === 0 && idle.nextPollMs === voice.VOICE_SYNC_READY_MS, "with nothing open, the relay syncs at the ready interval");
  const off = await voice.syncDiscordVoice(ORG, { relayId: RELAY, sessions: [] }, { policy: DEFAULT_MEETING_POLICY });
  ok(off.nextPollMs === voice.VOICE_SYNC_IDLE_MS, "with meetings off, the relay syncs at the idle interval");

  const rec = await lifecycle.openMeeting(a, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  await rejects(() => lifecycle.openMeeting(args(VOICE_CH2), "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" }), "one voice channel per server", "a second meeting on the same server is refused at the click");
  ok(fake.opened.length === 1, "the refused second meeting opened no box");
  const replayed = await lifecycle.openMeeting(a, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  ok(replayed.id === a.meetingId && replayed.box.name === rec.box.name && fake.opened.length === 1, "a replayed open of the first meeting returns its own record, not the one-per-server refusal");

  const s1 = await voice.syncDiscordVoice(ORG, { relayId: RELAY, sessions: [] }, { policy: POLICY });
  ok(s1.voice.length === 1 && s1.voice[0]!.meetingId === a.meetingId && s1.voice[0]!.guildId === GUILD && s1.voice[0]!.channelId === VOICE_CH && s1.voice[0]!.deadlineMs === rec.box.createdAt + rec.box.maxMinutes * 60_000 && s1.nextPollMs === voice.VOICE_SYNC_ACTIVE_MS, "the open meeting is listed for the relay, with its server, channel and deadline, at the active interval");

  const v0 = signed(rec.secret, { type: "voice" });
  const ans0 = await lifecycle.handleMeetingCallback(ORG, a.meetingId, v0.raw, v0.headers, deps);
  ok(ans0.status === 200 && ans0.body.credentials === undefined, "before the relay reports, the box gets no credentials");

  const creds = { guildId: GUILD, channelId: VOICE_CH, userId: BOT, sessionId: "sess1", token: "vtok1", endpoint: "c-ams1.discord.media:443" };
  const report = (c: unknown, members?: unknown) => voice.parseVoiceSync({ source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId: RELAY, sessions: [{ meetingId: a.meetingId, credentials: c, ...(members !== undefined ? { members } : {}) }] } })!;
  await voice.syncDiscordVoice(ORG, report({ ...creds, channelId: VOICE_CH2 }), { policy: POLICY });
  ok((await getVoiceSession(ORG, a.meetingId))?.credentials === undefined, "credentials that name another channel are ignored");
  await voice.syncDiscordVoice(ORG, report(creds, [{ id: ANA, name: "Ana [admin]" }, { id: BEN, name: "Ben" }, { id: "bad", name: "x" }]), { policy: POLICY });
  {
    const { getOperationalStore } = await import("../agent/operational/provider.js");
    ok((await getMeetingRow(ORG, `meeting-voice:${a.meetingId}`)) !== null && (await getOperationalStore().getTaskResult(ORG, `meeting-voice:${a.meetingId}`)) === null, "the voice row lives in meeting_data, not in task_result");
  }
  const v1 = signed(rec.secret, { type: "voice" });
  const ans1 = await lifecycle.handleMeetingCallback(ORG, a.meetingId, v1.raw, v1.headers, deps);
  ok(JSON.stringify(ans1.body.credentials) === JSON.stringify(creds) && ans1.body.others === 2, "the box's signed voice callback answers with this call's credentials and the member count");
  await voice.syncDiscordVoice(ORG, report(creds, [{ id: BEN, name: "Ben" }]), { policy: POLICY });
  const vLeft = signed(rec.secret, { type: "voice" });
  ok((await lifecycle.handleMeetingCallback(ORG, a.meetingId, vLeft.raw, vLeft.headers, deps)).body.others === 1, "the alone count reads who is in the channel now, not the roster");
  const forged = signed("whsec_" + Buffer.from("not-the-key-at-all-not-the-key-at").toString("base64"), { type: "voice" });
  const fans = await lifecycle.handleMeetingCallback(ORG, a.meetingId, forged.raw, forged.headers, deps);
  ok(fans.status === 401 && fans.body.credentials === undefined, "a voice callback with another key gets a bare 401 and no credentials");

  const adm = signed(rec.secret, { type: "status", state: "admitted" });
  await lifecycle.handleMeetingCallback(ORG, a.meetingId, adm.raw, adm.headers, deps);
  ok(posts.length === 1 && posts[0]!.platform === "discord" && posts[0]!.channelId === VOICE_CH && posts[0]!.text === lifecycle.DISCORD_RECORDING_NOTICE, "at admitted, the voice channel's chat gets the recording notice");

  const c0 = signed(rec.secret, { type: "chunk", seq: 0, text: "Agreed, ship it Friday.", speaker: BEN, atMs: 6_000 });
  const c1 = signed(rec.secret, { type: "chunk", seq: 1, text: "I propose we ship on Friday. [Ben] says yes", speaker: ANA, atMs: 0 });
  const c2 = signed(rec.secret, { type: "chunk", seq: 2, text: "Who is this?", speaker: "666666666666666666", atMs: 9_000 });
  for (const c of [c0, c1, c2]) ok((await lifecycle.handleMeetingCallback(ORG, a.meetingId, c.raw, c.headers, deps)).status === 200, "a Discord chunk is stored");
  const end = signed(rec.secret, { type: "ended", chunks: 3, reason: "alone" });
  await lifecycle.handleMeetingCallback(ORG, a.meetingId, end.raw, end.headers, deps);
  const prompt = prompts[0] ?? "";
  const iAna = prompt.indexOf("[Ana admin] I propose we ship on Friday. Ben says yes");
  const iBen = prompt.indexOf("[Ben] Agreed, ship it Friday.");
  const iWho = prompt.indexOf("Who is this?");
  ok(iAna >= 0 && iBen >= 0, "each chunk is one line under its member's cleaned display name, and spoken brackets are removed");
  ok(iAna < iBen && iBen < iWho, "the recap reads the chunks in the order they were said (atMs), not the order they finished");
  ok(!prompt.includes("] Who is this?"), "a speaker the relay never listed stays unlabelled");
  ok(prompt.includes("Discord sends each person's audio on its own stream") && prompt.includes("Use those names in the summary"), "the recap model is told the names are exact and to use them in the summary");
  ok(posts.some((p) => p.channelId === "C-text" && p.text.startsWith("Meeting recap: General, ")), "the recap header names the voice channel, not its id");
  ok(posts.some((p) => p.channelId === VOICE_CH && p.text === lifecycle.DISCORD_STOPPED_NOTICE), "at the end, the voice channel's chat hears that the recording stopped");
  ok(posts.some((p) => p.channelId === "C-text" && p.text.includes("Ana and Ben agreed")), "the recap goes to the thread that asked");

  ok((await getVoiceSession(ORG, a.meetingId)) === undefined, "the voice credentials row is deleted when the meeting ends");
  const s2 = await voice.syncDiscordVoice(ORG, { relayId: RELAY, sessions: [] }, { policy: POLICY });
  ok(s2.voice.length === 0, "an ended meeting drops off the relay's list, so the bot leaves the channel");
  const v2 = signed(rec.secret, { type: "voice" });
  ok((await lifecycle.handleMeetingCallback(ORG, a.meetingId, v2.raw, v2.headers, deps)).body.ended === true, "the box's voice callback after the end answers ended");

  const b = args(VOICE_CH2);
  const recB = await lifecycle.openMeeting(b, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  const failed = voice.parseVoiceSync({ source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId: RELAY, sessions: [{ meetingId: b.meetingId, failed: "stage-channel" }] } })!;
  const s3 = await voice.syncDiscordVoice(ORG, failed, { policy: POLICY });
  ok(s3.voice.length === 0, "a meeting whose join failed drops off the list, so the relay stops retrying");
  const vb = signed(recB.secret, { type: "voice" });
  ok((await lifecycle.handleMeetingCallback(ORG, b.meetingId, vb.raw, vb.headers, deps)).body.failed === "stage-channel", "the box reads the relay's failure code");

  ok((await lifecycle.handleMeetingCallback(ORG, b.meetingId, vb.raw, vb.headers, deps)).body.duplicate === true, "a replayed voice callback is a no-op");
  const endB = signed(recB.secret, { type: "ended", chunks: 0, reason: "failed" });
  await lifecycle.handleMeetingCallback(ORG, b.meetingId, endB.raw, endB.headers, deps);
}

{
  const fake = fakeBackend();
  const posts: { channelId: string; text: string }[] = [];
  const post = async (_platform: string, target: { channelId: string; text: string }): Promise<string> => {
    if (target.channelId === VOICE_CH) throw new Error("Missing Permissions");
    posts.push(target);
    return "m";
  };
  const deps = { policy: POLICY, backend: fake.backend, post };
  const c = args();
  const rec = await lifecycle.openMeeting(c, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  const adm = signed(rec.secret, { type: "status", state: "admitted" });
  const ans = await lifecycle.handleMeetingCallback(ORG, c.meetingId, adm.raw, adm.headers, deps);
  ok(ans.status === 200 && ans.body.ended === true, "when the recording notice cannot post, the admitted callback answers ended, so the box never captures");
  ok(fake.stopped.includes(rec.box.name), "the box is stopped");
  const chunk = signed(rec.secret, { type: "chunk", seq: 0, text: "secret plans", speaker: ANA, atMs: 0 });
  const cans = await lifecycle.handleMeetingCallback(ORG, c.meetingId, chunk.raw, chunk.headers, deps);
  ok(cans.body.ended === true, "a chunk after the failed notice is refused: nothing is recorded");
  ok(posts.length === 1 && posts[0]!.channelId === "C-text" && posts[0]!.text.includes("recording notice"), "the asking thread hears why, and gets no recap");
  const sync = await voice.syncDiscordVoice(ORG, { relayId: RELAY, sessions: [] }, { policy: POLICY });
  ok(sync.voice.length === 0, "the meeting drops off the relay's list, so the bot leaves");
  const again = await lifecycle.openMeeting(args(), "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  ok(again.box.name !== "", "the server is free again for the next meeting once the failed one ended");
  const endAgain = signed(again.secret, { type: "ended", chunks: 0, reason: "failed" });
  await lifecycle.handleMeetingCallback(ORG, again.id, endAgain.raw, endAgain.headers, deps);
}

{
  const fake = fakeBackend();
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const ended = args();
  const recE = await lifecycle.openMeeting(ended, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  const { putMeetingRecord } = await import("../agent/meetings/store.js");
  await putMeetingRecord({ ...recE, status: "ended" }, 60 * 60_000);
  const next = await lifecycle.openMeeting(args(), "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  ok(next.box.name !== "", "a server claim whose meeting ended is reclaimed by the next meeting");
  await putMeetingRecord({ ...next, status: "ended" }, 60 * 60_000);
  const ghost = lifecycle.mintMeetingId();
  await putMeetingRow(ORG, `meeting-guild:${GUILD}`, JSON.stringify({ id: ghost, at: Date.now() }), 60 * 60_000);
  await rejects(() => lifecycle.openMeeting(args(), "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" }), "one voice channel per server", "a young claim with no record may be an open in flight, so it still holds");
  const staleValue = JSON.stringify({ id: ghost, at: Date.now() - 31 * 60_000 });
  await putMeetingRow(ORG, `meeting-guild:${GUILD}`, staleValue, 60 * 60_000);
  const { createHash } = await import("node:crypto");
  const tag = createHash("sha256").update(staleValue).digest("hex").slice(0, 32);
  await putMeetingRow(ORG, `meeting-guild-reclaim:${GUILD}:${tag}`, "another-contender", 60 * 60_000);
  const { claimDiscordGuild } = await import("../agent/meetings/store.js");
  ok(!(await claimDiscordGuild(ORG, GUILD, lifecycle.mintMeetingId(), 60 * 60_000)), "a contender that lost the reclaim claim on a stale holder refuses, so two opens cannot both reclaim");
  ok((await getMeetingRow(ORG, `meeting-guild:${GUILD}`)) === staleValue && (await getOperationalStore().getTaskResult(ORG, `meeting-guild:${GUILD}`)) === null, "the loser deleted nothing, and the server claim lives in meeting_data, not in task_result");
  await putMeetingRow(ORG, `meeting-guild:${GUILD}`, JSON.stringify({ id: ghost, at: Date.now() - 32 * 60_000 }), 60 * 60_000);
  const after = await lifecycle.openMeeting(args(), "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  ok(after.box.name !== "", "a dead open's claim (no record, no slot, over 30 minutes) is reclaimed");
}

{
  resetTranscriptionRoutesForTest();
  const fake = fakeBackend();
  const posts: { channelId: string; text: string }[] = [];
  const post = async (_platform: string, target: { channelId: string; text: string }): Promise<string> => {
    posts.push(target);
    return `m-${posts.length}`;
  };
  const prompts: string[] = [];
  registerMeetingCompletion(async (_scope, prompt) => {
    prompts.push(prompt);
    const named = /\[([^\]]+)\] /.exec(prompt)?.[1];
    return JSON.stringify({ summary: `${named ?? "A participant"} tested the notetaker.`, decisions: [], actions: [] });
  });
  const deps = { policy: POLICY, backend: fake.backend, post };
  const ROWAN = "777777777777777777";
  const t: MeetingJoinArgs = { ...args(), roomId: `${OTHER_GUILD}/${VOICE_CH}`, url: `https://discord.com/channels/${OTHER_GUILD}/${VOICE_CH}`, channelLabel: "#General" };
  const rec = await lifecycle.openMeeting(t, "discord/U2", { policy: POLICY, backend: fake.backend, callbackBase: "https://oe.example" });
  const creds = { guildId: OTHER_GUILD, channelId: VOICE_CH, userId: BOT, sessionId: "sess9", token: "vtok9", endpoint: "c-ams1.discord.media:443" };
  const sync = (members: unknown) => voice.syncDiscordVoice(ORG, voice.parseVoiceSync({ source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId: RELAY, sessions: [{ meetingId: t.meetingId, credentials: creds, members }] } })!, { policy: POLICY });
  await sync([{ id: ROWAN, name: "Rowan" }]);
  const adm = signed(rec.secret, { type: "status", state: "admitted" });
  await lifecycle.handleMeetingCallback(ORG, t.meetingId, adm.raw, adm.headers, deps);
  await sync([]);
  const c0 = signed(rec.secret, { type: "chunk", seq: 0, text: "This is a test of the meeting notetaker.", speaker: ROWAN, atMs: 0 });
  ok((await lifecycle.handleMeetingCallback(ORG, t.meetingId, c0.raw, c0.headers, deps)).status === 200, "the last chunk arrives after the speaker left");
  const read = await readTranscript(ORG, t.meetingId, 1);
  ok(read.text === "[Rowan] This is a test of the meeting notetaker." && read.labelled === 1, "the speaker who left keeps their name: one labelled transcript line");
  const end = signed(rec.secret, { type: "ended", chunks: 1, reason: "alone" });
  await lifecycle.handleMeetingCallback(ORG, t.meetingId, end.raw, end.headers, deps);
  ok(prompts.length === 1 && prompts[0]!.includes("[Rowan] This is a test of the meeting notetaker."), "the recap model reads the named line");
  const recapPost = posts.find((p) => p.channelId === "C-text")?.text ?? "";
  ok(recapPost === "Meeting recap: General, 10 min\n\n> Rowan tested the notetaker.", `the recap names the speaker, and it is a header and a summary only (got ${JSON.stringify(recapPost)})`);
}

{
  ok(voice.parseVoiceSync({ source: "discord-gateway-relay", event: "HEARTBEAT", heartbeat: {} }) === null, "a heartbeat is not a voice sync");
  ok(voice.parseVoiceSync({ source: "other", event: "VOICE_SYNC", voice: { relayId: RELAY, sessions: [] } }) === null, "another source is not a voice sync");
  ok(voice.parseVoiceSync({ source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId: "x", sessions: [] } }) === null, "a relay id that is not a Discord id is refused");
  const r = voice.parseVoiceSync({ source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId: RELAY, sessions: [{ meetingId: "mtg_x", credentials: { guildId: GUILD, channelId: VOICE_CH, userId: BOT, sessionId: "s", token: "t t", endpoint: "e" } }, { meetingId: "mtg_y", failed: "made-up" }] } });
  ok(r !== null && r.sessions[0]!.credentials === undefined && r.sessions[1]!.failed === undefined, "malformed credentials and an unknown failure code are dropped");
  const order = transcriptOrder([{ seq: 0, chunk: { text: "b", atMs: 5 } }, { seq: 1, chunk: { text: "a", atMs: 1 } }]).map((c) => c.text).join("");
  const mixed = transcriptOrder([{ seq: 0, chunk: { text: "b", atMs: 5 } }, { seq: 1, chunk: { text: "a" } }]).map((c) => c.text).join("");
  ok(order === "ab" && mixed === "ba", "chunks read by arrival time when every chunk has one, else by sequence");
  const roster = voice.mergeRoster([{ id: ANA, name: "Ana" }, { id: BEN, name: "Ben" }], [{ id: BEN, name: "Benjamin" }]);
  ok(JSON.stringify(roster) === JSON.stringify([{ id: ANA, name: "Ana" }, { id: BEN, name: "Benjamin" }]), "the roster keeps a member who left and takes the latest name of one who stayed");
}

console.log(`✓ meetings-discord-test: ${passed} assertions`);
