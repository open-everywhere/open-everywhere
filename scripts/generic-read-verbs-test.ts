import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveReadAdapter,
  resolveReadTarget,
  keyedReadResult,
  ChannelKeyError,
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
import { ingestUntrusted, normalizeFenceNonce } from "@open-everywhere/core/agent/access/untrusted.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import type { BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "@open-everywhere/core/agent/channels/read-scope-audit.js";
import { encodeChannelKey, decodeChannelKey, isChannelKey, containerIdForPlatform, CHANNEL_KEY_PREFIX } from "@open-everywhere/core/agent/channels/channel-key.js";

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
  ok(normalizeFenceNonce(JSON.stringify(oldWrapped)) === normalizeFenceNonce(JSON.stringify(newWrapped)), "golden: the full untrusted-wrapped channel output is byte-identical");
  ok(oldWrapped.value !== newWrapped.value, "golden: …and the two renders carry DIFFERENT fence nonces (per-render, not a constant)");

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
  ok(r1.platform === "slack" && r1.adapter === fakeSlackAdapter, "gate: no targetPlatform argument ⇒ defaults to the turn origin (slack) → Slack adapter");

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
    ok(src.includes("resolveReadTarget("), `wiring: ${name} routes through the neutral execute chain (resolveReadTarget → resolveReadAdapter)`);
    ok(src.includes("resolveWindowSources("), `wiring: ${name} gates its mount on sources non-empty`);
  }
}

