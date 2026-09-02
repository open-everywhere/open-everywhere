import assert from "node:assert/strict";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import { LinearApiError } from "eve/channels/linear";
import {
  callLinear,
  createLinearActivity,
  linearChannelApi,
  linearChannelOperation,
  LINEAR_ACTIVITY_OPERATION,
  LINEAR_CHANNEL_OPERATION,
  type LinearApi,
  type LinearRetryPolicy,
} from "../agent/channels/linear-graphql.js";
import { createLinearIssue } from "../agent/channels/linear-create.js";
import { setLinearIssueState } from "../agent/channels/linear-actions.js";
import { readLinearIssue } from "../agent/channels/linear-api.js";
import { enrichTeamPrivacy } from "../agent/channels/linear.js";
import { describeLinearError } from "../agent/channels/linear-errors.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("linear rate limit (OPE-1234):");

const CREDENTIALS = { accessToken: "lin_api_test_token" } as const;
const ISSUE_ID = "550e8400-e29b-41d4-a716-446655440000";

type Make = () => Response;

const rateLimited = (retryAfter?: string): Make => () =>
  new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
    status: 429,
    ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
  });
const graphqlData = (data: unknown): Make => () => new Response(JSON.stringify({ data }), { status: 200 });
const graphqlErrors = (message: string): Make => () => new Response(JSON.stringify({ errors: [{ message }] }), { status: 200 });
const httpStatus = (status: number): Make => () => new Response(JSON.stringify({ errors: [{ message: "no" }] }), { status });

