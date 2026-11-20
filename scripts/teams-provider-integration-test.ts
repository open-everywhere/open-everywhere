import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerTeamsProvider, resolveTeamsTarget } from "@open-everywhere/provider-teams/agent/register.js";
import { TEAMS_APP_NAME_MAX, TEAMS_DEFAULT_APP_NAME, TEAMS_DEPLOY_HOST_PLACEHOLDER, teamsAppManifestTemplate } from "@open-everywhere/provider-teams/agent/app-manifest.js";
import { DEPLOY_HOST_PLACEHOLDER, surfaceAppManifest, surfaceAppManifestSurfaces, surfaceAppNameProblem } from "@open-everywhere/core/agent/ops/surface-manifest.js";
import { PRIVACY_PAGE_PATH, TERMS_PAGE_PATH } from "@open-everywhere/core/agent/pages/policy-pages.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { teamsReadAdapter } from "@open-everywhere/provider-teams/agent/channels/teams-read.js";
import {
  capabilitiesForPlatform,
  readAudit,
  bindFrom,
  resolvePartition,
  READ_ADAPTERS,
  resolveReadAdapter,
  type BindableContext,
  type Routine,
} from "@open-everywhere/core/agent/adapter-api.js";
import { _dynamicResolverForTest } from "@open-everywhere/core/agent/access/window-gated.js";
// eve 1.x's channel wrapper reads the session view from the adapter context, or else from a live
// projection. A direct call carries an empty view.
const v27Completed = (adapter: object) => async (event: unknown, ctx: unknown): Promise<void> => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = createRequire(import.meta.url).resolve("eve/package.json").replace(/package\.json$/u, "");
  const fold = (await import(pathToFileURL(`${eveRoot}dist/src/protocol/session-projection/fold.js`).href)) as { emptySessionView: () => unknown };
  const handler = (adapter as Record<string, (e: unknown, c: unknown) => Promise<unknown>>)["content.completed"]!;
  await handler(event, { ...(ctx as object), view: fold.emptySessionView() });
};
// eve 1.x delivers a final message as `content.completed` (a text part in the "reply" phase).
const asV27Content = (f: { readonly finishReason: string; readonly message: string | null; readonly turnId?: string }) => ({
  type: "content.completed" as const,
  ...(f.turnId !== undefined ? { scope: { turnId: f.turnId } } : {}),
  data: { partId: "part-1", kind: "text", phase: f.finishReason === "stop" ? "reply" : "narration", value: f.message ?? "" },
});


