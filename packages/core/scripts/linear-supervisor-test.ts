
import assert from "node:assert/strict";
import {
  linearSupervisorToken,
  linearSupervisorSentinel,
  extractLinearCommentSignal,
  classifyLinearAmbientComment,
  buildLinearSupervisorWake,
  linearAgentSessionSignal,
  routeLinearAgentSession,
  handleLinearSupervisorDispatch,
  shouldRotate,
  type LinearSupervisorDeps,
  type LinearSupervisorDispatch,
  type LinearSupervisorSession,
} from "../agent/channels/linear-supervisor.js";
import { renderWake } from "../agent/channels/normalized-wake.js";
import type { OpenEverywhereLinearAuth } from "../agent/channels/linear-identity.js";
import { UNTRUSTED_OPEN } from "../agent/access/untrusted.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const TEAM = "team-uuid-1";
const ISSUE = "issue-uuid-9";
const VIEWER = { id: "app-user-1", name: "Open Everywhere" };
const NOW = () => "2026-02-18T14:05:00.000Z";

ok(linearSupervisorSentinel(3) === "oe-sup:g3", "sentinel is oe-sup:g<gen>");
ok(linearSupervisorToken(TEAM, 1) === `linear:${TEAM}:oe-sup:g1`, "token is linear:<teamId>:oe-sup:g<gen>");
ok(linearSupervisorToken(TEAM, 2).includes(":oe-sup:g"), "token carries the :oe-sup:g infix");

ok(extractLinearCommentSignal({ kind: "data", type: "Comment", action: "create", organizationId: "org-1", raw: { data: { id: "c1" } } })?.commentId === "c1", "Comment create data webhook -> signal");
ok(extractLinearCommentSignal({ kind: "data", type: "Comment", action: "create", organizationId: "org-1", raw: { data: { id: "c1" } } })?.organizationId === "org-1", "the signal carries the organization id");
ok(extractLinearCommentSignal({ kind: "data", type: "Comment", action: "update", raw: { data: { id: "c1" } } }) === null, "comment edits are not ambient candidates (v1)");
ok(extractLinearCommentSignal({ kind: "data", type: "Issue", action: "create", raw: { data: { id: "i1" } } }) === null, "non-Comment data webhooks are not ambient candidates");
ok(extractLinearCommentSignal({ kind: "agent-session", type: "Comment", action: "create", raw: { data: { id: "c1" } } } as never) === null, "agent-session events are the native leg's, never ambient");
ok(extractLinearCommentSignal({ kind: "data", type: "Comment", action: "create", raw: {} }) === null, "a payload missing the comment id yields null (defensive)");

const plain = { body: "I think the migration can ship tomorrow", authorId: "human-1" };
ok(classifyLinearAmbientComment(plain, VIEWER).addressing === "channel-watch", "plain comment -> channel-watch (judged)");
ok(classifyLinearAmbientComment(plain, {}).addressing === "drop", "unresolved viewer -> DROP (fail-closed loop/partition guard)");
ok(classifyLinearAmbientComment(plain, { id: VIEWER.id }).addressing === "drop", "viewer id WITHOUT a name -> DROP (mention partition needs the name)");
ok(classifyLinearAmbientComment(plain, { name: VIEWER.name }).addressing === "drop", "viewer name WITHOUT an id -> DROP (loop guard needs the id)");
ok(classifyLinearAmbientComment({ ...plain, authorId: VIEWER.id }, VIEWER).addressing === "drop", "self-authored -> DROP (our own commentCreate reply)");
ok(classifyLinearAmbientComment({ ...plain, authorId: undefined }, VIEWER).addressing === "drop", "no author (bot/integration-authored) -> DROP");
ok(classifyLinearAmbientComment({ ...plain, parentAuthorId: VIEWER.id }, VIEWER).addressing === "drop", "reply inside the app's own thread -> DROP (the prompted agent-session path owns it)");
ok(classifyLinearAmbientComment({ ...plain, parentAuthorId: "human-2" }, VIEWER).addressing === "channel-watch", "reply inside a HUMAN thread stays judged");
ok(classifyLinearAmbientComment({ ...plain, body: `@${VIEWER.name} can you take this?` }, VIEWER).addressing === "drop", "app @mention -> DROP (owned by the agent-session path)");
ok(classifyLinearAmbientComment({ ...plain, body: "email me@openeverywherefans.dev" }, { id: VIEWER.id, name: "Open" }).addressing === "channel-watch", "an @name with a trailing word-char is NOT a mention -> judged");

