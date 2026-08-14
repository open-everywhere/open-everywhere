import assert from "node:assert/strict";
import {
  READ_ADAPTERS,
  supportedReadPlatforms,
  resolveReadAdapter,
  assertSurfaceAllowed,
} from "@open-everywhere/core/agent/channels/channel-read.js";
import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import {
  discordReadAdapter,
  discordLinesFromRaw,
  type DiscordReadRequester,
} from "@open-everywhere/provider-discord/agent/channels/discord-read.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { buildDiscordAuth, type DiscordIdentityInput } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import type { BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { defineAuthorTrust, registerAuthorTrust, _resetAuthorTrustForTest } from "@open-everywhere/core/agent/identity/author-trust.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerDiscordProvider();

{
  ok(READ_ADAPTERS["discord"] === discordReadAdapter, "registry: READ_ADAPTERS.discord is the REST fetch adapter");
  ok(supportedReadPlatforms().includes("discord"), "registry: discord is in the supported-platforms list");
  const mk = (kind: string, attrs: Record<string, string>): BindableContext =>
    ({ channel: { kind }, session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "discord-user" } } } }) as unknown as BindableContext;
  const uniDiscord = mk("unified", { oe_platform: "discord", oe_sources: "discord" });
  const resolved = resolveReadAdapter(uniDiscord, undefined, []);
  ok(resolved.platform === "discord" && resolved.adapter === discordReadAdapter, "registry: resolveReadAdapter routes a discord-origin turn to the Discord adapter");
}

