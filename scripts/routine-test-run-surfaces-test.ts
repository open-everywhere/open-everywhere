import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-routine-test-run-surfaces-")), "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.DISCORD_BOT_TOKEN = "fixture-discord-token-not-a-secret";
process.env.MICROSOFT_APP_PASSWORD = "fixture-app-secret-not-a-secret";
delete process.env.OE_PLATFORM;

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const { _setDeploymentIdentityForTest } = await import("@open-everywhere/core/agent/identity/deployment-identity.js");
const { overrideSettingsForTest, registerSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
_setDeploymentIdentityForTest({ org: "acme" });
registerSettings({});
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });
overrideSettingsForTest({ teams: { appId: "fixture-app-id-not-a-secret" } });

await import("@open-everywhere/core/agent/hooks/routine-test-run.js");
const testRun = await import("@open-everywhere/core/agent/routines/test-run.js");
const routineStore = await import("@open-everywhere/core/agent/routines/store.js");
const dispatch = await import("@open-everywhere/core/agent/schedules/dispatch.js");
const { postTestRunSummary } = await import("@open-everywhere/core/agent/hooks/routine-test-run.js");
const { ROUTINE_MARKER } = await import("@open-everywhere/core/agent/routines/routine.js");
const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
const { rawIdLeaks } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");
const { postArm } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { bindFrom } = await import("@open-everywhere/core/agent/identity/binding.js");
const { isWakeSurfaceBinding } = await import("@open-everywhere/core/agent/channels/unified-window.js");
type Routine = import("@open-everywhere/core/agent/routines/routine.js").Routine;

ok(testRun.testRunRefusal({ status: "active", trigger: { kind: "cron" }, surfaceKey: "discord/G1/C1" }) !== null, "before the bundles register, a Discord routine cannot be tested");
registerDiscordProvider();
registerTeamsProvider();

