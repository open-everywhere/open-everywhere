import assert from "node:assert/strict";
import {
  stripHtml,
  teamsLinesFromRaw,
  sanitizeTeamsChannelId,
  allowedTeamsChannelIds,
  assertTeamsChannelAllowed,
  teamsReadAdapter,
  _resetTeamsGraphTokenCache,
  type TeamsGraphRequester,
} from "../agent/channels/teams-read.js";
import { registerTeamsProvider } from "../agent/register.js";
import {
  READ_ADAPTERS,
  supportedReadPlatforms,
  resolveReadAdapter,
  registerConfig,
  defineDomain,
  readAudit,
  deploymentOrg,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth, type TeamsIdentityInput } from "../agent/channels/teams-identity.js";

registerTeamsProvider();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(stripHtml("Hello World <at id=\"0\">Jane Smith</at>") === "Hello World Jane Smith", "stripHtml: drops a mention <at> span, keeps its text");
  ok(stripHtml("<div><div><span>a &amp; b</span></div></div>") === "a & b", "stripHtml: nested tags dropped, &amp; decoded");
  ok(stripHtml("a &lt;b&gt; &quot;c&quot; &#39;d&#39;") === "a <b> \"c\" 'd'", "stripHtml: all five entities decoded");
  ok(stripHtml("line1\n\n  line2   line3") === "line1 line2 line3", "stripHtml: whitespace collapsed");
  ok(stripHtml("") === "", "stripHtml: empty in, empty out");
}

{
  const raw = [
    { id: "3", createdDateTime: "2021-03-28T21:11:12.395Z", messageType: "message", from: { user: { id: "U1", displayName: "Robin" } }, body: { contentType: "html", content: "third" } },
    { id: "sys", createdDateTime: "2021-03-28T20:00:00.000Z", messageType: "systemEventMessage", from: null, body: { contentType: "html", content: "<systemEventMessage/>" } },
    { id: "del", createdDateTime: "2021-03-28T20:15:00.000Z", deletedDateTime: "2021-03-28T20:16:00.000Z", messageType: "message", from: { user: { id: "U2" } }, body: { contentType: "html", content: "gone" } },
    { id: "empty", createdDateTime: "2021-03-28T20:20:00.000Z", messageType: "message", from: { user: { id: "U3" } }, body: { contentType: "html", content: "" } },
    { id: "1", createdDateTime: "2021-03-28T20:29:37.068Z", messageType: "message", from: { user: { id: "U1", displayName: "Robin" } }, body: { contentType: "html", content: "first <at id=\"0\">Jane</at>" } },
    { id: "2", createdDateTime: "2021-03-28T20:45:00.000Z", from: { application: { id: "APP1", displayName: "OtherBot" } }, body: { contentType: "html", content: "second" } },
  ];
  const lines = teamsLinesFromRaw(raw);
  ok(JSON.stringify(lines) === JSON.stringify([
    { author: "Robin", ts: "1", text: "first Jane" },
    { author: "OtherBot", ts: "2", text: "second" },
    { author: "Robin", ts: "3", text: "third" },
  ]), "teamsLinesFromRaw: deleted/system/empty dropped, HTML stripped, sorted oldest-first by createdDateTime (input order ignored)");
  ok(teamsLinesFromRaw("not-an-array").length === 0, "teamsLinesFromRaw: a non-array response yields no lines (fail-soft parse)");
  ok(teamsLinesFromRaw([]).length === 0, "teamsLinesFromRaw: empty array yields no lines");
}

{
  ok(sanitizeTeamsChannelId("19:channel-eng@thread.tacv2") === "19-channel-eng-thread.tacv2", "sanitizeTeamsChannelId: matches binding.ts's seg() on a real Teams id");
  ok(sanitizeTeamsChannelId("already-safe.123") === "already-safe.123", "sanitizeTeamsChannelId: an already-safe id is untouched");
  ok(sanitizeTeamsChannelId("  :leading-and-trailing:  ") === "leading-and-trailing", "sanitizeTeamsChannelId: trims + strips leading/trailing unsafe runs");
}

{
  const eng = defineDomain({ name: "eng", channels: ["teams/TENANT1/19-channel-eng-thread.tacv2", "teams/TENANT1/19-channel-standup-thread.tacv2", "slack/T/CS"] });
  const scope = allowedTeamsChannelIds("teams/TENANT1/19-channel-eng-thread.tacv2", [eng]);
  ok(scope.ids.has("19-channel-eng-thread.tacv2") && scope.ids.has("19-channel-standup-thread.tacv2"), "allowedTeamsChannelIds: own + domain's other teams channel both in scope");
  ok(!scope.ids.has("CS"), "allowedTeamsChannelIds: a slack-prefixed domain entry is excluded (teams-only)");
  ok(scope.domain === "eng", "allowedTeamsChannelIds: names the owning domain");
  const lone = allowedTeamsChannelIds("teams/TENANT1/19-channel-lone-thread.tacv2", []);
  ok(lone.ids.has("19-channel-lone-thread.tacv2") && lone.domain === undefined, "allowedTeamsChannelIds: own channel always in scope with no domain");
}

