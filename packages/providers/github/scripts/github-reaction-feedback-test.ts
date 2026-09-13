import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { IngestedReaction, ReactionSinkDeps } from "@open-everywhere/core/agent/adapter-api.js";
import type { GitHubPolledComment, GitHubReactionFeedbackDeps, GitHubReactionPollTarget } from "../agent/channels/github-reaction-feedback.js";

const dir = join(tmpdir(), `open-everywhere-github-reaction-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.OE_TELEMETRY = "off";

const OWNER = "acme";
const REPO = "widgets";
const NUMBER = 42;
const INSTALLATION = 777;
const SLUG = "oe-test";
const BOT_LOGIN = `${SLUG}[bot]`;
const AGENT_COMMENT = 5001;
const HUMAN_COMMENT = 5002;

interface StubCall {
  readonly method: string;
  readonly url: string;
}
const calls: StubCall[] = [];
let timeline: { id: number; login: string; type: string; reactions: number }[] = [];
let reactionsPage: unknown[] = [];

const PAGE = 100;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string }): Promise<Response> => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url });
  if (method === "POST" && url.includes(`/app/installations/${INSTALLATION}/access_tokens`)) {
    return new Response(JSON.stringify({ token: "ghs_stub", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: `${OWNER}/${REPO}` }] }), { status: 200 });
  }
  if (method === "GET" && url.includes(`/repos/${OWNER}/${REPO}/issues/${NUMBER}/comments`)) {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const slice = timeline.slice((page - 1) * PAGE, page * PAGE);
    return new Response(JSON.stringify(slice.map((c) => ({ id: c.id, user: { login: c.login, type: c.type }, reactions: { total_count: c.reactions } }))), { status: 200 });
  }
  if (method === "GET" && url.endsWith(`/repos/${OWNER}/${REPO}/issues/${NUMBER}`)) {
    return new Response(JSON.stringify({ number: NUMBER, comments: timeline.length }), { status: 200 });
  }
  if (method === "GET" && url.includes(`/repos/${OWNER}/${REPO}/issues/comments/${AGENT_COMMENT}/reactions`)) {
    return new Response(JSON.stringify(reactionsPage), { status: 200 });
  }
  return new Response("stub: unrouted", { status: 404 });
}) as typeof globalThis.fetch;

const { REACTION_FEEDBACK_ACTION, classifyEmoji, deploymentOrg, overrideSettingsForTest, readAudit } = await import("@open-everywhere/core/agent/adapter-api.js");
const {
  GITHUB_REACTION_POLL_COMMENT_BUDGET,
  githubCommentIsOwn,
  githubReactionKey,
  parseGitHubReactionPollTarget,
  routeGitHubReactionFeedback,
} = await import("../agent/channels/github-reaction-feedback.js");
const { markGitHubConversationPosted } = await import("../agent/channels/github-reaction-scope.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function delivery(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "created",
    repository: { name: REPO, owner: { login: OWNER }, private: false },
    issue: { number: NUMBER },
    comment: { id: 1, body: "thanks", user: { login: "octocat", type: "User" } },
    installation: { id: INSTALLATION },
    ...over,
  });
}

const TARGET: GitHubReactionPollTarget = { owner: OWNER, repo: REPO, number: NUMBER, installationId: INSTALLATION, repoPrivate: false };

function captureSink(): { sink: ReactionSinkDeps; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const recorded: IngestedReaction[] = [];
  const telem: IngestedReaction[] = [];
  return { sink: { record: async (r) => void recorded.push(r), telemetry: (r) => void telem.push(r) }, recorded, telem };
}

const AGENT_COMMENT_ROW: GitHubPolledComment = { id: AGENT_COMMENT, authorLogin: BOT_LOGIN, authorType: "Bot", reactionCount: 1 };
const HUMAN_COMMENT_ROW: GitHubPolledComment = { id: HUMAN_COMMENT, authorLogin: "octocat", authorType: "User", reactionCount: 3 };

function stubDeps(over: Partial<GitHubReactionFeedbackDeps> = {}): {
  deps: GitHubReactionFeedbackDeps;
  recorded: IngestedReaction[];
  telem: IngestedReaction[];
  asked: number[];
  claims: Set<string>;
} {
  const s = captureSink();
  const asked: number[] = [];
  const claims = new Set<string>();
  return {
    recorded: s.recorded,
    telem: s.telem,
    asked,
    claims,
    deps: {
      sink: s.sink,
      botLogin: BOT_LOGIN,
      listComments: async () => [AGENT_COMMENT_ROW, HUMAN_COMMENT_ROW],
      listReactions: async (_t, id) => {
        asked.push(id);
        return [{ content: "+1", userLogin: "octocat" }];
      },
      recorded: async (_p, key) => claims.has(key),
      markRecorded: async (_p, key) => void claims.add(key),
      inScope: async () => true,
      spendBudget: async () => true,
      ...over,
    },
  };
}

{
  const t = parseGitHubReactionPollTarget(delivery(), "issue_comment");
  ok(t?.owner === OWNER && t.repo === REPO && t.number === NUMBER, "an issue_comment delivery names its conversation");
  ok(t?.installationId === INSTALLATION, "…and the installation the read will mint a token for");
  ok(t?.repoPrivate === false, "…and the repo's visibility, which the binding needs");

  ok(parseGitHubReactionPollTarget(delivery({ comment: undefined }), "issues") !== null, "an `issues` delivery names one too — a poll is about the conversation, not a comment");
  const pr = JSON.stringify({ repository: { name: REPO, owner: { login: OWNER } }, pull_request: { number: 7 } });
  ok(parseGitHubReactionPollTarget(pr, "issue_comment")?.number === 7, "a payload carrying only `pull_request` resolves its number");

  ok(parseGitHubReactionPollTarget(delivery(), "push") === null, "negative control: a `push` delivery names no conversation to poll");
  ok(parseGitHubReactionPollTarget(delivery(), "pull_request_review_comment") === null, "negative control: a review-comment delivery is not in the poll's event set");
  ok(parseGitHubReactionPollTarget("not json at all", "issue_comment") === null, "an unparseable body yields null, never a throw");
  ok(parseGitHubReactionPollTarget(JSON.stringify({ repository: { name: REPO } }), "issue_comment") === null, "a body with no owner yields null");
}

{
  ok(githubCommentIsOwn(AGENT_COMMENT_ROW, BOT_LOGIN), "the App's own comment is recognised");
  ok(githubCommentIsOwn({ ...AGENT_COMMENT_ROW, authorLogin: BOT_LOGIN.toUpperCase() }, BOT_LOGIN), "…case-insensitively, as GitHub logins are");
  ok(!githubCommentIsOwn(HUMAN_COMMENT_ROW, BOT_LOGIN), "a person's comment is not");
  ok(!githubCommentIsOwn({ id: 1, authorLogin: BOT_LOGIN, authorType: "User" }, BOT_LOGIN), "a USER account wearing the bot login is not — the type must agree");
  ok(!githubCommentIsOwn({ id: 1, authorLogin: "other-app[bot]", authorType: "Bot" }, BOT_LOGIN), "another App's comment is not — the login must agree");
  ok(!githubCommentIsOwn(AGENT_COMMENT_ROW, undefined), "and with no configured slug, nothing is the agent's own");
}

{
  let listed = 0;
  const d = stubDeps({
    botLogin: undefined,
    listComments: async () => {
      listed++;
      return [AGENT_COMMENT_ROW];
    },
  });
  const out = await routeGitHubReactionFeedback(TARGET, d.deps);
  ok(out.length === 0, "🔴 no configured slug ⇒ nothing is ingested");
  ok(listed === 0, "…and nothing is even READ — the refusal is before the first request");

  const control = stubDeps();
  ok((await routeGitHubReactionFeedback(TARGET, control.deps)).length === 1, "negative control: with the slug configured the same poll records");
}

{
  const d = stubDeps();
  const out = await routeGitHubReactionFeedback(TARGET, d.deps);
  ok(out.length === 1 && out[0]!.recorded === true, "a reaction on the agent's own comment is recorded");
  ok(d.asked.length === 1 && d.asked[0] === AGENT_COMMENT, "…and ONLY the agent's own comment is asked about — never the person's");
  const r = d.recorded[0]!;
  ok(r.surface === "github" && r.verb === "added", "the row names the github surface, and only ever an ADD — a poll cannot see a removal");
  ok(r.reactorId === "octocat" && r.emoji === "+1", "…the reactor and the glyph GitHub's fixed enum sent");
  ok(r.target.channelId === `${OWNER}/${REPO}#${NUMBER}` && r.target.messageId === String(AGENT_COMMENT), "…keyed on the conversation and the reacted comment");
  ok(r.onBotReply === true, "…marked as the feedback case, which is structurally true here");

  const self = stubDeps({ listReactions: async () => [{ content: "eyes", userLogin: BOT_LOGIN }] });
  ok((await routeGitHubReactionFeedback(TARGET, self.deps)).length === 0, "the agent's own reaction is skipped — never feedback");
  ok(self.recorded.length === 0, "…and writes nothing");

  const quiet = stubDeps({ listComments: async () => [{ ...AGENT_COMMENT_ROW, reactionCount: 0 }] });
  ok((await routeGitHubReactionFeedback(TARGET, quiet.deps)).length === 0, "a comment with no reactions yields nothing");
  ok(quiet.asked.length === 0, "…and costs no second request");

  const broken = stubDeps({
    listComments: async () => {
      throw new Error("GitHub 502");
    },
  });
  ok((await routeGitHubReactionFeedback(TARGET, broken.deps)).length === 0, "a failing comment read yields nothing and does not propagate");
  const brokenReactions = stubDeps({
    listReactions: async () => {
      throw new Error("GitHub 502");
    },
  });
  ok((await routeGitHubReactionFeedback(TARGET, brokenReactions.deps)).length === 0, "a failing reaction read skips that comment and does not propagate");
}

