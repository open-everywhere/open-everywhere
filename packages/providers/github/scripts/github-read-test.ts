import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  registerConfig,
  resolveReadAdapter,
  supportedReadPlatforms,
  READ_ADAPTERS,
  ChannelScopeError,
  RateLimitExhaustedError,
  type BindableContext,
  type PrFetchFn,
  type RenderedLine,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerGithubProvider } from "../agent/register.js";
import { GITHUB_OWN_ACCOUNT_VENDOR, overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { githubReadAdapter, parseGithubContainer, reviewThreadLines, getJson, walkRetry, READ_WALK_BUDGET_MS } from "../agent/channels/github-read.js";
import { buildGitHubAuth } from "../agent/channels/github-identity.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
overrideSettingsForTest({ github: { appId: "1", appSlug: "oe-test", installations: { acme: "4242" } } });
process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
delete process.env.GITHUB_TOKEN;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
  String(url).includes("/app/installations/")
    ? new Response(JSON.stringify({ token: "gh-test-token", expires_at: "2099-01-01T00:00:00Z", repositories: [] }), { status: 201 })
    : realFetch(url, init)) as typeof fetch;
try {

registerGithubProvider();
registerConfig({
  loadDomains: () => [{ name: "d", reach: ["github/acme/api"] }],
} as unknown as Parameters<typeof registerConfig>[0]);

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  assert.deepStrictEqual(a, b, label);
  passed++;
}
async function throws(fn: () => Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ChannelScopeError, label);
  passed++;
}

function githubTurn(opts: {
  owner?: string;
  repo?: string;
  issue?: number;
  pr?: number;
  kind?: string;
  review?: number;
}): BindableContext {
  const auth = buildGitHubAuth({
    owner: opts.owner ?? "acme",
    repo: opts.repo ?? "api",
    isPrivate: true,
    conversationKind: opts.kind ?? (opts.pr ? "pull_request" : "issue"),
    ...(opts.issue !== undefined ? { issueNumber: opts.issue } : {}),
    ...(opts.pr !== undefined ? { pullRequestNumber: opts.pr } : {}),
    ...(opts.review !== undefined ? { reviewThreadRootCommentId: opts.review } : {}),
    actorLogin: "alice",
    authorAssociation: "MEMBER",
  });
  return { channel: { kind: "github" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

function transport(routes: readonly (readonly [string, unknown])[]): { fn: PrFetchFn; urls: string[] } {
  const urls: string[] = [];
  const fn: PrFetchFn = async (url) => {
    urls.push(url);
    const hit = routes.find(([fragment]) => url.includes(fragment));
    if (!hit) return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]), json: async () => hit[1] };
  };
  return { fn, urls };
}

const ISSUE_7 = { title: "Broken", body: "it fails", user: { login: "alice", type: "User" }, created_at: "t0", comments: 2 };
const COMMENTS_7 = [
  { id: 11, body: "looking", user: { login: "bob", type: "User" }, created_at: "t1" },
  { id: 12, body: "ci says no", user: { login: "ci-app", type: "Bot" }, created_at: "t2" },
];

ok(supportedReadPlatforms().includes("github"), "registerGithubProvider registers the github read adapter");
ok(READ_ADAPTERS["github"] === githubReadAdapter, "…and the registered adapter IS this bundle's");
{
  const resolved = resolveReadAdapter(githubTurn({ issue: 7 }), undefined, [{ name: "d", reach: ["github/acme/api"] }]);
  ok(resolved.platform === "github", "a github turn resolves the github platform");
  ok(resolved.adapter === githubReadAdapter, "…and resolves this adapter, not a 'not supported' throw");
}

eq(githubReadAdapter.wakeAddress(githubTurn({ issue: 7 })), { container: "acme/api#7" }, "an ISSUE turn names its conversation and no thread");
eq(githubReadAdapter.wakeAddress(githubTurn({ pr: 12 })), { container: "acme/api#12" }, "a PR TIMELINE turn names the PR and no thread");
eq(
  githubReadAdapter.wakeAddress(githubTurn({ pr: 12, kind: "review_thread", review: 555 })),
  { container: "acme/api#12", threadRoot: "555" },
  "a REVIEW-THREAD turn names the PR and the thread's root comment",
);
eq(githubReadAdapter.wakeAddress(githubTurn({})), undefined, "a turn with no conversation anchor names NO container (explicit undefined)");

