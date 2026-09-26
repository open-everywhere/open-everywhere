import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import {
  createCommentReply,
  notionOperation,
  retrieveBotUser,
  retrieveComment,
  resolveNotionCredential,
  NOTION_INGRESS_RETRY,
  type FetchLike,
} from "../agent/channels/notion-api.js";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import { NOTION_CHANNEL_CREDENTIAL } from "../agent/channels/notion-credentials.js";
import { registerBroker, resetBrokers, setRegisteredConnectorCredentials, DEFAULT_TOTAL_BUDGET_MS } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("notion rate limit (OPE-1233):");

const API_KEY = "ntn_test_key";
const COMMENT_ID = "1b2c3d4e-5f60-4a1b-8c9d-0e1f2a3b4c5d";

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited" }), { status: 429, headers });
}

function stubFetch(queue: Response[]) {
  const requests: Array<{ url: string; method?: string; body?: unknown; headers: Record<string, string> }> = [];
  const fetchLike: FetchLike = async (url, init) => {
    const next = queue[requests.length];
    requests.push({
      url,
      method: init?.method,
      body: init?.body,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
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
  const stub = stubFetch([
    rateLimited("3"),
    rateLimited("1"),
    new Response(JSON.stringify({ id: COMMENT_ID, discussion_id: "d-1", rich_text: [] }), { status: 200 }),
  ]);
  const clock = recorder();
  const comment = await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: stub.fetchLike, retry: { sleep: clock.sleep } });

  eq(clock.slept, [3000, 1000], "429 sequence: the honoured delays are EXACTLY the Retry-After values (3 s, then 1 s)");
  eq(stub.requests.length, 3, "429 sequence: the request is repeated until Notion answers");
  eq(comment.discussion_id, "d-1", "429 sequence: the caller receives the eventual success body");
  eq(stub.requests[2].headers.authorization, `Bearer ${API_KEY}`, "429 sequence: the RETRY re-sends the same credential");
  eq(stub.requests[0].url, stub.requests[2].url, "429 sequence: the retry goes to the SAME url");
}

{
  const stub = stubFetch([rateLimited("2"), new Response(JSON.stringify({ id: "new-comment" }), { status: 200 })]);
  const clock = recorder();
  const id = await createCommentReply({
    discussionId: "d-1",
    text: "hello",
    apiKey: API_KEY,
    fetch: stub.fetchLike,
    retry: { sleep: clock.sleep },
  });

  eq(clock.slept, [2000], "write path: a rate-limited reply waits the delay Notion named");
  eq(stub.requests.length, 2, "write path: the reply POST is repeated, not abandoned on the first 429");
  eq(id, "new-comment", "write path: the caller gets the created comment id, not a lost reply");
  eq(stub.requests[1].method, "POST", "write path: the retry is still a POST");
  eq(
    stub.requests[0].body,
    stub.requests[1].body,
    "write path: the RETRY re-sends the identical body — one reply, not a different one (each attempt is snapshotted, so this compares two recordings, not one pointer twice)",
  );
  ok(
    typeof stub.requests[1].body === "string" && (stub.requests[1].body as string).includes("hello"),
    "write path: …and that body is the caller's reply text, so the comparison above is over a real payload",
  );
}

{
  const stub = stubFetch([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }

  ok(caught instanceof RateLimitExhaustedError, "exhaustion: the failure is the NAMED RateLimitExhaustedError, not a bare 429 message");
  const e = caught as RateLimitExhaustedError;
  eq(e.name, "RateLimitExhaustedError", "exhaustion: the error name is readable by a caller that logs it");
  eq(e.surface, "notion", "exhaustion: the surface names Notion");
  eq(e.operation, "GET /v1/comments/{id}", "exhaustion: the operation is the endpoint SHAPE — the comment id is redacted out of it");
  eq(e.status, 429, "exhaustion: the refusal's HTTP status rides the error, so a classifier reads the same 429");
  eq(e.attempts, 4, "exhaustion: four attempts under the shared default");
  eq(e.waitedMs, 3000, "exhaustion: the total honoured wait is the sum of the three delays");
  eq(clock.slept, [1000, 1000, 1000], "exhaustion: three waits, one fewer than the attempts");
  eq(stub.requests.length, 4, "exhaustion: the fourth refusal is not followed by a fifth request");
  ok(!e.message.includes(COMMENT_ID), "exhaustion: the message carries NO comment id — every field on this error is safe to log");
}

{
  const okStub = stubFetch([new Response(JSON.stringify({ id: "u-1", type: "bot", name: "OE" }), { status: 200 })]);
  const okClock = recorder();
  const user = await retrieveBotUser({ apiKey: API_KEY, fetch: okStub.fetchLike, retry: { sleep: okClock.sleep } });
  eq(okClock.slept, [], "negative control: a 200 sleeps ZERO times");
  eq(okStub.requests.length, 1, "negative control: a 200 is requested EXACTLY once");
  eq(user.id, "u-1", "negative control: a 200 body reaches the caller unchanged");

  const missStub = stubFetch([new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 })]);
  const missClock = recorder();
  let missErr: unknown;
  try {
    await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: missStub.fetchLike, retry: { sleep: missClock.sleep } });
  } catch (err) {
    missErr = err;
  }
  eq(missClock.slept, [], "negative control: a 404 sleeps ZERO times");
  eq(missStub.requests.length, 1, "negative control: a 404 is requested EXACTLY once");
  ok(missErr instanceof Error && !(missErr instanceof RateLimitExhaustedError), "negative control: a 404 raises the helper's own error, never the rate-limit one");
  ok((missErr as Error).message.startsWith("retrieveComment"), "negative control: the 404 message is the pre-existing one");

  const errStub = stubFetch([new Response("boom", { status: 500 })]);
  const errClock = recorder();
  let serverErr: unknown;
  try {
    await createCommentReply({ discussionId: "d-1", text: "hi", apiKey: API_KEY, fetch: errStub.fetchLike, retry: { sleep: errClock.sleep } });
  } catch (err) {
    serverErr = err;
  }
  eq(errClock.slept, [], "negative control: a 500 sleeps ZERO times");
  eq(errStub.requests.length, 1, "negative control: a 500 is requested EXACTLY once — this seam retries a 429 and nothing else");
  ok(serverErr instanceof Error && !(serverErr instanceof RateLimitExhaustedError), "negative control: a 500 keeps raising createCommentReply's own error");
  eq((serverErr as { status?: number }).status, 500, "negative control: the OPE-825 numeric status still rides the 5xx error");
}

