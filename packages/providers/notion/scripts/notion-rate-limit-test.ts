import assert from "node:assert/strict";
import {
  RateLimitExhaustedError,
  setRegisteredConnectorCredentials,
  vercelConnectorHome,
  type CredentialGrantRow,
  type GrantOwnerSubject,
  type GrantedRequest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_GRANT_CREDENTIAL, notionGrantTransport } from "../agent/channels/notion-grant-transport.js";
import {
  createCommentReply,
  notionOperation,
  retrieveBotUser,
  retrieveComment,
  type FetchLike,
} from "../agent/channels/notion-api.js";

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
const COMMENT_ID = "00000000-0000-4000-8000-000000000013";

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
  const OAUTH_HOME = "mcp.notion.com/notion-mcp";
  const PAGE = "00000000-0000-4000-8000-000000000014";
  setRegisteredConnectorCredentials([
    {
      allows: ["api-key", "user-oauth"],
      connector: "notion",
      credentials: [
        {
          endpoints: { hosts: ["api.notion.com"], methods: ["GET"], pathPrefixes: ["/v1/"] },
          home: vercelConnectorHome(OAUTH_HOME),
          id: NOTION_GRANT_CREDENTIAL,
          type: "user-oauth" as const,
        },
      ],
      description: "notion (rate-limit test catalogue)",
    },
  ]);

  const grant = {
    askId: "ask-1", connector: "notion", createdAt: "2026-01-29T18:22:00.000Z", expiresAt: "2026-01-20T16:07:00.000Z",
    id: "grant-1", mode: "session", ownerPrincipalId: "slack/W1/U-owner", ownerSlug: "rowan",
    purpose: "draft the Q3 summary", requesterPrincipalId: "slack/W1/U-req", resource: `notion:page/${PAGE}`,
    scopeKey: "session-1", status: "active", tier: "read", verb: "read_page",
  } as CredentialGrantRow;
  const ownerSubject: GrantOwnerSubject = { org: "acme", vaultSubject: "p:acme/slack/W1/U-owner" };
  const request: GrantedRequest = { method: "GET", url: `https://api.notion.com/v1/blocks/${PAGE}/children` };

  function armGrant(queue: Response[], sleep: (ms: number) => Promise<void>) {
    let calls = 0;
    const transport = notionGrantTransport({
      async fetch() {
        const next = queue[calls];
        calls += 1;
        if (next === undefined) throw new Error("stub fetch ran out of responses");
        return next;
      },
      async mintOwnerToken() {
        return "tok-owner";
      },
      retry: { sleep },
    });
    return { transport, calls: () => calls };
  }

  {
    const clock = recorder();
    const armed = armGrant([rateLimited("2"), new Response(JSON.stringify({ object: "list", results: [] }), { status: 200 })], clock.sleep);
    await armed.transport(request, grant, ownerSubject);
    eq(clock.slept, [2000], "granted plane: the honoured delay is EXACTLY the Retry-After the refusal named");
    eq(armed.calls(), 2, "granted plane: the call is repeated, not abandoned on the first 429");
  }

  {
    const clock = recorder();
    const armed = armGrant([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")], clock.sleep);
    let caught: unknown;
    try {
      await armed.transport(request, grant, ownerSubject);
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof RateLimitExhaustedError, "granted plane: exhaustion ends in the NAMED failure, not a bare HTTP 429 refusal message");
    const e = caught as RateLimitExhaustedError;
    eq(e.surface, "notion", "granted plane: the surface names Notion");
    eq(e.operation, "GET /v1/blocks/{id}/children", "granted plane: the operation is the endpoint SHAPE — the page id is redacted");
    eq(e.attempts, 4, "granted plane: four attempts under the shared default");
    ok(!e.message.includes("tok-owner"), "🔴 granted plane: the OWNER'S minted token is nowhere in the message");
    eq(armed.calls(), 4, "granted plane: the fourth refusal is not followed by a fifth request");
  }

  {
    const clock = recorder();
    const armed = armGrant([new Response(JSON.stringify({ object: "list", results: [] }), { status: 200 })], clock.sleep);
    await armed.transport(request, grant, ownerSubject);
    eq(clock.slept, [], "granted plane negative control: a 200 sleeps ZERO times");
    eq(armed.calls(), 1, "granted plane negative control: a 200 is requested EXACTLY once");
  }
}

console.log(`  ${n} assertions passed`);
