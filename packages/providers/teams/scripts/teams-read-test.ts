import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { _seedTeamsGraphTeamIdForTest } from "../agent/channels/teams-graph-team-id.js";
import {
  decodeJwtRoles,
  boundaryFromRoles,
  boundaryOfGraphToken,
  noteTeamsReadBoundary,
  teamsReadBoundary,
  _resetTeamsReadBoundaryForTest,
  TENANT_WIDE_CHANNEL_READ_ROLES,
} from "../agent/channels/teams-graph-boundary.js";
import { boundaryCheck, teamsBoundaryProbe } from "../agent/ops.js";
import { registerTeamsProvider } from "../agent/register.js";
import {
  READ_ADAPTERS,
  supportedReadPlatforms,
  resolveReadAdapter,
  registerConfig,
  defineDomain,
  readAudit,
  deploymentOrg,
  defineAuthorTrust,
  registerAuthorTrust,
  _resetAuthorTrustForTest,
  getSettings,
  overrideSettingsForTest,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth, type TeamsIdentityInput } from "../agent/channels/teams-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-teams-read-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

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
    { author: "Robin", ts: "1", text: "first Jane", authorId: "U1" },
    { author: "OtherBot", ts: "2", text: "second", bot: true },
    { author: "Robin", ts: "3", text: "third", authorId: "U1" },
  ]), "teamsLinesFromRaw: deleted/system/empty dropped, HTML stripped, sorted oldest-first by createdDateTime (input order ignored)");
  ok(lines.every((l) => !("createdMs" in l)), "teamsLinesFromRaw: the internal sort key does not leak into the rendered line");
  ok(teamsLinesFromRaw("not-an-array").length === 0, "teamsLinesFromRaw: a non-array response yields no lines (fail-soft parse)");
  ok(teamsLinesFromRaw([]).length === 0, "teamsLinesFromRaw: empty array yields no lines");
}

{
  ok(sanitizeTeamsChannelId("19:channel-eng@thread.tacv2") === "19-channel-eng-thread.tacv2", "sanitizeTeamsChannelId: matches binding.ts's seg() on a real Teams id");
  ok(sanitizeTeamsChannelId("already-safe.123") === "already-safe.123", "sanitizeTeamsChannelId: an already-safe id is untouched");
  ok(sanitizeTeamsChannelId("  :leading-and-trailing:  ") === "leading-and-trailing", "sanitizeTeamsChannelId: trims + strips leading/trailing unsafe runs");
}

