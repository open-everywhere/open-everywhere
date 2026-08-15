
import assert from "node:assert/strict";
import {
  githubSupervisorToken,
  githubSupervisorSentinel,
  classifyGitHubAmbientComment,
  extractGitHubAmbientEvent,
  buildGitHubSupervisorWake,
  handleGitHubSupervisorDispatch,
  shouldRotate,
  type GitHubSupervisorDeps,
  type GitHubSupervisorDispatch,
  type GitHubSupervisorSession,
  type GitHubAmbientComment,
} from "../agent/channels/github-supervisor.js";
import { renderWake, UNTRUSTED_OPEN, OE_CHAT_NONMEMBER_ATTR, defineSurface, registerSurfaces, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { OpenEverywhereGitHubAuth } from "../agent/channels/github-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SLUG = "open-everywhere";
const OWNER = "acme";
const REPO = "widgets";
const NOW = () => "2026-02-18T14:05:00.000Z";

ok(githubSupervisorSentinel(3) === "oe-sup:g3", "sentinel is oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 1) === `github:${OWNER}/${REPO}:oe-sup:g1`, "token is github:<owner>/<repo>:oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 2).includes(":oe-sup:g"), "token carries the :oe-sup:g infix hooks/spend + the supervisor model role key on");

const base: GitHubAmbientComment = { body: "looks good, shipping this after lunch", authorLogin: "human-dev", authorType: "User", repoPrivate: true };

ok(classifyGitHubAmbientComment(base, SLUG).addressing === "channel-watch", "plain comment on a private repo -> channel-watch (judged)");
ok(classifyGitHubAmbientComment({ ...base, body: `hey @${SLUG} can you review this` }, SLUG).addressing === "drop", "bot @mention -> DROP (owned by the native path — the two legs partition, never overlap)");
ok(classifyGitHubAmbientComment({ ...base, body: `email me at foo@${SLUG}rocks.dev` }, SLUG).addressing === "channel-watch", "an @slug with a trailing word-char is NOT a mention (matches the native gate) -> judged");
ok(classifyGitHubAmbientComment(base, undefined).addressing === "drop", "no bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment(base, "  ").addressing === "drop", "blank bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: `${SLUG}[bot]` }, SLUG).addressing === "drop", "self-authored ([bot] reply) -> DROP");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: "dependabot[bot]" }, SLUG).addressing === "drop", "other bot-authored -> DROP (bot-to-bot loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "User", authorLogin: `${SLUG.toUpperCase()}[BOT]` }, SLUG).addressing === "drop", "own login under a mislabelled type still DROPs (belt-and-braces, case-insensitive)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: false }, SLUG).addressing === "drop", "PUBLIC + un-vouched repo -> DROP (no drive-by ambient wakes)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: undefined }, SLUG).addressing === "drop", "UNKNOWN privacy + un-vouched repo -> DROP (fail closed)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: false }, SLUG, { vouched: true }).addressing === "channel-watch", "PUBLIC but VOUCHED repo -> channel-watch (vouch widens ambient; private flag is just a signal)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: true }, SLUG, { vouched: false }).addressing === "channel-watch", "PRIVATE un-vouched repo still ambient-wakes (per-repo path unchanged — never narrowed)");