function stubFetch(queue: ReadonlyArray<Make>) {
  const requests: Array<{ url: string; method?: string; body?: string; authorization?: string }> = [];
  const fetchFn = (async (url: unknown, init: RequestInit) => {
    const next = queue[requests.length];
    const headers = (init.headers ?? {}) as Record<string, string>;
    requests.push({ url: String(url), method: init.method, body: typeof init.body === "string" ? init.body : undefined, authorization: headers.authorization });
    if (next === undefined) throw new Error(`stub fetch ran out of responses after ${requests.length} requests`);
    return next();
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

function apiWith(queue: ReadonlyArray<Make>): { api: LinearApi; requests: ReturnType<typeof stubFetch>["requests"]; slept: number[] } {
  const stub = stubFetch(queue);
  const clock = recorder();
  return { api: { fetch: stub.fetchFn, retry: { sleep: clock.sleep } }, requests: stub.requests, slept: clock.slept };
}

const TEAMS = { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } };
const CREATED = { issueCreate: { success: true, issue: { id: "uuid-1", identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" } } };

{
  const t = apiWith([rateLimited("3"), graphqlData(TEAMS), rateLimited("2"), rateLimited("1"), graphqlData(CREATED)]);
  const out = await createLinearIssue("ENG", { title: "Login 500s on retry", body: "Steps: …" }, { api: t.api, credentials: CREDENTIALS });

  eq(t.slept, [3000, 2000, 1000], "§1 the honoured delays are EXACTLY the Retry-After values across BOTH calls (3 s on the lookup, then 2 s and 1 s on issueCreate)");
  eq(t.requests.length, 5, "§1 each refused request is repeated until Linear answers");
  eq(out.ref.id, "ENG-42", "§1 the caller receives the created issue — a write that used to be lost on the first 429 now lands");
}

{
  const STATES = { issue: { team: { states: { nodes: [{ id: "s1", name: "Done" }] } } } };
  const t = apiWith([graphqlData(STATES), rateLimited("5"), graphqlData({ issueUpdate: { success: true } })]);
  const out = await setLinearIssueState(ISSUE_ID, "Done", { api: t.api, credentials: CREDENTIALS });

  eq(t.slept, [5000], "§2 the issueUpdate mutation honours its own Retry-After");
  eq(t.requests.length, 3, "§2 …and repeats only the refused call, not the one that already answered");
  ok(out.includes("Done"), `§2 the state change is reported as applied (${out})`);
}

{
  const ISSUE = { issue: { id: ISSUE_ID, identifier: "ENG-42", title: "t", description: "body", comments: { nodes: [], pageInfo: { hasNextPage: false } } } };
  const t = apiWith([rateLimited("4"), graphqlData(ISSUE)]);
  const read = await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS });

  eq(t.slept, [4000], "§3 a rate-limited read is retried on the same seam as a write");
  eq(read.identifier, "ENG-42", "§3 …and the caller receives the eventual answer");
}

{
  const t = apiWith([rateLimited("1"), graphqlData({ team: { private: true } })]);
  const priv = await enrichTeamPrivacy("team-1", { api: t.api, credentials: CREDENTIALS });

  eq(t.requests.length, 2, "§4 the refused call is repeated exactly once");
  ok((t.requests[1].body ?? "").includes("TeamPrivacy"), "§4 the SECOND attempt still carries the query — eve's `init` body is a string, so replaying it does not trip a consumed stream");
  eq(t.requests[1].authorization, `Bearer ${CREDENTIALS.accessToken}`, "§4 …and a live credential: eve resolves the token ONCE, before the first attempt");
  eq(t.requests[1].method, "POST", "§4 …by the same method");
  eq(priv, true, "🔴 §4 …and the replay is the attempt that ANSWERS — a retry that sent a broken request would fail here, not merely differ");
}

{
  const t = apiWith([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const err = await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).then(
    () => undefined,
    (e: unknown) => e,
  );

  ok(err instanceof RateLimitExhaustedError, `§5 a call that stays rate limited ends in the NAMED failure, not an empty answer (${String(err)})`);
  const rl = err as RateLimitExhaustedError;
  eq(rl.status, 429, "🔴 §5 the named failure carries status 429 — this is what keeps an exhausted write AMBIGUOUS in platform-failure.ts");
  eq(rl.surface, "linear", "§5 …and names the linear surface");
  eq(rl.operation, "OeReadIssue", "§5 …and the QUERY it gave up on");
  eq(rl.attempts, 4, "§5 the default ceiling is 4 attempts — the call stops, it does not loop");
  eq(t.requests.length, 4, "🔴 §5 exactly 4 requests reached the transport: a fifth would mean the ceiling does not hold");
  eq(t.slept, [1000, 1000, 1000], "§5 …after 3 honoured waits");
  eq(rl.waitedMs, 3000, "§5 …and the error reports the total it waited");
}

{
  const t = apiWith([rateLimited("45"), rateLimited("45"), rateLimited("45"), rateLimited("45")]);
  const err = await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).then(
    () => undefined,
    (e: unknown) => e,
  );

  ok(err instanceof RateLimitExhaustedError, "§6 an over-budget sequence still ends in the named failure");
  eq(t.slept, [30000, 30000], "§6 each wait is capped at 30 s, and the 60 s budget allows exactly two of them");
  eq((err as RateLimitExhaustedError).attempts, 3, "🔴 §6 the call gives up on attempt 3 of 4 — the budget, not the attempt count, is what refused");
  eq(t.requests.length, 3, "§6 …so only 3 requests reached the transport");
}

{
  const t = apiWith([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const err = (await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).catch((e: unknown) => e)) as RateLimitExhaustedError;

  ok(!err.operation.includes(ISSUE_ID), "🔴 §7 the operation carries NO issue id — every field on this error is documented safe to log");
  ok(!err.message.includes(ISSUE_ID), "🔴 §7 …and neither does the message the error renders");
  ok(!err.message.includes(CREDENTIALS.accessToken), "🔴 §7 …and the bearer token appears nowhere in it");
}

{
  const t = apiWith([rateLimited(), rateLimited("not-a-delay"), graphqlData({ team: { private: false } })]);
  await enrichTeamPrivacy("team-1", { api: t.api, credentials: CREDENTIALS });

  eq(t.slept, [1000, 1000], "§8 a missing header and an unreadable one BOTH take the 1 s fallback — never a zero-delay hot loop against an API that just asked us to slow down");
}

{
  const t = apiWith([graphqlData({ team: { private: true } })]);
  const priv = await enrichTeamPrivacy("team-1", { api: t.api, credentials: CREDENTIALS });
  eq(priv, true, "§9 a 200 answers on the first request…");
  eq(t.requests.length, 1, "§9 …with exactly one request…");
  eq(t.slept, [], "§9 …and ZERO sleeps");
}
{
  const t = apiWith([httpStatus(401)]);
  const err = (await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).catch((e: unknown) => e)) as unknown;
  ok(err instanceof LinearApiError, `§9 a permanent 401 still raises eve's LinearApiError, unchanged (${String(err)})`);
  eq((err as LinearApiError).status, 401, "§9 …carrying the status the classifier reads");
  eq(t.requests.length, 1, "🔴 §9 a permanent 4xx FAILS FAST — one request, no retry");
  eq(t.slept, [], "§9 …and no wait");
}
{
  const t = apiWith([httpStatus(500)]);
  const err = (await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).catch((e: unknown) => e)) as unknown;
  ok(err instanceof LinearApiError, "§9 a 5xx keeps its exact behaviour — this seam reads the status and nothing else");
  eq(t.requests.length, 1, "§9 …one request");
  eq(t.slept, [], "§9 …no wait");
}
{
  const t = apiWith([graphqlErrors("Entity not found: Issue")]);
  const err = (await readLinearIssue(ISSUE_ID, { api: t.api, credentials: CREDENTIALS }).catch((e: unknown) => e)) as unknown;
  ok(err instanceof LinearApiError, "§9 a GraphQL refusal at HTTP 200 still raises LinearApiError");
  eq((err as LinearApiError).status, 200, "§9 …at status 200, which is the shape isDecidedLinearRefusal reads");
  eq(t.requests.length, 1, "🔴 §9 a decided refusal is NOT retried");
  eq(t.slept, [], "§9 …and costs no wait");
}
{
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  const clock = recorder();
  const err = (await readLinearIssue(ISSUE_ID, { api: { fetch: fetchFn, retry: { sleep: clock.sleep } }, credentials: CREDENTIALS }).catch((e: unknown) => e)) as Error;
  ok(/ECONNRESET/.test(err.message), "§9 a transport throw propagates unchanged");
  eq(calls, 1, "🔴 §9 …and is NOT retried — the request may have applied, and repeating it could double a post");
  eq(clock.slept, [], "§9 …with no wait");
}

{
  const t = apiWith([rateLimited("2"), graphqlData({ agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } })]);
  const res = await createLinearActivity({
    api: t.api,
    credentials: CREDENTIALS,
    activity: { agentSessionId: "sess-1", content: { type: "response", body: "the answer" } },
  });

  eq(t.slept, [2000], "§10 a rate-limited Agent Activity is retried — this is the mention route's ANSWER, lost on the first 429 before this change");
  eq(res.success, true, "§10 …and the reply lands");
  eq(res.id, "act-1", "§10 …with the activity id the caller records");
}
{
  const t = apiWith([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const err = (await createLinearActivity({
    api: t.api,
    credentials: CREDENTIALS,
    activity: { agentSessionId: "sess-1", content: { type: "response", body: "the answer" } },
  }).catch((e: unknown) => e)) as RateLimitExhaustedError;

  ok(err instanceof RateLimitExhaustedError, "§10 an exhausted activity post ends in the named failure");
  eq(err.operation, LINEAR_ACTIVITY_OPERATION, "§10 …naming eve's own mutation, so an operator can grep for the call that raised it");
  ok(!err.message.includes("sess-1"), "§10 …and the session id is not in it");
}

{
  const t = apiWith([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const err = (await callLinear({
    api: t.api,
    credentials: CREDENTIALS,
    query: "query OeProbe { viewer { id } }",
    queryName: "OeProbe",
  }).catch((e: unknown) => e)) as RateLimitExhaustedError;
  eq(err.operation, "OeProbe", "§11 the operation is the call's own queryName, taken by the seam rather than passed by the caller");
}

{
  eq(linearChannelOperation(JSON.stringify({ query: "\n      mutation AgentActivityCreate($input: X!) { a }", variables: { agentSessionId: "sess-1" } })), "AgentActivityCreate", "§11b the channel api reads eve's own operation name off the document");
  eq(linearChannelOperation(JSON.stringify({ query: "query OeViewer { viewer { id } }" })), "OeViewer", "§11b …a query as well as a mutation");
  eq(linearChannelOperation(JSON.stringify({ query: "query { viewer { id } }" })), LINEAR_CHANNEL_OPERATION, "§11b an ANONYMOUS document falls back to the channel label rather than guessing");
  eq(linearChannelOperation("not json at all"), LINEAR_CHANNEL_OPERATION, "§11b …so does an unreadable body");
  eq(linearChannelOperation(JSON.stringify({ variables: {} })), LINEAR_CHANNEL_OPERATION, "§11b …and a body with no query");
  eq(linearChannelOperation(undefined), LINEAR_CHANNEL_OPERATION, "§11b …and no body at all");

  const withIds = JSON.stringify({ query: "mutation AgentActivityCreate($input: X!) { a }", variables: { agentSessionId: "sess-secret", body: "a member's words" } });
  const op = linearChannelOperation(withIds);
  ok(!op.includes("sess-secret") && !op.includes("member"), "🔴 §11b the operation carries nothing from the variables");
}
{
  const stub = stubFetch([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  const channelApi = linearChannelApi({ fetch: stub.fetchFn, retry: { sleep: clock.sleep } });
  const body = JSON.stringify({ query: "mutation AgentActivityCreate($input: X!) { a }", variables: {} });
  const err = (await (channelApi.fetch as typeof fetch)("https://api.linear.app/graphql", { method: "POST", body }).catch((e: unknown) => e)) as RateLimitExhaustedError;

  ok(err instanceof RateLimitExhaustedError, `§11b eve's own channel calls are retried and end in the named failure (${String(err)})`);
  eq(err.operation, "AgentActivityCreate", "🔴 §11b …naming the mutation that posts the mention route's terminal answer");
  eq(err.surface, "linear", "§11b …on the linear surface");
  eq(stub.requests.length, 4, "§11b …after the same bounded attempts");
  eq(clock.slept, [1000, 1000, 1000], "§11b …honouring the same Retry-After delays");
}
{
  const base = "https://linear.test.invalid/graphql";
  eq(linearChannelApi({ apiBaseUrl: base, fetch: stubFetch([]).fetchFn }).apiBaseUrl, base, "🔴 §11c linearChannelApi forwards apiBaseUrl, the way retryingApi does");
  eq(linearChannelApi({ fetch: stubFetch([]).fetchFn }).apiBaseUrl, undefined, "§11c NEGATIVE CONTROL: a caller that names no base still gets none — the key is absent, never an empty string eve would send to");
  eq(linearChannelApi().apiBaseUrl, undefined, "§11c …and neither does the live no-argument call every channel config makes");
  ok(typeof linearChannelApi({ apiBaseUrl: base }).fetch === "function", "§11c …and the retrying fetch is still installed alongside the base");
}
{
  const tunable: LinearRetryPolicy = { maxAttempts: 2, capMs: 10, fallbackMs: 10, totalBudgetMs: 10, sleep: async () => {}, now: () => 0 };
  ok(tunable.maxAttempts === 2, "§11d every knob core calls tunable is still accepted by the Linear seam");
  const bodyReader: LinearRetryPolicy = { retryAfterMs: () => 0 };
  const forbidden: LinearRetryPolicy = { retryForbiddenWithRetryAfter: true };
  ok(bodyReader !== undefined && forbidden !== undefined, "🔴 §11d …and the two funnel-fixed fields are REFUSED (the @ts-expect-error rows above are the assertion — typecheck:all reds if either becomes settable)");
}

{
  const exhausted = new RateLimitExhaustedError({ surface: "linear", operation: "OeSetIssueState", attempts: 4, waitedMs: 3000 });
  const described = describeLinearError(exhausted);
  ok(/429/.test(described), `§12 an exhausted retry is described as the 429 it is (${described})`);
  ok(/OeSetIssueState/.test(described), "§12 …naming the operation that gave up");
  ok(!/network\/transport/.test(described), "🔴 §12 …and NOT as a network blip");
  eq(describeLinearError(new Error("boom")), "network/transport error", "§12 negative control: an ordinary throw keeps the generic transport label");
}
{
  const STATES = { issue: { team: { states: { nodes: [{ id: "s1", name: "Done" }] } } } };
  const t = apiWith([graphqlData(STATES), rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const err = (await setLinearIssueState(ISSUE_ID, "Done", { api: t.api, credentials: CREDENTIALS }).catch((e: unknown) => e)) as Error;
  ok(/rate limited/.test(err.message), `§12 set_state reports a rate-limit exhaustion as one (${err.message})`);
  ok(!err.message.includes(CREDENTIALS.accessToken), "§12 …token-free, like every other Linear failure message");
}

console.log(`  ${n} assertions passed`);