const GUILD = "GUILD1";
const CHAN_ENG = "C-ENG";
const CHAN_STANDUP = "C-STANDUP";
const CHAN_OUTSIDE = "C-OUTSIDE";
const THREAD_ENG = "T-ENG-42";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({
      name: "eng",
      channels: [`discord/${GUILD}/${CHAN_ENG}`, `discord/${GUILD}/${CHAN_STANDUP}`, `discord/${GUILD}/${THREAD_ENG}`],
    }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function discordCtx(input: DiscordIdentityInput): BindableContext {
  const auth = buildDiscordAuth(input);
  return { channel: { kind: "discord" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

const engCtx = discordCtx({ userId: "U-ALICE", guildId: GUILD, channelId: CHAN_ENG });

{
  const calls: Array<{ channelId: string; limit: number }> = [];
  const raw = [
    { type: 0, id: "200", content: "second", author: { id: "A2" } },
    { type: 0, id: "100", content: "first", author: { id: "A1" } },
  ];
  const req: DiscordReadRequester = async (channelId, limit) => {
    calls.push({ channelId, limit });
    return raw;
  };
  const lines = await discordReadAdapter.readChannel(engCtx, CHAN_ENG, undefined, req);
  ok(calls.length === 1 && calls[0].channelId === CHAN_ENG && calls[0].limit === 50, "readChannel: DI requester called with the channel id + the default limit (50, unspecified)");
  ok(JSON.stringify(lines) === JSON.stringify(discordLinesFromRaw(raw)), "readChannel: renders via discordLinesFromRaw (oldest-first)");
}

{
  const calls: Array<{ channelId: string; limit: number }> = [];
  const raw = [{ type: 0, id: "300", content: "a reply", author: { id: "A3" } }];
  const req: DiscordReadRequester = async (channelId, limit) => {
    calls.push({ channelId, limit });
    return raw;
  };
  const lines = await discordReadAdapter.readThread(engCtx, CHAN_ENG, THREAD_ENG, undefined, req);
  ok(calls.length === 1 && calls[0].channelId === THREAD_ENG && calls[0].limit === 100, "readThread: DI requester is called with the THREAD's own id (not `channel`) + the default thread limit (100)");
  ok(lines.length === 1 && lines[0].text === "a reply", "readThread: renders the reply");
}

{
  const calls: number[] = [];
  const req: DiscordReadRequester = async (_channelId, limit) => {
    calls.push(limit);
    return [];
  };
  await discordReadAdapter.readChannel(engCtx, CHAN_ENG, 7, req);
  ok(calls[0] === 7, "readChannel: an explicit limit overrides the default and is forwarded to the requester");
}

{
  const req: DiscordReadRequester = async () => [];
  const lines = await discordReadAdapter.readChannel(engCtx, CHAN_STANDUP, undefined, req);
  ok(Array.isArray(lines) && lines.length === 0, "readChannel: a same-domain, non-own channel is allowed (empty page renders empty)");
}

{
  const req: DiscordReadRequester = async () => {
    throw new Error("must not be called — the allowlist gate should reject before any fetch");
  };
  await assert.rejects(
    () => discordReadAdapter.readChannel(engCtx, CHAN_OUTSIDE, undefined, req),
    /channel "C-OUTSIDE" is not in domain "eng" discord read scope/u,
    "readChannel: an out-of-domain channel is refused (through the adapter's own assertSurfaceAllowed call) before any Discord GET",
  );
  n++;
}

{
  const req: DiscordReadRequester = async () => {
    throw new Error("must not be called — the allowlist gate should reject before any fetch");
  };
  await assert.rejects(
    () => discordReadAdapter.readThread(engCtx, CHAN_ENG, "T-OUTSIDE", undefined, req),
    /channel "T-OUTSIDE" is not in domain "eng" discord read scope/u,
    "readThread: an out-of-domain thread id is refused before any Discord GET (assertSurfaceAllowed's generic \"channel\" wording, since a thread id IS a channel id on Discord)",
  );
  n++;
}

{
  const rows: Array<Record<string, unknown>> = [];
  const audit = async (e: Record<string, unknown>) => {
    rows.push(e);
  };
  await assert.rejects(
    () => assertSurfaceAllowed(engCtx, "discord", CHAN_OUTSIDE, { audit }),
    /channel "C-OUTSIDE" is not in domain "eng" discord read scope/u,
    "an audited refusal throws exactly the error the silent version threw",
  );
  n++;
  ok(rows.length === 1, "exactly one read.refused row per refused read");
  const row = rows[0] as { action?: string; platform?: string; workspace?: string; detail?: Record<string, unknown> };
  ok(row.action === "read.refused" && row.platform === "discord", "the row is a discord read.refused");
  ok(row.workspace === GUILD, "…stamped with the guild as the workspace");
  ok(row.detail?.target === CHAN_OUTSIDE && row.detail?.reason === "cross-domain", "…naming the refused channel id and the verdict");
  ok(
    row.detail?.callerDomain === "eng" && row.detail?.callerSurfaceKey === `discord/${GUILD}/${CHAN_ENG}` && row.detail?.targetDomain === null,
    "…both sides: the caller's domain + surface key, and no owning domain for an unlisted channel",
  );
  ok(Object.keys(row.detail ?? {}).length === 5, "…and nothing else — ids, domains and a verdict, never message CONTENT");

  const exploding = async () => {
    throw new Error("audit store is down");
  };
  await assert.rejects(
    () => assertSurfaceAllowed(engCtx, "discord", CHAN_OUTSIDE, { audit: exploding }),
    /channel "C-OUTSIDE" is not in domain "eng" discord read scope/u,
    "a failing audit sink still yields the SAME ChannelScopeError — best-effort, never control flow",
  );
  n++;

  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "discord", action: "read.refused" })).length;
  await assert.rejects(
    () => discordReadAdapter.readChannel(engCtx, CHAN_OUTSIDE, undefined, async () => []),
    /is not in domain "eng" discord read scope/u,
    "a refusal through the ADAPTER (no deps override) still throws",
  );
  n++;
  const after = await readAudit({ org, platform: "discord", action: "read.refused" });
  ok(after.length === before + 1, "…and appends exactly one durable read.refused row through the real appendAudit");
}

{
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;

  await discordReadAdapter.readChannel(engCtx, CHAN_ENG, 500);

  ok(calls.length === 1, "live requester: exactly one fetch call");
  ok(calls[0].url === `https://discord.com/api/v10/channels/${CHAN_ENG}/messages?limit=100`, "live requester: builds the exact Discord REST URL, limit CLAMPED to DISCORD_MAX_PAGE (100)");
  ok(calls[0].headers.authorization === "Bot test-bot-token", "live requester: sends `Bot <token>` on the SAME DISCORD_BOT_TOKEN the reply-post path uses");

  globalThis.fetch = originalFetch;
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
  else delete process.env.DISCORD_BOT_TOKEN;
}

{
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;

  await discordReadAdapter.readThread(engCtx, CHAN_ENG, THREAD_ENG, 30);

  ok(calls[0] === `https://discord.com/api/v10/channels/${THREAD_ENG}/messages?limit=30`, "live requester (thread): URL targets the thread's own channel id, not `channel`");

  globalThis.fetch = originalFetch;
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
  else delete process.env.DISCORD_BOT_TOKEN;
}

{
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;

  await assert.rejects(
    () => discordReadAdapter.readChannel(engCtx, CHAN_ENG, 50),
    /read: Discord GET messages failed \(HTTP 403\) for channel C-ENG\./u,
    "readChannel: a Discord HTTP error propagates (fail loud, matching teamsReadAdapter's posture)",
  );
  n++;

  globalThis.fetch = originalFetch;
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
  else delete process.env.DISCORD_BOT_TOKEN;
}

{
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => discordReadAdapter.readChannel(engCtx, CHAN_ENG, 50),
    /DISCORD_BOT_TOKEN is not set — the Discord read tools need the bot token\./u,
    "readChannel: the DEFAULT (live) requester fails loud on a missing bot token before any network call",
  );
  n++;
  ok(!fetchCalled, "readChannel: no fetch call was made when the token is missing");

  globalThis.fetch = originalFetch;
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
}

