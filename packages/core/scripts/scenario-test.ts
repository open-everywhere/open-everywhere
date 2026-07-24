import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_SECRET = "scenario-relay-secret-never-real";
const tmp = mkdtempSync(join(tmpdir(), "oe-scenarios-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_RELAY_SECRET = RELAY_SECRET;
process.env.DISCORD_BOT_TOKEN = "test-bot-token-never-real";
delete process.env.OE_DISCORD_AUTO_THREAD;
delete process.env.OE_DISCORD_STATUS_UX;
for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST"]) {
  delete process.env[k];
}

const { ScenarioRunner } = await import("./scenario-harness.js");
const { default: discordGateway } = await import("../agent/channels/discord-gateway.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { recordUsage } = await import("../agent/spend/store.js");
const { periodOf } = await import("../agent/spend/spend.js");
const { markThreadEngaged } = await import("../agent/channels/engagement.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { buildDiscordAuth } = await import("../agent/channels/discord-identity.js");
const { markCardPostedThisTurn } = await import("../agent/approvals/card-signal.js");
const { NO_REPLY_SENTINEL } = await import("../agent/channels/turn-delivery.js");
import type { BindableContext } from "../agent/identity/binding.js";
import type { Partition } from "../agent/memory/partition.js";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["U_ADMIN7"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function partitionFor(input: { userId: string; guildId?: string; channelId: string; channelType?: string }): Partition {
  const ctx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: buildDiscordAuth(input) } } };
  return resolvePartition(ctx);
}

const runner = new ScenarioRunner(discordGateway, RELAY_SECRET);
const scenario = runner.scenario.bind(runner);

await scenario("01-mention-autothread-reply", async (s) => {
  await s.inbound({
    id: "M1",
    content: "<@BOT> help me sort the deploy",
    channelId: "C1",
    channelType: "0",
    guildId: "G1",
    authorId: "U_DEV1",
    mentionsBot: true,
  });
  await s.event("discord:TH1", "turn.started");
  await s.event("discord:TH1", "message.appended");
  await s.event("discord:TH1", "message.appended");
  await s.event("discord:TH1", "message.completed", { finishReason: "stop", message: "Here's the answer: roll back to v42." });
});

await scenario("02-thread-followup-resume", async (s) => {
  await s.inbound({
    id: "M21",
    content: "<@BOT> can you check the failing build?",
    channelId: "C2",
    channelType: "0",
    guildId: "G2",
    authorId: "U_DEV2",
    mentionsBot: true,
  });
  await s.event("discord:TH1", "turn.started");
  await s.event("discord:TH1", "message.completed", { finishReason: "stop", message: "The build fails on the lint step." });
  await s.inbound({
    id: "M22",
    content: "and which rule is tripping it?",
    channelId: "TH1",
    channelType: "11",
    guildId: "G2",
    authorId: "U_DEV2",
    mentionsBot: false,
  });
  await s.event("discord:TH1", "turn.started");
  await s.event("discord:TH1", "message.appended", { messageSoFar: "no-unused-vars" });
  await s.event("discord:TH1", "message.completed", { finishReason: "stop", message: "no-unused-vars, in ci.ts line 12." });
}, { channelInfo: { TH1: { name: "can you check the failing build?", type: 11, parent_id: "C2" } } });

await scenario("03-dm-direct-reply", async (s) => {
  await s.inbound({
    id: "M31",
    content: "remind me what the deploy command is",
    channelId: "D3",
    channelType: "1",
    authorId: "U_DM3",
    mentionsBot: false,
  });
  await s.event("discord:D3", "turn.started");
  await s.event("discord:D3", "message.completed", { finishReason: "stop", message: "vercel deploy --prod" });
});

await scenario("04-judged-silence", async (s) => {
  const p = partitionFor({ userId: "U_TALK4", guildId: "G4", channelId: "C4", channelType: "0" });
  await markThreadEngaged(p, "C4", new Date().toISOString());
  s.note(`channel C4 engaged (real markThreadEngaged on ${p.surfaceKey})`);
  await s.inbound({
    id: "M41",
    content: "lunch at the usual place?",
    channelId: "C4",
    channelType: "0",
    guildId: "G4",
    authorId: "U_TALK4",
    mentionsBot: false,
  });
  await s.event("discord:C4", "turn.started");
  await s.event("discord:C4", "message.completed", { finishReason: "stop", message: NO_REPLY_SENTINEL });
});

await scenario("05-card-suppression", async (s) => {
  await s.inbound({
    id: "M51",
    content: "<@BOT> raise this channel's spend cap to $5/month",
    channelId: "C5T",
    channelType: "11",
    guildId: "G5",
    authorId: "U_DEV5",
    mentionsBot: true,
  });
  await s.event("discord:C5T", "turn.started");
  await s.event("discord:C5T", "actions.requested");
  await s.markCardPosted("discord:C5T", markCardPostedThisTurn);
  await s.event("discord:C5T", "action.result");
  await s.event("discord:C5T", "message.appended");
  await s.event("discord:C5T", "message.completed", {
    finishReason: "stop",
    message: "I've posted an approval card proposing a $5/month cap — an admin needs to approve it.",
  });
}, { channelInfo: { C5T: { name: "spend chat", type: 11, parent_id: "C5" } } });

await scenario("06-cap-decline-nonadmin", async (s) => {
  const p = partitionFor({ userId: "U_RANDO6", guildId: "G6", channelId: "C6", channelType: "0" });
  await getOperationalStore().setSpendLimit(p.org, p.surfaceKey, "surface", { monthlyTokens: 50 }, { setBy: "scenario-seed" });
  await recordUsage(p, periodOf(new Date().toISOString()), { inputTokens: 200, outputTokens: 5 });
  s.note(`surface cap 50 tokens/month on ${p.surfaceKey}; 205 tokens already recorded (real setSpendLimit + recordUsage)`);
  await s.inbound({
    id: "M61",
    content: "<@BOT> summarize this thread",
    channelId: "C6",
    channelType: "0",
    guildId: "G6",
    authorId: "U_RANDO6",
    mentionsBot: true,
  });
});

await scenario("07-cap-admin-bypass-throttle", async (s) => {
  const p = partitionFor({ userId: "U_ADMIN7", guildId: "G7", channelId: "C7", channelType: "0" });
  await getOperationalStore().setSpendLimit(p.org, p.surfaceKey, "surface", { monthlyTokens: 50 }, { setBy: "scenario-seed" });
  await recordUsage(p, periodOf(new Date().toISOString()), { inputTokens: 200, outputTokens: 5 });
  s.note(`surface cap 50 tokens/month on ${p.surfaceKey}; 205 tokens already recorded; author U_ADMIN7 is an org-roster admin`);
  await s.inbound({
    id: "M71",
    content: "<@BOT> kick off the release checklist",
    channelId: "C7",
    channelType: "0",
    guildId: "G7",
    authorId: "U_ADMIN7",
    mentionsBot: true,
  });
  await s.event("discord:TH1", "turn.started");
  await s.event("discord:TH1", "message.completed", { finishReason: "stop", message: "Checklist started — 6 items queued." });
  await s.inbound({
    id: "M72",
    content: "<@BOT> also page the on-call",
    channelId: "C7",
    channelType: "0",
    guildId: "G7",
    authorId: "U_ADMIN7",
    mentionsBot: true,
  });
  await s.event("discord:TH2", "turn.started");
  await s.event("discord:TH2", "message.completed", { finishReason: "stop", message: "Paged. They ack'd." });
});

await scenario("08-turn-failed", async (s) => {
  await s.inbound({
    id: "M81",
    content: "run the weekly report",
    channelId: "D8",
    channelType: "1",
    authorId: "U_DM8",
    mentionsBot: false,
  });
  await s.event("discord:D8", "turn.started");
  await s.event("discord:D8", "turn.failed", { error: { message: "model exploded" } });
});

await scenario(
  "09-autothread-fail-inline",
  async (s) => {
    await s.inbound({
      id: "M91",
      content: "<@BOT> what changed in last night's deploy?",
      channelId: "C9",
      channelType: "0",
      guildId: "G9",
      authorId: "U_DEV9",
      mentionsBot: true,
    });
    await s.event("discord:C9", "turn.started");
    await s.event("discord:C9", "message.completed", { finishReason: "stop", message: "Two changes: the cache fix and the new webhook route." });
  },
  { failNextThreadCreate: true },
);

rmSync(tmp, { recursive: true, force: true });
runner.finish("scenarios (discord-gateway sequencing)");