const dir = join(tmpdir(), `open-everywhere-teams-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
overrideSettingsForTest({ teams: { appId: "teams-app-id" } });
process.env.MICROSOFT_APP_PASSWORD = "teams-app-secret";

registerTeamsProvider();
registerSlackProvider();

const reply = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TEAMS_SERVICE_URL = "https://smba.trafficmanager.net/uk/";
interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let teamsResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "" } };
const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.includes("login.microsoftonline.com")) return resp(200, { token_type: "Bearer", expires_in: 3600, access_token: "teams-connector-token" });
    if (u.includes("smba.trafficmanager.net")) return resp(teamsResponse.status, teamsResponse.body);
    return resp(500, { error: "unexpected host" });
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

function teamsCtx(conversationId: string | undefined, serviceUrl: string | null = TEAMS_SERVICE_URL) {
  const svc = serviceUrl === null ? undefined : serviceUrl;
  return {
    channel: { kind: "teams" },
    session: {
      auth: {
        current: {
          attributes: {
            tenant_id: "TEN1",
            ...(conversationId ? { conversation_id: conversationId } : {}),
            ...(svc ? { service_url: svc } : {}),
            scope: "channel",
          },
          principalId: "U5",
          principalType: "teams-user",
        },
      },
    },
  };
}

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ArmedTool {
  readonly description: string;
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}
const armReply = (tool: unknown, ctx: unknown): ArmedTool | null =>
  _dynamicResolverForTest(tool)({}, ctx) as ArmedTool | null;

assert.deepStrictEqual(
  capabilitiesForPlatform("teams"),
  { midTurnPost: true, reactions: false, closingProseDropped: true },
  "registerTeamsProvider registers teams' manifest (midTurnPost wired via sendTeamsActivity, no reactions, and OPE-2006's closing-prose drop)",
);
n++;

const teamsArmed = armReply(reply, { channel: { kind: "teams" } });
ok(teamsArmed !== null, "reply arms on a Teams session (mid-turn post via sendTeamsActivity)");
const slackArmed = armReply(reply, { channel: { kind: "slack" } });
ok(slackArmed !== null && slackArmed.description === teamsArmed!.description, "reply: ONE description on teams + slack (no per-surface variant)");

{
  const target = resolveReplyTarget(teamsCtx("conv-1") as never);
  ok(
    target?.platform === "teams" && (target as { conversationId: string }).conversationId === "conv-1" && (target as { serviceUrl: string }).serviceUrl === TEAMS_SERVICE_URL,
    "resolveReplyTarget: teams carries the serviceUrl + conversation id (the captured reference)",
  );
  ok(resolveReplyTarget(teamsCtx("conv-1", null) as never) === null, "resolveReplyTarget: a teams ctx with no serviceUrl → null (can't cold-address)");
  ok(resolveReplyTarget(teamsCtx(undefined) as never) === null, "resolveReplyTarget: a conversation-less teams ctx → null");
}

calls = [];
teamsResponse = { status: 200, body: { id: "teams-activity-1" } };
fakeHttp();
try {
await inSession(async () => {
  const armed = armReply(reply, teamsCtx("conv-1"))!;
  const res = await armed.execute({ text: "teams answer" }, teamsCtx("conv-1"));
  ok(res.posted === true && res.id === "teams-activity-1", "reply: on Teams returns the sent activity id");
  const activityCall = calls.find((c) => c.url.includes("smba.trafficmanager.net") && c.url.includes("/v3/conversations/") && c.url.includes("/activities"));
  ok(activityCall !== undefined && activityCall.method === "POST", "reply: on Teams POSTs a message activity to the captured conversation reference");
  ok(activityCall!.url.includes("conv-1"), "reply: on Teams posts into the SAME conversation it was woken on");
  const payload = JSON.parse(activityCall!.body) as { type?: string; text?: string };
  ok(payload.type === "message" && payload.text === "teams answer", "reply: on Teams sends a message activity carrying the model text");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "teams" && r.detail?.id === "teams-activity-1"), "reply: audits a reply.post row stamped platform=teams");

  const before = calls.length;
  let refusal = "";
  try {
    const evil = armReply(reply, teamsCtx("conv-evil", "https://evil.example/api"))!;
    await evil.execute({ text: "leak me" }, teamsCtx("conv-evil", "https://evil.example/api"));
  } catch (e) {
    refusal = String((e as Error).message);
  }
  ok(refusal.includes("not a Bot Framework host"), "reply/T4: an un-allowlisted serviceUrl is REFUSED before the Connector token is minted");
  ok(!refusal.includes("evil.example"), "reply/T4: …with a host-free error (never echo the attacker-supplied endpoint)");
  ok(calls.length === before, "reply/T4: …and NOTHING was sent — not even the token mint (the check runs before the transport)");
});
} finally {
  restoreHttp();
}

{
  __setTestValveForTest("egress-spoof", true);
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));
  const inChatSession = <T>(fn: () => Promise<T>): Promise<T> => {
    const c = new ContextContainer();
    c.set(SessionKey, { sessionId: "teams-integration-chat-audit", auth: null, turn: 1, parent: undefined });
    return contextStorage.run(c, fn);
  };
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/adapter-api.js");
  const teamsChannel = (await import("@open-everywhere/provider-teams/agent/channels/teams.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };
  const completed = (message: string | null, ctx: unknown) => inChatSession(() => v27Completed(teamsChannel.adapter)(asV27Content({ finishReason: "stop", message }), ctx));
  const auditCtx = {
    state: { conversationId: "19:conv1", tenantId: "TEN1", channelId: "19:chan1", teamId: "TEAM1", conversationType: "channel", serviceUrl: "https://smba.trafficmanager.net", replyToActivityId: "act-root-1" },
    thread: { post: async () => undefined },
  };
  const teamsReplyPosts = async (): Promise<Array<{ detail?: Record<string, unknown> }>> =>
    (await readAudit({ org: "default", action: "reply.post" })).filter((r) => r.platform === "teams");
  const before = (await teamsReplyPosts()).length;
  await completed(NO_REPLY_SENTINEL, auditCtx);
  ok((await readAudit({ org: "default", action: "teams.no_reply" })).length === 0, "chat-audit: a teams judged silence writes NO teams.no_reply row (actions-only)");
  await completed("done — deployed", auditCtx);
  ok((await teamsReplyPosts()).length === before, "🔴 OPE-2006: a teams turn that ends in prose writes NO reply.post row — nothing left the host, so nothing may be counted as delivered");
  const dropped = (await readAudit({ org: "default", action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "teams");
  ok(
    dropped.length === 1 && dropped[0]!.detail?.chars === "done — deployed".length && dropped[0]!.detail?.conversationId === "19:conv1",
    "🔴 OPE-2006: …and ONE drop row records it, with the char count and the conversation the answer was owed to",
  );
  ok((await readAudit({ org: "default", action: "teams.replied" })).length === 0, "chat-audit: the legacy teams.replied row is GONE");
  __setTestValveForTest("egress-spoof", false);
}

{
  ok(READ_ADAPTERS["teams"] === teamsReadAdapter, "read: registerTeamsProvider wires the Microsoft Graph read adapter into the registry");
  const uniTeams = ({ channel: { kind: "unified" }, session: { auth: { current: { attributes: { oe_platform: "teams", oe_sources: "teams" }, principalId: "U1", principalType: "teams-user" } } } }) as unknown as BindableContext;
  const resolved = resolveReadAdapter(uniTeams, undefined, []);
  ok(resolved.platform === "teams" && resolved.adapter === teamsReadAdapter, "read: resolveReadAdapter routes a teams-origin turn to the Teams adapter (registered)");
}

function seedRoutine(id: string, surfaceKey: string, target: Record<string, unknown>): Routine {
  return {
    org: "default",
    id,
    surfaceKey,
    target,
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: `routine ${id}`,
    createdAt: new Date().toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: new Date().toISOString(),
  } as unknown as Routine;
}
{
  const chTarget = resolveTeamsTarget(
    seedRoutine("r-teams-ch", "teams/TEN1/19-eng-thread.tacv2", {
      serviceUrl: "https://smba.trafficmanager.net/uk/",
      conversationId: "19:eng@thread.tacv2",
      tenantId: "TEN1",
      channelId: "19:eng@thread.tacv2",
      teamId: "19:team@thread.tacv2",
      conversationType: "channel",
    }),
  );
  ok(chTarget !== null, "routine: a teams routine with a stored conversation reference resolves a DispatchTarget");
  const t = chTarget!.target as Record<string, unknown>;
  ok(
    t["serviceUrl"] === "https://smba.trafficmanager.net/uk/" && t["conversationId"] === "19:eng@thread.tacv2" && t["conversationType"] === "channel" && t["tenantId"] === "TEN1",
    "routine: teams receive target carries the full conversation reference (serviceUrl/conversationId/scope/tenant)",
  );
  ok(
    chTarget!.attributes["conversation_id"] === "19:eng@thread.tacv2" && chTarget!.attributes["service_url"] === "https://smba.trafficmanager.net/uk/" && chTarget!.attributes["tenant_id"] === "TEN1" && chTarget!.attributes["scope"] === "channel",
    "routine: teams fire stamps conversation/service/tenant/scope for bindTeams",
  );
  ok(chTarget!.attributes["membership_type"] === undefined, "routine: NO membership_type is invented at fire time (trust fails closed to external)");
  const chBinding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: { attributes: chTarget!.attributes } as never } } });
  ok(chBinding.workspace === "TEN1" && chBinding.surface === "19-eng-thread.tacv2", "routine: bindFrom re-derives the routine's REAL tenant/conversation partition (sanitized surface matches the surfaceKey)");
  ok(chBinding.mode === "channel" && chBinding.trust === "external", "routine: an unverified channel fire binds channel/external (fail-closed)");
  ok(
    resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: { attributes: chTarget!.attributes } as never } } }).surfaceKey === "teams/TEN1/19-eng-thread.tacv2",
    "routine: spend/usage attribution lands on the routine's real surfaceKey",
  );

  const dmTarget = resolveTeamsTarget(seedRoutine("r-teams-dm", "teams/TEN1/a-1user", { serviceUrl: "https://smba.trafficmanager.net/uk/", conversationId: "a:1user", conversationType: "personal" }));
  ok(dmTarget !== null, "routine: a teams personal-chat routine resolves a DispatchTarget");
  const dmBinding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: { attributes: dmTarget!.attributes } as never } } });
  ok(dmBinding.mode === "dm", "routine: a personal-chat fire binds dm mode (stored scope honoured)");

  ok(resolveTeamsTarget(seedRoutine("r-teams-noref", "teams/TEN1/19-x", { conversationId: "19:x@thread.tacv2" })) === null, "routine: a teams routine with no serviceUrl resolves null (dry-run, fail-closed)");

  const { planFireWork } = await import("@open-everywhere/core/agent/routines/fire-work.js");
  const { classifySessionId } = await import("@open-everywhere/core/agent/channels/window-key.js");
  const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
  const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
  overrideSettingsForTest({ window: { topology: true } });

  ok(chTarget!.origin !== undefined, "OPE-486/teams: the DispatchTarget now carries an origin — pre-fix this field was always undefined");
  ok(
    chTarget!.origin?.platform === "teams" &&
      (chTarget!.origin as { serviceUrl: string }).serviceUrl === "https://smba.trafficmanager.net/uk/" &&
      (chTarget!.origin as { conversationId: string }).conversationId === "19:eng@thread.tacv2" &&
      (chTarget!.origin as { tenantId?: string }).tenantId === "TEN1",
    "OPE-486/teams: the origin names the routine's real conversation reference",
  );

  const windowedDomain = defineDomain({ name: "teams-win", reach: ["teams/TEN1/19-eng-thread.tacv2"], ambientSupervisor: true, mode: "unified" });
  const teamsPlan = planFireWork({ surfaceKey: "teams/TEN1/19-eng-thread.tacv2", origin: chTarget!.origin!, domains: [windowedDomain], seatRowToken: undefined, armed: true });
  ok(teamsPlan !== null, "OPE-486/teams: a channel fire's origin is enough to take the divert path — pre-fix it never was");
  ok(classifySessionId(teamsPlan!.workToken).kind === "work", "OPE-486/teams: the fire is forwarded to the domain's WORK SESSION, same shape a Slack fire takes (OPE-2342; the thread-seat fire is retired, OPE-2350)");

  const noOriginPlan = planFireWork({ surfaceKey: "teams/TEN1/19-eng-thread.tacv2", origin: undefined as never, domains: [windowedDomain], seatRowToken: undefined, armed: true });
  ok(noOriginPlan === null, "OPE-486/teams NEGATIVE CONTROL: with no origin (the pre-fix state) the divert never applies, even on an otherwise-windowed surface");
  overrideSettingsForTest({ window: { topology: false } });
}

{
  const manifest = JSON.parse(teamsAppManifestTemplate()) as {
    version: string;
    bots: { scopes: string[] }[];
    webApplicationInfo?: unknown;
    authorization?: { permissions?: { resourceSpecific?: { name: string; type: string }[] } };
  };
  const rsc = manifest.authorization?.permissions?.resourceSpecific ?? [];
  const named = (name: string) => rsc.find((p) => p.name === name);

  ok(named("ChannelMessage.Read.Group")?.type === "Application", "manifest: the CHANNEL RSC grant is declared (Application context) — ambient team-channel delivery");
  ok(named("ChatMessage.Read.Chat")?.type === "Application", "manifest: the CHAT RSC grant is declared (Application context) — non-mention group-chat delivery");
  ok(named("ChannelMember.Read.Group")?.type === "Application", "manifest: the CHANNEL-MEMBER RSC grant is declared (Application context) — routine fire-eligibility room checks");
  ok(manifest.webApplicationInfo !== undefined, "manifest: authorization is paired with webApplicationInfo (its absence fails the upload)");
  ok(manifest.bots.some((b) => b.scopes.includes("groupChat")), "manifest: the bot is installable in groupChat scope (what the chat RSC grant applies to)");
  ok(manifest.version !== "1.0.1", "manifest: version was bumped past 1.0.1 — RSC consent is install-time only, so an unbumped package can't re-consent");
  ok(manifest.version !== "1.0.2", "manifest: version was bumped past 1.0.2 — the ChannelMember.Read.Group grant needs its own install-time re-consent");
}

{
  type TeamsManifest = {
    developer: { privacyUrl: string; termsOfUseUrl: string; websiteUrl: string };
    name: { short: string; full: string };
    description: { full: string };
    validDomains: string[];
  };
  const tracked = execFileSync("git", ["ls-files", "--", "teams-app/manifest.json"], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
  }).trim();
  ok(tracked === "", "the static teams-app/manifest.json is no longer tracked — one rendered definition, no second copy to drift");

  ok(TEAMS_DEPLOY_HOST_PLACEHOLDER === DEPLOY_HOST_PLACEHOLDER, "the Teams bundle's host placeholder is the one core substitutes");
  const unnamed = JSON.parse(teamsAppManifestTemplate()) as TeamsManifest;
  ok(unnamed.developer.privacyUrl.endsWith(PRIVACY_PAGE_PATH), `manifest: privacyUrl ends at the mounted path (got "${unnamed.developer.privacyUrl}")`);
  ok(unnamed.developer.termsOfUseUrl.endsWith(TERMS_PAGE_PATH), `manifest: termsOfUseUrl ends at the mounted path (got "${unnamed.developer.termsOfUseUrl}")`);
  ok(!unnamed.description.full.includes("on your behalf"), "manifest: the description does not claim it acts on your behalf");
  ok(unnamed.description.full.includes("one bot identity shared by this deployment"), "manifest: the description says what the shared bot credential is");
  ok(unnamed.name.short === TEAMS_DEFAULT_APP_NAME, "manifest: with no name configured the app carries the default name");

  ok(surfaceAppManifestSurfaces().includes("teams"), "🔴 registerTeamsOps() registers a Teams app manifest — surface_manifest serves Teams");
  const served = surfaceAppManifest("teams", { host: "my-agent.example.com" });
  const servedJson = JSON.parse(String(served?.manifest)) as TeamsManifest;
  ok(servedJson.validDomains[0] === "my-agent.example.com" && servedJson.developer.websiteUrl === "https://my-agent.example.com", "the served Teams manifest carries the substituted host");
  ok(served?.placeholdersRemaining === 0, "…and no host placeholder is left");

  overrideSettingsForTest({ identity: { name: "Aria" } });
  try {
    const named = JSON.parse(String(surfaceAppManifest("teams")?.manifest)) as TeamsManifest;
    ok(named.name.short === "Aria", "🔴 the served Teams manifest's name.short is the configured identity.name");
    ok(named.name.full.startsWith("Aria"), "…and name.full");
    ok(named.description.full.startsWith("Aria runs as a Microsoft Teams bot"), "…and description.full");
    ok(!JSON.stringify(named).includes("Open Everywhere"), "🔴 a named deployment's Teams manifest carries no brand at all");
    const explicit = JSON.parse(String(surfaceAppManifest("teams", { appName: "Acme Agent" })?.manifest)) as TeamsManifest;
    ok(explicit.name.short === "Acme Agent", "an explicit appName still OVERRIDES the configured name");
    ok(surfaceAppNameProblem("teams", "x".repeat(TEAMS_APP_NAME_MAX + 1)) !== undefined, `an explicit name over Teams' ${TEAMS_APP_NAME_MAX}-character limit is refused`);
    overrideSettingsForTest({ identity: { name: "An Extremely Long Configured Agent Name" } });
    const long = JSON.parse(String(surfaceAppManifest("teams")?.manifest)) as TeamsManifest;
    ok(long.name.short.length <= TEAMS_APP_NAME_MAX, "a long configured name is cut to Teams' limit rather than failing the upload");
  } finally {
    overrideSettingsForTest({ identity: { name: "" } });
  }
}