const trigger = { id: "c-trig", authorId: "human-1", authorName: "Priya", sentAt: "2026-03-24T18:51:00Z", text: "can we ship the migration tomorrow?" };
{
  const nw = buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, issueIdentifier: "ENG-42", issueTitle: "DB migration rollout", trigger, engagementTier: "reserved" });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("[channel-watch]"), "wake leads with the judged preamble");
  ok(message.includes("you are this team's standing session"), "wake uses the TEAM container noun");
  ok(message.includes("Calibration for this team: RESERVED"), "an explicit reserved tier rides the preamble");
  ok(message.includes(`<channel id="${TEAM}">`), "locus.channel = the team (the silo grain)");
  ok(message.includes(`<thread ts="ENG-42">`), "locus.thread = the issue identifier (the conversation)");
  ok(message.includes(`trigger="true"`) && message.includes("can we ship the migration tomorrow?"), "the comment is the trigger message");
  ok(message.includes(UNTRUSTED_OPEN), "the comment body is untrusted-wrapped by the envelope");
  ok(context !== undefined && context.length === 1 && context[0]!.includes("DB migration rollout"), "the issue title rides an untrusted-wrapped context block");
}
{
  const nw = buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, trigger });
  const { message, context } = renderWake(nw, NOW);
  ok(context === undefined, "no issue title -> no context block");
  ok(!message.includes("Calibration for this"), "no tier -> neutral -> no calibration sentence (Linear's platform default)");
  ok(message.includes(`<thread ts="${ISSUE}">`), "no identifier -> the issue id labels the thread");
}
{
  const plain = renderWake(buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, trigger }), NOW);
  const unified = renderWake(buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, trigger, unified: true }), NOW);
  ok(unified.message.includes(`<channel platform="linear" id="${TEAM}">`), "unified wake stamps the <channel platform=\"linear\"> surface address");
  ok(unified.message.includes("Cross-surface disclosure:"), "unified wake appends the P5 advisory disclosure to the judged preamble");
  ok(!plain.message.includes("platform=") && !plain.message.includes("Cross-surface disclosure"), "per-team wake carries NO platform attr / disclosure");
  const explicitOff = renderWake(buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, trigger, unified: false }), NOW);
  ok(explicitOff.message === plain.message, "unified:false renders BYTE-IDENTICAL to the unset per-team wake (flag-off invariant)");
}

