import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOIN_TIMEOUT_MS, channelRefusal, credentialsFrom, heldReport, nextDelay, parseSyncAnswer, planVoice, voiceStatePayload, voiceSyncEnvelope } from "../deploy/discord-relay/voice.js";

let n = 0;
const ok = (label: string, cond: boolean): void => {
  assert.ok(cond, label);
  n++;
};

const G1 = "111111111111111111";
const G2 = "222222222222222222";
const C1 = "333333333333333333";
const C2 = "444444444444444444";
const BOT = "555555555555555555";
const M1 = "mtg_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const M2 = "mtg_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const M3 = "mtg_cccccccccccccccccccccccccc";
const NOW = 1_000_000;

{
  const desired = [
    { meetingId: M1, guildId: G1, channelId: C1, deadlineMs: NOW + 60_000 },
    { meetingId: M2, guildId: G2, channelId: C2, deadlineMs: NOW + 60_000 },
  ];
  const p0 = planVoice(desired, new Map(), NOW);
  ok("a listed meeting the relay is not in is joined", p0.join.map((v) => v.meetingId).join(",") === `${M1},${M2}` && p0.leave.length === 0);
  const held = new Map([[M1, { guildId: G1, channelId: C1 }], [M2, { guildId: G2, channelId: C2 }]]);
  ok("a held, listed meeting is neither joined again nor left", planVoice(desired, held, NOW).join.length === 0 && planVoice(desired, held, NOW).leave.length === 0);
  const p1 = planVoice([desired[1]!], held, NOW);
  ok("a meeting the deployment no longer lists is left (it ended)", p1.leave.join(",") === M1 && p1.join.length === 0);
  const p2 = planVoice(desired, held, NOW + 60_001);
  ok("a meeting past its deadline is left even while still listed", p2.leave.join(",") === `${M1},${M2}` && p2.join.length === 0);
  const twice = [desired[0]!, { meetingId: M3, guildId: G1, channelId: C2, deadlineMs: NOW + 60_000 }];
  const p3 = planVoice(twice, new Map(), NOW);
  ok("two meetings in one server: only the first is joined (one voice channel per server)", p3.join.map((v) => v.meetingId).join(",") === M1);
  ok("a server the relay already serves for another meeting is not joined again", planVoice([twice[1]!, desired[0]!], new Map([[M1, { guildId: G1, channelId: C1 }]]), NOW).join.length === 0);
}

{
  const join = voiceStatePayload(G1, C1);
  ok("join is opcode 4 to the channel, muted, not deafened", join.op === 4 && join.d.guild_id === G1 && join.d.channel_id === C1 && join.d.self_mute === true && join.d.self_deaf === false);
  ok("leave is opcode 4 with a null channel", voiceStatePayload(G1, null).d.channel_id === null);
}

{
  const state = { guild_id: G1, channel_id: C1, user_id: BOT, session_id: "sess", member: { user: { username: "x" } }, self_mute: true };
  const server = { guild_id: G1, token: "vtok", endpoint: "c-ams1.discord.media:443" };
  const creds = credentialsFrom(state, server, { guildId: G1, channelId: C1 });
  ok("both updates for this channel give the credentials", creds !== undefined && creds.sessionId === "sess" && creds.token === "vtok" && creds.endpoint === "c-ams1.discord.media:443" && creds.userId === BOT);
  ok("the credentials carry exactly the six fields the box needs, nothing more", JSON.stringify(Object.keys(creds ?? {}).sort()) === JSON.stringify(["channelId", "endpoint", "guildId", "sessionId", "token", "userId"]));
  ok("no server update yet: nothing", credentialsFrom(state, undefined, { guildId: G1, channelId: C1 }) === undefined);
  ok("no state update yet: nothing", credentialsFrom(undefined, server, { guildId: G1, channelId: C1 }) === undefined);
  ok("a state that names another channel (a join in flight): nothing", credentialsFrom({ ...state, channel_id: C2 }, server, { guildId: G1, channelId: C1 }) === undefined);
  ok("a moved call (null endpoint): nothing until the next update", credentialsFrom(state, { ...server, endpoint: null }, { guildId: G1, channelId: C1 }) === undefined);
  ok("another server's voice server: nothing", credentialsFrom(state, { ...server, guild_id: G2 }, { guildId: G1, channelId: C1 }) === undefined);
}

