import assert from "node:assert/strict";
import {
  registerUnifiedWakeTarget,
  resolveUnifiedWakeTarget,
  isUnifiedWakeOrigin,
  unifiedThreadRef,
  isThreadScopedWakeOrigin,
  type UnifiedWakeTargetStore,
  type UnifiedWakeOrigin,
} from "../agent/channels/unified-window.js";
import { buildOneshotCompletionWake } from "../agent/channels/oneshot-wake.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const rows = new Map<string, string>();
const store: UnifiedWakeTargetStore = {
  putUnifiedWakeTarget: async (org, wakeId, targetJson) => {
    rows.set(`${org}:${wakeId}`, targetJson);
  },
  getUnifiedWakeTarget: async (org, wakeId) => rows.get(`${org}:${wakeId}`) ?? null,
};

const NOW = "2026-07-24T00:00:00.000Z";

interface Fixture {
  readonly name: string;
  readonly origin: UnifiedWakeOrigin;
  readonly json: string;
  readonly threadRef: { channelKey: string; threadKey: string };
  readonly threadScoped: boolean;
  readonly containerId: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "slack top-level (ambient)",
    origin: { platform: "slack", channelId: "C042WIN" },
    json: '{"platform":"slack","channelId":"C042WIN"}',
    threadRef: { channelKey: "slack/C042WIN", threadKey: "C042WIN" },
    threadScoped: false,
    containerId: "C042WIN",
  },
  {
    name: "slack threaded",
    origin: { platform: "slack", channelId: "C042WIN", threadTs: "1720009900.123456" },
    json: '{"platform":"slack","channelId":"C042WIN","threadTs":"1720009900.123456"}',
    threadRef: { channelKey: "slack/C042WIN", threadKey: "1720009900.123456" },
    threadScoped: true,
    containerId: "C042WIN",
  },
  {
    name: "slack addressed top-level mention (replyAnchorTs, threadTs deliberately ABSENT)",
    origin: { platform: "slack", channelId: "C042WIN", replyAnchorTs: "1720009901.000100" },
    json: '{"platform":"slack","channelId":"C042WIN","replyAnchorTs":"1720009901.000100"}',
    threadRef: { channelKey: "slack/C042WIN", threadKey: "C042WIN" },
    threadScoped: false,
    containerId: "C042WIN",
  },
  {
    name: "slack threaded + anchor (all optionals present)",
    origin: { platform: "slack", channelId: "C042WIN", threadTs: "1720009900.123456", replyAnchorTs: "1720009902.000200" },
    json: '{"platform":"slack","channelId":"C042WIN","threadTs":"1720009900.123456","replyAnchorTs":"1720009902.000200"}',
    threadRef: { channelKey: "slack/C042WIN", threadKey: "1720009900.123456" },
    threadScoped: true,
    containerId: "C042WIN",
  },
  {
    name: "github minimal (no installationId)",
    origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 },
    json: '{"platform":"github","owner":"acme","repo":"payments-api","issueNumber":55}',
    threadRef: { channelKey: "github/acme/payments-api", threadKey: "55" },
    threadScoped: true,
    containerId: "acme/payments-api",
  },
  {
    name: "github with installationId",
    origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 987 },
    json: '{"platform":"github","owner":"acme","repo":"payments-api","issueNumber":55,"installationId":987}',
    threadRef: { channelKey: "github/acme/payments-api", threadKey: "55" },
    threadScoped: true,
    containerId: "acme/payments-api",
  },
  {
    name: "linear MENTION (agentSessionId, no parent)",
    origin: { platform: "linear", agentSessionId: "as-lin-77", issueId: "issue-uuid-77" },
    json: '{"platform":"linear","agentSessionId":"as-lin-77","issueId":"issue-uuid-77"}',
    threadRef: { channelKey: "linear/issue-uuid-77", threadKey: "issue-uuid-77" },
    threadScoped: true,
    containerId: "issue-uuid-77",
  },
  {
    name: "linear MENTION + parentId",
    origin: { platform: "linear", agentSessionId: "as-lin-77", issueId: "issue-uuid-77", parentId: "comment-uuid-1" },
    json: '{"platform":"linear","agentSessionId":"as-lin-77","issueId":"issue-uuid-77","parentId":"comment-uuid-1"}',
    threadRef: { channelKey: "linear/issue-uuid-77", threadKey: "comment-uuid-1" },
    threadScoped: true,
    containerId: "issue-uuid-77",
  },
  {
    name: "linear AMBIENT (ambient:true, no agentSessionId)",
    origin: { platform: "linear", ambient: true, issueId: "issue-uuid-77" },
    json: '{"platform":"linear","ambient":true,"issueId":"issue-uuid-77"}',
    threadRef: { channelKey: "linear/issue-uuid-77", threadKey: "issue-uuid-77" },
    threadScoped: true,
    containerId: "issue-uuid-77",
  },
  {
    name: "linear AMBIENT + parentId",
    origin: { platform: "linear", ambient: true, issueId: "issue-uuid-77", parentId: "comment-uuid-1" },
    json: '{"platform":"linear","ambient":true,"issueId":"issue-uuid-77","parentId":"comment-uuid-1"}',
    threadRef: { channelKey: "linear/issue-uuid-77", threadKey: "comment-uuid-1" },
    threadScoped: true,
    containerId: "issue-uuid-77",
  },
  {
    name: "notion minimal (discussion only)",
    origin: { platform: "notion", discussionId: "disc-win-1" },
    json: '{"platform":"notion","discussionId":"disc-win-1"}',
    threadRef: { channelKey: "notion/disc-win-1", threadKey: "disc-win-1" },
    threadScoped: true,
    containerId: "disc-win-1",
  },
  {
    name: "notion with pageId",
    origin: { platform: "notion", discussionId: "disc-win-1", pageId: "P_WINPAGE" },
    json: '{"platform":"notion","discussionId":"disc-win-1","pageId":"P_WINPAGE"}',
    threadRef: { channelKey: "notion/P_WINPAGE", threadKey: "disc-win-1" },
    threadScoped: true,
    containerId: "disc-win-1",
  },
  {
    name: "notion with pageId + workspaceId",
    origin: { platform: "notion", discussionId: "disc-win-1", pageId: "P_WINPAGE", workspaceId: "W_WIN" },
    json: '{"platform":"notion","discussionId":"disc-win-1","pageId":"P_WINPAGE","workspaceId":"W_WIN"}',
    threadRef: { channelKey: "notion/P_WINPAGE", threadKey: "disc-win-1" },
    threadScoped: true,
    containerId: "disc-win-1",
  },
  {
    name: "discord minimal (channel + guild)",
    origin: { platform: "discord", channelId: "CH_WIN", guildId: "G_WIN" },
    json: '{"platform":"discord","channelId":"CH_WIN","guildId":"G_WIN"}',
    threadRef: { channelKey: "discord/G_WIN/CH_WIN", threadKey: "CH_WIN" },
    threadScoped: false,
    containerId: "CH_WIN",
  },
  {
    name: "discord with messageId",
    origin: { platform: "discord", channelId: "CH_WIN", guildId: "G_WIN", messageId: "5002" },
    json: '{"platform":"discord","channelId":"CH_WIN","guildId":"G_WIN","messageId":"5002"}',
    threadRef: { channelKey: "discord/G_WIN/CH_WIN", threadKey: "CH_WIN" },
    threadScoped: false,
    containerId: "CH_WIN",
  },
  {
    name: "discord addressed base-channel mention (messageId + autoThreadName)",
    origin: { platform: "discord", channelId: "CH_WIN", guildId: "G_WIN", messageId: "5002", autoThreadName: "Deploy window?" },
    json: '{"platform":"discord","channelId":"CH_WIN","guildId":"G_WIN","messageId":"5002","autoThreadName":"Deploy window?"}',
    threadRef: { channelKey: "discord/G_WIN/CH_WIN", threadKey: "CH_WIN" },
    threadScoped: false,
    containerId: "CH_WIN",
  },
  {
    name: "discord DM (dm:true, no guild)",
    origin: { platform: "discord", channelId: "D_DM", dm: true },
    json: '{"platform":"discord","channelId":"D_DM","dm":true}',
    threadRef: { channelKey: "discord/dm/D_DM", threadKey: "D_DM" },
    threadScoped: false,
    containerId: "D_DM",
  },
  {
    name: "discord DM with messageId (cosmetic anchor — no guild-keyed effect)",
    origin: { platform: "discord", channelId: "D_DM", dm: true, messageId: "7003" },
    json: '{"platform":"discord","channelId":"D_DM","dm":true,"messageId":"7003"}',
    threadRef: { channelKey: "discord/dm/D_DM", threadKey: "D_DM" },
    threadScoped: false,
    containerId: "D_DM",
  },
  {
    name: "teams minimal (plain conversation send)",
    origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "19:winchan@thread.tacv2;messageid=1712" },
    json: '{"platform":"teams","serviceUrl":"https://smba.trafficmanager.net/amer/","conversationId":"19:winchan@thread.tacv2;messageid=1712"}',
    threadRef: { channelKey: "teams/19_winchan@thread.tacv2;messageid=1712", threadKey: "19_winchan@thread.tacv2;messageid=1712" },
    threadScoped: false,
    containerId: "19:winchan@thread.tacv2;messageid=1712",
  },
  {
    name: "teams reply-chain (replyToActivityId)",
    origin: {
      platform: "teams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "19:winchan@thread.tacv2;messageid=1712",
      replyToActivityId: "1712000000000",
    },
    json: '{"platform":"teams","serviceUrl":"https://smba.trafficmanager.net/amer/","conversationId":"19:winchan@thread.tacv2;messageid=1712","replyToActivityId":"1712000000000"}',
    threadRef: { channelKey: "teams/19_winchan@thread.tacv2;messageid=1712", threadKey: "1712000000000" },
    threadScoped: true,
    containerId: "19:winchan@thread.tacv2;messageid=1712",
  },
  {
    name: "teams full (replyToActivityId + tenantId)",
    origin: {
      platform: "teams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "19:winchan@thread.tacv2;messageid=1712",
      replyToActivityId: "1712000000000",
      tenantId: "TEN_WIN",
    },
    json: '{"platform":"teams","serviceUrl":"https://smba.trafficmanager.net/amer/","conversationId":"19:winchan@thread.tacv2;messageid=1712","replyToActivityId":"1712000000000","tenantId":"TEN_WIN"}',
    threadRef: { channelKey: "teams/19_winchan@thread.tacv2;messageid=1712", threadKey: "1712000000000" },
    threadScoped: true,
    containerId: "19:winchan@thread.tacv2;messageid=1712",
  },
];

