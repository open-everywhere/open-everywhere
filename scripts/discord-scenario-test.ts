// proves: spend.gate

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_SECRET = "scenario-relay-secret-never-real";
const tmp = mkdtempSync(join(tmpdir(), "oe-scenarios-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_RELAY_SECRET = RELAY_SECRET;
process.env.DISCORD_BOT_TOKEN = "test-bot-token-never-real";
overrideSettingsForTest({ discord: { autoThread: true } });
overrideSettingsForTest({ discord: { statusUx: true } });
_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}

const { ScenarioRunner } = await import("./discord-scenario-harness.js");
const { default: discordGateway } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { recordSpend } = await import("@open-everywhere/core/agent/spend/store.js");
const { periodOf } = await import("@open-everywhere/core/agent/spend/spend.js");
const { markThreadEngaged } = await import("@open-everywhere/core/agent/channels/engagement.js");
const { resolvePartition } = await import("@open-everywhere/core/agent/memory/partition.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { buildDiscordAuth } = await import("@open-everywhere/provider-discord/agent/channels/discord-identity.js");
const { markCardPostedThisTurn } = await import("@open-everywhere/core/agent/approvals/card-signal.js");
const { markRepliedThisTurn } = await import("@open-everywhere/core/agent/channels/reply-signal.js");
const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/turn-delivery.js");
import type { BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import type { Partition } from "@open-everywhere/core/agent/memory/partition.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["discord/U_ADMIN7"] })],
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

await scenario("03-dm-direct-divert", async (s) => {
  await s.inbound({
    id: "M31",
    content: "remind me what the deploy command is",
    channelId: "D3",
    channelType: "1",
    authorId: "U_DM3",
    mentionsBot: false,
  });
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
  await recordSpend(p, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 200, outputTokens: 5 } });
  s.note(`surface cap 50 tokens/month on ${p.surfaceKey}; 205 tokens already recorded (real setSpendLimit + recordSpend)`);
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
  await recordSpend(p, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 200, outputTokens: 5 } });
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
    content: "<@BOT> run the weekly report",
    channelId: "C8",
    channelType: "0",
    guildId: "G8",
    authorId: "U_DEV8",
    mentionsBot: true,
  });
  await s.event("discord:TH1", "turn.started");
  await s.event("discord:TH1", "turn.failed", { error: { message: "model exploded" } });
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

await scenario("10-cap-decline-engaged-door", async (s) => {
  const p = partitionFor({ userId: "U_TALK10", guildId: "G10", channelId: "C10", channelType: "0" });
  await markThreadEngaged(p, "C10", new Date().toISOString());
  await getOperationalStore().setSpendLimit(p.org, p.surfaceKey, "surface", { monthlyTokens: 50 }, { setBy: "scenario-seed" });
  await recordSpend(p, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 200, outputTokens: 5 } });
  s.note(`channel C10 engaged; surface cap 50 tokens/month on ${p.surfaceKey}; 205 tokens already recorded`);
  await s.inbound({
    id: "M101",
    content: "so what did we decide about the migration?",
    channelId: "C10",
    channelType: "0",
    guildId: "G10",
    authorId: "U_TALK10",
    mentionsBot: false,
  });
});

await scenario("11-warm-prose-drop-no-promote", async (s) => {
  const p = partitionFor({ userId: "U_TALK11", guildId: "G11", channelId: "C11", channelType: "0" });
  await markThreadEngaged(p, "C11", new Date().toISOString());
  s.note(`channel C11 engaged WARM (real markThreadEngaged on ${p.surfaceKey})`);
  await s.inbound({
    id: "M111",
    content: "did the migration finish?",
    channelId: "C11",
    channelType: "0",
    guildId: "G11",
    authorId: "U_TALK11",
    mentionsBot: false,
  });
  await s.event("discord:C11", "turn.started");
  await s.event("discord:C11", "message.completed", { finishReason: "stop", message: "It finished at step 5 of 5." });
});

await scenario("12-warm-card-promotes", async (s) => {
  const p = partitionFor({ userId: "U_TALK12", guildId: "G12", channelId: "C12", channelType: "0" });
  await markThreadEngaged(p, "C12", new Date().toISOString());
  s.note(`channel C12 engaged WARM (real markThreadEngaged on ${p.surfaceKey})`);
  await s.inbound({
    id: "M121",
    content: "can you raise the cap?",
    channelId: "C12",
    channelType: "0",
    guildId: "G12",
    authorId: "U_TALK12",
    mentionsBot: false,
  });
  await s.event("discord:C12", "turn.started");
  await s.markCardPosted("discord:C12", markCardPostedThisTurn);
  await s.event("discord:C12", "message.completed", { finishReason: "stop", message: "I've posted an approval card." });
});