eq(parseGithubContainer("acme/api#7"), { owner: "acme", repo: "api", repoFull: "acme/api", number: 7 }, "the container id parses to owner/repo/number");
eq(parseGithubContainer("acme/api"), undefined, "a container with no number is refused");
eq(parseGithubContainer("api#7"), undefined, "a container with no owner is refused");
eq(parseGithubContainer("acme/api#0"), undefined, "conversation number 0 is refused");

{
  const t = transport([
    ["/issues/7/comments", COMMENTS_7],
    ["/issues/7", ISSUE_7],
  ]);
  const { lines, possiblyIncomplete } = await githubReadAdapter.readChannel(githubTurn({ issue: 7 }), "acme/api#7", 50, t.fn);
  eq(lines.length, 3, "an issue read returns its opening post plus both comments");
  eq(lines[0], { author: "alice", authorId: "alice", ts: "t0", text: "Broken\n\nit fails" }, "the opening line is the issue's title and body");
  eq(lines[1]?.text, "looking", "the first comment follows the opening post, oldest first");
  eq(lines[2], { author: "ci-app", bot: true, ts: "t2", text: "ci says no" }, "a Bot comment is marked a machine and carries no author id");
  eq(possiblyIncomplete, false, "🔴 OPE-1015: the issue's own comment COUNT (2, both fetched) declares this complete — not left absent for the heuristic");
  ok(
    t.urls.every((u) => !u.includes("/pulls/")),
    "the issue read NEVER fetches the PR object — this is the 404 gap (scm/pr-feedback.ts:151) closed",
  );
  ok(t.urls.some((u) => u.includes("/repos/acme/api/issues/7?") || u.endsWith("/repos/acme/api/issues/7")), "it reads the issue through /issues/{n}");
}
{
  const pr = { ...ISSUE_7, title: "Add caching", comments: 1 };
  const t = transport([
    ["/issues/12/comments", [COMMENTS_7[0]]],
    ["/issues/12", pr],
  ]);
  const { lines } = await githubReadAdapter.readChannel(githubTurn({ pr: 12 }), "acme/api#12", 50, t.fn);
  eq(lines.length, 2, "a PR conversation reads through the same endpoint");
  eq(lines[0]?.text, "Add caching\n\nit fails", "…and its opening line is the PR's own title and body");
}
{
  const t = transport([["/issues/9", { ...ISSUE_7, comments: 0 }]]);
  const { lines } = await githubReadAdapter.readChannel(githubTurn({ issue: 9 }), "acme/api#9", 50, t.fn);
  eq(lines.length, 1, "a comment-less conversation reads as its opening post alone");
  ok(t.urls.every((u) => !u.includes("/comments")), "…and asks for no comment page at all");
}

{
  const page2 = Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, body: `c${i}`, user: { login: "bob" }, created_at: `t${i}` }));
  const t = transport([
    ["/issues/7/comments", page2],
    ["/issues/7", { ...ISSUE_7, comments: 150 }],
  ]);
  const { lines, possiblyIncomplete } = await githubReadAdapter.readChannel(githubTurn({ issue: 7 }), "acme/api#7", 50, t.fn);
  ok(t.urls.some((u) => u.includes("comments?per_page=100&page=2")), "a 150-comment conversation reads the LAST page, not page 1");
  ok(!t.urls.some((u) => u.includes("comments?per_page=100&page=1")), "…and does not also read page 1 when the last page covers the limit");
  eq(lines.length, 50, "the page is capped to the caller's limit, opening post included");
  eq(lines[lines.length - 1]?.text, "c49", "the NEWEST comment is the last line");
  eq(possiblyIncomplete, true, "🔴 OPE-1015: 150 total comments against 49 fetched DECLARES partial from the issue's own count, exact — not a line-count guess");
}
{
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, body: `p${i}`, user: { login: "bob" }, created_at: `u${i}` }));
  const page2 = [{ id: 999, body: "newest", user: { login: "bob" }, created_at: "z" }];
  const urls: string[] = [];
  const fn: PrFetchFn = async (url) => {
    urls.push(url);
    const body = url.includes("page=2") ? page2 : url.includes("page=1") ? page1 : { ...ISSUE_7, comments: 101 };
    return { ok: true, status: 200, text: async () => "", json: async () => body };
  };
  const { lines } = await githubReadAdapter.readChannel(githubTurn({ issue: 7 }), "acme/api#7", 50, fn);
  ok(urls.some((u) => u.includes("page=2")) && urls.some((u) => u.includes("page=1")), "a short last page pulls the page before it");
  eq(lines[lines.length - 1]?.text, "newest", "the newest comment is still last");
  eq(lines.length, 50, "and the read still holds to the caller's limit");
}