console.log("(a) canonical serialised form + register/resolve round-trip:");
{
  let i = 0;
  for (const f of FIXTURES) {
    const wakeId = `wk-fixture-${i++}`;
    await registerUnifiedWakeTarget(store, "default", wakeId, f.origin, NOW);
    eq(rows.get(`default:${wakeId}`), f.json, `${f.name}: registerUnifiedWakeTarget writes the canonical JSON`);
    const parsed: unknown = JSON.parse(f.json);
    ok(isUnifiedWakeOrigin(parsed), `${f.name}: the canonical JSON re-validates (stored rows keep resolving)`);
    eq(await resolveUnifiedWakeTarget(store, "default", wakeId), f.origin, `${f.name}: resolveUnifiedWakeTarget round-trips to a deep-equal origin`);
  }
}

console.log("(b) isUnifiedWakeOrigin accepts / rejects / tolerates:");
for (const f of FIXTURES) ok(isUnifiedWakeOrigin(f.origin), `${f.name}: accepted by isUnifiedWakeOrigin`);

const OK_TEAMS_URL = "https://smba.trafficmanager.net/amer/";
const REJECTS: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a string", "slack"],
  ["a number", 42],
  ["an array", []],
  ["no platform", { channelId: "C1" }],
  ["unknown platform", { platform: "irc", channelId: "C1" }],
  ["empty platform", { platform: "", channelId: "C1" }],
  ["non-string platform", { platform: 5, channelId: "C1" }],
  ["prototype-chain platform (constructor)", { platform: "constructor", channelId: "C1" }],
  ["prototype-chain platform (__proto__)", JSON.parse('{"platform":"__proto__","channelId":"C1"}')],
  ["prototype-chain platform (toString)", { platform: "toString", channelId: "C1" }],
  ["slack: missing channelId", { platform: "slack" }],
  ["slack: empty channelId", { platform: "slack", channelId: "" }],
  ["slack: non-string channelId", { platform: "slack", channelId: 7 }],
  ["slack: non-string threadTs", { platform: "slack", channelId: "C1", threadTs: 5 }],
  ["slack: null threadTs", { platform: "slack", channelId: "C1", threadTs: null }],
  ["slack: non-string replyAnchorTs", { platform: "slack", channelId: "C1", replyAnchorTs: 5 }],
  ["github: missing owner", { platform: "github", repo: "r", issueNumber: 1 }],
  ["github: empty owner", { platform: "github", owner: "", repo: "r", issueNumber: 1 }],
  ["github: missing repo", { platform: "github", owner: "o", issueNumber: 1 }],
  ["github: empty repo", { platform: "github", owner: "o", repo: "", issueNumber: 1 }],
  ["github: missing issueNumber", { platform: "github", owner: "o", repo: "r" }],
  ["github: string issueNumber", { platform: "github", owner: "o", repo: "r", issueNumber: "55" }],
  ["github: zero issueNumber", { platform: "github", owner: "o", repo: "r", issueNumber: 0 }],
  ["github: negative issueNumber", { platform: "github", owner: "o", repo: "r", issueNumber: -3 }],
  ["github: Infinity issueNumber", { platform: "github", owner: "o", repo: "r", issueNumber: Infinity }],
  ["github: NaN issueNumber", { platform: "github", owner: "o", repo: "r", issueNumber: NaN }],
  ["github: string installationId", { platform: "github", owner: "o", repo: "r", issueNumber: 1, installationId: "987" }],
  ["linear: missing issueId", { platform: "linear", agentSessionId: "as" }],
  ["linear: empty issueId", { platform: "linear", agentSessionId: "as", issueId: "" }],
  ["linear: NEITHER shape (no agentSessionId, no ambient)", { platform: "linear", issueId: "i" }],
  ["linear: BOTH shapes (ambient + agentSessionId)", { platform: "linear", ambient: true, agentSessionId: "as", issueId: "i" }],
  ["linear: ambient:false is not a shape", { platform: "linear", ambient: false, issueId: "i" }],
  ["linear: ambient as a string", { platform: "linear", ambient: "true", issueId: "i" }],
  ["linear: empty agentSessionId", { platform: "linear", agentSessionId: "", issueId: "i" }],
  ["linear: ambient WITH an (empty) agentSessionId", { platform: "linear", ambient: true, agentSessionId: "", issueId: "i" }],
  ["linear: non-string parentId", { platform: "linear", agentSessionId: "as", issueId: "i", parentId: 7 }],
  ["notion: missing discussionId", { platform: "notion" }],
  ["notion: empty discussionId", { platform: "notion", discussionId: "" }],
  ["notion: non-string pageId", { platform: "notion", discussionId: "d", pageId: 5 }],
  ["notion: non-string workspaceId", { platform: "notion", discussionId: "d", workspaceId: {} }],
  ["discord: missing guildId", { platform: "discord", channelId: "CH1" }],
  ["discord: empty guildId", { platform: "discord", channelId: "CH1", guildId: "" }],
  ["discord: missing channelId", { platform: "discord", guildId: "G1" }],
  ["discord: empty channelId", { platform: "discord", channelId: "", guildId: "G1" }],
  ["discord: non-string messageId", { platform: "discord", channelId: "CH1", guildId: "G1", messageId: 5 }],
  ["discord: non-string autoThreadName", { platform: "discord", channelId: "CH1", guildId: "G1", autoThreadName: 5 }],
  ["discord DM: dm:true WITH a guildId (the XOR, impersonation direction)", { platform: "discord", channelId: "D1", dm: true, guildId: "G1" }],
  ["discord DM: dm:true with an EMPTY guildId (present is present — still both shapes)", { platform: "discord", channelId: "D1", dm: true, guildId: "" }],
  ["discord DM: dm:true WITH autoThreadName (guild-keyed engagement write)", { platform: "discord", channelId: "D1", dm: true, autoThreadName: "x" }],
  ["discord DM: dm:false is not a shape", { platform: "discord", channelId: "D1", dm: false }],
  ["discord DM: dm as the STRING 'true'", { platform: "discord", channelId: "D1", dm: "true" }],
  ["discord DM: dm as 1", { platform: "discord", channelId: "D1", dm: 1 }],
  ["discord DM: dm:true, missing channelId", { platform: "discord", dm: true }],
  ["discord DM: dm:true, empty channelId", { platform: "discord", channelId: "", dm: true }],
  ["discord DM: dm:true, non-string messageId", { platform: "discord", channelId: "D1", dm: true, messageId: 5 }],
  ["teams: missing serviceUrl", { platform: "teams", conversationId: "c" }],
  ["teams: non-string serviceUrl", { platform: "teams", serviceUrl: 5, conversationId: "c" }],
  ["teams: unparseable serviceUrl", { platform: "teams", serviceUrl: "not a url", conversationId: "c" }],
  ["teams: http serviceUrl", { platform: "teams", serviceUrl: "http://smba.trafficmanager.net/amer/", conversationId: "c" }],
  ["teams: unlisted https host", { platform: "teams", serviceUrl: "https://evil.example/api", conversationId: "c" }],
  ["teams: suffix-trick host (notsmba.…)", { platform: "teams", serviceUrl: "https://notsmba.trafficmanager.net/", conversationId: "c" }],
  ["teams: lookalike-suffix host (….evil.example)", { platform: "teams", serviceUrl: "https://smba.trafficmanager.net.evil.example/", conversationId: "c" }],
  ["teams: missing conversationId", { platform: "teams", serviceUrl: OK_TEAMS_URL }],
  ["teams: empty conversationId", { platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "" }],
  ["teams: non-string replyToActivityId", { platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "c", replyToActivityId: 5 }],
  ["teams: non-string tenantId", { platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "c", tenantId: 5 }],
];
for (const [label, v] of REJECTS) ok(!isUnifiedWakeOrigin(v), `REJECTED — ${label}`);

