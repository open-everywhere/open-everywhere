import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveReadAdapter,
  renderChannelBody,
  channelReadSource,
  renderThreadBody,
  threadReadSource,
  allowedSurfaceIdsFrom,
  registerReadAdapter,
  READ_ADAPTERS,
  supportedReadPlatforms,
  type ChannelReadResult,
  type ThreadReadResult,
  type ReadAdapter,
} from "@open-everywhere/core/agent/channels/channel-read.js";
import { discordReadAdapter, discordLinesFromRaw } from "@open-everywhere/provider-discord/agent/channels/discord-read.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { teamsReadAdapter } from "@open-everywhere/provider-teams/agent/channels/teams-read.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { genericReadVerbsEnabled } from "@open-everywhere/core/agent/access/source-scoped-mount.js";
import { overrideSettingsForTest, resetSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { ingestUntrusted } from "@open-everywhere/core/agent/access/untrusted.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import type { BindableContext } from "@open-everywhere/core/agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerTeamsProvider();
registerDiscordProvider();

function mk(kind: string, attrs: Record<string, string>): BindableContext {
  return {
    channel: { kind },
    session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "slack-user" } } },
  } as unknown as BindableContext;
}

const MSGS = [
  { author: "U1", ts: "111.1", text: "hello there" },
  { author: "U2", ts: "112.2", text: "hi back" },
];

{
  const uniNoSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack" });
  assert.throws(() => resolveReadAdapter(uniNoSlack, undefined, []), /not supported yet/u, "UNREGISTERED slack (core alone): resolveReadAdapter fails loud, never fakes a read");
  n++;
}
const fakeSlackAdapter: ReadAdapter = {
  platform: "slack",
  readChannel: async () => MSGS,
  readThread: async () => MSGS,
};
registerReadAdapter(fakeSlackAdapter);

{
  const chan: ChannelReadResult = { platform: "slack", channel: "C0ABC", count: 2, messages: MSGS };
  const oldChannelBody = `Recent messages in C0ABC (oldest first):\n[U1] hello there\n[U2] hi back`;
  const oldChannelSource = `slack channel C0ABC`;
  ok(renderChannelBody(chan) === oldChannelBody, "golden: channel body is byte-identical to read_slack_channel for platform:slack");
  ok(channelReadSource(chan) === oldChannelSource, "golden: channel untrusted-wrap source is byte-identical (`slack channel <ch>`)");
  const oldWrapped = { type: "text" as const, value: ingestUntrusted(oldChannelBody, { source: oldChannelSource }) };
  const newWrapped = { type: "text" as const, value: ingestUntrusted(renderChannelBody(chan), { source: channelReadSource(chan) }) };
  ok(JSON.stringify(oldWrapped) === JSON.stringify(newWrapped), "golden: the full untrusted-wrapped channel output is byte-identical");

  const empty: ChannelReadResult = { platform: "slack", channel: "C0ABC", count: 0, messages: [] };
  ok(renderChannelBody(empty) === "No readable messages in C0ABC.", "golden: empty-channel body byte-identical");

  const thr: ThreadReadResult = { platform: "slack", channel: "C0ABC", thread_ts: "999.9", count: 2, messages: MSGS };
  ok(renderThreadBody(thr) === `Thread 999.9 in C0ABC (oldest first):\n[U1] hello there\n[U2] hi back`, "golden: thread body byte-identical to read_slack_thread");
  ok(threadReadSource(thr) === `slack thread C0ABC/999.9`, "golden: thread untrusted-wrap source byte-identical (`slack thread <ch>/<ts>`)");
  const thrEmpty: ThreadReadResult = { platform: "slack", channel: "C0ABC", thread_ts: "999.9", count: 0, messages: [] };
  ok(renderThreadBody(thrEmpty) === "No readable replies in thread 999.9.", "golden: empty-thread body byte-identical");
}