{
  const clock = recorder();
  let calls = 0;
  const throwing: FetchLike = async () => {
    calls++;
    throw new Error("socket hang up");
  };
  let caught: unknown;
  try {
    await createCommentReply({ discussionId: "d-1", text: "hi", apiKey: API_KEY, fetch: throwing, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }
  eq(calls, 1, "transport throw: the unanswered POST is sent ONCE — repeating it could double a reply");
  eq(clock.slept, [], "transport throw: nothing is slept on");
  ok(caught instanceof Error && (caught as Error).message === "socket hang up", "transport throw: the original error propagates untouched");
}

{
  const stub = stubFetch([rateLimited("not-a-delay"), new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  const clock = recorder();
  await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [1000], "malformed Retry-After: the seam waits the 1 s fallback, never zero");

  const absent = stubFetch([rateLimited(undefined), new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  const absentClock = recorder();
  await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: absent.fetchLike, retry: { sleep: absentClock.sleep } });
  eq(absentClock.slept, [1000], "absent Retry-After: the same fallback applies");
}

{
  const nowMs = Date.parse("Thu, 27 Aug 2026 12:00:00 GMT");
  const stub = stubFetch([rateLimited("Thu, 27 Aug 2026 12:00:05 GMT"), new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  const clock = recorder();
  await retrieveComment(COMMENT_ID, {
    apiKey: API_KEY,
    fetch: stub.fetchLike,
    retry: { sleep: clock.sleep, now: () => nowMs },
  });
  eq(clock.slept, [5000], "HTTP-date Retry-After: the delay is the gap to that absolute time, read off the injected clock");
}

{
  const stub = stubFetch([rateLimited("600"), new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  const clock = recorder();
  await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [30_000], "cap: a 10-minute Retry-After is clamped to the 30 s per-wait ceiling, not obeyed literally");

  const budgeted = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const budgetClock = recorder();
  let caught: unknown;
  try {
    await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: budgeted.fetchLike, retry: { sleep: budgetClock.sleep } });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "total budget: the call ends in the named failure rather than overrunning");
  eq(budgetClock.slept, [30_000, 30_000], "total budget: exactly two 30 s waits fit the 60 s budget; the third is refused BEFORE it is spent");
  eq(budgeted.requests.length, 3, "total budget: the refused wait means no fourth request");
}

{
  const allowed = stubFetch([new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  await retrieveComment(COMMENT_ID, {
    apiKey: API_KEY,
    fetch: allowed.fetchLike,
    endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET"] },
  });
  eq(allowed.requests.length, 1, "fence positive control: permissive rules DO reach the transport");

  const fenced = stubFetch([new Response(JSON.stringify({ id: "x" }), { status: 200 })]);
  let refused: unknown;
  try {
    await retrieveComment(COMMENT_ID, {
      apiKey: API_KEY,
      fetch: fenced.fetchLike,
      endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/blocks"], methods: ["GET"] },
    });
  } catch (err) {
    refused = err;
  }
  ok(refused instanceof Error, "fence: rules that forbid /v1/comments still refuse the call");
  eq(fenced.requests.length, 0, "🔴 fence: the request never reached the transport — wrapping the funnel in the retry did NOT move the fence off the dispatch path");
}

{
  eq(notionOperation("GET", `https://api.notion.com/v1/comments/${COMMENT_ID}`), "GET /v1/comments/{id}", "operation: a dashed uuid segment redacts to {id}");
  eq(
    notionOperation("GET", "https://api.notion.com/v1/blocks/1b2c3d4e5f604a1b8c9d0e1f2a3b4c5d/children"),
    "GET /v1/blocks/{id}/children",
    "operation: an UNDASHED 32-hex id redacts too, and the fixed segment after it survives",
  );
  eq(notionOperation("GET", "https://api.notion.com/v1/users/me"), "GET /v1/users/me", "operation: a fixed segment is NOT mistaken for an id");
  eq(
    notionOperation("GET", `https://api.notion.com/v1/comments?block_id=${COMMENT_ID}&page_size=100`),
    "GET /v1/comments",
    "operation: the query string is dropped whole — `block_id` is an id as much as a path segment is",
  );
  eq(notionOperation("POST", "https://api.notion.com/v1/search"), "POST /v1/search", "operation: the method is upper-cased and carried");
  eq(notionOperation(undefined, "https://api.notion.com/v1/search"), "GET /v1/search", "operation: an absent method reads as GET, matching fetch's own default");
  eq(notionOperation("POST", "not a url"), "POST", "operation: an unparseable url falls back to the method alone rather than guessing a path");
  eq(
    notionOperation("GET", "https://api.notion.com/v1/blocks/abc123/children"),
    "GET /v1/blocks/abc123/children",
    "operation: a segment that is NOT uuid-shaped is NOT redacted — the rule keys on the shape, and Notion's own ids are always uuids",
  );
}

{
  const INGRESS_MAX_DURATION_MS = 300_000;
  const CALLS_ON_THE_DELIVERY_PATH = 15;
  const worstCasePerCall = Math.min(
    NOTION_INGRESS_RETRY.totalBudgetMs,
    (NOTION_INGRESS_RETRY.maxAttempts - 1) * NOTION_INGRESS_RETRY.capMs,
  );
  ok(
    worstCasePerCall * CALLS_ON_THE_DELIVERY_PATH < INGRESS_MAX_DURATION_MS / 2,
    `🔴 11a the ingress policy's worst case (${worstCasePerCall} ms x ${CALLS_ON_THE_DELIVERY_PATH} calls) leaves over half the 300 s ingress ceiling for the work itself`,
  );
  ok(
    DEFAULT_TOTAL_BUDGET_MS * CALLS_ON_THE_DELIVERY_PATH > INGRESS_MAX_DURATION_MS,
    `🔴 11a NEGATIVE CONTROL: the SHARED defaults (${DEFAULT_TOTAL_BUDGET_MS} ms per call) overrun that same ceiling — which is the defect this policy exists for`,
  );

  const tight = stubFetch([rateLimited("600"), rateLimited("600")]);
  const tightClock = recorder();
  let tightErr: unknown;
  try {
    await retrieveComment(COMMENT_ID, { apiKey: API_KEY, fetch: tight.fetchLike, retry: { ...NOTION_INGRESS_RETRY, sleep: tightClock.sleep } });
  } catch (err) {
    tightErr = err;
  }
  eq(tightClock.slept, [2_000], "11b the ingress policy clamps a 10-minute Retry-After to its own 2 s cap, not the shared 30 s one");
  eq(tight.requests.length, 2, "11b …and spends exactly two attempts, not the shared four");
  ok(tightErr instanceof RateLimitExhaustedError, "11b …then ends in the named failure, which the caller fail-softs");

  resetBrokers();
  registerBroker("test", { async getSecret() { return API_KEY; } });
  setRegisteredConnectorCredentials([
    { connector: "notion", allows: ["api-key"], credentials: [{ id: NOTION_CHANNEL_CREDENTIAL, type: "api-key", secretRef: "db:notion:channel-key", broker: "test", intake: false }] },
  ]);
  const deliverySlept: number[] = [];
  let deliveryFetches = 0;
  const body = JSON.stringify({
    type: "comment.created",
    workspace_id: "ws-1",
    entity: { id: "cmt-1", type: "comment" },
    data: { page_id: "11111111-1111-1111-1111-111111111111" },
  });
  const secret = "verification-token";
  await handleNotionDelivery(body, "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex"), {
    signingKeys: [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret }],
    allowUnverified: false,
    credentialFor: (id) => resolveNotionCredential(id),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "U_BOT",
    ambientEnabled: () => true,
    fetch: async () => {
      deliveryFetches += 1;
      return rateLimited("600");
    },
    retry: { sleep: async (ms: number) => void deliverySlept.push(ms) },
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(deliveryFetches > 0, "11c positive control: the delivery DID reach the injected fetch, so the sequence below is a real one");
  eq(
    deliverySlept,
    [2_000],
    `🔴 11c the DELIVERY path spent exactly one 2 s wait — the ingress policy's own cap, taken from ingressCallOpts and not from this test. A call site building its options inline records NOTHING here and sleeps the shared 30 s for real (recorded: ${JSON.stringify(deliverySlept)})`,
  );
  resetBrokers();
}

console.log(`  ${n} assertions passed`);