const RAW_ENG = "19:channel-eng@thread.tacv2";
const RAW_STANDUP = "19:channel-standup@thread.tacv2";
const RAW_OUTSIDE = "19:channel-outside@thread.tacv2";
const RAW_TEAM = "19:team-eng@thread.tacv2";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({
      name: "eng",
      channels: [`teams/TENANT1/${sanitizeTeamsChannelId(RAW_ENG)}`, `teams/TENANT1/${sanitizeTeamsChannelId(RAW_STANDUP)}`],
    }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function teamsCtx(input: TeamsIdentityInput): BindableContext {
  const auth = buildTeamsAuth(input);
  return { channel: { kind: "teams" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

const engCtx = teamsCtx({
  userId: "29:user-alice",
  tenantId: "TENANT1",
  conversationId: RAW_ENG,
  channelId: RAW_ENG,
  teamId: RAW_TEAM,
  serviceUrl: "https://smba.trafficmanager.net/uk/",
  scope: "channel",
});

{
  const calls: string[] = [];
  const req: TeamsGraphRequester = async (url) => {
    calls.push(url);
    return {
      value: [
        { id: "200", createdDateTime: "2021-01-01T00:02:00Z", messageType: "message", from: { user: { displayName: "Bob" } }, body: { contentType: "html", content: "second" } },
        { id: "100", createdDateTime: "2021-01-01T00:01:00Z", messageType: "message", from: { user: { displayName: "Alice" } }, body: { contentType: "html", content: "first &amp; best" } },
      ],
    };
  };
  const lines = await teamsReadAdapter.readChannel(engCtx, RAW_ENG, 50, req);
  ok(calls.length === 1 && calls[0] === `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(RAW_TEAM)}/channels/${encodeURIComponent(RAW_ENG)}/messages?$top=50`, "readChannel: builds the exact Graph URL with the RAW team + channel ids");
  ok(JSON.stringify(lines) === JSON.stringify([
    { author: "Alice", ts: "100", text: "first & best" },
    { author: "Bob", ts: "200", text: "second" },
  ]), "readChannel: oldest-first, HTML-stripped, regardless of the page's own order");
}

{
  const calls: string[] = [];
  const req: TeamsGraphRequester = async (url) => {
    calls.push(url);
    return { value: [{ id: "r1", createdDateTime: "2021-01-01T00:05:00Z", messageType: "message", from: { user: { displayName: "Carol" } }, body: { contentType: "html", content: "a reply" } }] };
  };
  const lines = await teamsReadAdapter.readThread(engCtx, RAW_ENG, "root-42", 50, req);
  ok(calls[0] === `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(RAW_TEAM)}/channels/${encodeURIComponent(RAW_ENG)}/messages/${encodeURIComponent("root-42")}/replies?$top=50`, "readThread: builds the replies URL against the root message id");
  ok(lines.length === 1 && lines[0].text === "a reply", "readThread: renders the reply");
}

{
  const req: TeamsGraphRequester = async () => ({ value: [] });
  const lines = await teamsReadAdapter.readChannel(engCtx, RAW_STANDUP, 50, req);
  ok(Array.isArray(lines) && lines.length === 0, "readChannel: a same-domain, non-own channel is allowed (empty page renders empty)");
}

{
  const req: TeamsGraphRequester = async () => {
    throw new Error("must not be called — the allowlist gate should reject before any fetch");
  };
  await assert.rejects(
    () => teamsReadAdapter.readChannel(engCtx, RAW_OUTSIDE, 50, req),
    /is not in domain "eng" teams read scope/u,
    "readChannel: an out-of-domain channel is refused before any Graph call",
  );
  n++;
}

{
  const rows: Array<Record<string, unknown>> = [];
  const audit = async (e: Record<string, unknown>) => {
    rows.push(e);
  };
  await assert.rejects(
    () => assertTeamsChannelAllowed(engCtx, RAW_OUTSIDE, { audit }),
    /is not in domain "eng" teams read scope/u,
    "an audited refusal throws exactly the error the silent version threw",
  );
  n++;
  ok(rows.length === 1, "exactly one read.refused row per refused read");
  const row = rows[0] as { action?: string; platform?: string; detail?: Record<string, unknown> };
  ok(row.action === "read.refused" && row.platform === "teams", "the row is a teams read.refused");
  ok(row.detail?.target === sanitizeTeamsChannelId(RAW_OUTSIDE) && row.detail?.reason === "cross-domain", "…naming the SANITIZED refused channel id and the verdict");
  ok(row.detail?.callerDomain === "eng" && row.detail?.targetDomain === null, "…both sides: the caller's domain, and no owning domain for an unlisted channel");
  ok(Object.keys(row.detail ?? {}).length === 5, "…and nothing else — ids, domains and a verdict, never message CONTENT");

  const exploding = async () => {
    throw new Error("audit store is down");
  };
  await assert.rejects(
    () => assertTeamsChannelAllowed(engCtx, RAW_OUTSIDE, { audit: exploding }),
    /is not in domain "eng" teams read scope/u,
    "a failing audit sink still yields the SAME ChannelScopeError — best-effort, never control flow",
  );
  n++;

  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "teams", action: "read.refused" })).length;
  await assert.rejects(
    () => teamsReadAdapter.readChannel(engCtx, RAW_OUTSIDE, 50, async () => ({ value: [] })),
    /is not in domain "eng" teams read scope/u,
    "a refusal through the ADAPTER (no deps override) still throws",
  );
  n++;
  const after = await readAudit({ org, platform: "teams", action: "read.refused" });
  ok(after.length === before + 1, "…and appends exactly one durable read.refused row through the real appendAudit");
}

{
  let calls = 0;
  const req: TeamsGraphRequester = async () => {
    calls++;
    return { value: [{ id: `p${calls}`, createdDateTime: `2021-01-01T00:0${calls}:00Z`, messageType: "message", from: { user: { displayName: "X" } }, body: { contentType: "text", content: `msg${calls}` } }], ["@odata.nextLink"]: "https://graph.microsoft.com/v1.0/next-page-always" };
  };
  const lines = await teamsReadAdapter.readChannel(engCtx, RAW_ENG, 100, req);
  ok(calls === 5, "readChannel: pagination stops at TEAMS_GRAPH_MAX_PAGES (5) even with an always-present nextLink");
  ok(lines.length === 5, "readChannel: all 5 bounded pages' messages are rendered");
}

{
  const req: TeamsGraphRequester = async () => {
    throw new Error("read: Teams Graph GET failed (HTTP 403) for <url> — Forbidden");
  };
  await assert.rejects(() => teamsReadAdapter.readChannel(engCtx, RAW_ENG, 50, req), /HTTP 403/u, "readChannel: a Graph HTTP error propagates (fail loud, matching discordReadAdapter's posture)");
  n++;
}

{
  const saved = { id: process.env.MICROSOFT_APP_ID, teamsId: process.env.TEAMS_APP_ID, pw: process.env.MICROSOFT_APP_PASSWORD, teamsPw: process.env.TEAMS_APP_PASSWORD };
  delete process.env.MICROSOFT_APP_ID;
  delete process.env.TEAMS_APP_ID;
  delete process.env.MICROSOFT_APP_PASSWORD;
  delete process.env.TEAMS_APP_PASSWORD;
  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "teams", action: "teams.token_mint_failed" })).length;
  _resetTeamsGraphTokenCache();
  await assert.rejects(
    () => teamsReadAdapter.readChannel(engCtx, RAW_ENG, 50),
    /MICROSOFT_APP_ID or TEAMS_APP_ID is required/u,
    "readChannel: the DEFAULT (live) requester fails loud on missing app credentials before any network call",
  );
  n++;
  const after = await readAudit({ org, platform: "teams", action: "teams.token_mint_failed" });
  assert.ok(after.length > before, "a failed Graph token mint appends a durable teams.token_mint_failed audit row (never a silent stale token)");
  n++;
  assert.equal(after[0]!.detail?.credential, "teams.graph-app-only", "…naming which credential failed");
  n++;
  assert.ok(typeof after[0]!.detail?.error === "string" && (after[0]!.detail!.error as string).length > 0, "…with a non-empty error detail");
  n++;
  if (saved.id !== undefined) process.env.MICROSOFT_APP_ID = saved.id;
  if (saved.teamsId !== undefined) process.env.TEAMS_APP_ID = saved.teamsId;
  if (saved.pw !== undefined) process.env.MICROSOFT_APP_PASSWORD = saved.pw;
  if (saved.teamsPw !== undefined) process.env.TEAMS_APP_PASSWORD = saved.teamsPw;
  _resetTeamsGraphTokenCache();
}

{
  ok(READ_ADAPTERS["teams"] === teamsReadAdapter, "registry: READ_ADAPTERS.teams is the Microsoft Graph adapter (registered by the bundle)");
  ok(supportedReadPlatforms().includes("teams"), "registry: teams is in the LIVE supported-platforms list once the bundle registered it");
  const mk = (kind: string, attrs: Record<string, string>): BindableContext =>
    ({ channel: { kind }, session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "teams-user" } } } }) as unknown as BindableContext;
  const uniTeams = mk("unified", { oe_platform: "teams", oe_sources: "teams" });
  const resolved = resolveReadAdapter(uniTeams, undefined, []);
  ok(resolved.platform === "teams" && resolved.adapter === teamsReadAdapter, "registry: resolveReadAdapter routes a teams-origin turn to the Teams adapter");
}

console.log(`✓ ${n} teams-read assertions passed`);