{
  const creds = { guildId: G1, channelId: C1, userId: BOT, sessionId: "s", token: "t", endpoint: "e.discord.media:443" };
  const h: { since: number; ready?: boolean; failed?: string } = { since: NOW };
  ok("a join still waiting inside the timeout reports nothing", JSON.stringify(heldReport(h, undefined, NOW + 1_000)) === "{}");
  ok("the credentials are reported once both updates arrived", heldReport(h, creds, NOW + 2_000).credentials === creds);
  ok("a later gap (a moved call, a null endpoint) long after the join reports NO failure", JSON.stringify(heldReport(h, undefined, NOW + 40 * 60_000)) === "{}" && h.failed === undefined);
  const never: { since: number; ready?: boolean; failed?: string } = { since: NOW };
  ok("a join that never got credentials fails as join-timeout", heldReport(never, undefined, NOW + JOIN_TIMEOUT_MS + 1).failed === "join-timeout");
  ok("a failure stays a failure", heldReport(never, creds, NOW + JOIN_TIMEOUT_MS + 2).failed === "join-timeout");
}

{
  ok("a voice channel with Connect joins", channelRefusal({ type: 2 }, true) === undefined);
  ok("a Stage channel is refused (not proven)", channelRefusal({ type: 13 }, true) === "stage-channel");
  ok("a text channel is refused", channelRefusal({ type: 0 }, true) === "not-voice");
  ok("a channel the bot cannot see is refused", channelRefusal(undefined, false) === "not-found");
  ok("no Connect permission is refused", channelRefusal({ type: 2 }, false) === "no-permission");
}

{
  const a = parseSyncAnswer({ voice: [{ meetingId: M1, guildId: G1, channelId: C1, deadlineMs: NOW }, { meetingId: "../x", guildId: G1, channelId: C1, deadlineMs: NOW }, { meetingId: M2, guildId: "nope", channelId: C1, deadlineMs: NOW }, null], nextPollMs: 3000 });
  ok("a malformed desired entry is dropped, a good one kept", a.voice.length === 1 && a.voice[0]!.meetingId === M1 && a.nextPollMs === 3000);
  ok("a non-object answer joins nothing", parseSyncAnswer(null).voice.length === 0 && parseSyncAnswer("x").voice.length === 0);
  ok("the delay is the deployment's, clamped to 1 s .. 10 min, and 10 s after a failed sync", nextDelay(3000) === 3000 && nextDelay(10) === 1000 && nextDelay(9e9) === 600_000 && nextDelay(undefined) === 10_000);
  const env = voiceSyncEnvelope(BOT, []);
  ok("the envelope is the relay's VOICE_SYNC shape", env.source === "discord-gateway-relay" && env.event === "VOICE_SYNC" && env.voice.relayId === BOT);
}

{
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "discord-relay");
  const src = readFileSync(join(dir, "index.js"), "utf8");
  ok("index.js imports the voice seam", /from\s+"\.\/voice\.js"/.test(src) && src.includes("planVoice") && src.includes("credentialsFrom"));
  ok("index.js asks for the voice-states intent", src.includes("GatewayIntentBits.GuildVoiceStates"));
  ok("the voice sync runs in FORWARD mode only", /if \(INGEST_URL\) scheduleVoiceSync/.test(src));
  const tokenWord = /token/i;
  ok("negative control: the check sees `client.token`", tokenWord.test("out.push({ meetingId, botToken: client.token })"));
  ok("the sync report never names a token (no bot token can ride along)", !tokenWord.test(src.slice(src.indexOf("function voiceReports"), src.indexOf("function scheduleVoiceSync"))));
  ok("the join needs Send Messages too, so OE can post the recording notice", src.includes("PermissionFlagsBits.SendMessages"));
  ok("the Dockerfile ships voice.js", /^COPY .*\bvoice\.js\b.*$/m.test(readFileSync(join(dir, "Dockerfile"), "utf8")));
}

console.log(`✓ discord-relay-voice-test: ${n} assertions`);