{
  const eng = defineDomain({ name: "eng", reach: ["teams/TENANT1/19-channel-eng-thread.tacv2", "teams/TENANT1/19-channel-standup-thread.tacv2", "slack/T/CS"] });
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
const GROUP_TEAM = "00000000-0000-4000-8000-000000000021";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({
      name: "eng",
      reach: [`teams/TENANT1/${sanitizeTeamsChannelId(RAW_ENG)}`, `teams/TENANT1/${sanitizeTeamsChannelId(RAW_STANDUP)}`],
    }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function teamsCtx(input: TeamsIdentityInput): BindableContext {
  const auth = buildTeamsAuth(input);
  return { channel: { kind: "teams" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

_seedTeamsGraphTeamIdForTest(RAW_TEAM, GROUP_TEAM);

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
  ok(calls.length === 1 && calls[0] === `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(GROUP_TEAM)}/channels/${encodeURIComponent(RAW_ENG)}/messages?$top=50`, "readChannel: builds the exact Graph URL with the RESOLVED group id and the raw channel id — the Connector-spelled team id never reaches Graph");
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
  ok(calls[0] === `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(GROUP_TEAM)}/channels/${encodeURIComponent(RAW_ENG)}/messages/${encodeURIComponent("root-42")}/replies?$top=50`, "readThread: builds the replies URL against the root message id");
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
  ok(
    JSON.stringify(Object.keys(row.detail ?? {}).sort()) === JSON.stringify(["boundary", "callerDomain", "callerSurfaceKey", "reason", "target", "targetDomain"]),
    "…and nothing else — ids, domains and verdicts, never message CONTENT",
  );
  ok(row.detail?.boundary === "unknown", "…the boundary marker reads unknown here: no Graph token has been minted in this process");

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
  const saved = { appId: getSettings().teams.appId, pw: process.env.MICROSOFT_APP_PASSWORD, teamsPw: process.env.TEAMS_APP_PASSWORD };
  overrideSettingsForTest({ teams: { appId: "" } });
  delete process.env.MICROSOFT_APP_PASSWORD;
  delete process.env.TEAMS_APP_PASSWORD;
  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "teams", action: "teams.token_mint_failed" })).length;
  _resetTeamsGraphTokenCache();
  await assert.rejects(
    () => teamsReadAdapter.readChannel(engCtx, RAW_ENG, 50),
    /teams\.appId is required/u,
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
  overrideSettingsForTest({ teams: { appId: saved.appId } });
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

{
  const b64url = (s: string): string => Buffer.from(s, "utf-8").toString("base64url");
  const jwt = (payload: unknown): string => `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.ZmFrZS1zaWc`;

  ok(
    JSON.stringify(decodeJwtRoles(jwt({ aud: "https://graph.microsoft.com", roles: ["ChannelMessage.Read.All"] }))) === JSON.stringify(["ChannelMessage.Read.All"]),
    "decodeJwtRoles: reads the roles claim out of a well-formed token",
  );
  ok(
    JSON.stringify(decodeJwtRoles(jwt({ aud: "https://graph.microsoft.com" }))) === JSON.stringify([]),
    "decodeJwtRoles: a token with NO roles claim decodes to [] — a real state (no consented app permissions), not a parse failure",
  );
  ok(decodeJwtRoles("not-a-jwt") === undefined, "decodeJwtRoles: a non-JWT string is undefined (malformed), never []");
  ok(decodeJwtRoles("a.b") === undefined, "decodeJwtRoles: a two-segment token is undefined");
  ok(decodeJwtRoles("aaa..bbb") === undefined, "decodeJwtRoles: an empty payload segment is undefined");
  ok(decodeJwtRoles(`${b64url("{}")}.${b64url("{not json")}.sig`) === undefined, "decodeJwtRoles: a payload that is not JSON is undefined");
  ok(decodeJwtRoles(jwt(["an", "array"])) === undefined, "decodeJwtRoles: a payload that is not a JSON OBJECT is undefined");
  ok(decodeJwtRoles(jwt({ roles: "ChannelMessage.Read.All" })) === undefined, "decodeJwtRoles: a non-array roles claim is undefined, never coerced to a match");
  ok(
    JSON.stringify(decodeJwtRoles(jwt({ roles: ["Group.Read.All", 7, null] }))) === JSON.stringify(["Group.Read.All"]),
    "decodeJwtRoles: non-string entries are dropped from the roles array",
  );

  for (const role of TENANT_WIDE_CHANNEL_READ_ROLES) {
    ok(boundaryFromRoles([role]) === "tenant-wide", `boundaryFromRoles: "${role}" alone removes the Microsoft team boundary`);
  }
  ok(TENANT_WIDE_CHANNEL_READ_ROLES.length === 3, "the denylist holds exactly the three application permissions Microsoft documents for these two endpoints");
  ok(
    boundaryFromRoles(["ChannelMessage.Read.All", "Group.Read.All"]) === "tenant-wide",
    "boundaryFromRoles: several tenant-wide roles still read as tenant-wide",
  );
  ok(boundaryFromRoles([]) === "per-team", "boundaryFromRoles: no consented application permissions is the per-team path");
  ok(
    boundaryFromRoles(["ChannelMessage.Read.Group"]) === "per-team",
    "boundaryFromRoles: the RSC permission itself is NOT tenant-wide (and in reality never appears in the token at all)",
  );
  ok(
    boundaryFromRoles(["User.Read.All", "Group.Selected", "TeamsActivity.Send"]) === "per-team",
    "boundaryFromRoles: unrelated consented roles do not trip the denylist",
  );
  ok(boundaryFromRoles(undefined) === "unknown", "boundaryFromRoles: an undecodable token is unknown — never guessed either way");

  const TENANT_WIDE_TOKEN = jwt({ aud: "https://graph.microsoft.com", roles: ["User.Read.All", "ChannelMessage.Read.All"] });
  const PER_TEAM_TOKEN = jwt({ aud: "https://graph.microsoft.com", roles: ["User.Read.All"] });
  ok(boundaryOfGraphToken(TENANT_WIDE_TOKEN) === "tenant-wide", "boundaryOfGraphToken: a token carrying ChannelMessage.Read.All reads as tenant-wide");
  ok(boundaryOfGraphToken(PER_TEAM_TOKEN) === "per-team", "boundaryOfGraphToken: a token carrying only unrelated roles reads as per-team");
  ok(boundaryOfGraphToken("garbage") === "unknown", "boundaryOfGraphToken: a token that does not parse reads as unknown");

  const org = deploymentOrg();
  _resetTeamsReadBoundaryForTest();
  ok(teamsReadBoundary() === "unknown", "teamsReadBoundary: unknown before any Graph token is minted");

  const before = (await readAudit({ org, platform: "teams", action: "teams.read_boundary" })).length;
  await noteTeamsReadBoundary(TENANT_WIDE_TOKEN);
  ok(teamsReadBoundary() === "tenant-wide", "noteTeamsReadBoundary: holds the determination for the rest of the process");
  const afterFirst = await readAudit({ org, platform: "teams", action: "teams.read_boundary" });
  ok(afterFirst.length === before + 1, "noteTeamsReadBoundary: the FIRST determination appends exactly one durable teams.read_boundary row");
  ok(afterFirst[0]!.detail?.boundary === "tenant-wide", "…whose detail names the boundary that governs");
  ok(
    JSON.stringify(afterFirst[0]!.detail?.tenantWideRoles) === JSON.stringify(["ChannelMessage.Read.All"]),
    "…and names WHICH tenant-wide role removed the boundary",
  );
  ok(afterFirst[0]!.detail?.enforcedBy === "open-everywhere-domain-allowlist", "…and says who is left holding the fence");
  ok(!JSON.stringify(afterFirst[0]!.detail).includes(TENANT_WIDE_TOKEN.split(".")[2]), "…and carries no part of the token itself");

  await noteTeamsReadBoundary(TENANT_WIDE_TOKEN);
  const afterRepeat = await readAudit({ org, platform: "teams", action: "teams.read_boundary" });
  ok(afterRepeat.length === afterFirst.length, "noteTeamsReadBoundary: an UNCHANGED re-mint appends no row (a row that appears is real news)");

  await noteTeamsReadBoundary(PER_TEAM_TOKEN);
  ok(teamsReadBoundary() === "per-team", "noteTeamsReadBoundary: a changed determination replaces the held one");
  const afterChange = await readAudit({ org, platform: "teams", action: "teams.read_boundary" });
  ok(afterChange.length === afterRepeat.length + 1, "…and a CHANGE does append a row");
  ok(afterChange[0]!.detail?.boundary === "per-team", "…naming the new boundary");
  ok(afterChange[0]!.detail?.enforcedBy === "microsoft-rsc-per-team", "…and that Microsoft is holding the line again");

  await noteTeamsReadBoundary(TENANT_WIDE_TOKEN);
  const refusedBefore = (await readAudit({ org, platform: "teams", action: "read.refused" })).length;
  await assert.rejects(
    () => teamsReadAdapter.readChannel(engCtx, RAW_OUTSIDE, 50, async () => ({ value: [] })),
    /is not in domain "eng" teams read scope/u,
    "a cross-domain teams read still refuses",
  );
  n++;
  const refusedRows = await readAudit({ org, platform: "teams", action: "read.refused" });
  ok(refusedRows.length === refusedBefore + 1, "…appending one read.refused row");
  ok(refusedRows[0]!.detail?.boundary === "tenant-wide", "…which now records WHICH boundary governs this deployment's teams reads (OPE-428)");
  ok(refusedRows[0]!.detail?.target === sanitizeTeamsChannelId(RAW_OUTSIDE), "…without disturbing the fields the row already carried");

  _resetTeamsReadBoundaryForTest();
  const unknownBefore = (await readAudit({ org, platform: "teams", action: "read.refused" })).length;
  await assert.rejects(() => teamsReadAdapter.readChannel(engCtx, RAW_OUTSIDE, 50, async () => ({ value: [] })), /teams read scope/u, "…refusing again with nothing determined");
  n++;
  const unknownRows = await readAudit({ org, platform: "teams", action: "read.refused" });
  ok(unknownRows.length === unknownBefore + 1, "…appending one more row");
  ok(
    unknownRows[0]!.detail?.boundary === "unknown",
    "…marked unknown when no Graph token has been minted in this process — the fence never makes a network call to find out",
  );

  const perTeamCheck = boundaryCheck("per-team");
  ok(perTeamCheck.status === "ok", "preflight: the per-team path is the OK posture — Microsoft itself holds the line");
  ok(perTeamCheck.fix === undefined, "…and needs no remediation");
  const wideCheck = boundaryCheck("tenant-wide");
  ok(wideCheck.status === "info", "preflight: the tenant-wide path reports as info — a documented, supported configuration");
  ok(wideCheck.status !== "missing", "…and NEVER as missing, which would make `ready` false and block an informed operator");
  ok(wideCheck.detail.includes("TENANT-WIDE") && wideCheck.detail.includes("ONLY fence"), "…while saying plainly what the operator gave up");
  ok(typeof wideCheck.fix === "string" && wideCheck.fix.includes("ChannelMessage.Read.Group"), "…and how to get the boundary back");
  ok(boundaryCheck("unknown").status === "info", "preflight: an undetermined boundary reports as info, never as a claim either way");

  const savedProbeAppId = getSettings().teams.appId;
  overrideSettingsForTest({ teams: { appId: "" } });
  ok((await teamsBoundaryProbe({})).length === 0, "preflight probe: no Teams app credentials ⇒ no checks at all");
  ok(
    (await teamsBoundaryProbe({ MICROSOFT_APP_ID: "id", MICROSOFT_APP_PASSWORD: "pw" })).length === 0,
    "🔴 OPE-2650: preflight probe: env MICROSOFT_APP_ID with the teams.appId setting unset ⇒ no checks (env ignored)",
  );
  overrideSettingsForTest({ teams: { appId: "id" } });
  ok(
    (await teamsBoundaryProbe({ MICROSOFT_APP_PASSWORD: "pw" })).length === 1,
    "preflight probe: credentials without a tenant id ⇒ one check, no network call",
  );
  const noTenant = (await teamsBoundaryProbe({ MICROSOFT_APP_PASSWORD: "pw" }))[0]!;
  ok(noTenant.status === "info" && noTenant.detail.includes("tenant-scoped"), "…explaining that Graph's client-credential token is tenant-scoped");
  overrideSettingsForTest({ teams: { appId: savedProbeAppId } });
}

{
  const page = teamsLinesFromRaw([
    {
      id: "1",
      createdDateTime: "2026-08-14T10:00:00Z",
      from: { user: { id: "29:aad-alice", displayName: "Alice" } },
      body: { contentType: "html", content: "<p>morning</p>" },
    },
    {
      id: "2",
      createdDateTime: "2026-08-14T10:01:00Z",
      from: { user: { id: "29:aad-guest", displayName: "Guest" } },
      body: { contentType: "html", content: "<p>hello</p>" },
    },
    {
      id: "3",
      createdDateTime: "2026-08-14T10:02:00Z",
      from: { application: { id: "app-1", displayName: "Pipeline" } },
      body: { contentType: "html", content: "<p>build green</p>" },
    },
  ]);
  ok(
    JSON.stringify(page.map((l) => [l.author, l.authorId, l.bot === true])) ===
      JSON.stringify([["Alice", "29:aad-alice", false], ["Guest", "29:aad-guest", false], ["Pipeline", undefined, true]]),
    "grading fields: `author` stays the DISPLAY NAME the model reads, while `authorId` carries the Entra id the probe needs; an application author is marked a machine",
  );

  _resetAuthorTrustForTest();
  ok((await teamsReadAdapter.refutedAuthorIds(engCtx, page)).length === 0, "🔴 unarmed tenant: a Teams read marks NOTHING (=== []) — the stated limit of the register-only leg");

  registerAuthorTrust([defineAuthorTrust({ tenant: "teams/TENANT1", internal: ["teams/29:aad-alice"] })]);
  ok((await teamsReadAdapter.refutedAuthorIds(engCtx, page)).length > 0, "🔴 armed tenant: the UNLISTED author is refuted and the read MARKS");

  const memberOnly = page.filter((l) => l.authorId !== "29:aad-guest");
  ok((await teamsReadAdapter.refutedAuthorIds(engCtx, memberOnly)).length === 0, "🔴 negative control: an armed tenant whose page holds only DECLARED authors does not mark (=== [])");

  ok(
    (await teamsReadAdapter.refutedAuthorIds(engCtx, page.filter((l) => l.bot === true))).length === 0,
    "🔴 negative control: an APPLICATION author is not a person outside the org (=== [])",
  );
  _resetAuthorTrustForTest();
}

await removeTempDir(tmp);
console.log(`✓ ${n} teams-read assertions passed`);
