import assert from "node:assert/strict";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import { githubWrite, type GitHubFetchLike } from "../agent/channels/github-post-arm.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("github rate limit (OPE-1235):");

const TOKEN = "ghs_installation_token";
const COMMENT = {
  operation: "issues.createComment",
  method: "POST",
  path: "/repos/acme/widgets/issues/7/comments",
  token: TOKEN,
  body: { body: "hello" },
} as const;

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 429, headers });
}

const created = (id = 42): Response => new Response(JSON.stringify({ id }), { status: 201 });

function stubFetch(queue: Response[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchLike: GitHubFetchLike = async (url, init) => {
    const next = queue[requests.length];
    requests.push({ url, init });
    if (next === undefined) throw new Error("stub fetch ran out of responses");
    return next;
  };
  return { fetchLike, requests };
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

{
  const stub = stubFetch([rateLimited("3"), rateLimited("1"), created(4242)]);
  const clock = recorder();
  const res = await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });

  eq(clock.slept, [3000, 1000], "429 sequence: the honoured delays are EXACTLY the Retry-After values (3 s, then 1 s)");
  eq(stub.requests.length, 3, "429 sequence: the comment POST is repeated until GitHub accepts it");
  eq(res.status, 201, "429 sequence: the caller receives the eventual success response");
  eq(((await res.json()) as { id: number }).id, 4242, "429 sequence: the created comment id survives the retries");
  eq(stub.requests[0].url, "https://api.github.com/repos/acme/widgets/issues/7/comments", "429 sequence: the path resolves against the GitHub REST base");
}

{
  const stub = stubFetch([rateLimited("1"), created()]);
  const clock = recorder();
  await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });

  const [first, second] = stub.requests;
  eq(first.url, second.url, "retry: same url");
  eq(first.init.method, second.init.method, "retry: same method");
  eq(first.init.body, second.init.body, "retry: same body");
  eq(first.init.body, JSON.stringify({ body: "hello" }), "retry: the body is the caller's JSON, unchanged by the funnel");
  eq(second.init.headers, first.init.headers, "retry: the same headers, the credential included");
}

{
  const stub = stubFetch([created(), new Response("", { status: 200 }), created()]);
  await githubWrite(COMMENT, { fetch: stub.fetchLike });
  await githubWrite(
    { operation: "issues.updateComment", method: "PATCH", path: "/repos/acme/widgets/issues/comments/99", token: TOKEN, body: { body: "edited" } },
    { fetch: stub.fetchLike },
  );
  await githubWrite(
    { operation: "issues.createReaction", method: "POST", path: "/repos/acme/widgets/issues/7/reactions", token: TOKEN, body: { content: "rocket" } },
    { fetch: stub.fetchLike },
  );

  const headers = stub.requests[0].init.headers as Record<string, string>;
  eq(headers.authorization, `Bearer ${TOKEN}`, "request shape: the installation token rides the authorization header");
  eq(headers.accept, "application/vnd.github+json", "request shape: GitHub's JSON accept header");
  eq(headers["x-github-api-version"], "2022-11-28", "request shape: the pinned REST API version");
  eq(headers["content-type"], "application/json", "request shape: a JSON content type");

  eq(stub.requests[1].init.method, "PATCH", "request shape: the EDIT is a PATCH");
  eq(stub.requests[1].url, "https://api.github.com/repos/acme/widgets/issues/comments/99", "request shape: the edit hits the comments endpoint");
  eq(stub.requests[1].init.body, JSON.stringify({ body: "edited" }), "request shape: the edit sends the new body");
  eq(stub.requests[2].init.method, "POST", "request shape: the REACTION is a POST");
  eq(stub.requests[2].url, "https://api.github.com/repos/acme/widgets/issues/7/reactions", "request shape: the reaction hits the reactions endpoint");
  eq(stub.requests[2].init.body, JSON.stringify({ content: "rocket" }), "request shape: the reaction sends GitHub's fixed content enum value");
}