{
  const guestPage = discordLinesFromRaw([
    { type: 0, id: "300", content: "hello", author: { id: "U-STRANGER" } },
    { type: 0, id: "200", content: "beep", author: { id: "B-BOT", bot: true } },
    { type: 0, id: "100", content: "morning", author: { id: "U-ALICE" } },
  ]);
  ok(
    JSON.stringify(guestPage.map((l) => [l.authorId, l.bot === true])) === JSON.stringify([["U-ALICE", false], [undefined, true], ["U-STRANGER", false]]),
    "grading fields: a `user` line carries its authorId; a `bot` line is marked a machine and carries none",
  );

  _resetAuthorTrustForTest();
  let probes = 0;
  const roleProbe = async (guildId: string, userId: string) => {
    probes++;
    return guildId === GUILD && userId === "U-ALICE" ? ["R-ENG"] : [];
  };
  ok((await discordReadAdapter.refutedAuthorIds(engCtx, guestPage, roleProbe)).length === 0, "🔴 unarmed guild: a read marks NOTHING (=== []) — silence is never a declaration");
  ok(probes === 0, "🔴 unarmed guild: ZERO role lookups — the cost gate, measured rather than read off the code");

  registerAuthorTrust([defineAuthorTrust({ tenant: `discord/${GUILD}`, internal: [{ membership: `discord/${GUILD}/role:R-ENG` }] })]);
  probes = 0;
  ok((await discordReadAdapter.refutedAuthorIds(engCtx, guestPage, roleProbe)).length > 0, "🔴 armed guild: a page carrying an author with no declared role MARKS");
  ok(probes === 2, "armed guild: one role lookup per DISTINCT human author (the bot is skipped) — the guild id came from the binding");

  const memberPage = discordLinesFromRaw([
    { type: 0, id: "200", content: "second", author: { id: "U-ALICE" } },
    { type: 0, id: "100", content: "first", author: { id: "U-ALICE" } },
  ]);
  probes = 0;
  ok((await discordReadAdapter.refutedAuthorIds(engCtx, memberPage, roleProbe)).length === 0, "🔴 negative control: an armed guild's DECLARED member does not mark (=== [])");
  ok(probes === 1, "…and a repeat author is probed once, not once per message");

  ok(
    (await discordReadAdapter.refutedAuthorIds(engCtx, guestPage, async () => undefined)).length === 0,
    "🔴 negative control: a role probe answering `undefined` skips the register query — 'cannot check' is not 'checked and empty' (=== [])",
  );

  ok(
    (await discordReadAdapter.refutedAuthorIds(engCtx, guestPage, async () => {
      throw new Error("role lookup exploded");
    })).length === 0,
    "negative control: a THROWING role probe fails OPEN (=== [])",
  );
  _resetAuthorTrustForTest();
}

console.log(`✓ ${n} discord-read assertions passed`);