const mention = { ...base, body: `hey @${SLUG} does this match what we agreed in Slack?` };
ok(classifyGitHubAmbientComment(mention, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "direct", "single-window @mention on a VOUCHED repo -> direct (the unified window answers it, native suppressed)");
ok(classifyGitHubAmbientComment({ ...mention, repoPrivate: false }, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "direct", "single-window @mention on a VOUCHED PUBLIC repo -> direct (vouch is the floor; private flag ignored — the Free-plan case)");
ok(classifyGitHubAmbientComment(mention, SLUG).addressing === "drop", "the SAME @mention WITHOUT treatMentionAsDirect -> DROP (byte-identical default; native path owns it)");
ok(classifyGitHubAmbientComment(mention, SLUG, { treatMentionAsDirect: true, vouched: false }).addressing === "drop", "single-window @mention on an UN-VOUCHED repo -> DROP (native NOT suppressed there — no double-handle, fail-closed)");
ok(classifyGitHubAmbientComment({ ...mention, repoPrivate: true }, SLUG, { treatMentionAsDirect: true }).addressing === "drop", "single-window @mention, PRIVATE but un-vouched -> DROP (private flag never admits the window — the vouch is the floor)");
ok(classifyGitHubAmbientComment(base, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "channel-watch", "a NON-mention comment is unaffected by treatMentionAsDirect -> channel-watch (judged)");

const trigger = { id: "ic-42", authorLogin: "human-dev", sentAt: "2026-03-24T18:51:00Z", text: "should we bump the retry budget here?", trust: "unauth" as const };
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries on cold start", trigger, engagementTier: "reserved" });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("[channel-watch]"), "wake leads with the judged preamble");
  ok(message.includes("you are this repo's standing session"), "wake uses the REPO container noun");
  ok(message.includes("Calibration for this repo: RESERVED"), "the reserved calibration sentence rides the preamble (GitHub's platform default tier)");
  ok(message.includes(`<channel id="${OWNER}/${REPO}">`), "locus.channel = owner/repo (the silo grain)");
  ok(message.includes(`<thread ts="#42">`), "locus.thread = the issue number (the conversation the comment belongs to)");
  ok(message.includes(`trigger="true"`) && message.includes("should we bump the retry budget here?"), "the comment is the trigger message");
  ok(message.includes(UNTRUSTED_OPEN), "an UNVOUCHED author's comment body is untrusted-wrapped by the envelope");
  ok(context !== undefined && context.length === 1 && context[0]!.includes("Flaky retries on cold start"), "the issue title rides an untrusted-wrapped context block");
  ok(context![0]!.includes(UNTRUSTED_OPEN), "the title context is untrusted-wrapped too (payload-supplied text)");

  const member = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries on cold start", trigger: { ...trigger, trust: "peer" }, engagementTier: "reserved" }), NOW);
  ok(member.message.includes("should we bump the retry budget here?"), "the member's comment still renders verbatim");
  ok(!member.message.includes(UNTRUSTED_OPEN), "a PEER-authored comment body is NOT untrusted-wrapped (OPE-577 — the fence keys on the author)");
  ok(member.context![0]!.includes(UNTRUSTED_OPEN), "…and the issue TITLE stays fenced regardless of who commented — it is payload text, not an authored message");
}
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger });
  const { message, context } = renderWake(nw, NOW);
  ok(context === undefined, "no issue title -> no context block");
  ok(!message.includes("Calibration for this"), "no tier -> neutral -> no calibration sentence (byte-identical preamble)");
}
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger, handoffNote: "Open asks: the retry-budget question in #42.", handoffFromGeneration: 1 });
  const { message } = renderWake(nw, NOW);
  ok(message.includes("Open asks: the retry-budget question in #42."), "a handoff note renders in the wake");
  ok(message.includes(`from-generation="1"`), "the handoff note is attributed to the outgoing generation");
}
{
  const plain = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, trigger }), NOW);
  const unified = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, trigger, unified: true }), NOW);
  ok(unified.message.includes(`<channel platform="github" id="${OWNER}/${REPO}">`), "unified wake stamps the <channel platform=\"github\"> surface address");
  ok(unified.message.includes("Cross-surface disclosure:"), "unified wake appends the P5 advisory disclosure to the judged preamble");
  ok(!plain.message.includes("platform="), "per-repo wake carries NO platform attribute");
  ok(!plain.message.includes("Cross-surface disclosure"), "per-repo wake carries NO disclosure sentence");
  const explicitOff = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, trigger, unified: false }), NOW);
  ok(explicitOff.message === plain.message, "unified:false renders BYTE-IDENTICAL to the unset per-repo wake (flag-off invariant)");
}