{
  const stub = stubFetch([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }

  ok(caught instanceof RateLimitExhaustedError, "exhaustion: the failure is the NAMED RateLimitExhaustedError, not a bare 429 message");
  const e = caught as RateLimitExhaustedError;
  eq(e.name, "RateLimitExhaustedError", "exhaustion: the error name is readable by a caller that logs it");
  eq(e.surface, "github", "exhaustion: the surface names GitHub");
  eq(e.operation, "issues.createComment", "exhaustion: the operation is the vendor route name");
  eq(e.status, 429, "exhaustion: the refusal's HTTP status rides the error, so a classifier reads the same 429");
  eq(e.attempts, 4, "exhaustion: four attempts under the shared default");
  eq(e.waitedMs, 3000, "exhaustion: the total honoured wait is the sum of the three delays");
  eq(clock.slept, [1000, 1000, 1000], "exhaustion: three waits, one fewer than the attempts");
  eq(stub.requests.length, 4, "exhaustion: the fourth refusal is not followed by a fifth request");
  ok(!e.message.includes(TOKEN), "🔴 exhaustion: the message carries NO token");
  ok(!e.message.includes("acme/widgets"), "exhaustion: the message carries no repo path — every field on this error is safe to log");
}

{
  for (const status of [201, 404, 500] as const) {
    const stub = stubFetch([new Response(JSON.stringify({ message: "x" }), { status })]);
    const clock = recorder();
    const res = await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
    eq(clock.slept, [], `negative control: a ${status} sleeps ZERO times`);
    eq(stub.requests.length, 1, `negative control: a ${status} is requested EXACTLY once`);
    eq(res.status, status, `negative control: a ${status} comes back untouched, so the caller's res.ok/res.status read is unchanged`);
  }
}

{
  const clock = recorder();
  let calls = 0;
  const throwing: GitHubFetchLike = async () => {
    calls++;
    throw new Error("socket hang up");
  };
  let caught: unknown;
  try {
    await githubWrite(COMMENT, { fetch: throwing, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }
  eq(calls, 1, "transport throw: the unanswered POST is sent ONCE — repeating it could double a comment");
  eq(clock.slept, [], "transport throw: nothing is slept on");
  ok(caught instanceof Error && (caught as Error).message === "socket hang up", "transport throw: the original error propagates untouched");
}

{
  const stub = stubFetch([rateLimited("not-a-delay"), created()]);
  const clock = recorder();
  await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [1000], "malformed Retry-After: the seam waits the 1 s fallback, never zero");

  const absent = stubFetch([rateLimited(undefined), created()]);
  const absentClock = recorder();
  await githubWrite(COMMENT, { fetch: absent.fetchLike, retry: { sleep: absentClock.sleep } });
  eq(absentClock.slept, [1000], "absent Retry-After: the same fallback applies");
}

{
  const stub = stubFetch([rateLimited("600"), created()]);
  const clock = recorder();
  await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [30_000], "cap: a 10-minute Retry-After is clamped to the 30 s per-wait ceiling, not obeyed literally");

  const budgeted = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const budgetClock = recorder();
  let caught: unknown;
  try {
    await githubWrite(COMMENT, { fetch: budgeted.fetchLike, retry: { sleep: budgetClock.sleep } });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "total budget: the call ends in the named failure rather than overrunning");
  eq(budgetClock.slept, [30_000, 30_000], "total budget: exactly two 30 s waits fit the 60 s budget; the third is refused BEFORE it is spent");
  eq(budgeted.requests.length, 3, "total budget: the refused wait means no fourth request");
}

{
  const stub = stubFetch([rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await githubWrite(COMMENT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep, maxAttempts: 2 } });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "tightened policy: two attempts still end in the named failure");
  eq((caught as RateLimitExhaustedError).attempts, 2, "tightened policy: the caller's attempt bound is the one that applies");
  eq(stub.requests.length, 2, "tightened policy: exactly two requests left the host");
}

console.log(`  ${n} assertions passed`);