{
  const key = githubReactionKey(String(AGENT_COMMENT), "octocat", "+1");
  const already = stubDeps();
  already.claims.add(key);
  ok((await routeGitHubReactionFeedback(TARGET, already.deps)).length === 0, "🔴 a reaction the claim store already holds is NOT recorded twice");
  ok(already.recorded.length === 0, "…and reaches no sink");

  const elsewhere = stubDeps();
  elsewhere.claims.add(githubReactionKey("999999", "octocat", "+1"));
  ok((await routeGitHubReactionFeedback(TARGET, elsewhere.deps)).length === 1, "a claim on another comment's reaction silences nothing here");

  const twice = stubDeps({ listComments: async () => [AGENT_COMMENT_ROW, AGENT_COMMENT_ROW] });
  ok((await routeGitHubReactionFeedback(TARGET, twice.deps)).length === 1, "the same comment listed twice in one poll records once");

  const other = stubDeps({
    listReactions: async () => [
      { content: "+1", userLogin: "octocat" },
      { content: "heart", userLogin: "octocat" },
    ],
  });
  other.claims.add(key);
  ok((await routeGitHubReactionFeedback(TARGET, other.deps)).length === 1, "negative control: a different glyph from the same person IS a new row");
  ok(other.recorded[0]!.emoji === "heart", "…and it is the new one");

  const twoPolls = stubDeps();
  ok((await routeGitHubReactionFeedback(TARGET, twoPolls.deps)).length === 1, "the first poll records the reaction");
  ok(twoPolls.claims.has(key), "…and claims its key");
  ok((await routeGitHubReactionFeedback(TARGET, twoPolls.deps)).length === 0, "🔴 …so the second poll over the same state records nothing");

  const lost = stubDeps({
    sink: {
      record: async () => {
        throw new Error("audit store down");
      },
      telemetry: () => undefined,
    },
  });
  const lostOut = await routeGitHubReactionFeedback(TARGET, lost.deps);
  ok(lostOut.length === 1 && lostOut[0]!.recorded === false, "a failing sink yields an outcome that says the row was not recorded");
  ok(lost.claims.size === 0, "🔴 …and claims NOTHING, so the next poll tries the reaction again");

  const audits: number[] = [];
  const unreadable = stubDeps({
    recorded: async () => {
      throw new Error("store down");
    },
    listReactions: async () => [
      { content: "+1", userLogin: "octocat" },
      { content: "heart", userLogin: "hubot" },
      { content: "rocket", userLogin: "monalisa" },
    ],
    auditClaimUnreadable: async (_t, _p, _at, skipped) => void audits.push(skipped),
  });
  ok((await routeGitHubReactionFeedback(TARGET, unreadable.deps)).length === 0, "🔴 an unreadable claim store records nothing — the dedupe fails CLOSED");
  ok(audits.length === 1, `🔴 …and writes exactly ONE audit row for the poll, not one per reaction (got ${audits.length})`);
  ok(audits[0] === 3, `…naming how many reactions it skipped (got ${String(audits[0])})`);

  const healthy = stubDeps({ auditClaimUnreadable: async () => void audits.push(-1) });
  await routeGitHubReactionFeedback(TARGET, healthy.deps);
  ok(audits.length === 1, "negative control: a claim store that answers writes no unreadable row");

  const held = stubDeps({ recorded: async () => true, auditClaimUnreadable: async () => void audits.push(-1) });
  await routeGitHubReactionFeedback(TARGET, held.deps);
  ok(audits.length === 1, "🔴 negative control: an ALREADY-RECORDED answer is not an unreadable store");
}