{
  const wakeId = "wk-abc-123";
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, unified: true, directMention: true, wakeId });
  const { message } = renderWake(nw, NOW);
  ok(message.startsWith("[direct]"), "direct-mention leads with the ADDRESSED preamble, not [channel-watch]");
  ok(!message.includes("[channel-watch]"), "direct-mention does NOT use the silence-biased watch preamble");
  ok(message.includes("addressed to you and is asking for a response"), "direct-mention tells the supervisor it is addressed and owes a reply");
  ok(!message.includes("the bar to reply is high"), "direct-mention drops the watch preamble's high-bar silence framing");
  ok(message.includes(`<wake reason="mention"`), "direct-mention keeps the full judged envelope (reason=\"mention\")");
  ok(message.includes(`wake-id="${wakeId}"`), "the wake-id survives in the envelope — the reply tool echoes it (the only reply route on the unified channel)");
  ok(message.includes(`mention="true"`), "the trigger is flagged as a @mention (response-obligation signal)");
  ok(message.includes(`<channel platform="github" id="${OWNER}/${REPO}">`), "the surface address rides the unified addressed wake");
  ok(message.includes("Cross-surface disclosure:"), "the P5 cross-surface disclosure still rides the addressed wake");
  ok(message.includes(UNTRUSTED_OPEN), "the comment body is still untrusted-wrapped by the envelope (W1 holds on the addressed path)");
}
{
  const off = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved", directMention: false }), NOW);
  const plain = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved" }), NOW);
  ok(off.message === plain.message, "directMention:false renders BYTE-IDENTICAL to the unset channel-watch wake (flag-off invariant)");
  ok(JSON.stringify(off.context) === JSON.stringify(plain.context), "directMention:false context is byte-identical too");
  ok(off.message.startsWith("[channel-watch]"), "the flag-off wake is still the silence-biased channel-watch ambient wake");
}

{
  const payload = {
    action: "created",
    issue: { number: 42, title: "Flaky retries on cold start" },
    comment: { id: 9001, body: "should we bump the retry budget?", user: { login: "human-dev", type: "User", id: 7 }, author_association: "MEMBER", created_at: "2026-03-24T18:51:00Z" },
    repository: { name: REPO, full_name: `${OWNER}/${REPO}`, id: 555, private: true, owner: { login: OWNER } },
    installation: { id: 4242 },
  } as unknown as Record<string, unknown>;
  const ev = extractGitHubAmbientEvent("issue_comment", payload);
  ok(ev !== null, "issue_comment created -> ambient candidate");
  ok(ev!.owner === OWNER && ev!.repo === REPO && ev!.issueNumber === 42, "extractor reads owner/repo/issue");
  ok(ev!.repoPrivate === true && ev!.installationId === 4242 && ev!.repositoryId === 555, "extractor reads privacy/installation/repo id");
  ok(ev!.comment.authorLogin === "human-dev" && ev!.comment.authorAssociation === "MEMBER" && ev!.comment.id === "9001", "extractor reads the comment author facts");
  ok(ev!.isPullRequest === false, "no issue.pull_request marker -> not a PR timeline comment");
  const prEv = extractGitHubAmbientEvent("issue_comment", { ...payload, issue: { number: 7, title: "t", pull_request: { url: "x" } } });
  ok(prEv !== null && prEv.isPullRequest === true && prEv.issueNumber === 7, "issue.pull_request marker -> PR timeline comment (same number space)");
  ok(extractGitHubAmbientEvent("issue_comment", { ...payload, action: "edited" }) === null, "edited comments are not ambient candidates (v1)");
  ok(extractGitHubAmbientEvent("pull_request_review_comment", payload) === null, "review-thread inline comments are out of ambient scope (v1)");
  ok(extractGitHubAmbientEvent("issues", payload) === null, "non-comment events are not ambient candidates");
  ok(extractGitHubAmbientEvent("issue_comment", { action: "created" }) === null, "a payload missing repo/issue/comment yields null (defensive)");
}

const AUTH: OpenEverywhereGitHubAuth = { authenticator: "github", principalId: "human-dev", principalType: "github-user", attributes: { owner: OWNER, repo: REPO, issue_number: "42" } };
const SURFACE = `github/${OWNER}/${REPO}`;

