process.env.OE_SQLITE_PATH = ":memory:";
overrideSettingsForTest({ discord: { autoThread: false } });
overrideSettingsForTest({ discord: { statusUx: false } });

import assert from "node:assert/strict";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
registerDiscordProvider();
registerSlackProvider();
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { turnAnchorKey, turnChannelKey, resolveTurnAnchor } from "@open-everywhere/core/agent/channels/turn-registry.js";
import turnAnchorHook from "@open-everywhere/core/agent/hooks/turn-anchor.js";
import { buildDiscordAuth, type OpenEverywhereDiscordAuth } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import {
  authForRelayMessage,
  dispatchSurfaceFor,
  type DiscordRelayMessage,
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

function relay(over: Partial<DiscordRelayMessage>): DiscordRelayMessage {
  return {
    id: "TRIGGER_1",
    content: "hello",
    channelId: "C1",
    channelType: "0",
    guildId: "G1",
    author: { id: "U1", username: "human", bot: false },
    mentionsBot: true,
    botName: "Ada",
    botId: "BOT",
    ...over,
  };
}

function ctxFromAuth(auth: OpenEverywhereDiscordAuth | Record<string, unknown>, kind: "discord" | "slack" = "discord"): BindableContext {
  return { channel: { kind }, session: { auth: { current: auth as never } } };
}

function hookCtx(
  auth: OpenEverywhereDiscordAuth | Record<string, unknown>,
  sessionId: string,
  continuationToken?: string,
  kind: "discord" | "slack" = "discord",
) {
  return {
    channel: { kind, continuationToken },
    session: { id: sessionId, auth: { current: auth } },
  };
}

type TurnAnchorHookLike = { events: Record<string, (event: unknown, ctx: unknown) => Promise<void>> };
const hook = turnAnchorHook as unknown as TurnAnchorHookLike;

{
  const msg = relay({});
  const auth = authForRelayMessage(msg)!;
  const b = bindFrom(ctxFromAuth(auth));
  ok(b.anchorMessageId === "TRIGGER_1", "a Discord message-triggered binding publishes the triggering message id as the anchor");
  ok(b.threadTs === undefined, "…and STILL carries no threadTs — Discord has none; this is the slot the hook used to read");
  ok(b.engagementKey === "C1", "OPE-661's engagementKey is untouched — still the channel id, a DIFFERENT field from the new anchor");
}

{
  const msg = relay({ id: "TRIGGER_2" });
  const auth = authForRelayMessage(msg)!;
  const ctx = hookCtx(auth, "sess_discord_1", "discord:C1");
  await hook.events["turn.started"]({ data: { turnId: "turn_discord_1" } }, ctx);

  const org = resolvePartition(ctxFromAuth(auth)).org;
  const expectedAnchorKey = turnAnchorKey("discord", "C1", "TRIGGER_2")!;
  const row = await resolveTurnAnchor(org, { anchorKey: expectedAnchorKey });
  ok(row !== null, "🔴 ROUND TRIP: the anchor row resolves by the EXACT key a reaction on the triggering message carries — dead before this ticket");
  ok(row?.turnId === "turn_discord_1", "…and names the turn that actually started");

  const rowByChannel = await resolveTurnAnchor(org, { channelKey: turnChannelKey("discord", "C1") });
  ok(rowByChannel?.turnId === "turn_discord_1", "/oe stop's channel-key resolution is untouched by the new anchor field");
}

{
  const auth = buildDiscordAuth({ userId: "U1", guildId: "G1", channelId: "C1", channelType: "0" });
  const b = bindFrom(ctxFromAuth(auth));
  ok(b.anchorMessageId === undefined, "a slash-command binding (no message id known) still publishes NO anchor — this is the pre-existing, honest gap");
  ok(turnAnchorKey("discord", "C1", b.anchorMessageId) === undefined, "…so turnAnchorKey stays undefined, exactly as every Discord turn used to be");
}

{
  const msg = relay({ id: "TRIGGER_AUTOTHREAD", channelId: "BASE1" });
  const baseAuth = authForRelayMessage(msg)!;
  const surface = dispatchSurfaceFor(msg, baseAuth, "THREAD1");
  const b = bindFrom(ctxFromAuth(surface.auth));
  ok(b.anchorMessageId === undefined, "🔴 a turn re-keyed onto a fresh auto-thread carries NO anchor — a narrower, PRE-EXISTING gap, not a regression");
  ok((surface.auth.attributes.channel_id as string) === "THREAD1", "…even though the turn itself correctly re-keyed onto the thread");
}

{
  const slackAuth = {
    authenticator: "slack",
    principalId: "US",
    principalType: "slack-user",
    attributes: { team_id: "T_S", channel_id: "C_S", thread_ts: "1700.5", channel_type: "channel", user_id: "US" },
  };
  const b = bindFrom(ctxFromAuth(slackAuth, "slack"));
  ok(b.threadTs === "1700.5", "the Slack binding still anchors on the thread ts");
  ok(b.anchorMessageId === undefined, "🔴 REGRESSION PIN: the Slack mapper publishes NO anchorMessageId — bindSlack never sets it");

  const ctx = hookCtx(slackAuth, "sess_slack_1", "slack:C_S:1700.5", "slack");
  await hook.events["turn.started"]({ data: { turnId: "turn_slack_1" } }, ctx);
  const org = resolvePartition(ctxFromAuth(slackAuth, "slack")).org;
  const row = await resolveTurnAnchor(org, { anchorKey: turnAnchorKey("slack", "C_S", "1700.5") });
  ok(row?.turnId === "turn_slack_1", "the real hook still anchors a Slack turn on its thread ts, exactly as before this ticket");
}

console.log(`✓ discord-stop-hand-anchor: ${n} assertions passed (key-derivation round trip + slash-command/auto-thread carve-outs + slack regression pin)`);