{
  const many = Array.from({ length: GITHUB_REACTION_POLL_COMMENT_BUDGET + 5 }, (_v, i) => ({ ...AGENT_COMMENT_ROW, id: 9000 + i }));
  const d = stubDeps({ listComments: async () => many });
  await routeGitHubReactionFeedback(TARGET, d.deps);
  ok(d.asked.length === GITHUB_REACTION_POLL_COMMENT_BUDGET, "the budget caps how many of the agent's comments one poll examines");

  const tight = stubDeps({ listComments: async () => many, commentBudget: 2 });
  await routeGitHubReactionFeedback(TARGET, tight.deps);
  ok(tight.asked.length === 2, "negative control: a smaller budget examines fewer — the cap is the budget, not a constant");
}

{
  ok(classifyEmoji("+1") === "positive", "github `+1` buckets positive");
  ok(classifyEmoji("-1") === "negative", "github `-1` buckets negative");
  ok(classifyEmoji("heart") === "positive", "github `heart` buckets positive");
  ok(classifyEmoji("hooray") === "positive", "github `hooray` buckets positive");
  ok(classifyEmoji("rocket") === "positive", "github `rocket` buckets positive");
  ok(classifyEmoji("laugh") === "positive", "github `laugh` buckets positive");
  ok(classifyEmoji("confused") === "negative", "github `confused` buckets negative");
  ok(classifyEmoji("eyes") === "other", "negative control: github `eyes` stays `other` — it is a status glyph, not sentiment");
}