const REVIEW_COMMENTS = [
  { id: 555, body: "this allocates", user: { login: "bob", type: "User" }, created_at: "r1" },
  { id: 556, body: "fixed", user: { login: "alice", type: "User" }, created_at: "r2", in_reply_to_id: 555 },
  { id: 777, body: "another thread", user: { login: "carol", type: "User" }, created_at: "r3" },
  { id: 778, body: "reply elsewhere", user: { login: "bob", type: "User" }, created_at: "r4", in_reply_to_id: 777 },
];
eq(reviewThreadLines(REVIEW_COMMENTS, "555").map((l: RenderedLine) => l.text), ["this allocates", "fixed"], "a thread read keeps its root and its replies");
eq(reviewThreadLines(REVIEW_COMMENTS, "777").map((l: RenderedLine) => l.text), ["another thread", "reply elsewhere"], "…and the OTHER thread on the same PR reads separately");
eq(reviewThreadLines(REVIEW_COMMENTS, "12345"), [], "a root nothing replies to reads as an empty thread, never as the whole PR");
{
  const t = transport([["/pulls/12/comments", REVIEW_COMMENTS]]);
  const { lines, possiblyIncomplete } = await githubReadAdapter.readThread(githubTurn({ pr: 12, kind: "review_thread", review: 555 }), "acme/api#12", "555", 100, t.fn);
  eq(lines.map((l) => l.text), ["this allocates", "fixed"], "the live thread read fetches the PR's review comments and filters to the thread");
  eq(lines[0]?.authorId, "bob", "…and attributes each line to its author");
  eq(possiblyIncomplete, false, "🔴 OPE-1015: the review-comment walk saw a SHORT page (< 100) — it can PROVE it saw everything, so this declares complete");
}
{
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 900 + i, body: `r${i}`, user: { login: "bob", type: "User" }, created_at: `s${i}` }));
  const t = transport([["/pulls/12/comments", fullPage]]);
  const out = await githubReadAdapter.readThread(githubTurn({ pr: 12, kind: "review_thread", review: 900 }), "acme/api#12", "900", 100, t.fn);
  eq(out.possiblyIncomplete, true, "🔴 five full 100-comment pages give the walk no proof it saw everything — declared partial");
  ok(typeof out.partialReason === "string" && out.partialReason.length > 0, "…and the reason rides as data — the review-comment page ceiling, named");
}

{
  const t = transport([
    ["/issues/7/comments", COMMENTS_7],
    ["/issues/7", ISSUE_7],
  ]);
  const own = githubTurn({ issue: 7 });
  ok((await githubReadAdapter.readChannel(own, "acme/api#7", 50, t.fn)).lines.length === 3, "control: the turn's OWN container reads");
  await throws(() => githubReadAdapter.readChannel(own, "evil/api#7", 50, t.fn), "another OWNER's repo of the same name is refused");
  await throws(() => githubReadAdapter.readChannel(own, "acme/secret#7", 50, t.fn), "a repo outside the domain's read scope is refused");
  await throws(() => githubReadAdapter.readChannel(own, "acme/api", 50, t.fn), "a container id that names no conversation is refused");
  await throws(() => githubReadAdapter.readThread(own, "evil/api#7", "555", 100, t.fn), "the thread read runs the SAME fence");
  ok(
    !t.urls.some((u) => u.includes("evil") || u.includes("secret")),
    "no refused read reached the network — the fence runs BEFORE the fetch",
  );
}

