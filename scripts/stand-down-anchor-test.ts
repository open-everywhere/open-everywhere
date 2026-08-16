process.env.OE_SQLITE_PATH = ":memory:";
overrideSettingsForTest({ discord: { autoThread: false } });
overrideSettingsForTest({ discord: { statusUx: false } });

import assert from "node:assert/strict";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
registerDiscordProvider();
registerSlackProvider();
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { shouldDeliverReply } from "@open-everywhere/core/agent/channels/engagement.js";
import { bindFrom } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import standDown from "@open-everywhere/core/agent/tools/stand_down.js";
import {
  dispatchTurn,
  authForRelayMessage,
  engagementCoordsFor,
  type DiscordRelayMessage,
  type DiscordGatewaySend,
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

console.log(`✓ stand-down-anchor: ${n} assertions passed (discord key chain + real wake-gate round trip + re-invitation + slack regression pin + anchorless copy)`);