{
  const { teamsSingleWindowPrivacyOk } = await import("@open-everywhere/provider-teams/agent/channels/teams-supervisor.js");
  const vouchedFacts = { tenantId: "TEN1", vouched: true } as const;
  ok(teamsSingleWindowPrivacyOk({ ...vouchedFacts, scope: "channel" }), "window floor: a vouched team CHANNEL is admitted");
  ok(!teamsSingleWindowPrivacyOk({ ...vouchedFacts, scope: "groupChat" }), "window floor: a group chat is refused EVEN WHEN VOUCHED (a per-person surface is not an org container)");
  ok(!teamsSingleWindowPrivacyOk({ ...vouchedFacts, scope: "personal" }), "window floor: a personal chat is refused even when vouched");
}

{
  const { teamsOnMessage } = await import("@open-everywhere/provider-teams/agent/channels/teams.js");
  const { buildTeamsAuth } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");
  const { recordSpend } = await import("@open-everywhere/core/agent/spend/store.js");
  const { periodOf } = await import("@open-everywhere/core/agent/spend/spend.js");
  const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");

  const auth = (conversationId: string, tenantId: string) =>
    buildTeamsAuth({ userId: "cap-user", userName: "Cap User", tenantId, conversationId, teamId: "team-cap", serviceUrl: TEAMS_SERVICE_URL, scope: "channel" });
  const bindableOf = (a: ReturnType<typeof buildTeamsAuth>) => ({ channel: { kind: "teams" as const }, session: { auth: { current: a } } });
  const msg = (conversationId: string, tenantId: string): unknown => ({
    scope: "channel",
    isBotMentioned: true,
    from: { id: "cap-user", name: "Cap User" },
    recipient: { id: "28:cap-bot" },
    tenantId,
    conversation: { id: conversationId, tenantId },
    teamsChannelId: conversationId,
    teamId: "team-cap",
    serviceUrl: TEAMS_SERVICE_URL,
    channelData: {},
    text: "@bot hi",
  });
  const drive = async (conversationId: string, tenantId: string) => {
    const posted: string[] = [];
    const ctx = { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async (t: string) => { posted.push(t); return { id: "p" }; } }, isSubscribed: async () => false };
    const res = await teamsOnMessage(ctx as never, msg(conversationId, tenantId) as never);
    return { res, posted };
  };

  const overAuth = auth("19:cap@thread.tacv2", "TENCAP");
  const overPart = resolvePartition(bindableOf(overAuth));
  const okAuth = auth("19:ok@thread.tacv2", "TENOK");
  const okPart = resolvePartition(bindableOf(okAuth));
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
    loadSpendBudgets: () => ({ perSurface: { [overPart.surfaceKey]: { surfaceMonthlyTokens: 1 } } }),
  });
  await recordSpend(overPart as never, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 100, outputTokens: 100 } });

  const over = await drive("19:cap@thread.tacv2", "TENCAP");
  ok(over.res === null, "spend-gate: an over-budget teams mention DECLINES the turn (returns null, no model turn)");
  ok(over.posted.length === 1 && over.posted[0]!.includes(overPart.surfaceKey), "spend-gate: the decline posts a VISIBLE refusal naming the surface scope key");
  const gateRows = (await readAudit({ org: overPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === overPart.surfaceKey);
  ok(gateRows.length === 1 && gateRows[0]!.detail?.door === "mention" && gateRows[0]!.detail?.over === true, "spend-gate: an over-budget teams mention writes ONE spend.gate audit row (door=mention, over=true)");

  const under = await drive("19:ok@thread.tacv2", "TENOK");
  ok(under.res !== null && (under.res as { auth?: unknown }).auth !== undefined, "spend-gate: an under-budget teams mention DISPATCHES (returns {auth})");
  ok(under.posted.length === 0, "spend-gate: an under-budget teams mention posts NO refusal");
  ok((await readAudit({ org: okPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === okPart.surfaceKey).length === 0, "spend-gate: an under-budget teams mention writes NO spend.gate row");

  const live = provider.getOperationalStore();
  const broken = { ...live, spendTotals: async () => { throw new Error("store down"); } } as typeof live;
  provider.registerOperationalStore(broken);
  provider.resetOperationalStore();
  const failOpen = await drive("19:cap@thread.tacv2", "TENCAP");
  ok(failOpen.res !== null && (failOpen.res as { auth?: unknown }).auth !== undefined, "spend-gate: a THROWN budget check fails OPEN (over-budget scope still dispatches)");
  provider.registerOperationalStore(live);
  provider.resetOperationalStore();
}

{
  const { teamsOnMessage } = await import("@open-everywhere/provider-teams/agent/channels/teams.js");
  const { buildTeamsAuth } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");

  const CONV = "19:engaged@thread.tacv2";
  const TENANT = "TENENG";
  const seamAuth = buildTeamsAuth({ userId: "seam-user", tenantId: TENANT, conversationId: CONV, teamId: "team-seam", serviceUrl: TEAMS_SERVICE_URL, scope: "channel" });
  const seamPart = resolvePartition({ channel: { kind: "teams" as const }, session: { auth: { current: seamAuth } } });
  const plain = (): unknown => ({
    scope: "channel",
    isBotMentioned: false,
    from: { id: "seam-user", name: "Seam User" },
    recipient: { id: "28:seam-bot" },
    tenantId: TENANT,
    conversation: { id: CONV, tenantId: TENANT },
    teamsChannelId: CONV,
    teamId: "team-seam",
    serviceUrl: TEAMS_SERVICE_URL,
    channelData: {},
    text: "and what about the second item?",
  });
  const driveSeam = async () => {
    const ctx = { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async () => ({ id: "p" }) }, isSubscribed: async () => false };
    return await teamsOnMessage(ctx as never, plain() as never);
  };

  const store = getOperationalStore();
  ok((await driveSeam()) === null, "engaged seam: a plain non-mention channel message in an UN-engaged conversation is DROPPED — the mention gate's old behaviour, unchanged");

  await store.markEngaged(seamPart.org, seamPart.surfaceKey, CONV, new Date().toISOString(), { participating: true });
  const admitted = await teamsOnMessage(
    { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async () => ({ id: "p" }) }, isSubscribed: async () => false } as never,
    plain() as never,
  );
  ok(admitted !== null && (admitted as { auth?: unknown }).auth !== undefined, "🔴 engaged seam: once the conversation is ENGAGED the SAME plain message is ADMITTED and runs a turn — the native gate really does ask the seam");

  ok((await store.markStopped(seamPart.org, seamPart.surfaceKey, CONV)) === true, "engaged seam: markStopped flags the existing row (this is what stand_down does on Teams)");
  ok((await driveSeam()) === null, "🔴 engaged seam: a stood-down conversation drops the same plain message again — the stop takes effect on the native path");

  const reMention = await teamsOnMessage(
    { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async () => ({ id: "p" }) }, isSubscribed: async () => false } as never,
    { ...(plain() as Record<string, unknown>), isBotMentioned: true } as never,
  );
  ok(reMention !== null, "⭐ NEGATIVE CONTROL: an @mention in the SAME stood-down conversation still passes — the way back in is never closed");
}