{
  const retryAfter = (seconds: string): PrFetchFn => {
    const headers = new Headers();
    headers.set("retry-after", seconds);
    let calls = 0;
    return (async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(ISSUE_7), json: async () => ISSUE_7 };
    }) as unknown as PrFetchFn;
  };
  const slept: number[] = [];
  const got = await getJson<typeof ISSUE_7>(retryAfter("2"), "https://api.github.com/repos/acme/api/issues/7", "gh-test-token", "issues.get", {
    sleep: async (ms) => void slept.push(ms),
  });
  eq(slept, [2000], "§7 the read seam honours a 429's Retry-After — the delay is the exact header value");
  eq(got.title, "Broken", "§7 the eventual success is returned once the 429 clears");
}
{
  let calls = 0;
  const notFound: PrFetchFn = async () => {
    calls++;
    return { ok: false, status: 404, text: async () => "nope", json: async () => ({}) };
  };
  const slept: number[] = [];
  await assert.rejects(
    () => getJson(notFound, "https://api.github.com/repos/acme/api/issues/999", "gh-test-token", "issues.get", { sleep: async (ms) => void slept.push(ms) }),
    /read: GitHub GET failed/,
    "§7 negative control: a 404 throws the plain read-failed error, not a retry exhaustion",
  );
  passed++;
  eq(calls, 1, "§7 negative control: a 404 is requested EXACTLY once");
  eq(slept, [], "§7 negative control: zero sleeps");
}
{
  const headers = new Headers();
  headers.set("retry-after", "1");
  const alwaysLimited: PrFetchFn = (async () => ({ ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) })) as unknown as PrFetchFn;
  const slept: number[] = [];
  let caught: unknown;
  try {
    await getJson(alwaysLimited, "https://api.github.com/repos/acme/api/issues/7/comments", "gh-test-token", "issues.comments.list", {
      sleep: async (ms) => void slept.push(ms),
    });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "§7 exhaustion: the NAMED RateLimitExhaustedError");
  eq((caught as RateLimitExhaustedError).surface, "github", "§7 exhaustion: the surface names github");
  eq((caught as RateLimitExhaustedError).operation, "issues.comments.list", "§7 exhaustion: the operation is the vendor route name");
  eq(slept, [1000, 1000, 1000], "§7 exhaustion: three waits under the shared default");
}

const MAX_REVIEW_PAGES_EXPECTED = 5;
{
  const at = (t: number) => (): number => t;
  eq(walkRetry(1_000, { now: at(400) }).totalBudgetMs, 600, "§8 a call inside a walk takes what is LEFT of the deadline");
  eq(walkRetry(1_000, { now: at(1_000) }).totalBudgetMs, 0, "§8 at the deadline the budget is zero, not the shared default");
  eq(walkRetry(1_000, { now: at(9_999) }).totalBudgetMs, 0, "§8 past the deadline it clamps to zero rather than going negative");
}
{
  const headers = new Headers();
  headers.set("retry-after", "1");
  const limited: PrFetchFn = (async () => ({ ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) })) as unknown as PrFetchFn;
  const slept: number[] = [];
  await assert.rejects(
    () => getJson(limited, "https://api.github.com/x", "gh-test-token", "issues.get", { totalBudgetMs: 0, sleep: async (ms) => void slept.push(ms) }),
    RateLimitExhaustedError,
    "§8 a spent budget refuses at once",
  );
  passed++;
  eq(slept, [], "§8 …and waits for nothing on the way — the budget is a real ceiling, not a counter");
}
{
  const fullPage = (n: number): unknown[] =>
    Array.from({ length: 100 }, (_, i) => ({ id: n * 1000 + i, body: `r${i}`, user: { login: "bob", type: "User" }, created_at: `s${i}` }));
  const headers = new Headers();
  headers.set("retry-after", "30");
  const walkOf = (): { seam: { now: () => number; sleep: (ms: number) => Promise<void> }; slept: number[] } => {
    let clock = 0;
    const slept: number[] = [];
    return {
      slept,
      seam: {
        now: () => clock,
        sleep: async (ms: number) => {
          slept.push(ms);
          clock += ms;
        },
      },
    };
  };
  const limitedOnce = (): PrFetchFn => {
    const seen = new Set<string>();
    let page = 0;
    return (async (url: string) => {
      if (url.includes("/issues/")) return { ok: true, status: 200, text: async () => "", json: async () => ISSUE_7 };
      if (!seen.has(url)) {
        seen.add(url);
        return { ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) };
      }
      page++;
      return { ok: true, status: 200, text: async () => "", json: async () => fullPage(page) };
    }) as unknown as PrFetchFn;
  };

  const bounded = walkOf();
  let caught: unknown;
  try {
    await githubReadAdapter.readThread(githubTurn({ pr: 12, kind: "review_thread", review: 1000 }), "acme/api#12", "1000", 100, limitedOnce(), bounded.seam);
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "§8 the walk gives up once its SHARED budget is spent");
  ok(
    bounded.slept.reduce((a, b) => a + b, 0) <= READ_WALK_BUDGET_MS,
    `§8 …having waited no more than the whole read's budget (waited ${bounded.slept.reduce((a, b) => a + b, 0)}ms of ${READ_WALK_BUDGET_MS}ms)`,
  );
  ok(bounded.slept.length < MAX_REVIEW_PAGES_EXPECTED, `§8 …so it never paid a 30 s wait on every page (paid ${bounded.slept.length})`);

  const unbounded = walkOf();
  const frozen = { now: () => 0, sleep: async (ms: number) => void unbounded.slept.push(ms) };
  const out = await githubReadAdapter.readThread(
    githubTurn({ pr: 12, kind: "review_thread", review: 1000 }),
    "acme/api#12",
    "1000",
    100,
    limitedOnce(),
    frozen,
  );
  eq(unbounded.slept.length, MAX_REVIEW_PAGES_EXPECTED, "§8 negative control: with a never-shrinking budget every page pays its own 30 s wait");
  ok(out.possiblyIncomplete === true, "§8 negative control: …and the walk completes, hitting its page ceiling");
}