{
  const uniSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack,discord" });
  const r1 = resolveReadAdapter(uniSlack, undefined, []);
  ok(r1.platform === "slack" && r1.adapter === fakeSlackAdapter, "gate: target.platform omitted ⇒ defaults to the turn origin (slack) → Slack adapter");

  const uniDiscord = mk("unified", { oe_platform: "discord", oe_sources: "slack,discord" });
  const r2 = resolveReadAdapter(uniDiscord, "discord", []);
  ok(r2.platform === "discord" && r2.adapter === discordReadAdapter, "gate: an explicit discord read routes to the Discord adapter");

  const soloSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack" });
  assert.throws(() => resolveReadAdapter(soloSlack, "discord", []), /is not one of this window's sources/u, "gate: an out-of-sources platform is REFUSED at execute (platform ∉ sources)");
  n++;

  assert.throws(() => resolveReadAdapter(uniSlack, "discord", []), /the message that woke this turn came from slack/u, "gate: assertTurnSurface still fences a cross-surface read on a multi-source window");
  n++;

  const uniLinear = mk("unified", { oe_platform: "linear", oe_sources: "linear" });
  assert.throws(() => resolveReadAdapter(uniLinear, undefined, []), /not supported yet \(supported: teams, discord, slack\)/u, "gate: an unsupported surface (linear) fails loud with the supported list");
  n++;

  ok(!supportedReadPlatforms().includes("linear") && READ_ADAPTERS["linear"] === undefined, "linear is declared unsupported (absent from READ_ADAPTERS), not faked");
  ok(supportedReadPlatforms().includes("slack") && supportedReadPlatforms().includes("discord") && supportedReadPlatforms().includes("teams"), "slack + discord + teams are the wired read adapters");

  const fakeReadAdapter: ReadAdapter = {
    platform: "fake-test-platform",
    async readChannel() { return []; },
    async readThread() { return []; },
  };
  registerReadAdapter(fakeReadAdapter);
  ok(READ_ADAPTERS["fake-test-platform"] === fakeReadAdapter, "registry: registerReadAdapter adds a new platform, visible via READ_ADAPTERS (same live registry object)");
  const uniFake = mk("unified", { oe_platform: "fake-test-platform", oe_sources: "fake-test-platform" });
  const rFake = resolveReadAdapter(uniFake, undefined, []);
  ok(rFake.platform === "fake-test-platform" && rFake.adapter === fakeReadAdapter, "registry: a newly-registered platform is resolvable through resolveReadAdapter's normal gate chain");

  const uniStillUnknown = mk("unified", { oe_platform: "still-unknown", oe_sources: "still-unknown" });
  assert.throws(
    () => resolveReadAdapter(uniStillUnknown, undefined, []),
    /not supported yet \(supported: teams, discord, slack, fake-test-platform\)/u,
    "registry: an unregistered platform still fails loud, and the LIVE supported list now includes the fake registration above",
  );
  n++;
}

{
  const raw = [
    { type: 0, id: "300", content: "third", author: { id: "A3" } },
    { type: 7, id: "250", content: "joined the server", author: { id: "SYS" } },
    { type: 0, id: "200", content: "", author: { id: "A2" } },
    { type: 0, id: "150", content: "from-a-bot", author: { id: "B1", bot: true } },
    { type: 0, id: "100", content: "first", author: { id: "A1" } },
  ];
  const lines = discordLinesFromRaw(raw);
  ok(JSON.stringify(lines) === JSON.stringify([
    { author: "A1", ts: "100", text: "first", authorId: "A1" },
    { author: "B1", ts: "150", text: "from-a-bot", bot: true },
    { author: "A3", ts: "300", text: "third", authorId: "A3" },
  ]), "discord: normalized oldest-first, system/empty dropped, bot labelled by id");
  ok(discordLinesFromRaw("not-an-array").length === 0, "discord: a non-array response yields no lines (fail-soft parse)");

  const eng = defineDomain({ name: "eng", channels: ["slack/T/CS", "discord/G/CD", "github/o/r"] });
  const discordScope = allowedSurfaceIdsFrom("discord/G/CD", "discord", [eng]);
  ok(discordScope.ids.has("CD") && !discordScope.ids.has("CS") && discordScope.domain === "eng", "allowlist: discord scope = own + domain discord channels only (slack/github keys excluded)");
  const slackScope = allowedSurfaceIdsFrom("slack/T/CS", "slack", [eng]);
  ok(slackScope.ids.has("CS") && !slackScope.ids.has("CD"), "allowlist: slack scope excludes the discord channel");
  const lone = allowedSurfaceIdsFrom("discord/G/CX", "discord", []);
  ok(lone.ids.has("CX") && lone.domain === undefined, "allowlist: own surface is always in scope (no domain)");
}

{
  resetSettingsForTest();
  ok(genericReadVerbsEnabled() === false, "flag: nothing registered ⇒ OFF (read_slack_* is the live reader, byte-identical)");
  overrideSettingsForTest({ tools: { genericReadVerbs: true } });
  ok(genericReadVerbsEnabled() === true, "flag: `tools.genericReadVerbs: true` ⇒ ON (generic verbs mount, read_slack_* retire)");
  overrideSettingsForTest({ tools: { genericReadVerbs: false } });
  ok(genericReadVerbsEnabled() === false, "flag: `tools.genericReadVerbs: false` ⇒ OFF");
  process.env.OE_GENERIC_READ_VERBS = "1";
  ok(genericReadVerbsEnabled() === false, "flag: 🔴 a stray OE_GENERIC_READ_VERBS=1 does NOT arm the generic verbs — the mirror is deleted (OPE-411)");
  delete process.env.OE_GENERIC_READ_VERBS;
  resetSettingsForTest();

  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/core/agent/tools");
  const slackToolsDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/providers/slack/agent/tools");
  const slackChanSrc = readFileSync(join(slackToolsDir, "read_slack_channel.ts"), "utf8");
  const slackThreadSrc = readFileSync(join(slackToolsDir, "read_slack_thread.ts"), "utf8");
  ok(/if \(genericReadVerbsEnabled\(\)\) return null;/u.test(slackChanSrc), "wiring: read_slack_channel retires when the flag is ON (returns null)");
  ok(/if \(genericReadVerbsEnabled\(\)\) return null;/u.test(slackThreadSrc), "wiring: read_slack_thread retires when the flag is ON");
  ok(slackChanSrc.indexOf("genericReadVerbsEnabled()") < slackChanSrc.indexOf("sourceScopedMount("), "wiring: the retire guard precedes the Stage-1 mount (flag-OFF path unchanged)");

  const readChanSrc = readFileSync(join(toolsDir, "read_channel.ts"), "utf8");
  const readThreadSrc = readFileSync(join(toolsDir, "read_thread.ts"), "utf8");
  for (const [name, src] of [["read_channel", readChanSrc], ["read_thread", readThreadSrc]] as const) {
    ok(/if \(!genericReadVerbsEnabled\(\)\) return null;/u.test(src), `wiring: ${name} is ABSENT when the flag is OFF`);
    ok(src.includes("resolveReadAdapter("), `wiring: ${name} routes through the neutral execute chain (resolveReadAdapter)`);
    ok(src.includes("resolveWindowSources("), `wiring: ${name} gates its mount on sources non-empty`);
  }
}

console.log(`✓ ${n} generic-read-verbs assertions passed`);