{
  const { teamsOnMessage } = await import("@open-everywhere/provider-teams/agent/channels/teams.js");
  const { bindTeams } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");
  const { _resetTeamsUserTypeCacheForTest } = await import("@open-everywhere/provider-teams/agent/channels/teams-roster.js");
  const saved = { ms: process.env.MICROSOFT_TENANT_ID, teams: process.env.TEAMS_TENANT_ID };
  const dm = (n: number, serviceUrl = TEAMS_SERVICE_URL): unknown => ({
    scope: "personal",
    conversationType: "personal",
    isBotMentioned: false,
    from: { id: "29:dm-partner", name: "Dee" },
    recipient: { id: "28:dm-bot" },
    tenantId: "TEN-DM-HOME",
    conversation: { id: `a:native-dm-${n}`, conversationType: "personal", tenantId: "TEN-DM-HOME" },
    serviceUrl,
    channelData: {},
    text: "hi",
  });
  let rosterCalls = 0;
  const drive = async (n: number, serviceUrl = TEAMS_SERVICE_URL) => {
    _resetTeamsUserTypeCacheForTest();
    const request = async () => {
      rosterCalls++;
      return { ok: true, status: 200, body: { userRole: "user" } };
    };
    const ctx = { teams: { serviceUrl, request }, thread: { post: async () => ({ id: "p" }) }, isSubscribed: async () => false };
    const res = (await teamsOnMessage(ctx as never, dm(n, serviceUrl) as never)) as { auth?: { attributes?: Record<string, string> } } | null;
    return res?.auth;
  };
  const verified = (auth: unknown) => bindTeams({ channel: { kind: "teams" }, session: { auth: { current: auth } } } as never).trustVerified;
  try {
    delete process.env.TEAMS_TENANT_ID;
    process.env.MICROSOFT_TENANT_ID = "ten-dm-home";
    const home = await drive(1);
    ok(home?.attributes?.["user_type"] === "member" && home.attributes["tenant_home"] === "true", "🔴 native DM: a roster member in the HOME tenant gets the tenant_home stamp (OPE-2446)");
    ok(verified(home) === true, "🔴 native DM: …and bindTeams verifies that DM partner");
    process.env.MICROSOFT_TENANT_ID = "TEN-SOMEONE-ELSE";
    const foreign = await drive(2);
    ok(foreign?.attributes?.["user_type"] === "member" && foreign.attributes["tenant_home"] === undefined, "native DM negative control: a member under ANOTHER home tenant gets no tenant_home stamp");
    ok(verified(foreign) === false, "native DM negative control: …and the partner stays unverified");
    process.env.MICROSOFT_TENANT_ID = "ten-dm-home";
    const before = rosterCalls;
    const hostile = await drive(3, "https://attacker.example/");
    ok(hostile !== undefined && rosterCalls === before, "🔴 native DM: an UNTRUSTED serviceUrl host is never asked (no roster call, so no token leaves)");
    ok(hostile?.attributes?.["user_type"] === undefined && hostile?.attributes?.["tenant_home"] === undefined, "🔴 native DM: …so no user_type and no tenant_home stamp");
    ok(verified(hostile) === false, "🔴 native DM: …and the partner stays unverified");
  } finally {
    if (saved.ms === undefined) delete process.env.MICROSOFT_TENANT_ID;
    else process.env.MICROSOFT_TENANT_ID = saved.ms;
    if (saved.teams !== undefined) process.env.TEAMS_TENANT_ID = saved.teams;
  }
}

