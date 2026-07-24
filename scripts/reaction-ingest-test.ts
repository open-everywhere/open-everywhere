
import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { IngestedReaction, ReactionSinkDeps } from "@open-everywhere/core/agent/channels/reaction-ingest.js";

const dir = join(tmpdir(), `open-everywhere-reaction-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.OE_TELEMETRY = "off";

const {
  classifyEmoji,
  ingestReaction,
  buildIngestedReaction,
  REACTION_FEEDBACK_ACTION,
  registerReactionSurface,
  isRegisteredReactionSurface,
  registeredReactionSurfaces,
} = await import("@open-everywhere/core/agent/channels/reaction-ingest.js");
const { parseRelayReaction, routeDiscordReaction } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function captureSink(): { deps: ReactionSinkDeps; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const recorded: IngestedReaction[] = [];
  const telem: IngestedReaction[] = [];
  return {
    deps: {
      record: async (r) => void recorded.push(r),
      telemetry: (r) => void telem.push(r),
    },
    recorded,
    telem,
  };
}

ok(classifyEmoji("thumbsup") === "positive", "classifyEmoji: thumbsup → positive");
ok(classifyEmoji("white_check_mark") === "positive", "classifyEmoji: white_check_mark → positive");
ok(classifyEmoji("👍") === "positive", "classifyEmoji: 👍 unicode → positive");
ok(classifyEmoji("👍🏽") === "positive", "classifyEmoji: skin-tone modifier stripped → positive");
ok(classifyEmoji("thumbsup::skin-tone-3") === "positive", "classifyEmoji: Slack skin-tone suffix stripped → positive");
ok(classifyEmoji("❤️") === "positive", "classifyEmoji: variation selector stripped → positive");
ok(classifyEmoji("thumbsdown") === "negative", "classifyEmoji: thumbsdown → negative");
ok(classifyEmoji("👎") === "negative", "classifyEmoji: 👎 unicode → negative");
ok(classifyEmoji("x") === "negative", "classifyEmoji: x → negative");
ok(classifyEmoji("shrug") === "other", "classifyEmoji: unknown shortcode → other");
ok(classifyEmoji("some_custom_emoji") === "other", "classifyEmoji: arbitrary custom name → other (never leaked)");

{
  const base = buildIngestedReaction({
    surface: "slack",
    verb: "added",
    reactorId: "U1",
    emoji: "thumbsup",
    target: { channelId: "C1", messageId: "1.1" },
    onBotReply: true,
    partition: { org: "default", platform: "slack", workspace: "T1", surfaceKey: "slack/T1/C1" },
  });
  ok(base.emojiClass === "positive", "buildIngestedReaction: computes the emoji class");

  const s = captureSink();
  const out = await ingestReaction(base, s.deps);
  ok(out.recorded && out.onBotReply && s.recorded.length === 1 && s.telem.length === 1, "ingest: bot-reply reaction → recorded AND telemetry");

  const s2 = captureSink();
  const out2 = await ingestReaction({ ...base, onBotReply: false }, s2.deps);
  ok(!out2.recorded && s2.recorded.length === 0 && s2.telem.length === 1, "ingest: non-bot-reply reaction → telemetry only, never stored");

  const s3 = captureSink();
  let stampedAt = "";
  await ingestReaction(base, { ...s3.deps, record: async (_r, at) => void (stampedAt = at), now: () => "2026-07-08T00:00:00.000Z" });
  ok(stampedAt === "2026-07-08T00:00:00.000Z", "ingest: record is stamped with the injected clock");
}

{
  const add = parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_ADD", reaction: { verb: "added", messageId: "M1", channelId: "D1", guildId: "G1", channelType: 0, emoji: "👍", reactorId: "U1", messageAuthorId: "BOT", botId: "BOT" } });
  ok(add !== null && add.verb === "added" && add.messageId === "M1" && add.channelId === "D1" && add.emoji === "👍" && add.reactorId === "U1" && add.messageAuthorId === "BOT" && add.botId === "BOT" && add.channelType === "0", "parseDiscord: reaction add → all fields (numeric channelType coerced)");
  const rem = parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_REMOVE", reaction: { messageId: "M1", channelId: "D1", emoji: "👎", reactorId: "U1" } });
  ok(rem !== null && rem.verb === "removed", "parseDiscord: reaction remove → verb removed");
  ok(parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_CREATE", message: {} }) === null, "parseDiscord: a message payload → null (not a reaction)");
  ok(parseRelayReaction({ source: "other", event: "MESSAGE_REACTION_ADD", reaction: {} }) === null, "parseDiscord: wrong source → null");
  ok(parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_ADD", reaction: { channelId: "D1", reactorId: "U1", emoji: "👍" } }) === null, "parseDiscord: missing messageId → null");
  ok(parseRelayReaction("garbage") === null, "parseDiscord: non-object → null (never throws)");
}

{
  {
    const s = captureSink();
    const rx = parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_ADD", reaction: { messageId: "M1", channelId: "D1", guildId: "G1", emoji: "👍", reactorId: "U1", messageAuthorId: "BOT", botId: "BOT" } })!;
    const out = await routeDiscordReaction(rx, { sink: s.deps });
    ok(out.recorded && out.onBotReply && s.recorded[0].surface === "discord" && s.recorded[0].emojiClass === "positive", "routeDiscord: reaction on the bot's own message → recorded (surface=discord)");
  }
  {
    const s = captureSink();
    const rx = parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_ADD", reaction: { messageId: "M1", channelId: "D1", guildId: "G1", emoji: "👍", reactorId: "U1", messageAuthorId: "SOMEONE", botId: "BOT" } })!;
    const out = await routeDiscordReaction(rx, { sink: s.deps });
    ok(!out.recorded && s.telem.length === 1, "routeDiscord: reaction on a non-bot message → telemetry only");
  }
  {
    const s = captureSink();
    const rx = parseRelayReaction({ source: "discord-gateway-relay", event: "MESSAGE_REACTION_ADD", reaction: { messageId: "M1", channelId: "D1", guildId: "G1", emoji: "eyes", reactorId: "BOT", messageAuthorId: "SOMEONE", botId: "BOT" } })!;
    const out = await routeDiscordReaction(rx, { sink: s.deps });
    ok(!out.recorded && s.recorded.length === 0 && s.telem.length === 0, "routeDiscord: the bot's own reaction is ignored entirely (defence in depth)");
  }
}

{
  ok(isRegisteredReactionSurface("discord"), "registry: discord is a registered reaction surface at module load");
  ok(!isRegisteredReactionSurface("slack"), "registry UNREGISTERED default (OPE-114 stage 4): slack registers from its bundle, so core alone reports it unregistered");
  ok(!isRegisteredReactionSurface("fake-test-surface"), "registry: an unregistered platform reports as not registered");

  registerReactionSurface("fake-test-surface");
  ok(isRegisteredReactionSurface("fake-test-surface"), "registry: registerReactionSurface adds a new platform, immediately queryable");
  ok(registeredReactionSurfaces().includes("fake-test-surface"), "registry: the fake platform shows up in the enumerated list");

  const stillUnknown = buildIngestedReaction({
    surface: "slack",
    verb: "added",
    reactorId: "U9",
    emoji: "thumbsup",
    target: { channelId: "C9", messageId: "9.9" },
    onBotReply: true,
    partition: { org: "default", platform: "slack", workspace: "T1", surfaceKey: "slack/T1/C9" },
  });
  ok(!isRegisteredReactionSurface("still-unregistered-surface"), "registry: a never-registered surface name stays unregistered");
  const sUnknown = captureSink();
  const outUnknown = await ingestReaction(stillUnknown, sUnknown.deps);
  ok(outUnknown.recorded && sUnknown.recorded.length === 1 && sUnknown.telem.length === 1, "registry: ingestReaction behaviour is unaffected by the registry (no new gate introduced)");
}

console.log(`\n✓ reaction-ingest: ${n} assertions passed (bucketing, seam, Discord parse/route, registry — the slack legs moved to @open-everywhere/provider-slack)\n`);
