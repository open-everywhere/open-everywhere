process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_DISCORD_AUTO_THREAD = "false";
process.env.OE_DISCORD_STATUS_UX = "false";

import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { WARM_SILENT_LIMIT } from "@open-everywhere/core/agent/channels/engagement.js";
import {
  dispatchTurn,
  authForRelayMessage,
  promoteParticipatingOnReply,
  maybeShedWarmSurface,
  engagementCoordsFor,
  type DiscordRelayMessage,
  type DiscordGatewaySend,
  type DiscordGatewayState,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";

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
  loadDomains: () => [defineDomain({ name: "guild", channels: ["discord/G1/TH1"], nameDropWake: true })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "TH1" ? ["guild"] : []),
});

const store = getOperationalStore();

function relay(over: Partial<DiscordRelayMessage>): DiscordRelayMessage {
  return {
    id: "m1",
    content: "hello",
    channelId: "C1",
    channelType: "0",
    guildId: "G1",
    author: { id: "U1", username: "human", bot: false },
    mentionsBot: false,
    botName: "Ada",
    botId: "BOT",
    ...over,
  };
}

function fakeSend(): { send: DiscordGatewaySend; calls: Array<{ message: unknown; options: unknown }> } {
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const send: DiscordGatewaySend = async (message, options) => {
    calls.push({ message, options });
    return {};
  };
  return { send, calls };
}

const noThread = async () => null;
const noParent = async () => undefined;

{
  const msg = relay({ id: "mention1", channelId: "C1", channelType: "0", mentionsBot: true, content: "<@BOT> hi" });
  const auth = authForRelayMessage(msg)!;
  const { send, calls } = fakeSend();
  await dispatchTurn(msg, auth, send, noThread, noParent);
  const coords = engagementCoordsFor({ channelId: "C1", guildId: "G1" });
  const rec = coords ? await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key) : null;
  ok(rec !== null && rec.participating === true, "a MENTION engages the surface as participating:true (not a merely-warm watcher)");
  ok(rec!.silentStreak === 0, "a mention's engagement starts with a zero silent streak");
  ok(calls.length === 1, "the mention dispatched exactly one turn");
}

{
  const msg = relay({ id: "nd1", channelId: "TH1", channelType: "11", mentionsBot: false, content: "hey Ada can you help" });
  const auth = authForRelayMessage(msg)!;
  const { send } = fakeSend();
  await dispatchTurn(msg, auth, send, noThread, noParent);
  const coords = engagementCoordsFor({ channelId: "TH1", guildId: "G1" });
  const rec = coords ? await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key) : null;
  ok(rec !== null && rec.participating === false, "a thread name-drop engages the thread as a WARM watcher (participating:false)");
}

{
  const state: DiscordGatewayState = { channelId: "TH1", guildId: "G1" };
  const coords = engagementCoordsFor(state)!;
  await store.markEngaged(coords.p.org, coords.p.surfaceKey, coords.key, "2026-07-08T10:00:00Z", { participating: false });
  await store.bumpSilentStreak(coords.p.org, coords.p.surfaceKey, coords.key);
  await promoteParticipatingOnReply(state);
  const rec = await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key);
  ok(rec !== null && rec.participating === true && rec.silentStreak === 0, "a posted reply PROMOTES the warm record to participating and resets the streak");
}

{
  const state: DiscordGatewayState = { channelId: "BASE_ND", guildId: "G1" };
  const coords = engagementCoordsFor(state)!;
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key)) === null, "precondition: no engagement on the base channel");
  await promoteParticipatingOnReply(state);
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key)) === null, "a base-channel name-drop reply does NOT create whole-channel engagement (no record → left un-engaged)");
}

{
  const dmState: DiscordGatewayState = { channelId: "DM1" };
  ok(engagementCoordsFor(dmState) === null, "engagementCoordsFor returns null for a DM (no guild → no engagement)");
  await promoteParticipatingOnReply(dmState);
  ok(true, "promote on a DM state is a safe no-op");
}

{
  const state: DiscordGatewayState = { channelId: "WARM1", guildId: "G1" };
  const coords = engagementCoordsFor(state)!;
  await store.markEngaged(coords.p.org, coords.p.surfaceKey, coords.key, "2026-07-08T10:00:00Z", { participating: false });
  ok(WARM_SILENT_LIMIT === 3, "shared WARM_SILENT_LIMIT is 3");
  await maybeShedWarmSurface(state);
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key))?.silentStreak === 1, "first silent turn → streak 1, still engaged");
  await maybeShedWarmSurface(state);
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key))?.silentStreak === 2, "second silent turn → streak 2, still engaged");
  await maybeShedWarmSurface(state);
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key)) === null, "third silent turn hits the limit → surface disengaged");
}

{
  const state: DiscordGatewayState = { channelId: "PART1", guildId: "G1" };
  const coords = engagementCoordsFor(state)!;
  await store.markEngaged(coords.p.org, coords.p.surfaceKey, coords.key, "2026-07-08T10:00:00Z", { participating: true });
  await maybeShedWarmSurface(state);
  await maybeShedWarmSurface(state);
  await maybeShedWarmSurface(state);
  const rec = await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key);
  ok(rec !== null && rec.participating === true && rec.silentStreak === 0, "a participating surface is sticky — never streak-bumped, never shed on silence");
}

{
  const state: DiscordGatewayState = { channelId: "GHOST", guildId: "G1" };
  await maybeShedWarmSurface(state);
  const coords = engagementCoordsFor(state)!;
  ok((await store.getEngagement(coords.p.org, coords.p.surfaceKey, coords.key)) === null, "shedding a surface with no engagement record is a safe no-op");
}

{
  const coords = engagementCoordsFor({ channelId: "CX", guildId: "GX" });
  ok(coords !== null && coords.p.surfaceKey === "discord/GX/CX" && coords.key === "CX", "engagementCoordsFor rebuilds discord/<guild>/<channel> with the channel id as the engagement key");
}

console.log(`✓ discord-engagement: ${n} assertions passed (mention participating + thread name-drop warm + reply-promote incl. base-channel no-create + DM no-op + warm shed at limit + participating exemption + coords rebuild)`);