{
  let listed = 0;
  const countingList = async (): Promise<GitHubPolledComment[]> => {
    listed++;
    return [AGENT_COMMENT_ROW];
  };

  const stranger = stubDeps({ inScope: async () => false, listComments: countingList });
  ok((await routeGitHubReactionFeedback(TARGET, stranger.deps)).length === 0, "a conversation the arm is told is out of scope records nothing");
  ok(listed === 0 && stranger.asked.length === 0, "🔴 …and costs ZERO reads — the refusal is ahead of the first request");

  listed = 0;
  const inConversation = stubDeps({ inScope: async () => true, listComments: countingList });
  ok((await routeGitHubReactionFeedback(TARGET, inConversation.deps)).length === 1, "negative control: a conversation the arm is told is in scope still polls and records");
  ok(listed === 1, "…having actually read the comment page");

  listed = 0;
  let budgetAsked = 0;
  const spent = stubDeps({
    listComments: countingList,
    spendBudget: async () => {
      budgetAsked++;
      return false;
    },
  });
  ok((await routeGitHubReactionFeedback(TARGET, spent.deps)).length === 0, "a repository out of hourly budget records nothing");
  ok(listed === 0 && spent.asked.length === 0, "🔴 …and costs ZERO reads");
  ok(budgetAsked === 1, "…and the budget was actually consulted, not skipped");

  budgetAsked = 0;
  const strangerAgain = stubDeps({ inScope: async () => false, spendBudget: async () => (budgetAsked++, true) });
  await routeGitHubReactionFeedback(TARGET, strangerAgain.deps);
  ok(budgetAsked === 0, "🔴 a conversation the agent is not in spends no budget — the cheap gate runs first");
}

