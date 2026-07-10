
import assert from "node:assert/strict";
import {
  linearSupervisorToken,
  linearSupervisorSentinel,
  extractLinearCommentSignal,
  classifyLinearAmbientComment,
  buildLinearSupervisorWake,
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

console.log(`\n✓ linear-supervisor: ${passed} assertions passed`);
