import assert from "node:assert/strict";
import {
  DEFAULT_CAP_MS,
  DEFAULT_FALLBACK_MS,
  RateLimitExhaustedError,
  isRateLimitedForbidden,
  parseRetryAfterMs,
  withRetryAfter,
  withRetryAfterLoose,
} from "../agent/channels/rate-limit-retry.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("rate-limit-retry:");

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response("{\"ok\":false,\"error\":\"ratelimited\"}", { status: 429, headers });
}

function scripted(queue: Array<Response | Error>) {
  const state = { calls: 0 };
  const send = async (): Promise<Response> => {
    const next = queue[Math.min(state.calls, queue.length - 1)];
    state.calls += 1;
    if (next === undefined) throw new Error("scripted transport was given an empty queue");
    if (next instanceof Error) throw next;
    return next;
  };
  return { send, state };
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

{
  const { send, state } = scripted([
    rateLimited("2"),
    rateLimited("5"),
    new Response("{\"ok\":true,\"ts\":\"1.0\"}", { status: 200 }),
  ]);
  const clock = recorder();
  const res = await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });

  eq(state.calls, 3, "429,429,200: the call is repeated until Slack stops refusing");
  eq(clock.slept, [2000, 5000], "429 sequence: the HONOURED delays are exactly what Retry-After named (2 s, then 5 s)");
  eq(res.status, 200, "429 sequence: the answer returned is the first non-429 response");
  eq(await res.json(), { ok: true, ts: "1.0" }, "429 sequence: the success body reaches the caller intact");
}