{
  const saved = { slug: process.env.GITHUB_APP_SLUG, appId: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_SLUG = SLUG;
  process.env.GITHUB_APP_ID = "1234";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  overrideSettingsForTest({ webhooks: { allowUnverifiedGithub: true } });

  timeline = [
    ...Array.from({ length: 249 }, (_v, i) => ({ id: 100 + i, login: "octocat", type: "User", reactions: 0 })),
    { id: AGENT_COMMENT, login: BOT_LOGIN, type: "Bot", reactions: 1 },
  ];
  reactionsPage = [{ content: "heart", user: { login: "octocat", type: "User" } }];

  const channel = (await import("../agent/channels/github.js")).default;
  type WebhookHandler = (req: Request, args: unknown) => Promise<Response>;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/github") as { handler: WebhookHandler } | undefined;
  ok(route !== undefined, "(precondition) the github channel exposes its webhook route");

  const realError = console.error;
  const realWarn = console.warn;
  async function drive(body: string, eventType: string): Promise<void> {
    const waited: Promise<unknown>[] = [];
    const args = {
      waitUntil: (p: Promise<unknown>) => void waited.push(p),
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      to: undefined,
      from: undefined,
    };
    const req = new Request("https://example.test/eve/v1/github", {
      method: "POST",
      headers: { "x-github-event": eventType, "content-type": "application/json" },
      body,
    });
    await route!.handler(req, args).catch(() => undefined);
    await Promise.allSettled(waited);
  }

  let before = 0;
  let afterUnmarked = 0;
  let afterPoll = 0;
  let afterPush = 0;
  let readsWhileUnmarked = 0;
  try {
    console.error = () => undefined;
    console.warn = () => undefined;
    before = (await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length;

    const callsBefore = calls.length;
    await drive(delivery(), "issue_comment");
    afterUnmarked = (await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length;
    readsWhileUnmarked = calls.slice(callsBefore).filter((c) => c.url.includes(`/repos/${OWNER}/${REPO}/issues/`)).length;

    await markGitHubConversationPosted(OWNER, REPO, NUMBER, new Date().toISOString());

    await drive(delivery(), "issue_comment");
    afterPoll = (await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length;
    await drive(delivery(), "push");
    afterPush = (await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length;
  } finally {
    console.error = realError;
    console.warn = realWarn;
    overrideSettingsForTest({ webhooks: { allowUnverifiedGithub: false } });
    if (saved.slug === undefined) delete process.env.GITHUB_APP_SLUG;
    else process.env.GITHUB_APP_SLUG = saved.slug;
    if (saved.appId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = saved.appId;
    if (saved.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = saved.pem;
  }

  ok(afterUnmarked === before, "🔴 REACHABILITY (gate 1): an unmarked conversation records nothing through the real route");
  ok(readsWhileUnmarked === 0, "🔴 …and made ZERO reads against the repository — the whole point of OPE-1540");
  ok(afterPoll === before + 1, "🔴 REACHABILITY: once the reply path's own mark is written, the real route polls and records a durable audit row");
  ok(afterPush === afterPoll, "negative control: a `push` delivery names no conversation, so it records nothing");

  const rows = await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION });
  const detail = rows[0]!.detail as Record<string, unknown>;
  ok(detail["surface"] === "github" && detail["emoji"] === "heart", "…naming the surface and the glyph the stub returned");
  ok(detail["messageId"] === String(AGENT_COMMENT), "…the agent's own comment, never the person's");
  ok(rows[0]!.principalId === "octocat", "…and the person who reacted");
  ok(calls.some((c) => c.url.includes(`/issues/comments/${AGENT_COMMENT}/reactions`)), "…having actually walked the reactions route");
  ok(!calls.some((c) => c.url.includes(`/issues/comments/${HUMAN_COMMENT}/reactions`)), "…and never the person's comment");

  const pagesRead = calls.filter((c) => c.url.includes(`/issues/${NUMBER}/comments`)).map((c) => new URL(c.url).searchParams.get("page"));
  ok(pagesRead.includes("3"), "🔴 the poll reads the LAST comment page — GitHub serves this route oldest-first");
  ok(!pagesRead.includes("1"), "negative control: it never reads page 1, which holds the conversation's oldest comments");
  ok(calls.some((c) => c.url.endsWith(`/issues/${NUMBER}`)), "…and it read the issue object first, whose `comments` count names that page");
}

globalThis.fetch = realFetch;
rmSync(dir, { recursive: true, force: true });
console.log(`✓ github reaction-feedback: ${n} assertions`);