{
  const rows: Array<Record<string, unknown>> = [];
  const audit = async (e: Record<string, unknown>) => {
    rows.push(e);
  };

  const uniSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack" });
  await auditOriginFenceRefusal(uniSlack, "notion", { audit });
  n++;
  ok(rows.length === 1, "auditOriginFenceRefusal: exactly one row written");
  {
    const row = rows[0] as { action?: string; platform?: string; detail?: Record<string, unknown> };
    ok(row.action === "notion.origin_refused", "…action name is `<target>.origin_refused`");
    ok(row.platform === "notion", "…platform field equals the target (queryable by platform)");
    ok(row.detail?.target === "notion" && row.detail?.origin === "slack" && "sessionId" in (row.detail ?? {}), "…detail carries target, this turn's origin, and a sessionId key");
  }
  rows.length = 0;

  await auditSourcesGateRefusal(uniSlack, "linear", { audit });
  n++;
  ok(rows.length === 1, "auditSourcesGateRefusal: exactly one row written");
  {
    const row = rows[0] as { action?: string; platform?: string; detail?: Record<string, unknown> };
    ok(row.action === "linear.sources_refused", "…action name is `<target>.sources_refused`");
    ok(row.platform === "linear", "…platform field equals the target");
    ok(row.detail?.target === "linear" && row.detail?.origin === "slack", "…detail names the refused target and this turn's origin");
  }
  rows.length = 0;

  const unplaceable = { session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  await auditOriginFenceRefusal(unplaceable, "notion", { audit });
  n++;
  ok((rows[0] as { detail?: Record<string, unknown> }).detail?.origin === null, "an unplaceable turn's origin is audited as `null`, not omitted or guessed");
  ok(!("principalId" in rows[0]), "no principal on this context ⇒ no principalId field (never a fabricated one)");
  rows.length = 0;

  const exploding = async () => {
    throw new Error("audit store is down");
  };
  let originThrew = false;
  try {
    await auditOriginFenceRefusal(uniSlack, "notion", { audit: exploding });
  } catch {
    originThrew = true;
  }
  ok(originThrew === false, "a failing audit sink does not throw out of auditOriginFenceRefusal (best-effort, never control flow)");
  let sourcesThrew = false;
  try {
    await auditSourcesGateRefusal(uniSlack, "notion", { audit: exploding });
  } catch {
    sourcesThrew = true;
  }
  ok(sourcesThrew === false, "a failing audit sink does not throw out of auditSourcesGateRefusal (best-effort, never control flow)");
}

{
  ok(encodeChannelKey("slack", "C0ABC") === "ch_c2xhY2s6QzBBQkM", "codec: a slack container mints its literal key");
  ok(encodeChannelKey("discord", "C0ABC") === "ch_ZGlzY29yZDpDMEFCQw", "codec: the SAME container id on another platform mints a DIFFERENT key (the platform is IN the key)");
  ok(JSON.stringify(decodeChannelKey("ch_c2xhY2s6QzBBQkM")) === JSON.stringify({ platform: "slack", container: "C0ABC" }), "codec: a key decodes back to its exact (platform, container) pair");
  ok(isChannelKey(encodeChannelKey("teams", "19:abc@thread.tacv2")), "codec: a container id holding its own colons round-trips (the FIRST colon separates)");
  ok(decodeChannelKey(encodeChannelKey("teams", "19:abc@thread.tacv2"))?.container === "19:abc@thread.tacv2", "codec: …and the whole container id comes back, colons included");

  for (const bad of ["C0ABC", "", "ch_", "ch_!!!!", "ch_c2xhY2s6QzBBQkM=", "ZGlzY29yZDpDMEFCQw", "ch_bm9zZXA", "ch_OkMwQUJD"]) {
    ok(decodeChannelKey(bad) === null, `codec: "${bad}" is NOT a channel key (rejected, never guessed)`);
  }
  ok(CHANNEL_KEY_PREFIX === "ch_", "codec: the prefix is stable — a stored/rendered key stays readable across releases");
  ok(encodeChannelKey("", "C0ABC") === "C0ABC", "codec: a locus with NO platform passes its container id through rather than minting a key that decodes to nothing");
  ok(encodeChannelKey("slack", "") === "", "codec: a locus with NO container id mints nothing");

  const uniSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack,discord" });
  const t = resolveReadTarget(uniSlack, "ch_c2xhY2s6QzBBQkM", []);
  ok(t.platform === "slack" && t.adapter === fakeSlackAdapter && t.container === "C0ABC", "read target: the key alone resolves the platform, the adapter AND the container id — no `platform` argument exists any more");

  assert.throws(() => resolveReadTarget(uniSlack, "C0ABC", []), ChannelKeyError, "read target: a RAW container id is refused — it is not an address");
  n++;
  assert.throws(() => resolveReadTarget(uniSlack, "C0ABC", []), /is not a channel key/u, "read target: …and the refusal tells the model where to find a real one");
  n++;

  assert.throws(() => resolveReadTarget(uniSlack, encodeChannelKey("discord", "D1"), []), /the message that woke this turn came from slack/u, "read target: the origin fence fires on the platform the KEY names (the key is an address, never a grant)");
  n++;
  const soloSlack = mk("unified", { oe_platform: "slack", oe_sources: "slack" });
  assert.throws(() => resolveReadTarget(soloSlack, encodeChannelKey("discord", "D1"), []), /is not one of this window's sources/u, "read target: the topology gate fires on the platform the KEY names");
  n++;

  const chan: ChannelReadResult = { platform: "slack", channel: "C0ABC", count: 2, messages: MSGS };
  const keyed = keyedReadResult(chan);
  ok(keyed.channel === "ch_c2xhY2s6QzBBQkM", "render: keyedReadResult swaps the fetched container id for the key");
  ok(renderChannelBody(keyed).startsWith("Recent messages in ch_c2xhY2s6QzBBQkM (oldest first):"), "render: the read BODY names the key, not the raw container id");
  ok(!renderChannelBody(keyed).includes("C0ABC"), "🔴 render: the raw container id does NOT reach the model in the body");
  ok(channelReadSource(keyed) === "slack channel ch_c2xhY2s6QzBBQkM", "render: the provenance label still names the SURFACE (provenance is not addressing) but addresses by key");
  const thr: ThreadReadResult = { platform: "slack", channel: "C0ABC", thread_ts: "999.9", count: 2, messages: MSGS };
  ok(renderThreadBody(keyedReadResult(thr)).startsWith("Thread 999.9 in ch_c2xhY2s6QzBBQkM (oldest first):"), "render: the thread body names the key, and thread_ts stays a raw message id (a message is not a place)");

  ok(containerIdForPlatform("ch_c2xhY2s6QzBBQkM", "slack") === "C0ABC", "stage-1: read_slack_* decodes a slack key to the raw id it fetches with");
  ok(containerIdForPlatform("C0ABC", "slack") === "C0ABC", "stage-1: …and a raw Slack id still passes through unchanged (the flag-off contract)");
  assert.throws(() => containerIdForPlatform(encodeChannelKey("discord", "D1"), "slack"), /names a discord channel/u, "stage-1: a key naming ANOTHER platform is refused, never mis-addressed as a slack read");
  n++;

  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/core/agent/tools");
  for (const name of ["read_channel", "read_thread"] as const) {
    const src = readFileSync(join(toolsDir, `${name}.ts`), "utf8");
    ok(src.includes("resolveReadTarget("), `wiring: ${name} resolves its target from the channel key`);
    ok(!src.includes("input.target"), `wiring: ${name} takes NO platform argument — one key is the whole address`);
    ok(src.includes("keyedReadResult("), `wiring: ${name} re-addresses its model-facing output in the key`);
  }
}

console.log(`✓ ${n} generic-read-verbs assertions passed`);