{
  const { send, state } = scripted([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", maxAttempts: 4, sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }

  ok(caught instanceof RateLimitExhaustedError, "exhausted: the failure is a RateLimitExhaustedError, not undefined and not a bare Error");
  eq((caught as Error).name, "RateLimitExhaustedError", "exhausted: the error NAME is the named failure a log or a caller reads");
  eq(state.calls, 4, "exhausted: maxAttempts bounds the calls (4 attempts, not an unbounded loop)");
  eq(clock.slept, [1000, 1000, 1000], "exhausted: 4 attempts means 3 waits — the last refusal is not slept on");
  const err = caught as RateLimitExhaustedError;
  eq(err.attempts, 4, "exhausted: the error reports the attempts made");
  eq(err.waitedMs, 3000, "exhausted: the error reports the total honoured wait");
  eq(err.surface, "slack", "exhausted: the error names the surface");
  eq(err.operation, "chat.postMessage", "exhausted: the error names the operation");
}

{
  const cases: Array<{ label: string; body: string; status: number }> = [
    { label: "200 ok:true", body: "{\"ok\":true}", status: 200 },
    { label: "200 ok:false (application refusal)", body: "{\"ok\":false,\"error\":\"channel_not_found\"}", status: 200 },
    { label: "500 server error", body: "oops", status: 500 },
    { label: "403 forbidden", body: "{\"ok\":false}", status: 403 },
    { label: "408 request timeout (ambiguous, but not a rate limit)", body: "", status: 408 },
    { label: "430 — adjacent to 429 and NOT it", body: "", status: 430 },
  ];
  for (const c of cases) {
    const { send, state } = scripted([new Response(c.body, { status: c.status })]);
    const clock = recorder();
    const res = await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
    eq(state.calls, 1, `negative control (${c.label}): called exactly once — never retried`);
    eq(clock.slept, [], `negative control (${c.label}): ZERO sleeps — the non-429 path is untouched`);
    eq(res.status, c.status, `negative control (${c.label}): the response passes through unchanged`);
  }
}

{
  const boom = new Error("socket hang up");
  const { send, state } = scripted([boom]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }
  eq(caught, boom, "transport throw: the original error reaches the caller unwrapped");
  eq(state.calls, 1, "transport throw: never retried — an unanswered write may already have applied");
  eq(clock.slept, [], "transport throw: ZERO sleeps");
}

{
  const { send } = scripted([rateLimited("86400"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
  eq(clock.slept, [DEFAULT_CAP_MS], "cap: a Retry-After of a day is clamped to the per-wait ceiling");
}
{
  const { send } = scripted([rateLimited(undefined), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
  eq(clock.slept, [DEFAULT_FALLBACK_MS], "fallback: a 429 with NO Retry-After waits the documented floor, not zero");
}
{
  const { send } = scripted([rateLimited("not-a-delay"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
  eq(clock.slept, [DEFAULT_FALLBACK_MS], "fallback: an unreadable Retry-After waits the floor rather than guessing");
}

{
  const { send, state } = scripted([rateLimited("30"), rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, {
      surface: "slack",
      operation: "chat.postMessage",
      maxAttempts: 4,
      capMs: 30_000,
      totalBudgetMs: 45_000,
      sleep: clock.sleep,
    });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "budget: overrunning the total budget produces the same named failure");
  eq(clock.slept, [30_000], "budget: the SECOND 30 s wait would exceed a 45 s budget, so it is never slept");
  eq((caught as RateLimitExhaustedError).waitedMs, 30_000, "budget: the total wait stayed under the budget");
  eq(state.calls, 2, "budget: the sequence stopped early — attempts were still available");
}
{
  const { send } = scripted([rateLimited("30"), rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "s", operation: "o", sleep: clock.sleep }).catch(() => undefined);
  eq(clock.slept, [30_000, 30_000], "budget: at the DEFAULTS the 60 s budget stops the third wait, capping one call at 60 s");
}

{
  const { send, state } = scripted([rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, { surface: "slack", operation: "x", maxAttempts: 1, sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "maxAttempts=1: the single refusal is already exhaustion");
  eq(state.calls, 1, "maxAttempts=1: exactly one call");
  eq(clock.slept, [], "maxAttempts=1: no wait — there is no attempt left to wait for");
}

{
  const now = Date.parse("2026-08-27T12:00:00Z");
  eq(parseRetryAfterMs("30", now), 30_000, "parse: delta-seconds becomes milliseconds");
  eq(parseRetryAfterMs("0", now), 0, "parse: a zero delay is zero, not the fallback");
  eq(parseRetryAfterMs("  7  ", now), 7000, "parse: surrounding whitespace is tolerated");
  eq(parseRetryAfterMs("Thu, 27 Aug 2026 12:00:20 GMT", now), 20_000, "parse: an HTTP-date becomes the delay to that instant");
  eq(parseRetryAfterMs("Thu, 27 Aug 2026 11:59:00 GMT", now), 0, "parse: an HTTP-date already past clamps to 0");
  eq(parseRetryAfterMs(null, now), undefined, "parse: an absent header has no delay");
  eq(parseRetryAfterMs(undefined, now), undefined, "parse: an undefined header has no delay");
  eq(parseRetryAfterMs("", now), undefined, "parse: an empty header has no delay");
  eq(parseRetryAfterMs("   ", now), undefined, "parse: a whitespace-only header has no delay");
  eq(parseRetryAfterMs("-5", now), undefined, "parse: a NEGATIVE value is not delta-seconds — it must not become a negative wait");
  eq(parseRetryAfterMs("1.5", now), undefined, "parse: a fractional value is not delta-seconds");
  eq(parseRetryAfterMs("soon", now), undefined, "parse: a word is neither form");
}

{
  const headers = new Headers();
  headers.set("retry-after", "2");
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers, text: async () => "x", json: async () => ({}) };
    return { ok: true, status: 200, headers: new Headers(), text: async () => "ok", json: async () => ({ ok: true }) };
  };
  const clock = recorder();
  const res = await withRetryAfterLoose(send, { surface: "s", operation: "o", sleep: clock.sleep });
  eq(clock.slept, [2000], "loose 8a: a response that already carries headers honours Retry-After exactly");
  eq(res.status, 200, "loose 8a: the eventual success is returned");
}
{
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, text: async () => "x", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true }) };
  };
  const clock = recorder();
  const res = await withRetryAfterLoose(send, { surface: "s", operation: "o", sleep: clock.sleep });
  eq(clock.slept, [DEFAULT_FALLBACK_MS], "loose 8b: a headers-less response retries on the fallback wait, not zero and not a crash");
  eq(res.status, 200, "loose 8b: the eventual success is returned");
}
{
  class FakeResponse {
    constructor(
      readonly ok: boolean,
      readonly status: number,
      private readonly bodyText: string,
    ) {}
    async text(): Promise<string> {
      return this.bodyText;
    }
    async json(): Promise<unknown> {
      return JSON.parse(this.bodyText);
    }
  }
  let calls = 0;
  const send = async (): Promise<FakeResponse> => {
    calls++;
    if (calls === 1) return new FakeResponse(false, 429, "{}");
    return new FakeResponse(true, 200, '{"minted":"tok"}');
  };
  const clock = recorder();
  const res = await withRetryAfterLoose(send, { surface: "s", operation: "o", sleep: clock.sleep });
  eq(clock.slept, [DEFAULT_FALLBACK_MS], "loose 8c: a class-instance response also retries on the fallback wait");
  eq(res.status, 200, "loose 8c: status (an own property) survives the proxy");
  ok(res instanceof FakeResponse, "loose 8c: the proxy still reports as an instance of the original class");
  eq(await res.json(), { minted: "tok" }, "🔴 loose 8c: json() — a PROTOTYPE method — still works and resolves `this` correctly through the proxy");
  const withHeaders = res as unknown as { headers: { get(name: string): string | null } };
  eq(withHeaders.headers.get("retry-after"), null, "loose 8c: the injected headers accessor answers null for every header");
}
{
  let calls = 0;
  const send = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true }) };
  };
  const clock = recorder();
  await withRetryAfterLoose(send, { surface: "s", operation: "o", sleep: clock.sleep });
  eq(clock.slept, [], "loose 8d negative control: a headers-less 2xx sleeps zero times");
  eq(calls, 1, "loose 8d negative control: called exactly once");
}
{
  let calls = 0;
  const send = async () => {
    calls++;
    return { ok: false, status: 429, text: async () => "x", json: async () => ({}) };
  };
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfterLoose(send, { surface: "loose-surface", operation: "loose-op", sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "loose 8e: exhaustion through the loose adapter is still the NAMED failure");
  eq((caught as RateLimitExhaustedError).surface, "loose-surface", "loose 8e: the surface survives the adapter");
  eq(calls, 4, "loose 8e: four attempts under the shared default");
}

{
  const { send } = scripted([rateLimited("9"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "discord", operation: "POST /x", sleep: clock.sleep, retryAfterMs: () => 750 });
  eq(clock.slept, [750], "override 9a: the body-based delay (750 ms) wins over the 9 s header");
}
{
  const { send } = scripted([rateLimited("3"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "discord", operation: "POST /x", sleep: clock.sleep, retryAfterMs: () => undefined });
  eq(clock.slept, [3000], "override 9b: an override that yields nothing falls back to the header (3 s)");
}
{
  for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { send } = scripted([rateLimited("2"), new Response("{}", { status: 200 })]);
    const clock = recorder();
    await withRetryAfter(send, { surface: "d", operation: "o", sleep: clock.sleep, retryAfterMs: () => bad });
    eq(clock.slept, [2000], `override 9c: an unusable override value (${bad}) falls back to the header, not a wrong wait`);
  }
}
{
  const { send } = scripted([new Response("{}", { status: 200 })]);
  const clock = recorder();
  let overrideCalls = 0;
  const res = await withRetryAfter(send, {
    surface: "d",
    operation: "o",
    sleep: clock.sleep,
    retryAfterMs: () => {
      overrideCalls++;
      return 500;
    },
  });
  eq(overrideCalls, 0, "override 9d: a non-429 never consults the body override");
  eq(clock.slept, [], "override 9d: …and it is not slept on");
  eq(res.status, 200, "override 9d: the 200 passes through untouched");
}
{
  const { send } = scripted([rateLimited("9"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "d", operation: "o", sleep: clock.sleep, retryAfterMs: async () => 250 });
  eq(clock.slept, [250], "override 9e: an ASYNC override is awaited, and its value wins");
}

function forbidden(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response('{"message":"Forbidden"}', { status: 403, headers });
}

{
  const { send, state } = scripted([forbidden("3"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  const res = await withRetryAfter(send, { surface: "slack", operation: "chat.postMessage", sleep: clock.sleep });
  eq(state.calls, 1, "🔴 403 10a: with NO opt-in, a 403 bearing Retry-After is sent EXACTLY once — the contract for every other provider is unchanged");
  eq(clock.slept, [], "403 10a: …and it is never slept on");
  eq(res.status, 403, "403 10a: …and the 403 comes back untouched for the caller to refuse");
}
{
  const { send, state } = scripted([forbidden("3"), new Response("{}", { status: 200 })]);
  const clock = recorder();
  await withRetryAfter(send, { surface: "notion", operation: "pages.create", sleep: clock.sleep, retryForbiddenWithRetryAfter: false });
  eq(state.calls, 1, "403 10b: an explicit `false` opt-in is the same as no opt-in — one request");
  eq(clock.slept, [], "403 10b: …and no sleep");
}
{
  const { send, state } = scripted([forbidden("3"), new Response('{"id":"c1"}', { status: 201 })]);
  const clock = recorder();
  const res = await withRetryAfter(send, {
    surface: "github",
    operation: "issues.createComment",
    sleep: clock.sleep,
    retryForbiddenWithRetryAfter: true,
  });
  eq(clock.slept, [3000], "🔴 403 10c: the opted-in seam honours the 403's Retry-After (3 s) — the behaviour OPE-1256 adds");
  eq(state.calls, 2, "403 10c: the write is repeated once, then accepted");
  eq(res.status, 201, "403 10c: the caller receives the eventual success");
}
{
  const { send, state } = scripted([forbidden(), new Response("{}", { status: 200 })]);
  const clock = recorder();
  const res = await withRetryAfter(send, {
    surface: "github",
    operation: "issues.createComment",
    sleep: clock.sleep,
    retryForbiddenWithRetryAfter: true,
  });
  eq(state.calls, 1, "🔴 403 10d: a BARE 403 is a permission refusal — sent EXACTLY once even on the opted-in seam");
  eq(clock.slept, [], "🔴 403 10d: …and never slept on, so a genuine denial can never become a hot loop");
  eq(res.status, 403, "403 10d: …and it comes back untouched");
}
{
  for (const bad of ["", "  ", "soon", "-5", "3.5"]) {
    const { send, state } = scripted([forbidden(bad), new Response("{}", { status: 200 })]);
    const clock = recorder();
    const res = await withRetryAfter(send, { surface: "github", operation: "o", sleep: clock.sleep, retryForbiddenWithRetryAfter: true });
    eq(state.calls, 1, `🔴 403 10e: a 403 whose Retry-After (${JSON.stringify(bad)}) does not parse stays a refusal — one request`);
    eq(clock.slept, [], `403 10e: …and no fallback wait is taken for ${JSON.stringify(bad)}`);
    eq(res.status, 403, `403 10e: …and the 403 is returned for ${JSON.stringify(bad)}`);
  }
}
{
  const { send, state } = scripted([forbidden("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, {
      surface: "github",
      operation: "issues.createComment",
      sleep: clock.sleep,
      maxAttempts: 3,
      retryForbiddenWithRetryAfter: true,
    });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "403 10f: an exhausted 403 sequence throws the NAMED failure, never a silent drop");
  eq((caught as RateLimitExhaustedError).refusalStatus, 403, "🔴 403 10f: `refusalStatus` carries the spelling the vendor actually sent");
  eq((caught as RateLimitExhaustedError).status, 429, "🔴 403 10f: `status` stays 429 — the error MEANS rate limited, so it must not route into the permission-denied arm");
  eq((caught as RateLimitExhaustedError).attempts, 3, "403 10f: it gave up after the bounded attempts");
  eq(state.calls, 3, "403 10f: …which is exactly the number of requests sent");
}
{
  const { send } = scripted([rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await withRetryAfter(send, { surface: "slack", operation: "o", sleep: clock.sleep, maxAttempts: 2 });
  } catch (err) {
    caught = err;
  }
  eq((caught as RateLimitExhaustedError).refusalStatus, 429, "403 10g: a 429 exhaustion still reports refusalStatus 429");
}
{
  const at = Date.UTC(2026, 0, 1, 0, 0, 0);
  ok(isRateLimitedForbidden(forbidden("5"), at), "403 10h: a 403 with delta-seconds IS a rate-limit refusal");
  ok(isRateLimitedForbidden(forbidden("Thu, 01 Jan 2026 00:00:30 GMT"), at), "403 10h: …and an HTTP-date form is too");
  ok(!isRateLimitedForbidden(forbidden(), at), "🔴 403 10h: a bare 403 is NOT");
  ok(!isRateLimitedForbidden(forbidden("later"), at), "🔴 403 10h: nor is one whose header does not parse");
  ok(!isRateLimitedForbidden(rateLimited("5"), at), "403 10h: a 429 is not routed through this predicate — it is already a refusal by status");
  ok(!isRateLimitedForbidden(new Response("{}", { status: 401, headers: new Headers({ "retry-after": "5" }) }), at), "🔴 403 10h: a 401 bearing Retry-After is NOT admitted — the opt-in widens to 403 and nothing else");
  ok(!isRateLimitedForbidden(new Response("{}", { status: 500, headers: new Headers({ "retry-after": "5" }) }), at), "🔴 403 10h: nor is a 500 bearing Retry-After");
}

console.log(`✓ rate-limit-retry: ${n} assertions passed (honoured delay, named exhaustion, non-429 negative controls, cap/fallback/total-budget, Retry-After parsing, the withRetryAfterLoose adapter, the retryAfterMs body override, the per-seam 403 opt-in)`);