{
  const wakeId = "wk-lin-123";
  const nw = buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, issueIdentifier: "ENG-42", issueTitle: "DB migration rollout", trigger, unified: true, directMention: true, wakeId, engagementTier: "reserved" });
  const { message } = renderWake(nw, NOW);
  ok(message.startsWith("[direct]"), "direct-mention leads with the ADDRESSED preamble, not [channel-watch]");
  ok(!message.includes("[channel-watch]"), "direct-mention does NOT use the silence-biased watch preamble");
  ok(message.includes("addressed to you and is asking for a response"), "direct-mention tells the supervisor it is addressed and owes a reply");
  ok(!message.includes("Calibration for this team"), "the ambient calibration tier NEVER rides an addressed mention (an answer is owed)");
  ok(message.includes(`<wake reason="mention"`), "direct-mention keeps the full judged envelope (reason=\"mention\")");
  ok(message.includes(`wake-id="${wakeId}"`), "the wake-id survives in the envelope — the reply tool echoes it (the only reply route on the unified channel)");
  ok(message.includes(`mention="true"`), "the trigger is flagged as a @mention (response-obligation signal)");
  ok(message.includes(`<channel platform="linear" id="${TEAM}">`), "the surface address rides the unified addressed wake");
  ok(message.includes("Cross-surface disclosure:"), "the P5 cross-surface disclosure still rides the addressed wake");
  ok(message.includes(UNTRUSTED_OPEN), "the comment body is still untrusted-wrapped by the envelope (W1 holds on the addressed path)");
  ok(message.includes(`trust="principal"`), "a direct mention defaults the trigger trust to principal (the live leg passes the real tier)");
}
{
  const off = renderWake(buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, issueTitle: "DB migration rollout", trigger, engagementTier: "reserved", directMention: false }), NOW);
  const plain = renderWake(buildLinearSupervisorWake({ teamId: TEAM, issueId: ISSUE, issueTitle: "DB migration rollout", trigger, engagementTier: "reserved" }), NOW);
  ok(off.message === plain.message, "directMention:false renders BYTE-IDENTICAL to the unset channel-watch wake (flag-off invariant)");
  ok(JSON.stringify(off.context) === JSON.stringify(plain.context), "directMention:false context is byte-identical too");
  ok(off.message.startsWith("[channel-watch]"), "the flag-off wake is still the silence-biased channel-watch ambient wake");
}

{
  const base = { action: "created", agentSessionId: "as-1", organizationId: "org-1", teamId: TEAM, sourceCommentId: "c-mention" };
  ok(routeLinearAgentSession(base, false, true) === "native", "singleWindow OFF -> native (byte-identical, whatever the event/vouch)");
  ok(routeLinearAgentSession(base, true, true) === "suppress-and-divert", "created mention on a singleWindow VOUCHED team -> suppress-and-divert");
  ok(routeLinearAgentSession(base, true, false) === "native", "M1: singleWindow but team is UN-VOUCHED -> native (never leak an un-vouched surface into the shared window; fail-closed)");
  ok(routeLinearAgentSession({ ...base, sourceCommentId: undefined }, true, true) === "native", "comment-less created (assignment/delegation) -> native (not a mention; keep the native session)");
  ok(routeLinearAgentSession({ ...base, agentSessionId: undefined }, true, true) === "native", "no session id -> native (under-identified; fail-open to the path that answers)");
  ok(routeLinearAgentSession({ ...base, organizationId: undefined }, true, true) === "native", "no organization id -> native (can't key the surface)");
  ok(routeLinearAgentSession({ ...base, teamId: undefined }, true, true) === "native", "no team id -> native (can't resolve the grain)");
  ok(routeLinearAgentSession({ ...base, action: "prompted", promptSourceCommentId: "c-reply" }, true, true) === "suppress-and-divert", "S3: comment-backed prompted on a vouched team -> suppress-and-divert (self-diverts, no separate Comment webhook)");
  ok(routeLinearAgentSession({ ...base, action: "prompted", promptSourceCommentId: "c-reply" }, true, false) === "native", "M1 applies to prompted too: an UN-VOUCHED team prompt -> native");
  ok(routeLinearAgentSession({ ...base, action: "prompted" }, true, true) === "native", "comment-LESS prompted -> native (nothing to divert; never lose a user message)");
  ok(routeLinearAgentSession({ ...base, action: "updated" }, true, true) === "native", "unknown actions -> native (unchanged behaviour)");
}
{
  const sig = linearAgentSessionSignal(
    {
      action: "created",
      organizationId: "org-1",
      agentSession: { id: "as-9", organizationId: "org-shadow", sourceCommentId: null, commentId: "c-anchor" },
      agentActivity: { sourceCommentId: "c-prompt" },
    },
    TEAM,
  );
  ok(sig.agentSessionId === "as-9" && sig.organizationId === "org-1" && sig.teamId === TEAM, "signal prefers the event-level organization id and carries the raw-derived team");
  ok(sig.sourceCommentId === "c-anchor", "a null sourceCommentId falls back to the session's thread-anchor commentId");
  ok(sig.promptSourceCommentId === "c-prompt", "the prompt activity's source comment rides the signal (the prompted `suppress` predicate)");
  const bare = linearAgentSessionSignal({ action: "prompted", agentSession: { id: "as-9" } }, undefined);
  ok(bare.organizationId === undefined && bare.sourceCommentId === undefined && bare.promptSourceCommentId === undefined, "absent facts stay undefined (fail-open to native downstream)");
}

