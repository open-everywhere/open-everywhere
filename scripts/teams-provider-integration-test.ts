import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { registerTeamsProvider, resolveTeamsTarget } from "@open-everywhere/provider-teams/agent/register.js";
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

const dir = join(tmpdir(), `open-everywhere-teams-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
delete process.env.OE_TRUST;
process.env.MICROSOFT_APP_ID = "teams-app-id";
process.env.MICROSOFT_APP_PASSWORD = "teams-app-secret";

registerTeamsProvider();

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

const TEAMS_SERVICE_URL = "https://smba.test.local";
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
    if (u.includes("smba.test.local")) return resp(teamsResponse.status, teamsResponse.body);
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
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as ArmedTool | null;

assert.deepStrictEqual(
  capabilitiesForPlatform("teams"),
  { midTurnPost: true, reactions: false },
  "registerTeamsProvider registers teams' manifest (midTurnPost wired via sendTeamsActivity, no reactions)",
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
await inSession(async () => {
  const armed = armReply(reply, teamsCtx("conv-1"))!;
  const res = await armed.execute({ text: "teams answer" }, teamsCtx("conv-1"));
  ok(res.posted === true && res.id === "teams-activity-1", "reply: on Teams returns the sent activity id");
  const activityCall = calls.find((c) => c.url.includes("smba.test.local") && c.url.includes("/v3/conversations/") && c.url.includes("/activities"));
  ok(activityCall !== undefined && activityCall.method === "POST", "reply: on Teams POSTs a message activity to the captured conversation reference");
  ok(activityCall!.url.includes("conv-1"), "reply: on Teams posts into the SAME conversation it was woken on");
  const payload = JSON.parse(activityCall!.body) as { type?: string; text?: string };
  ok(payload.type === "message" && payload.text === "teams answer", "reply: on Teams sends a message activity carrying the model text");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "teams" && r.detail?.id === "teams-activity-1"), "reply: audits a reply.post row stamped platform=teams");
});
restoreHttp();

{
  process.env.OE_EGRESS_SPOOF = "1";
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
  const completed = (message: string | null, ctx: unknown) => inChatSession(() => teamsChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx));
  const auditCtx = {
    state: { conversationId: "19:conv1", tenantId: "TEN1", channelId: "19:chan1", teamId: "TEAM1", conversationType: "channel", serviceUrl: "https://smba.test.local", replyToActivityId: "act-root-1" },
    thread: { post: async () => undefined },
  };
  const terminalReplyPosts = async (): Promise<Array<{ detail?: Record<string, unknown> }>> =>
    (await readAudit({ org: "default", action: "reply.post" })).filter((r) => r.platform === "teams" && r.detail?.route === "terminal");
  await completed(NO_REPLY_SENTINEL, auditCtx);
  ok((await readAudit({ org: "default", action: "teams.no_reply" })).length === 0, "chat-audit: a teams judged silence writes NO teams.no_reply row (actions-only)");
  await completed("done — deployed", auditCtx);
  const tp = await terminalReplyPosts();
  ok(tp.length === 1 && tp[0]!.detail?.chars === "done — deployed".length, "chat-audit: a teams terminal-prose reply writes ONE reply.post row (route:terminal, choke point via serviceUrl+replyToActivityId)");
  ok((await readAudit({ org: "default", action: "teams.replied" })).length === 0, "chat-audit: the legacy teams.replied row is GONE");
  delete process.env.OE_EGRESS_SPOOF;
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
}

console.log(`\n✓ teams-provider-integration: ${n} assertions passed (manifest row, reply gate, target, execute + audit, read adapter, routine dispatch + bindFrom)`);
