import assert from "node:assert/strict";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import { discordFetch, discordBodyRetryAfterMs, DISCORD_SURFACE, type DiscordFetchLike } from "@open-everywhere/provider-discord/agent/channels/discord-rest.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("discord rate limit (OPE-1236):");

const OP = "POST /channels/{id}/messages";
const URL = "https://discord.com/api/v10/channels/999888777/messages";
const INIT: RequestInit = { method: "POST", headers: { authorization: "Bot xoxb-not-a-real-token" }, body: JSON.stringify({ content: "hi" }) };

function rateLimited(opts: { bodyRetryAfter?: number; header?: string; global?: boolean } = {}): Response {
  const headers = new Headers();
  if (opts.header !== undefined) headers.set("retry-after", opts.header);
  const body: Record<string, unknown> = { message: "You are being rate limited." };
  if (opts.bodyRetryAfter !== undefined) body.retry_after = opts.bodyRetryAfter;
  if (opts.global !== undefined) body.global = opts.global;
  return new Response(JSON.stringify(body), { status: 429, headers });
}

const okJson = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status });

function stubFetch(queue: Response[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchLike: DiscordFetchLike = async (url, init) => {
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
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.75, header: "9", global: false }), okJson({ id: "m1" })]);
  const clock = recorder();
  const res = await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });

  eq(clock.slept, [750], "🔴 body precedence: the JSON retry_after (0.75 s) is honoured to the ms, NOT the 9 s header and NOT the fallback");
  eq(stub.requests.length, 2, "body precedence: the write is repeated once, then accepted");
  eq(res.status, 200, "body precedence: the caller receives the eventual success");
  eq(((await res.json()) as { id: string }).id, "m1", "body precedence: the success body survives the retry — the 429 clone-read did not disturb it");
}

{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 2.5, header: "3" }), okJson({ id: "m2" })]);
  const clock = recorder();
  await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [2500], "body wins: 2.5 s from the body, not 3 s from the header");
}

{
  const stub = stubFetch([rateLimited({ header: "4", global: true }), okJson({ id: "m3" })]);
  const clock = recorder();
  await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [4000], "header fallback: with no body retry_after, the Retry-After header (4 s) is honoured");
}

{
  const stub = stubFetch([rateLimited({}), okJson({ id: "m4" })]);
  const clock = recorder();
  await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  eq(clock.slept, [1000], "no source: a 429 with neither a body retry_after nor a header waits the 1 s floor");
}

{
  for (const status of [200, 404, 500] as const) {
    const stub = stubFetch([okJson({ status }, status)]);
    const clock = recorder();
    const res = await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
    eq(clock.slept, [], `negative control: a ${status} sleeps ZERO times`);
    eq(stub.requests.length, 1, `negative control: a ${status} is requested EXACTLY once`);
    eq(res.status, status, `negative control: a ${status} comes back untouched, so the caller's res.ok/res.status read is unchanged`);
  }
}

{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 })]);
  const clock = recorder();
  let caught: unknown;
  try {
    await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }

  ok(caught instanceof RateLimitExhaustedError, "exhaustion: the failure is the NAMED RateLimitExhaustedError, not a bare 429");
  const e = caught as RateLimitExhaustedError;
  eq(e.name, "RateLimitExhaustedError", "exhaustion: the error name is readable by a caller that logs it");
  eq(e.surface, DISCORD_SURFACE, "exhaustion: the surface names discord");
  eq(e.operation, OP, "exhaustion: the operation is the id-free vendor route shape");
  eq(e.status, 429, "exhaustion: the refusal's HTTP status rides the error");
  eq(e.attempts, 4, "exhaustion: four attempts under the shared default");
  eq(e.waitedMs, 1500, "exhaustion: the total honoured wait is the sum of the three 0.5 s body delays");
  eq(clock.slept, [500, 500, 500], "exhaustion: three waits, one fewer than the attempts");
  eq(stub.requests.length, 4, "exhaustion: the fourth refusal is not followed by a fifth request");
  ok(!e.message.includes("xoxb"), "🔴 exhaustion: the message carries NO token");
  ok(!e.message.includes("999888777"), "exhaustion: the message carries no channel id — every field on this error is safe to log");
}

{
  const clock = recorder();
  let calls = 0;
  const throwing: DiscordFetchLike = async () => {
    calls++;
    throw new Error("socket hang up");
  };
  let caught: unknown;
  try {
    await discordFetch(OP, URL, INIT, { fetch: throwing, retry: { sleep: clock.sleep } });
  } catch (err) {
    caught = err;
  }
  eq(calls, 1, "transport throw: the unanswered POST is sent ONCE — repeating it could double a message");
  eq(clock.slept, [], "transport throw: nothing is slept on");
  ok(caught instanceof Error && (caught as Error).message === "socket hang up", "transport throw: the original error propagates untouched");
}

{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), okJson({ id: "m8" })]);
  const clock = recorder();
  await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  const [first, second] = stub.requests;
  eq(first.url, second.url, "retry: same url");
  eq(first.init, second.init, "retry: the SAME init object — same method, headers and body, unchanged by the funnel");
  eq(first.url, URL, "retry: the url is the caller's, verbatim");
}

{
  eq(await discordBodyRetryAfterMs(rateLimited({ bodyRetryAfter: 0.75 })), 750, "body reader: a fractional retry_after becomes milliseconds");
  eq(await discordBodyRetryAfterMs(rateLimited({ bodyRetryAfter: 0 })), 0, "body reader: a zero delay is zero, not undefined");
  eq(await discordBodyRetryAfterMs(rateLimited({})), undefined, "body reader: no retry_after field ⇒ undefined, so the seam falls back to the header");
  eq(await discordBodyRetryAfterMs(rateLimited({ header: "5" })), undefined, "body reader: a header-only 429 body still yields undefined here — the header is the primitive's job");
  eq(await discordBodyRetryAfterMs(new Response("not json at all", { status: 429 })), undefined, "body reader: a non-JSON body never throws — it yields undefined");
  eq(await discordBodyRetryAfterMs(new Response(JSON.stringify({ retry_after: "soon" }), { status: 429 })), undefined, "body reader: a non-numeric retry_after is not a delay");
  eq(await discordBodyRetryAfterMs(new Response(JSON.stringify({ retry_after: -3 }), { status: 429 })), undefined, "body reader: a negative retry_after is not a delay");

  const res = rateLimited({ bodyRetryAfter: 1.25 });
  eq(await discordBodyRetryAfterMs(res), 1250, "body reader: 1.25 s ⇒ 1250 ms");
  eq(((await res.json()) as { retry_after: number }).retry_after, 1.25, "🔴 body reader: reads a CLONE — the original body is intact for the primitive to cancel");
}

{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 })]);
  const clock = recorder();
  let caught: unknown;
  try {
    await discordFetch(OP, URL, INIT, { fetch: stub.fetchLike, retry: { sleep: clock.sleep, maxAttempts: 2 } });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "tightened policy: two attempts still end in the named failure");
  eq((caught as RateLimitExhaustedError).attempts, 2, "tightened policy: the caller's attempt bound is the one that applies");
  eq(stub.requests.length, 2, "tightened policy: exactly two requests left the host");
}

console.log(`  ${n} assertions passed`);