await scenario("13-warm-reply-tool-promotes", async (s) => {
  const p = partitionFor({ userId: "U_TALK13", guildId: "G13", channelId: "C13", channelType: "0" });
  await markThreadEngaged(p, "C13", new Date().toISOString());
  s.note(`channel C13 engaged WARM (real markThreadEngaged on ${p.surfaceKey})`);
  await s.inbound({
    id: "M131",
    content: "what is the rollback command?",
    channelId: "C13",
    channelType: "0",
    guildId: "G13",
    authorId: "U_TALK13",
    mentionsBot: false,
  });
  await s.event("discord:C13", "turn.started");
  await s.markReplied("discord:C13", markRepliedThisTurn);
  await s.event("discord:C13", "message.completed", { finishReason: "stop", message: "Rolled back with `oe deploy --to v42`." });
});

const gateRows = async (part: Partition): Promise<{ door?: unknown; over?: unknown }[]> =>
  (await readAudit({ org: part.org, action: "spend.gate" })).filter((r) => r.detail?.key === part.surfaceKey).map((r) => r.detail ?? {});

let auditAssertions = 0;
let auditFailures = 0;
const okAudit = (cond: boolean, label: string): void => {
  if (cond) auditAssertions++;
  else {
    console.error(`✗ ${label}`);
    auditFailures++;
  }
};

const mentionDecline = await gateRows(partitionFor({ userId: "U_RANDO6", guildId: "G6", channelId: "C6", channelType: "0" }));
okAudit(
  mentionDecline.length === 1 && mentionDecline[0]!.door === "mention" && mentionDecline[0]!.over === true,
  "spend.gate: an over-budget Discord MENTION decline writes ONE row (door=mention, over=true)",
);

const engagedDecline = await gateRows(partitionFor({ userId: "U_TALK10", guildId: "G10", channelId: "C10", channelType: "0" }));
okAudit(
  engagedDecline.length === 1 && engagedDecline[0]!.door === "engagement" && engagedDecline[0]!.over === true,
  "spend.gate: an over-budget Discord ENGAGED wake writes ONE row (door=engagement — not mention)",
);

const bypassed = await gateRows(partitionFor({ userId: "U_ADMIN7", guildId: "G7", channelId: "C7", channelType: "0" }));
okAudit(
  bypassed.length === 2 && bypassed.every((d) => d.over === true && d.door === "mention"),
  "spend.gate: an ADMIN BYPASS still writes the row (the cap tripped) — one per over-cap wake",
);

for (const [label, part] of [
  ["a mention in an UNCAPPED channel (01)", partitionFor({ userId: "U_DEV1", guildId: "G1", channelId: "C1", channelType: "0" })],
  ["an UNCAPPED DM (03)", partitionFor({ userId: "U_DM3", channelId: "D3", channelType: "1" })],
] as const) {
  okAudit((await gateRows(part)).length === 0, `spend.gate: ${label} writes NO row (the row is OVER-only, not per-wake)`);
}

{
  const { getThreadEngagement } = await import("@open-everywhere/core/agent/channels/engagement.js");
  const dropped = await getThreadEngagement(partitionFor({ userId: "U_TALK11", guildId: "G11", channelId: "C11", channelType: "0" }), "C11");
  okAudit(dropped !== null, "engagement/CONTROL: scenario 11's seeded warm row exists — the assertion below reads a real row, never a missing one");
  okAudit(
    dropped?.participating !== true,
    "🔴 OPE-2006: a turn whose only output was DROPPED prose leaves the warm surface WARM — nothing reached the room, so no promotion was earned",
  );
  const delivered = await getThreadEngagement(partitionFor({ userId: "U_TALK12", guildId: "G12", channelId: "C12", channelType: "0" }), "C12");
  okAudit(
    delivered?.participating === true,
    "🔴 POSITIVE CONTROL: the same door with a card POSTED this turn DOES promote to participating — the promotion is still wired",
  );
  const replied = await getThreadEngagement(partitionFor({ userId: "U_TALK13", guildId: "G13", channelId: "C13", channelType: "0" }), "C13");
  okAudit(
    replied?.participating === true,
    "🔴 POSITIVE CONTROL: a turn that delivered through the `reply` TOOL promotes too — the predicate reads BOTH delivery signals, not the card alone",
  );
}

if (auditFailures > 0) console.error(`\n✗ durable-write assertions: ${auditFailures} assertion(s) failed\n`);
else console.log(`✓ durable-write assertions: ${auditAssertions} passed (spend.gate door/bypass/negative control · engagement promotes on DELIVERY, not on a dropped turn)`);

await removeTempDir(tmp);
runner.finish("scenarios (discord-gateway sequencing)", auditFailures);