interface Wire {
  readonly url: string;
  readonly body: Record<string, unknown>;
}
const wire: Wire[] = [];
let idSeq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("login.microsoftonline.com") || url.includes("botframework.com/oauth")) {
    return new Response(JSON.stringify({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const isDiscordPost = method === "POST" && /discord\.com\/api\/v10\/channels\/[^/]+\/messages$/u.test(url);
  const isTeamsPost = method === "POST" && /\/v3\/conversations\/[^/]+\/activities(\/[^/]+)?$/u.test(url);
  if (isDiscordPost || isTeamsPost) {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    wire.push({ url, body });
    return new Response(JSON.stringify({ id: `${isDiscordPost ? "1400000000000000" : "17600000"}${String(++idSeq).padStart(3, "0")}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const sends: { target: Record<string, unknown>; attrs: Record<string, string> }[] = [];
const recordingTo = ((_channel: unknown, target: Record<string, unknown>) => ({
  send: async (_message: string, opts: { auth: { attributes: Record<string, string> } }) => {
    sends.push({ target, attrs: opts.auth.attributes });
  },
})) as never;

async function tick(now: string, extra: Record<string, unknown> = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now: new Date(now),
    to: recordingTo,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    confirmRoomMembership: async () => true,
    confirmCreatorActive: async () => true,
    confirmTeamsRoomMembership: async () => ({ member: true }),
    confirmTeamsCreatorActive: async () => true,
    ...extra,
  } as never);
  await Promise.all(pending);
}

function routine(over: Partial<Routine> & Pick<Routine, "id" | "surfaceKey" | "target">): Routine {
  return {
    org: "acme",
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "Post the open incident count.",
    createdBy: "U-OWNER",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2099-01-01T00:00:00.000Z",
    ...over,
  };
}

function replyTargetOf(attrs: Record<string, string>): Record<string, unknown> | null {
  return resolveReplyTarget({ channel: { kind: "teams" }, session: { auth: { current: { attributes: attrs, principalId: "", principalType: "teams-user" } } } } as never) as Record<string, unknown> | null;
}

async function replyOnWire(target: Record<string, unknown>, text: string): Promise<Wire | undefined> {
  const before = wire.length;
  await postArm("teams")!.dispatchReply!(target as never, text, undefined as never);
  return wire.slice(before).find((w) => String(w.body["text"] ?? "") === text);
}

async function requestTest(r: Routine, id: string, at: string): Promise<void> {
  await routineStore.updateRoutine(r.org, r.surfaceKey, r.id, { testRun: { id, requestedBy: "U-ASKER", requestedAt: at } });
}

try {
  {
    const GUILD = "1300000000000000100";
    const CHANNEL = "1300000000000000200";
    const r = routine({ id: "r-discord", surfaceKey: `discord/${GUILD}/${CHANNEL}`, target: { channelId: CHANNEL, guildId: GUILD } });
    ok(testRun.testRunRefusal(r) === null, "🔴 discord: a Discord routine can be tested (OPE-2540; today's code says Slack only)");
    await routineStore.addRoutine({} as never, r);
    await requestTest(r, "t-0000d001", "2026-07-02T12:00:00.000Z");
    const wireBefore = wire.length;
    await tick("2026-07-02T12:00:00.000Z");
    const posts = wire.slice(wireBefore);
    const root = posts.find((w) => String(w.body["content"] ?? "").startsWith("🧪 Test run of"));
    ok(root !== undefined && root.url.endsWith(`/channels/${CHANNEL}/messages`), "🔴 discord: the arm posts the test's opening message in the routine's own channel");
    ok(root!.body["message_reference"] === undefined, "discord: the opening post is a top-level message");
    ok(String(root!.body["content"]).includes("posts only its answer, in this room") && !String(root!.body["content"]).includes("r-discord"), "discord: the opening post promises no thread and names no raw id");
    ok(sends.length === 1, "🔴 discord: the test fires once");
    const fire = sends[0]!;
    const rootId = fire.attrs[testRun.ROUTINE_TEST_ANCHOR_ATTR];
    ok(typeof rootId === "string" && rootId.startsWith("1400000000000000"), "discord: the bag carries the opening post's id as the anchor");
    ok(fire.target["channelId"] === CHANNEL && fire.target["conversationId"] === rootId, "🔴 discord: the fire keys its session on the opening post — eve's (channel, conversation) token, not the room's");
    ok(fire.attrs["channel_id"] === CHANNEL && fire.attrs["guild_id"] === GUILD && fire.attrs[ROUTINE_MARKER.id] === "r-discord", "🔴 discord: the bag is the routine's own bag, so the test binds to the routine's channel and guild");
    ok(fire.attrs["thread_ts"] === undefined, "discord: no Slack thread stamp");

    const summaryWireBefore = wire.length;
    const text = await postTestRunSummary(fire.attrs, false, { read: async () => [{ tool: "post_message", what: "post message: “3 incidents open”" }] });
    const summary = wire.slice(summaryWireBefore).find((w) => String(w.body["content"] ?? "").startsWith("🧪 Test run of"));
    ok(text !== undefined && summary !== undefined && summary.url.endsWith(`/channels/${CHANNEL}/messages`), "🔴 discord: the summary posts in the routine's channel");
    ok((summary!.body["message_reference"] as { message_id?: string } | undefined)?.message_id === rootId, "🔴 discord: …as a reply to the test's opening post");
    ok(String(summary!.body["content"]).includes("post message: “3 incidents open”"), "discord: the summary lists the blocked write");
    const after = await routineStore.getRoutine("acme", r.surfaceKey, r.id);
    ok(after?.testRun === undefined && after?.nextRunAt === r.nextRunAt && after?.lastRunAt === undefined, "discord: the request is consumed and the schedule does not move");
  }

  const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
  const TENANT = "tenant-one";
  {
    const CONV = "a:1personal-chat-id";
    const r = routine({
      id: "r-teams-dm",
      surfaceKey: `teams/${TENANT}/a_1personal-chat-id`,
      target: { serviceUrl: SERVICE_URL, conversationId: CONV, conversationType: "personal", tenantId: TENANT },
    });
    ok(testRun.testRunRefusal(r) === null, "🔴 teams: a Teams routine can be tested (OPE-2540)");
    await routineStore.addRoutine({} as never, r);
    await requestTest(r, "t-0000e001", "2026-07-02T13:00:00.000Z");
    const wireBefore = wire.length;
    const sendsBefore = sends.length;
    await tick("2026-07-02T13:00:00.000Z");
    const root = wire.slice(wireBefore).find((w) => String(w.body["text"] ?? "").startsWith("🧪 Test run of"));
    ok(root !== undefined && root.url.endsWith(`/v3/conversations/${encodeURIComponent(CONV)}/activities`), "🔴 teams 1:1: the arm posts the opening activity into the person's chat");
    ok(sends.length === sendsBefore + 1, "teams 1:1: the test fires once");
    const rootText = String(root!.body["text"]);
    ok(!rootText.includes("<@") && rawIdLeaks(rootText, "teams").length === 0 && !rootText.includes("U-ASKER"), "🔴 teams 1:1: the opening post names the asker in words — Teams renders no <@…> mention");
    const fire = sends.at(-1)!;
    const rootId = fire.attrs[testRun.ROUTINE_TEST_ANCHOR_ATTR];
    ok(typeof rootId === "string" && rootId.startsWith("17600000"), "teams 1:1: the bag carries the opening activity's id as the anchor");
    ok(fire.target["conversationId"] === CONV && fire.target["replyToActivityId"] === rootId, "🔴 teams 1:1: the fire keys its session on the opening activity, never on the person's own chat session");
    ok(fire.target["serviceUrl"] === SERVICE_URL && fire.target["initialMessage"] === undefined, "teams 1:1: the routine's own reference, and no eve root (a 1:1 eve root keeps no reply id)");
    ok(fire.attrs["conversation_id"] === CONV && fire.attrs[ROUTINE_MARKER.id] === "r-teams-dm", "🔴 teams 1:1: the bag is the routine's own bag");
    ok(fire.attrs["reply_to_activity_id"] === rootId, "🔴 teams 1:1: the bag names the opening activity, so the turn's binding knows where to answer (OPE-2568)");
    const answerTo = replyTargetOf(fire.attrs);
    ok(answerTo?.["conversationId"] === CONV && answerTo?.["replyToActivityId"] === rootId, "🔴 teams 1:1: the turn's `reply` resolves to the opening activity, not to the routine's chat (OPE-2568)");
    const answer = await replyOnWire(answerTo!, "3 incidents open");
    ok(answer !== undefined && answer.url.endsWith(`/v3/conversations/${encodeURIComponent(CONV)}/activities/${rootId}`), "🔴 teams 1:1: …and the answer goes on the wire as a reply to the opening activity");

    const summaryWireBefore = wire.length;
    const text = await postTestRunSummary(fire.attrs, false, { read: async () => [] });
    const summary = wire.slice(summaryWireBefore).find((w) => String(w.body["text"] ?? "").startsWith("🧪 Test run of"));
    ok(text !== undefined && summary !== undefined && summary.url.endsWith(`/v3/conversations/${encodeURIComponent(CONV)}/activities/${rootId}`), "🔴 teams 1:1: the summary replies to the opening activity");
    ok(String(summary!.body["text"]).includes("It tried no writes") && String(summary!.body["text"]).includes("nothing was posted but its answer"), "teams 1:1: an empty list is said out loud, with no thread promise");
  }

  {
    const BASE = "19:channel-abc@thread.tacv2";
    const CONV = `${BASE};messageid=1700000000111`;
    const r = routine({
      id: "r-teams-ch",
      surfaceKey: `teams/${TENANT}/19_channel-abc_thread.tacv2_messageid_1700000000111`,
      target: { serviceUrl: SERVICE_URL, conversationId: CONV, conversationType: "channel", tenantId: TENANT, channelId: BASE, teamId: "19:team@thread.tacv2", aadObjectId: "aad-owner" },
    });
    await routineStore.addRoutine({} as never, r);
    await requestTest(r, "t-0000e002", "2026-07-02T14:00:00.000Z");
    const wireBefore = wire.length;
    const sendsBefore = sends.length;
    await tick("2026-07-02T14:00:00.000Z");
    const root = wire.slice(wireBefore).find((w) => String(w.body["text"] ?? "").startsWith("🧪 Test run of"));
    ok(root !== undefined && root.url.endsWith(`/v3/conversations/${encodeURIComponent(BASE)}/activities`), "🔴 teams channel: the opening post goes to the CHANNEL, so it opens a reply chain of its own");
    const fire = sends.at(-1)!;
    ok(sends.length === sendsBefore + 1, "teams channel: the test fires once");
    const rootId = fire.attrs[testRun.ROUTINE_TEST_ANCHOR_ATTR];
    ok(fire.target["conversationId"] === BASE && fire.target["replyToActivityId"] === rootId, "🔴 teams channel: the fire keys its session on the new chain, not on the routine's chain");
    ok(fire.attrs["conversation_id"] === CONV && fire.attrs["channel_id"] === BASE, "teams channel: the bag still names the routine's own conversation and channel");
    const answerTo = replyTargetOf(fire.attrs);
    ok(answerTo?.["conversationId"] === BASE && answerTo?.["replyToActivityId"] === rootId, "🔴 teams channel: the turn's `reply` resolves to the test's own chain, not the routine's chain (OPE-2568)");
    const answer = await replyOnWire(answerTo!, "2 incidents open");
    ok(answer !== undefined && answer.url.endsWith(`/v3/conversations/${encodeURIComponent(BASE)}/activities/${rootId}`), "🔴 teams channel: …and the answer goes on the wire under the opening post");
    const { reply_to_activity_id: _stamp, ...unstamped } = fire.attrs;
    const plain = replyTargetOf(unstamped);
    ok(plain?.["conversationId"] === CONV && plain?.["replyToActivityId"] === undefined, "teams channel: a turn with no host stamp still answers in its own conversation (negative control)");

    await requestTest(r, "t-0000e003", "2026-07-02T14:10:00.000Z");
    const before = sends.length;
    const told = wire.length;
    await tick("2026-07-02T14:10:00.000Z", { confirmTeamsRoomMembership: async () => ({ member: false }) });
    ok(sends.length === before, "🔴 teams channel: a creator no longer in the Teams channel gets no test fire");
    ok(wire.slice(told).some((w) => String(w.body["text"] ?? "").includes("can no longer run it in this room")), "teams channel: …and the room is told why, in words");

    await requestTest(r, "t-0000e004", "2026-07-02T14:20:00.000Z");
    const unresolvedBefore = sends.length;
    await tick("2026-07-02T14:20:00.000Z", { confirmTeamsRoomMembership: async () => ({ member: undefined, unresolved: "read_error" }) });
    ok(sends.length === unresolvedBefore + 1, "teams channel: an unresolved room check lets the test start");
    const rows = await readAudit({ org: "acme", action: "routine.eligibility_unresolved" });
    ok(rows.some((row) => (row.detail as Record<string, unknown>)?.["routineId"] === "r-teams-ch" && (row.detail as Record<string, unknown>)?.["test"] === "t-0000e004"), "🔴 teams channel: …and writes a routine.eligibility_unresolved row, so the fail-open does not read as a pass");
  }

  {
    const BASE = "19:channel-job@thread.tacv2";
    const CONV = `${BASE};messageid=1700000000222`;
    const r = routine({
      id: "r-teams-job",
      surfaceKey: `teams/${TENANT}/19_channel-job_thread.tacv2_messageid_1700000000222`,
      target: { serviceUrl: SERVICE_URL, conversationId: CONV, conversationType: "channel", tenantId: TENANT, channelId: BASE, teamId: "19:team@thread.tacv2", aadObjectId: "aad-owner" },
      sessionMode: "job",
      prompt: "Chase the incident review until it is filed.",
      nextRunAt: "2026-07-03T09:00:00.000Z",
    });
    await routineStore.addRoutine({} as never, r);
    const wireBefore = wire.length;
    const sendsBefore = sends.length;
    await tick("2026-07-03T09:00:00.000Z");
    const kickoff = wire.slice(wireBefore).find((w) => String(w.body["text"] ?? "").startsWith("🔄 Starting job"));
    ok(kickoff !== undefined && kickoff.url.endsWith(`/v3/conversations/${encodeURIComponent(BASE)}/activities`), "🔴 teams job: the first fire posts a kickoff in the CHANNEL, so the job has a reply chain of its own (OPE-2568)");
    ok(String(kickoff!.body["text"]).includes("this post") && !String(kickoff!.body["text"]).includes("this thread"), "teams job: the kickoff names a post, not a Slack thread");
    ok(sends.length === sendsBefore + 1, "teams job: the job fires once");
    const fire1 = sends.at(-1)!;
    const anchor = (await routineStore.getRoutine("acme", r.surfaceKey, r.id))?.jobSessionAnchor;
    ok(typeof anchor === "string" && anchor.startsWith("17600000"), "🔴 teams job: the kickoff's activity id is stored as the job's anchor");
    ok(fire1.target["conversationId"] === BASE && fire1.target["replyToActivityId"] === anchor, "🔴 teams job: the fire keys its session on the kickoff — eve's (tenant, conversation, reply id) token");
    ok(fire1.attrs["reply_to_activity_id"] === anchor && fire1.attrs["conversation_id"] === CONV, "🔴 teams job: the bag names the kickoff, and is otherwise the routine's own bag");
    const answerTo = replyTargetOf(fire1.attrs);
    ok(answerTo?.["conversationId"] === BASE && answerTo?.["replyToActivityId"] === anchor, "🔴 teams job: the job's `reply` lands under the kickoff post");
    const jobBinding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: { attributes: fire1.attrs, principalId: "", principalType: "teams-user" } } } } as never);
    ok(jobBinding.target?.["replyToActivityId"] === anchor && isWakeSurfaceBinding(jobBinding), "🔴 teams job: the stamped binding passes the frozen-binding check a windowed fire meets");

    const wireBefore2 = wire.length;
    await tick("2026-07-03T10:01:00.000Z");
    ok(!wire.slice(wireBefore2).some((w) => String(w.body["text"] ?? "").startsWith("🔄 Starting job")), "🔴 teams job: a re-fire posts no second kickoff");
    const jobFires = sends.slice(sendsBefore).filter((f) => f.attrs[ROUTINE_MARKER.id] === "r-teams-job");
    const fire2 = jobFires.at(-1)!;
    ok(jobFires.length === 2 && fire2.target["replyToActivityId"] === anchor && fire2.attrs["reply_to_activity_id"] === anchor, "🔴 teams job: a re-fire reuses the SAME anchor ⇒ one durable session (the join)");

  }

  {
    const GUILD = "1300000000000000100";
    const CHANNEL = "1300000000000000300";
    const r = routine({ id: "r-discord-job", surfaceKey: `discord/${GUILD}/${CHANNEL}`, target: { channelId: CHANNEL, guildId: GUILD }, sessionMode: "job", nextRunAt: "2026-07-04T09:00:00.000Z" });
    await routineStore.addRoutine({} as never, r);
    const mine = (): typeof sends => sends.filter((f) => f.attrs[ROUTINE_MARKER.id] === "r-discord-job");
    const wireBefore = wire.length;
    await tick("2026-07-04T09:00:00.000Z");
    const kickoff = wire.slice(wireBefore).find((w) => String(w.body["content"] ?? "").startsWith("🔄 Starting job"));
    ok(kickoff !== undefined && kickoff.url.endsWith(`/channels/${CHANNEL}/messages`), "🔴 discord job: the first fire posts a kickoff in the routine's channel");
    const anchor = (await routineStore.getRoutine("acme", r.surfaceKey, r.id))?.jobSessionAnchor;
    const fire = mine().at(-1);
    ok(mine().length === 1 && typeof anchor === "string" && fire?.target["channelId"] === CHANNEL && fire?.target["conversationId"] === anchor, "🔴 discord job: the fire keys its session on the kickoff message");
    ok(fire!.attrs["channel_id"] === CHANNEL && fire!.attrs["thread_ts"] === undefined && fire!.attrs["reply_to_activity_id"] === undefined, "discord job: the bag is the routine's own bag, with no stamp");
    await tick("2026-07-04T10:01:00.000Z");
    ok(mine().length === 2 && mine().at(-1)!.target["conversationId"] === anchor, "🔴 discord job: a re-fire reuses the same anchor");
  }

} finally {
  globalThis.fetch = realFetch;
}

console.log(`✓ routine-test-run-surfaces: ${n} assertions passed`);