{
  const OWN_ACCOUNT_ASK_ATTR = "oe_own_account_ask";
  const stamp = (sessionId: string, connector: string): string => `${sessionId}|-|${connector}`;

  function turnAskingOwnAccount(connector: string): BindableContext {
    const base = githubTurn({ issue: 7 }) as unknown as { session: { auth: { current: { attributes?: Record<string, unknown> } } } };
    const attributes = { ...(base.session.auth.current.attributes ?? {}), [OWN_ACCOUNT_ASK_ATTR]: stamp("seat-1", connector) };
    return { ...base, session: { ...base.session, auth: { current: { ...base.session.auth.current, attributes } }, id: "seat-1" } } as unknown as BindableContext;
  }

  const asked = transport([["/issues/7", ISSUE_7]]);
  let refusal: unknown;
  try {
    await githubReadAdapter.readChannel(turnAskingOwnAccount("github"), "acme/api#7", 10, asked.fn);
  } catch (err) {
    refusal = err;
  }
  ok(refusal instanceof Error, "§9 a read on a turn that asked for the member's OWN GitHub account is refused");
  ok(String((refusal as Error).message).includes("own github account"), "§9 …with the gate's own sentence, which names the account that was asked for");
  eq(asked.urls.length, 0, "§9 …and NOTHING was fetched — the refusal lands before the vendor is dialed");

  const notion = transport([["/issues/7", ISSUE_7]]);
  const throughNotion = await githubReadAdapter.readChannel(turnAskingOwnAccount("notion"), "acme/api#7", 10, notion.fn);
  ok(throughNotion.lines.length > 0, "§9 negative control: a NOTION own-account stamp does not refuse a GitHub read");

  const plain = transport([["/issues/7", ISSUE_7]]);
  const ordinary = await githubReadAdapter.readChannel(githubTurn({ issue: 7 }), "acme/api#7", 10, plain.fn);
  ok(ordinary.lines.length > 0, "§9 negative control: a turn with no own-account stamp reads normally");
}

{
  const ORDINARY = ["through", "highlight", "light", "although", "right", "throughput"];
  const namesGithub = (word: string): boolean => word.includes("github");
  const hidesInsideWord = (word: string): boolean => ORDINARY.some((ordinary) => ordinary.includes(word));

  const aliases: readonly string[] = GITHUB_OWN_ACCOUNT_VENDOR.aliases ?? [];
  ok(aliases.length > 0, "§10 the shipped vendor declares at least one alias");
  ok(GITHUB_OWN_ACCOUNT_VENDOR.connector === "github", "§10 the shipped connector word is the access plane's own `github`");
  for (const word of [GITHUB_OWN_ACCOUNT_VENDOR.connector, ...aliases]) {
    ok(namesGithub(word), `§10 the shipped word "${word}" names github`);
    ok(!hidesInsideWord(word), `§10 the shipped word "${word}" hides inside no ordinary word`);
  }
  ok(hidesInsideWord("gh"), "§10 negative control: `gh` DOES hide inside `through` — the hiding hazard is real");
  ok(!namesGithub("notion.so"), "§10 negative control: a word that does not name github fails the naming rule");
}

console.log(`✓ github-read: ${passed} assertions passed`);
} finally {
  globalThis.fetch = realFetch;
}