function dispatch(over: Partial<GitHubSupervisorDispatch> = {}): GitHubSupervisorDispatch {
  return { surfaceKey: SURFACE, owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries", auth: AUTH, trigger, engagementTier: "reserved", ingested: [], ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[] }

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: true, handoffNote: null };
  const wakes: WakeCapture[] = [];
  const touched: string[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async (sk) => { touched.push(sk); },
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context }); },
    now: NOW,
  };
  await handleGitHubSupervisorDispatch(dispatch(), deps);
  ok(wakes.length === 1, "dispatch wakes once");
  ok(wakes[0]!.token === githubSupervisorToken(OWNER, REPO, 1), "wake uses the supervisor continuation token (the :oe-sup:g infix)");
  ok(wakes[0]!.message.includes("you are this repo's standing session"), "the delivered message is the repo-supervisor wake");
  ok(touched.length === 1 && touched[0] === SURFACE, "touchSession records the wake on the current generation");
  await handleGitHubSupervisorDispatch(dispatch({ unified: true }), deps);
  ok(wakes[1]!.message.includes(`<channel platform="github" id="${OWNER}/${REPO}">`), "a unified dispatch stamps the surface address on the delivered wake");
  ok(!wakes[0]!.message.includes("platform="), "the non-unified dispatch's wake stays unstamped (byte-identical off)");
}

{
  const token = "oe-dom:acme-eng:oe-sup:g1";
  const session: GitHubSupervisorSession = { token, generation: 1, freshGeneration: false, handoffNote: null };
  const wakeId = "wk-dispatch-1";
  const window = { wakeId, origin: { platform: "github" as const, owner: OWNER, repo: REPO, issueNumber: 42, installationId: 4242 } };
  let captured: { message: string; window: unknown } | undefined;
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { captured = { message: w.message, window: w.window }; },
    now: NOW,
  };
  await handleGitHubSupervisorDispatch(dispatch({ unified: true, directMention: true, window }), deps);
  ok(captured !== undefined, "the single-window direct @mention dispatches a wake");
  ok(captured!.message.startsWith("[direct]"), "the delivered wake is the ADDRESSED direct-mention wake (not a silence-biased watch)");
  ok(captured!.message.includes(`wake-id="${wakeId}"`), "the delivered wake renders the wake-id (the reply tool's routing key)");
  ok(JSON.stringify(captured!.window) === JSON.stringify(window), "deps.wake receives the window (its wiring diverts into the unified channel + registers the reply-target map)");
}