const AUTH: OpenEverywhereLinearAuth = { authenticator: "linear", principalId: "human-1", principalType: "linear-user", attributes: { team_id: TEAM, issue_id: ISSUE, comment_id: "c-trig" } };
const SURFACE = `linear/org-1/${TEAM}`;

function dispatch(over: Partial<LinearSupervisorDispatch> = {}): LinearSupervisorDispatch {
  return { surfaceKey: SURFACE, teamId: TEAM, issueId: ISSUE, issueIdentifier: "ENG-42", issueTitle: "DB migration rollout", auth: AUTH, trigger, ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[] }

{
  const session: LinearSupervisorSession = { token: linearSupervisorToken(TEAM, 1), generation: 1, freshGeneration: true, handoffNote: null };
  const wakes: WakeCapture[] = [];
  const touched: string[] = [];
  const deps: LinearSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async (sk) => { touched.push(sk); },
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context }); },
    now: NOW,
  };
  await handleLinearSupervisorDispatch(dispatch(), deps);
  ok(wakes.length === 1 && wakes[0]!.token === linearSupervisorToken(TEAM, 1), "dispatch wakes once under the supervisor token");
  ok(wakes[0]!.message.includes("you are this team's standing session"), "the delivered message is the team-supervisor wake");
  ok(touched.length === 1 && touched[0] === SURFACE, "touchSession records the wake");
}

{
  const token = "oe-dom:acme-eng:oe-sup:g1";
  const session: LinearSupervisorSession = { token, generation: 1, freshGeneration: false, handoffNote: null };
  const wakeId = "wk-lin-dispatch-1";
  const window = { wakeId, origin: { platform: "linear" as const, agentSessionId: "as-dispatch-1", issueId: ISSUE, parentId: "c-root" }, addressing: "direct-mention" as const };
  let captured: { message: string; window: unknown } | undefined;
  const deps: LinearSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { captured = { message: w.message, window: w.window }; },
    now: NOW,
  };
  await handleLinearSupervisorDispatch(dispatch({ unified: true, directMention: true, window }), deps);
  ok(captured !== undefined, "the single-window direct @mention dispatches a wake");
  ok(captured!.message.startsWith("[direct]"), "the delivered wake is the ADDRESSED direct-mention wake (not a silence-biased watch)");
  ok(captured!.message.includes(`wake-id="${wakeId}"`), "the delivered wake renders the wake-id (the reply tool's routing key)");
  ok(JSON.stringify(captured!.window) === JSON.stringify(window), "deps.wake receives the window WITH addressing (its wiring stamps oe_addressing for the prose-delivery bridge)");
}