console.log("(b2) load-bearing tolerances (validator wider than the type):");
{
  ok(isUnifiedWakeOrigin({ platform: "slack", channelId: "C1", futureField: "x" }), "tolerated: an extra unknown field (slack)");
  ok(
    isUnifiedWakeOrigin({ platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "c", futureField: 1 }),
    "tolerated: an extra unknown field (teams)",
  );
  ok(isUnifiedWakeOrigin({ platform: "slack", channelId: "C1", threadTs: "" }), "tolerated: slack threadTs '' (typeof-only optional check)");
  ok(isUnifiedWakeOrigin({ platform: "slack", channelId: "C1", replyAnchorTs: "" }), "tolerated: slack replyAnchorTs ''");
  ok(isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "as", issueId: "i", parentId: "" }), "tolerated: linear parentId ''");
  ok(isUnifiedWakeOrigin({ platform: "notion", discussionId: "d", pageId: "" }), "tolerated: notion pageId ''");
  ok(isUnifiedWakeOrigin({ platform: "discord", channelId: "CH1", guildId: "G1", messageId: "" }), "tolerated: discord messageId ''");
  ok(isUnifiedWakeOrigin({ platform: "discord", channelId: "D1", dm: true, messageId: "" }), "tolerated: discord DM messageId '' (the SAME typeof-only optional check as the guild shape)");
  ok(isUnifiedWakeOrigin({ platform: "discord", channelId: "D1", dm: true, futureField: "x" }), "tolerated: an extra unknown field (discord DM) — forward-compat is the same on the new variant");
  ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "c", replyToActivityId: "" }), "tolerated: teams replyToActivityId ''");
  eq(
    unifiedThreadRef({ platform: "slack", channelId: "C1", threadTs: "" } as UnifiedWakeOrigin),
    { channelKey: "slack/C1", threadKey: "" },
    "frozen divergence: slack threadTs '' → threadKey '' (?? does not fall back on '')",
  );
  ok(!isThreadScopedWakeOrigin({ platform: "slack", channelId: "C1", threadTs: "" } as UnifiedWakeOrigin), "frozen divergence: slack threadTs '' is NOT thread-scoped (length>0 check)");
  eq(
    unifiedThreadRef({ platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "conv", replyToActivityId: "" } as UnifiedWakeOrigin),
    { channelKey: "teams/conv", threadKey: "" },
    "frozen divergence: teams replyToActivityId '' → threadKey ''",
  );
  ok(
    !isThreadScopedWakeOrigin({ platform: "teams", serviceUrl: OK_TEAMS_URL, conversationId: "conv", replyToActivityId: "" } as UnifiedWakeOrigin),
    "frozen divergence: teams replyToActivityId '' is NOT thread-scoped",
  );
  eq(
    unifiedThreadRef({ platform: "notion", discussionId: "d", pageId: "" } as UnifiedWakeOrigin),
    { channelKey: "notion/", threadKey: "d" },
    "frozen divergence: notion pageId '' → channelKey 'notion/' (?? does not fall back on '')",
  );
  ok(isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 1.5 }), "tolerated: github non-integer issueNumber (finite>0, no integer check)");
  ok(isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 1, installationId: -1 }), "tolerated: github negative installationId (typeof-only)");
  ok(isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 1, installationId: NaN }), "tolerated: github NaN installationId (typeof-only)");
  ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://SMBA.Trafficmanager.NET/amer/", conversationId: "c" }), "tolerated: teams host is case-insensitive");
  ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://emea.smba.trafficmanager.net/x", conversationId: "c" }), "accepted: a regional .smba.trafficmanager.net subdomain (dot-suffix)");
  ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://europe.botframework.com/", conversationId: "c" }), "accepted: a .botframework.com subdomain (dot-suffix)");
  ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://botframework.com/", conversationId: "c" }), "accepted: the bare botframework.com exact host");
  const prevHosts = process.env.OE_TEAMS_SERVICE_HOSTS;
  try {
    ok(!isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.infra.gcc.teams.microsoft.com/x", conversationId: "c" }), "a sovereign-cloud host is NOT in the default allowlist");
    process.env.OE_TEAMS_SERVICE_HOSTS = "smba.infra.gcc.teams.microsoft.com";
    ok(isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.infra.gcc.teams.microsoft.com/x", conversationId: "c" }), "…and IS admitted once opted in via OE_TEAMS_SERVICE_HOSTS");
  } finally {
    if (prevHosts === undefined) delete process.env.OE_TEAMS_SERVICE_HOSTS;
    else process.env.OE_TEAMS_SERVICE_HOSTS = prevHosts;
  }
}

console.log("(c) per-fixture derivations:");
for (const f of FIXTURES) {
  eq(unifiedThreadRef(f.origin), f.threadRef, `${f.name}: unifiedThreadRef`);
  eq(isThreadScopedWakeOrigin(f.origin), f.threadScoped, `${f.name}: isThreadScopedWakeOrigin`);
  const wake = buildOneshotCompletionWake({ taskId: "task-1", summary: "done", origin: f.origin, wakeId: "wk-c" }, NOW);
  eq(wake.locus.channel?.id, f.containerId, `${f.name}: oneshot originContainerId (completion-wake locus id)`);
  eq(wake.platform, f.origin.platform, `${f.name}: the completion wake carries the origin's platform`);
}

console.log("(c2) the DM threadRef namespace never collides with a guild one:");
{
  const dmRef = unifiedThreadRef({ platform: "discord", channelId: "C_SAME", dm: true } as UnifiedWakeOrigin);
  const guildRef = unifiedThreadRef({ platform: "discord", channelId: "C_SAME", guildId: "dm" } as UnifiedWakeOrigin);
  eq(dmRef, { channelKey: "discord/dm/C_SAME", threadKey: "C_SAME" }, "the DM channelKey is namespaced on a literal `dm` segment");
  eq(guildRef.channelKey, dmRef.channelKey, "…and the one theoretically-colliding guild id IS the literal string \"dm\" — which a decimal snowflake can never be");
  ok(
    unifiedThreadRef({ platform: "discord", channelId: "C_SAME", guildId: "G_WIN" } as UnifiedWakeOrigin).channelKey !== dmRef.channelKey,
    "a REAL (snowflake) guild id never collides with the DM namespace, even on the same channel id",
  );
}

{
  rows.set("default:wk-corrupt", "{not json");
  eq(await resolveUnifiedWakeTarget(store, "default", "wk-corrupt"), null, "a malformed-JSON row resolves null (fail closed)");
  rows.set("default:wk-badshape", '{"platform":"slack"}');
  eq(await resolveUnifiedWakeTarget(store, "default", "wk-badshape"), null, "a valid-JSON invalid-shape row resolves null (fail closed)");
  rows.set("default:wk-unknown-arm", '{"platform":"irc","chatId":"7"}');
  eq(await resolveUnifiedWakeTarget(store, "default", "wk-unknown-arm"), null, "an unknown-platform row resolves null (unregistered arm ⇒ fail closed)");
}

console.log(`\nwake-origin fixtures: ${n} assertions passed (${FIXTURES.length} fixtures across 6 platforms / 7 union arms).`);