ok(shouldRotate({ createdAt: NOW(), lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young, low-token generation is NOT rotated");
ok(shouldRotate({ createdAt: NOW(), lastWakeAt: "2026-07-01T00:00:00Z", turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: a stale (quiet-gap) generation rotates");
ok(shouldRotate({ createdAt: "2026-05-01T00:00:00Z", lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: an AGED generation rotates even when just woken (OPE-345 expiry)");

for (const [label, err] of [
  ["a gateway blip", new Error("transient network blip")],
  ["an eve session-limit-shaped error", new Error("SESSION_TOKEN_LIMIT_REACHED")],
] as const) {
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: false, handoffNote: null };
  let touched = false;
  const wakes: WakeCapture[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async () => { touched = true; },
    now: NOW,
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context }); throw err; },
  };
  await assert.rejects(() => handleGitHubSupervisorDispatch(dispatch(), deps), /transient network blip|SESSION_TOKEN_LIMIT_REACHED/, `${label} propagates out of the dispatch`);
  passed++;
  ok(wakes.length === 1, `${label}: exactly one wake attempt (no retry, no rotate-and-redeliver)`);
  ok(!touched, `${label}: the session is NOT touched`);
}

{
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { rmSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");

  const dir = join(tmpdir(), `open-everywhere-github-supervisor-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  process.env.GITHUB_APP_SLUG = SLUG;

  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));

  const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
    const c = new ContextContainer();
    const auth = attributes ? { current: { attributes }, initiator: null } : null;
    c.set(SessionKey, { sessionId: "github-supervisor-test", auth, turn: 1, parent: undefined });
    return contextStorage.run(c, fn);
  };

  const githubChannelModule = (await import("../agent/channels/github.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };

  const { shouldSuppressNativeMention } = await import("../agent/channels/github.js");
  ok(shouldSuppressNativeMention(true, true) === true, "single-window VOUCHED repo -> native mention SUPPRESSED (the unified window answers it instead)");
  ok(shouldSuppressNativeMention(true, false) === false, "single-window UN-VOUCHED repo -> native KEPT (ambient drops mentions there — no gap, no reply lost; fail-closed)");
  ok(shouldSuppressNativeMention(false, true) === false, "NON-single-window repo -> native KEPT (byte-identical: the native mention session engages exactly as today)");
  const turnStarted = (ctx: unknown) => githubChannelModule.adapter["turn.started"]!({}, ctx);
  const completed = (message: string | null, ctx: unknown) =>
    githubChannelModule.adapter["message.completed"]!({ finishReason: "stop", message }, ctx);

  const supervisorState = () => ({
    baseRef: null, baseSha: null, checkoutPath: null, conversationKind: "issue", defaultBranch: null,
    headRef: null, headSha: null, installationId: 4242, issueNumber: null, owner: OWNER,
    pullRequestNumber: null, repo: REPO, repositoryId: 555, reviewCommentId: null,
    reviewThreadRootCommentId: null, triggeringCommentId: null, triggeringUserLogin: null,
    oeSupervisor: true as const,
    oeReplyTarget: undefined as { issueNumber: number } | undefined,
  });

  {
    const state = supervisorState();
    await inSession(() => turnStarted({ state }), { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(state.oeReplyTarget?.issueNumber === 42, "turn.started snapshots the issue_number auth attribute as the reply target");
    await inSession(() => turnStarted({ state }), { owner: OWNER, repo: REPO, pull_request_number: "7" });
    ok(state.oeReplyTarget?.issueNumber === 7, "a PR timeline comment's pull_request_number anchors the SAME endpoint (issues/{n}/comments)");
    await inSession(() => turnStarted({ state }));
    ok(state.oeReplyTarget === undefined, "no auth anchor CLEARS the target (never carry a stale one forward)");
  }

  {
    const state = supervisorState();
    const posts: Array<{ method: string; path: string; body: unknown }> = [];
    const github = { request: async (input: { method: string; path: string; body?: unknown }) => { posts.push({ method: input.method, path: input.path, body: input.body }); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("the retry budget is fine — the flake is the cold-start race", { state, github });
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(posts.length === 1 && posts[0]!.method === "POST" && posts[0]!.path === `/repos/${OWNER}/${REPO}/issues/42/comments`, "the supervisor reply posts to the snapshot issue via installation-auth REST");
    ok((posts[0]!.body as { body?: string }).body?.includes("cold-start race") === true, "the reply body is the turn's final text");
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("this must not post", { state, github });
    });
    ok(posts.length === 0, "no per-turn target ⇒ the supervisor posts NOTHING (fail safe)");
  }

  {
    const state = { ...supervisorState(), oeUnified: true as const, oeReplyTarget: undefined as { issueNumber: number; owner?: string; repo?: string } | undefined };
    const posts: Array<{ path: string }> = [];
    const github = { request: async (input: { path: string }) => { posts.push({ path: input.path }); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("cross-repo answer", { state, github });
    }, { owner: "acme", repo: "payments-api", issue_number: "9" });
    ok(state.oeReplyTarget?.owner === "acme" && state.oeReplyTarget?.repo === "payments-api", "unified turn.started snapshots THIS wake's owner/repo off the delivery auth");
    ok(posts.length === 1 && posts[0]!.path === "/repos/acme/payments-api/issues/9/comments", "the unified reply posts into the repo that woke it, NOT the session's seed repo");
    posts.length = 0;
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("this must not post", { state, github });
    }, { issue_number: "9" });
    ok(state.oeReplyTarget === undefined, "unified path: a wake without owner/repo auth CLEARS the target");
    ok(posts.length === 0, "unified path: cleared target ⇒ posts NOTHING (never the seed repo)");
    const perRepo = supervisorState();
    await inSession(() => turnStarted({ state: perRepo, github }), { owner: "someone", repo: "elsewhere", issue_number: "3" });
    ok(perRepo.oeReplyTarget !== undefined && !("owner" in (perRepo.oeReplyTarget as Record<string, unknown>)), "non-unified snapshot stays {issueNumber} only (byte-identical off)");
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("NO_REPLY", { state, github });
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(posts.length === 0, "NO_REPLY suppresses the supervisor reply");
    const { readAudit } = await import("@open-everywhere/core/agent/adapter-api.js");
    const silences = await readAudit({ action: "github.no_reply" });
    ok(silences.length >= 1, "judged silence writes a github.no_reply audit row (audited silence, Slack/Notion parity)");
  }

  {
    const { markSilentRoutineTurn } = await import("@open-everywhere/core/agent/adapter-api.js");
    const nonSupervisor = { ...supervisorState(), oeSupervisor: undefined, issueNumber: 42 };
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    let threw: unknown = null;
    await inSession(async () => {
      markSilentRoutineTurn();
      try {
        await completed("NO_REPLY", { state: nonSupervisor, github });
      } catch (err) {
        threw = err;
      }
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(
      posts.length === 0 && threw === null,
      "SILENT routine: a non-supervisor github turn is DROPPED before eve's default poster (else it comments the literal string NO_REPLY)",
    );
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(() => githubChannelModule.adapter["turn.failed"]!({ error: "boom" }, { state, github }));
    ok(posts.length === 0, "a failed supervisor turn posts NO error comment (reserved posture)");
    const { readAudit } = await import("@open-everywhere/core/agent/adapter-api.js");
    const fails = await readAudit({ action: "github.supervisor_turn_failed" });
    ok(fails.length >= 1, "the failed supervisor turn is audited instead");
  }
}

{
  const ghWake = buildGitHubSupervisorWake({
    owner: OWNER, repo: REPO, issueNumber: 7,
    trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "principal" },
  });
  ok(ghWake.trigger.kind === "message" && ghWake.trigger.message.trust === "principal", "github builder: a resolved trigger trust rides into the wake");
  const ghDefault = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm" } });
  ok(ghDefault.trigger.kind === "message" && ghDefault.trigger.message.trust === "peer", "github builder: unset trust keeps the legacy peer (byte-compat for pure callers)");
}

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: true, handoffNote: null };
  const auths: OpenEverywhereGitHubAuth[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { auths.push(w.auth); },
    now: NOW,
  };
  const attrsOf = (a: OpenEverywhereGitHubAuth): Record<string, unknown> => (a.attributes ?? {}) as Record<string, unknown>;

  _resetSurfacesForTest();

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{ refuted: true }] }), deps);
  ok(attrsOf(auths[0]!)[OE_CHAT_NONMEMBER_ATTR] === "true", "taint carriage: a refuted author stamps oe_chat_nonmember on the auth the wake dep receives");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(attrsOf(auths[1]!)[OE_CHAT_NONMEMBER_ATTR] === undefined, "taint carriage: an unrefuted author leaves oe_chat_nonmember ABSENT (negative control)");
  ok(auths[1] === AUTH, "taint carriage: an unmarked wake passes the caller's auth BY REFERENCE — byte-identical to before this existed");
  ok(attrsOf(AUTH)[OE_CHAT_NONMEMBER_ATTR] === undefined, "taint carriage: the stamp never mutates the caller's auth");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [] }), deps);
  ok(auths[2] === AUTH, "taint carriage: an empty ingested set marks nothing (negative control)");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{ trust: "relay", refuted: true }] }), deps);
  ok(auths[3] === AUTH, "taint carriage: a `relay` author never marks, even when refuted (negative control — the machine floor)");

  registerSurfaces([defineSurface({ key: SURFACE, trust: "public" })]);
  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(attrsOf(auths[4]!)[OE_CHAT_NONMEMBER_ATTR] === "true", "taint carriage: a repo declared `public` marks through the ROOM leg with no refuted author");
  _resetSurfacesForTest();

  registerSurfaces([defineSurface({ key: SURFACE, trust: "internal" })]);
  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(auths[5] === AUTH, "taint carriage: a repo declared `internal` marks nothing (negative control)");
  _resetSurfacesForTest();
}

console.log(`\n✓ github-supervisor: ${passed} assertions passed`);
