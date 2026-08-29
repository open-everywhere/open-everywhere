import assert from "node:assert/strict";
import { RateLimitExhaustedError } from "../agent/channels/rate-limit-retry.js";
import { createOrUpdatePullRequest, type PrFetchFn } from "../agent/scm/pr.js";
import { setGithubIssueState, createGithubIssue } from "../agent/scm/issue-actions.js";
import { GitHubContents, type HttpFetch } from "../agent/scm/contents.js";
import { createBranch } from "../agent/scm/refs.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("scm rate limit (OPE-1253):");

type FakeResponse = { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> };

function rateLimited(retryAfter?: string): FakeResponse {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return { ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({ message: "rate limited" }) };
}

function rateLimitedNoHeaders(): FakeResponse {
  return { ok: false, status: 429, text: async () => "rate limited", json: async () => ({ message: "rate limited" }) };
}

function okJson(body: unknown, status = 200): FakeResponse {
  return { ok: true, status, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body };
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

function stubQueue(queue: FakeResponse[]) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<FakeResponse> => {
    calls.push(url);
    const next = queue[calls.length - 1];
    if (next === undefined) throw new Error("stub fetch ran out of responses");
    return next;
  };
  return { fn, calls };
}

{
  const stub = stubQueue([rateLimited("2"), okJson({ html_url: "https://github.com/acme/web/pull/9", number: 9 })]);
  const clock = recorder();
  const result = await createOrUpdatePullRequest({
    repo: "acme/web",
    head: "fix/x",
    base: "main",
    title: "t",
    body: "b",
    token: "ghs_w",
    fetchFn: stub.fn as unknown as PrFetchFn,
    retry: { sleep: clock.sleep },
  });
  eq(clock.slept, [2000], "pr.ts: the honoured delay is EXACTLY the Retry-After value (2 s)");
  eq(stub.calls.length, 2, "pr.ts: the create POST is repeated until GitHub accepts it");
  eq(result.number, 9, "pr.ts: the eventual PR is returned once the 429 clears");
}

{
  const stub = stubQueue([okJson({ html_url: "https://github.com/acme/web/pull/1", number: 1 })]);
  const clock = recorder();
  const result = await createOrUpdatePullRequest({
    repo: "acme/web",
    head: "fix/y",
    base: "main",
    title: "t",
    body: "b",
    token: "ghs_w",
    fetchFn: stub.fn as unknown as PrFetchFn,
    retry: { sleep: clock.sleep },
  });
  eq(clock.slept, [], "pr.ts negative control: zero sleeps");
  eq(stub.calls.length, 1, "pr.ts negative control: a 2xx is requested EXACTLY once");
  eq(result.number, 1, "pr.ts negative control: the PR comes back untouched");
}

{
  const stub = stubQueue([rateLimited("1"), okJson({})]);
  const clock = recorder();
  const msg = await setGithubIssueState("acme/web#7", "closed", {
    fetchFn: stub.fn as unknown as PrFetchFn,
    resolveToken: async () => "ghs_issue",
    retry: { sleep: clock.sleep },
  });
  eq(clock.slept, [1000], "issue-actions.ts: the honoured delay is the Retry-After value (1 s)");
  eq(stub.calls.length, 2, "issue-actions.ts: the state PATCH is repeated until GitHub accepts it");
  ok(msg.includes("closed"), "issue-actions.ts: the eventual success is reported");
}

{
  const stub = stubQueue([okJson({})]);
  const clock = recorder();
  await setGithubIssueState("acme/web#7", "open", { fetchFn: stub.fn as unknown as PrFetchFn, resolveToken: async () => "ghs_issue", retry: { sleep: clock.sleep } });
  eq(clock.slept, [], "issue-actions.ts negative control: zero sleeps");
  eq(stub.calls.length, 1, "issue-actions.ts negative control: a 2xx is requested EXACTLY once");
}

{
  const stub = stubQueue([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await createGithubIssue(
      "acme/web",
      { title: "t", body: "b" },
      { fetchFn: stub.fn as unknown as PrFetchFn, resolveToken: async () => "ghs_issue", retry: { sleep: clock.sleep } },
    );
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "issue-actions.ts exhaustion: the NAMED RateLimitExhaustedError, not a bare 429");
  const e = caught as RateLimitExhaustedError;
  eq(e.surface, "github", "issue-actions.ts exhaustion: the surface names GitHub");
  eq(e.operation, "issues.create", "issue-actions.ts exhaustion: the operation is the vendor route name");
  eq(e.attempts, 4, "issue-actions.ts exhaustion: four attempts under the shared default");
  eq(stub.calls.length, 4, "issue-actions.ts exhaustion: the fourth refusal is not followed by a fifth request");
  eq(clock.slept, [1000, 1000, 1000], "issue-actions.ts exhaustion: three waits, one fewer than the attempts");
}

{
  const stub = stubQueue([rateLimited("1"), okJson({ commit: { sha: "abc123" } })]);
  const clock = recorder();
  const client = new GitHubContents(stub.fn as unknown as HttpFetch, "https://api.github.com", { sleep: clock.sleep });
  const sha = await client.putFile("acme/web", "memory/note.md", "hello", "note", "main", "ghs_c", { name: "bot", email: "bot@example.com" });
  eq(clock.slept, [1000], "contents.ts putFile: the honoured delay is the Retry-After value (1 s)");
  eq(stub.calls.length, 2, "contents.ts putFile: the PUT is repeated until GitHub accepts it");
  eq(sha, "abc123", "contents.ts putFile: the eventual commit sha is returned");
}

{
  const stub = stubQueue([{ ok: false, status: 404, headers: new Headers(), text: async () => "", json: async () => ({}) }]);
  const clock = recorder();
  const client = new GitHubContents(stub.fn as unknown as HttpFetch, "https://api.github.com", { sleep: clock.sleep });
  const file = await client.getFile("acme/web", "memory/note.md", "main", "ghs_c");
  eq(clock.slept, [], "contents.ts negative control: zero sleeps");
  eq(stub.calls.length, 1, "contents.ts negative control: a 404 is requested EXACTLY once — never mistaken for a 429");
  eq(file, null, "contents.ts negative control: a 404 reports absent, not an error");
}

{
  const stub = stubQueue([rateLimited("2"), rateLimitedNoHeaders(), okJson({})]);
  const clock = recorder();
  const outcome = await createBranch({
    repo: "acme/web",
    branch: "access-request/42",
    sha: "deadbeef",
    token: "ghs_r",
    fetchFn: stub.fn as unknown as HttpFetch,
    retry: { sleep: clock.sleep },
  });
  eq(clock.slept, [2000, 1000], "refs.ts: BOTH the headers-bearing (2 s) and the headers-less (1 s fallback) 429 are honoured");
  eq(stub.calls.length, 3, "refs.ts: neither refusal crashes or stalls the retry loop");
  eq(outcome, "created", "refs.ts: the eventual success is reported");
}

{
  const stub = stubQueue([{ ok: false, status: 422, headers: new Headers(), text: async () => "Reference already exists", json: async () => ({}) }]);
  const clock = recorder();
  const outcome = await createBranch({ repo: "acme/web", branch: "access-request/42", sha: "deadbeef", token: "ghs_r", fetchFn: stub.fn as unknown as HttpFetch, retry: { sleep: clock.sleep } });
  eq(clock.slept, [], "refs.ts negative control: zero sleeps");
  eq(stub.calls.length, 1, "refs.ts negative control: a 422 is requested EXACTLY once");
  eq(outcome, "exists", "refs.ts negative control: an existing branch resolves as exists, not an error");
}

console.log(`  ${n} assertions passed`);