{
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  const { roomEngagementAddress, readStandDownAck } = await import("@open-everywhere/core/agent/channels/engagement.js");
  const { markTeamsRoomWatched } = await import("@open-everywhere/provider-teams/agent/channels/teams-engagement.js");
  const standDown = (await import("@open-everywhere/core/agent/tools/stand_down.js")).default as unknown as {
    readonly execute: (input: { reason?: string }, ctx: unknown) => Promise<{ standingDown: boolean; note: string }>;
  };
  const store = getOperationalStore();
  const roomCtx = (channelId: string, conversationId: string, sessionId: string, turnId: string) => {
    const base = teamsCtx(conversationId);
    const attrs = { ...base.session.auth.current.attributes, tenant_id: "TEN-ROOM", channel_id: channelId };
    return { ...base, session: { id: sessionId, turn: { id: turnId }, auth: { current: { ...base.session.auth.current, attributes: attrs } } } };
  };
  const STOPPED_ROOM = "19:room-stopped@thread.tacv2";
  const OPEN_ROOM = "19:room-open@thread.tacv2";
  const stopperCtx = roomCtx(STOPPED_ROOM, `${STOPPED_ROOM};messageid=1`, "room-stop-session", "turn_room_stop");
  const workerCtx = roomCtx(STOPPED_ROOM, `${STOPPED_ROOM};messageid=2`, "room-worker-session", "turn_room_worker");
  const controlCtx = roomCtx(OPEN_ROOM, `${OPEN_ROOM};messageid=1`, "room-worker-session", "turn_room_control");
  ok(bindFrom(workerCtx as never).roomEngagementKey === STOPPED_ROOM, "OPE-2806 precondition: the Teams binding publishes the channel as its room-grain anchor");

  const stoppedPart = resolvePartition(stopperCtx as never);
  const stoppedRoom = roomEngagementAddress(stoppedPart);
  const openRoom = roomEngagementAddress(resolvePartition(controlCtx as never));
  await markTeamsRoomWatched(stoppedPart, "2026-01-01T00:00:00Z");
  await markTeamsRoomWatched(resolvePartition(controlCtx as never), "2026-01-01T00:00:00Z");

  const res = await inSession(() => standDown.execute({ reason: "asked me to stop" }, stopperCtx));
  ok(res.standingDown === true && res.note.includes("anywhere in this room"), "OPE-2806 precondition: the conversation grain holds no row, so stand_down stops the ROOM");
  ok((await store.getEngagement(stoppedPart.org, stoppedPart.surfaceKey, `${STOPPED_ROOM};messageid=1`)) === null, "OPE-2806 precondition: …and the reply chain holds no stop of its own");
  ok((await store.getEngagement(stoppedRoom.partition.org, stoppedRoom.partition.surfaceKey, stoppedRoom.anchor))?.stopped === true, "OPE-2806 precondition: …the stop lives on the room row");
  ok((await store.getEngagement(openRoom.partition.org, openRoom.partition.surfaceKey, openRoom.anchor))?.stopped === false, "OPE-2806 precondition: the control room is watched and NOT stopped");

  calls = [];
  teamsResponse = { status: 200, body: { id: "teams-room-activity" } };
  fakeHttp();
  const activities = () => calls.filter((c) => c.url.includes("/v3/conversations/") && c.url.includes("/activities")).length;
  const attempt = async (ctx: unknown, text: string): Promise<{ posted?: unknown; error?: string }> =>
    inSession(async () => {
      try {
        return await armReply(reply, ctx)!.execute({ text }, ctx);
      } catch (e) {
        return { error: String((e as Error).message) };
      }
    });
  try {
    const worker = await attempt(workerCtx, "the worker's finding");
    ok(typeof worker.error === "string" && /stand down/i.test(worker.error), "🔴 OPE-2806: a worker reply into a room that stood down at ROOM grain is REFUSED with the stand-down steer");
    ok(activities() === 0, "🔴 OPE-2806: …and nothing reached the stopped room");

    const ack = await attempt(stopperCtx, "Standing down here.");
    ok(ack.posted === true, "OPE-2806: the turn that stood down still posts its ONE acknowledgement, read from the room-grain row");
    ok(activities() === 1, "OPE-2806: …and that one post reached the room");
    const spent = await readStandDownAck(stoppedRoom.partition, stoppedRoom.anchor);
    ok(spent.kind === "held" && spent.spent === true, "OPE-2806: …and it spent the acknowledgement at the room address");
    const again = await attempt(stopperCtx, "One more thing.");
    ok(typeof again.error === "string" && /stand down/i.test(again.error), "🔴 OPE-2806: the stander's SECOND post into the stopped room is refused");
    ok(activities() === 1, "OPE-2806: …so the stopped room received exactly ONE message");

    const control = await attempt(controlCtx, "the worker's finding");
    ok(control.posted === true && control.error === undefined, "OPE-2806 NEGATIVE CONTROL: the same worker's reply into a room that did NOT stand down still posts");
    ok(activities() === 2, "OPE-2806 NEGATIVE CONTROL: …and it reached that room");

    const editTool = (await import("@open-everywhere/core/agent/tools/edit_reply.js")).default;
    const updates = () => calls.filter((c) => c.method === "PUT" && c.url.includes("/activities/")).length;
    const edit = async (ctx: unknown): Promise<{ edited?: unknown; error?: string }> =>
      inSession(async () => {
        try {
          return await armReply(editTool, ctx)!.execute({ message_id: "teams-room-activity", text: "corrected" }, ctx);
        } catch (e) {
          return { error: String((e as Error).message) };
        }
      });
    const { recordOwnPost } = await import("@open-everywhere/core/agent/channels/own-post-ledger.js");
    const { replyEditLocus } = await import("@open-everywhere/core/agent/channels/reply-post.js");
    const workerLocus = replyEditLocus(resolveReplyTarget(workerCtx as never)!);
    ok(workerLocus !== undefined && workerLocus !== null, "OPE-2808 precondition: the worker's conversation has an edit locus");
    await recordOwnPost(stoppedPart.org, workerLocus!, "teams-room-activity");
    const workerEdit = await edit(workerCtx);
    ok(typeof workerEdit.error === "string" && /stand down/i.test(workerEdit.error), `🔴 OPE-2808: a worker's edit_reply in a room that stood down at ROOM grain is REFUSED with the stand-down steer (${workerEdit.error ?? "edited"})`);
    const standerEdit = await edit(stopperCtx);
    ok(typeof standerEdit.error === "string" && /stand down/i.test(standerEdit.error), "🔴 OPE-2808: …and so is the stander's own edit after its acknowledgement");
    ok(updates() === 0, "🔴 OPE-2808: …so no message in the stopped room changed");
    const controlEdit = await edit(controlCtx);
    ok(controlEdit.edited === true && controlEdit.error === undefined, `OPE-2808 NEGATIVE CONTROL: an edit in a room that did NOT stand down still lands (${controlEdit.error ?? "edited"})`);
    ok(updates() === 1, "OPE-2808 NEGATIVE CONTROL: …and it reached that room");
  } finally {
    restoreHttp();
  }
}

console.log(`\n✓ teams-provider-integration: ${n} assertions passed (manifest row, RSC manifest block, group-chat window floor, reply gate, target, execute + audit, read adapter, routine dispatch + bindFrom, attended-mention spend gate, engaged-seam admission on the native gate, a room-grain stand-down refuses a worker reply and an edit)`);