ok(shouldRotate({ lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young generation is NOT rotated");

{
  const session: LinearSupervisorSession = { token: linearSupervisorToken(TEAM, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const audits: string[] = [];
  let forced = false;
  const wakes: WakeCapture[] = [];
  let first = true;
  const deps: LinearSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { forced = true; return { token: linearSupervisorToken(TEAM, 2), generation: 2, handoffNote: "carried over" }; },
    audit: async (a) => { audits.push(a); },
    now: NOW,
    wake: async (w) => {
      if (first) { first = false; throw new Error("SESSION_TOKEN_LIMIT_REACHED"); }
      wakes.push({ token: w.token, message: w.message, context: w.context });
    },
  };
  await handleLinearSupervisorDispatch(dispatch(), deps);
  ok(forced && audits.includes("linear.session_terminal_death"), "terminal death -> audited force-rotate");
  ok(wakes.length === 1 && wakes[0]!.token === linearSupervisorToken(TEAM, 2), "the trigger is re-delivered ONCE to the fresh generation");
}

{
  const session: LinearSupervisorSession = { token: linearSupervisorToken(TEAM, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const deps: LinearSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { throw new Error("should not be called"); },
    now: NOW,
    wake: async () => { throw new Error("transient network blip"); },
  };
  await assert.rejects(() => handleLinearSupervisorDispatch(dispatch(), deps), /transient network blip/, "a transient (non-terminal) wake error propagates");
  passed++;
}

{
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { rmSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");

  const dir = join(tmpdir(), `open-everywhere-linear-supervisor-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  process.env.LINEAR_ACCESS_TOKEN = "lin_test_token";

  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));

  const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
    const c = new ContextContainer();
    const auth = attributes ? { current: { attributes }, initiator: null } : null;
    c.set(SessionKey, { sessionId: "linear-supervisor-test", auth, turn: 1, parent: undefined });
    return contextStorage.run(c, fn);
  };

  const linearChannelModule = (await import("../agent/channels/linear.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };
  const turnStarted = (ctx: unknown) => linearChannelModule.adapter["turn.started"]!({}, ctx);
  const completed = (message: string | null, ctx: unknown) =>
    linearChannelModule.adapter["message.completed"]!({ finishReason: "stop", message }, ctx);

  const supervisorState = () => ({
    agentSessionId: null,
    organizationId: "org-1",
    oeSupervisor: true as const,
    oeTeamId: TEAM,
    oeReplyTarget: undefined as { issueId: string; parentId?: string } | undefined,
  });

  const realFetch = globalThis.fetch;
  let gql: Array<{ query?: string; variables?: { input?: { issueId?: string; parentId?: string; body?: string } } }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes("api.linear.app")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as (typeof gql)[number];
      gql.push(parsed);
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    {
      const state = supervisorState();
      await inSession(() => turnStarted({ state }), { issue_id: ISSUE, comment_id: "c-top" });
      ok(state.oeReplyTarget?.issueId === ISSUE && state.oeReplyTarget?.parentId === "c-top", "a TOP-LEVEL trigger threads the reply under the trigger comment itself");
      await inSession(() => turnStarted({ state }), { issue_id: ISSUE, comment_id: "c-reply", parent_comment_id: "c-root" });
      ok(state.oeReplyTarget?.parentId === "c-root", "a THREADED trigger threads the reply under the SAME thread root");
      await inSession(() => turnStarted({ state }));
      ok(state.oeReplyTarget === undefined, "no auth anchor CLEARS the target (never carry a stale one forward)");
    }

    {
      const state = supervisorState();
      gql = [];
      await inSession(async () => {
        await turnStarted({ state });
        await completed("shipping tomorrow works — the index backfill finished", { state });
      }, { issue_id: ISSUE, comment_id: "c-top" });
      ok(gql.length === 1 && gql[0]!.query?.includes("commentCreate") === true, "the supervisor reply posts via GraphQL commentCreate");
      const input = gql[0]!.variables?.input;
      ok(input?.issueId === ISSUE && input?.parentId === "c-top" && input?.body?.includes("index backfill") === true, "the reply targets the snapshot issue + thread with the turn's final text");
    }

    {
      const state = supervisorState();
      gql = [];
      await inSession(async () => {
        await turnStarted({ state });
        await completed("this must not post", { state });
      });
      ok(gql.length === 0, "no per-turn target ⇒ the supervisor posts NOTHING (fail safe)");
    }

    {
      const state = { ...supervisorState(), oeUnified: true as const, oeReplyTarget: undefined as { issueId: string; parentId?: string; teamId?: string; organizationId?: string } | undefined };
      gql = [];
      await inSession(async () => {
        await turnStarted({ state });
        await completed("answering the other team's issue", { state });
      }, { issue_id: "issue-uuid-OTHER", comment_id: "c-x", team_id: "team-uuid-2", organization_id: "org-1" });
      ok(state.oeReplyTarget?.teamId === "team-uuid-2" && state.oeReplyTarget?.organizationId === "org-1", "unified turn.started snapshots THIS wake's team/org off the delivery auth");
      ok(gql.length === 1 && gql[0]!.variables?.input?.issueId === "issue-uuid-OTHER", "the unified reply posts into the issue that woke it (fail-open message-tool-only: terminal prose is Linear's only reply route)");
      const { readAudit } = await import("../agent/audit/audit.js");
      const replied = await readAudit({ action: "linear.replied" });
      ok(replied.some((r) => r.surface === "linear/org-1/team-uuid-2"), "the linear.replied audit row names the WAKING container (snapshot team), not the seed team");
      const perTeam = supervisorState();
      await inSession(() => turnStarted({ state: perTeam }), { issue_id: ISSUE, comment_id: "c-top", team_id: "team-uuid-2", organization_id: "org-1" });
      ok(perTeam.oeReplyTarget !== undefined && !("teamId" in (perTeam.oeReplyTarget as Record<string, unknown>)), "non-unified snapshot stays {issueId, parentId} only (byte-identical off)");
    }

    {
      const state = supervisorState();
      gql = [];
      await inSession(async () => {
        await turnStarted({ state });
        await completed("NO_REPLY", { state });
      }, { issue_id: ISSUE, comment_id: "c-top" });
      ok(gql.length === 0, "NO_REPLY suppresses the supervisor reply");
      const { readAudit } = await import("../agent/audit/audit.js");
      const silences = await readAudit({ action: "linear.no_reply" });
      ok(silences.length >= 1, "judged silence writes a linear.no_reply audit row (audited silence, cross-surface parity)");
    }

    {
      const state = supervisorState();
      gql = [];
      await inSession(() => linearChannelModule.adapter["turn.failed"]!({ error: "boom" }, { state }));
      ok(gql.length === 0, "a failed supervisor turn posts NOTHING");
      const { readAudit } = await import("../agent/audit/audit.js");
      const fails = await readAudit({ action: "linear.supervisor_turn_failed" });
      ok(fails.length >= 1, "the failed supervisor turn is audited instead");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { registerTrustedSurfaces, _resetTrustedSurfacesForTest } = await import("../agent/identity/trust.js");
  const { computeMentionRouting } = (await import("../agent/channels/linear.js")) as unknown as {
    computeMentionRouting: (event: unknown, teamId: string | undefined) => Promise<{ routing: string; isPrivate?: boolean }>;
  };

  const ORG = "O_WIN";
  const T_PRIV = "T_PRIV";
  const T_FREE = "T_FREE";
  const T_PUB = "T_PUB";
  const T_PLAIN = "T_PLAIN";
  const skFor = (t: string) => `linear/${ORG}/${t}`;

  const ISSUE_TEAM: Record<string, { teamId: string; isPrivate: boolean }> = {
    "issue-priv": { teamId: T_PRIV, isPrivate: true },
    "issue-free": { teamId: T_FREE, isPrivate: false },
    "issue-pub": { teamId: T_PUB, isPrivate: true },
    "issue-plain": { teamId: T_PLAIN, isPrivate: true },
  };

  registerTrustedSurfaces([skFor(T_PRIV), skFor(T_FREE), skFor(T_PLAIN)]);

  const windowDomain = defineDomain({
    name: "payments",
    channels: [skFor(T_PRIV), skFor(T_FREE), skFor(T_PUB)],
    ambientSupervisor: true,
    mode: "unified",
  });
  const org = defineDomain({ name: "org", match: "org" });

  const baseAppConfig = {
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadSilos: () => [],
    domainsForSurface: () => [],
  };

  process.env.LINEAR_ACCESS_TOKEN = "lin_test_token";
  const realFetch = globalThis.fetch;
  let issueTeamCalls = 0;
  let teamPrivacyCalls = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (!String(input).includes("api.linear.app")) return new Response("unexpected", { status: 500 });
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { id?: string } };
    const id = parsed.variables?.id ?? "";
    if (parsed.query?.includes("OeIssueTeam")) {
      issueTeamCalls++;
      const hit = ISSUE_TEAM[id];
      return new Response(JSON.stringify({ data: { issue: hit ? { team: { id: hit.teamId, private: hit.isPrivate } } : null } }), { status: 200 });
    }
    if (parsed.query?.includes("TeamPrivacy")) {
      teamPrivacyCalls++;
      return new Response(JSON.stringify({ data: { team: { private: id !== T_FREE } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;

  const mkEvent = (issueId: string, sourceCommentId: string | null = "c-mention") => ({
    action: "created",
    kind: "agent_session",
    organizationId: ORG,
    agentSession: { id: "as-1", issueId, sourceCommentId },
    delivery: { event: "AgentSessionEvent", id: `dlv-${issueId}` },
    previousComments: [],
    raw: {},
  });

  const prevWindowTopology = process.env.OE_WINDOW_TOPOLOGY;
  try {
    process.env.OE_WINDOW_TOPOLOGY = "1";
    registerConfig({ ...baseAppConfig, loadDomains: () => [windowDomain, org] });

    issueTeamCalls = 0; teamPrivacyCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-priv"), undefined);
      ok(v.routing === "suppress-and-divert", "FIX: raw parse missed the team → issue→team resolution → VOUCHED single-window mention routes suppress-and-divert (was: native — the dead gate)");
      ok(v.isPrivate === true, "the verdict carries the authoritative team-private SIGNAL (reused by the native binding — enriched at most once)");
      ok(issueTeamCalls === 1 && teamPrivacyCalls === 0, "team + private signal came from ONE issue→team query (no separate TeamPrivacy call)");
    }

    issueTeamCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-free"), undefined);
      ok(v.routing === "suppress-and-divert", "WIDEN: a VOUCHED PUBLIC single-window team DIVERTS (vouch is the floor; team.private===false is just a signal — the Free-plan case)");
      ok(v.isPrivate === false, "the public team's private signal is surfaced (false) but did NOT gate the divert");
    }

    issueTeamCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-pub"), undefined);
      ok(v.routing === "native", "FAIL-CLOSED: an UN-VOUCHED single-window team routes native even though team.private===true (private never admits — the vouch is the sole floor)");
      ok(v.isPrivate === true, "the un-vouched team's private signal is still surfaced (true) but did NOT admit the window");
    }

    issueTeamCalls = 0; teamPrivacyCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-plain"), undefined);
      ok(v.routing === "native", "a resolved team with NO crossSurfaceWindow domain routes native (singleWindow false)");
      ok(teamPrivacyCalls === 0, "non-single-window ⇒ the private signal is never fetched (not needed off the window path)");
    }

    issueTeamCalls = 0; teamPrivacyCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-priv"), T_PRIV);
      ok(v.routing === "suppress-and-divert", "raw fast-path: team already parsed → VOUCHED single-window → suppress-and-divert");
      ok(issueTeamCalls === 0 && teamPrivacyCalls === 1, "fast path makes NO issue→team call and enriches the private signal by team id (byte-identical to pre-fix)");
    }

    process.env.OE_WINDOW_TOPOLOGY = "0";
    registerConfig({ ...baseAppConfig, loadDomains: () => [windowDomain, org] });
    issueTeamCalls = 0; teamPrivacyCalls = 0;
    {
      const v = await computeMentionRouting(mkEvent("issue-priv"), undefined);
      ok(v.routing === "native", "window-topology code gate OFF → mention routes native (single-window inert)");
      ok(issueTeamCalls === 0 && teamPrivacyCalls === 0, "feature OFF ⇒ ZERO Linear API calls (byte-identical: no network added on non-single-window deployments)");
    }
  } finally {
    if (prevWindowTopology === undefined) delete process.env.OE_WINDOW_TOPOLOGY;
    else process.env.OE_WINDOW_TOPOLOGY = prevWindowTopology;
    globalThis.fetch = realFetch;
    _resetTrustedSurfacesForTest();
  }
}

console.log(`\n✓ linear-supervisor: ${passed} assertions passed`);
