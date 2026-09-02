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

const { discordCreateMessage, openDiscordDm, triggerDiscordTyping, setDiscordReaction, createDiscordThread } = await import(
  "@open-everywhere/provider-discord/agent/channels/discord-gateway.js"
);

async function withGateway(body: () => Promise<void>): Promise<string[]> {
  const priorToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "not-a-real-bot-token";
  const lines: string[] = [];
  const priorLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = priorLog;
    if (priorToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = priorToken;
  }
  return lines;
}

{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), okJson({ id: "posted-1" })]);
  const clock = recorder();
  let got: string | null = null;
  await withGateway(async () => {
    got = await discordCreateMessage("111222333", "the completion", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(got, "posted-1", "🔴 gateway 11a: the completion post-back now SURVIVES a 429 and returns the new message id");
  eq(clock.slept, [500], "gateway 11a: it honoured Discord's body retry_after, not the 1 s fallback");
  eq(stub.requests.length, 2, "gateway 11a: refused once, then accepted");
}
{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 }), rateLimited({ bodyRetryAfter: 0.5 })]);
  const clock = recorder();
  let got: string | null = "unset";
  const lines = await withGateway(async () => {
    got = await discordCreateMessage("111222333", "the completion", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(got, null, "gateway 11b: an exhausted post-back still returns null — it NEVER throws into the completion handler");
  eq(stub.requests.length, 4, "gateway 11b: four attempts under the shared default, then it gives up");
  ok(
    lines.some((l) => /rate limited/.test(l) && /gave up after 4 attempts/.test(l)),
    "🔴 gateway 11b: the exhaustion is LOGGED BY NAME before being swallowed — otherwise the completion drops in silence",
  );
  ok(!lines.some((l) => l.includes("not-a-real-bot-token")), "🔴 gateway 11b: no line carries the bot token");
}
{
  const stub = stubFetch([okJson({ message: "server error" }, 500)]);
  const clock = recorder();
  let got: string | null = "unset";
  await withGateway(async () => {
    got = await discordCreateMessage("111222333", "the completion", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(stub.requests.length, 1, "🔴 gateway 11c: a 500 is sent EXACTLY once — the backoff did not widen to non-429 failures");
  eq(clock.slept, [], "gateway 11c: …and is never slept on");
  eq(got, null, "gateway 11c: …and still returns null, as it did before");
}
{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 0.25 }), okJson({ id: "dm-1" })]);
  const clock = recorder();
  let got: string | null = null;
  await withGateway(async () => {
    got = await openDiscordDm("444555666", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(got, "dm-1", "gateway 11d: open-DM survives a 429 and returns the DM channel id");
  eq(clock.slept, [250], "gateway 11d: it honoured the body retry_after");

  const dead = stubFetch([rateLimited({ bodyRetryAfter: 0.25 }), rateLimited({ bodyRetryAfter: 0.25 })]);
  const clock2 = recorder();
  let out: string | null = "unset";
  const lines = await withGateway(async () => {
    out = await openDiscordDm("444555666", { fetch: dead.fetchLike, retry: { sleep: clock2.sleep, maxAttempts: 2 } });
  });
  eq(out, null, "gateway 11d: an exhausted open-DM still returns null — the external-sender notice degrades, never throws");
  ok(
    lines.some((l) => /open-DM rate limited/.test(l)),
    "🔴 gateway 11d: the exhaustion is NAMED in the log — this catch was bare before OPE-1311, so the drop was silent",
  );
}
{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 9 }), rateLimited({ bodyRetryAfter: 9 }), rateLimited({ bodyRetryAfter: 9 }), rateLimited({ bodyRetryAfter: 9 })]);
  const clock = recorder();
  const lines = await withGateway(async () => {
    await triggerDiscordTyping("111222333", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(clock.slept, [2000], "🔴 gateway 11e: typing waits the CAPPED 2 s once — not the 9 s the vendor named, and not three times");
  eq(stub.requests.length, 2, "🔴 gateway 11e: typing makes exactly TWO attempts — the affordance policy, not the shared four");
  ok(lines.some((l) => /typing trigger rate limited/.test(l)), "gateway 11e: the give-up is named in the log");
}
{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 9 }), rateLimited({ bodyRetryAfter: 9 })]);
  const clock = recorder();
  const lines = await withGateway(async () => {
    await setDiscordReaction("111222333", "999", "👀", "PUT", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(clock.slept, [2000], "gateway 11f: the reaction waits the capped 2 s");
  eq(stub.requests.length, 2, "gateway 11f: …across exactly two attempts");
  ok(lines.some((l) => /reaction PUT rate limited/.test(l)), "gateway 11f: the give-up names the action");

  const good = stubFetch([rateLimited({ bodyRetryAfter: 0.5 }), new Response(null, { status: 204 })]);
  const clock2 = recorder();
  await withGateway(async () => {
    await setDiscordReaction("111222333", "999", "👀", "PUT", { fetch: good.fetchLike, retry: { sleep: clock2.sleep } });
  });
  eq(good.requests.length, 2, "gateway 11f: a reaction refused once is re-sent and accepted");
  ok(good.requests[1]?.url.includes("%F0%9F%91%80"), "gateway 11f: the retry re-sends the SAME percent-encoded emoji route");
}
{
  const stub = stubFetch([rateLimited({ bodyRetryAfter: 4 }), okJson({ id: "thread-1" })]);
  const clock = recorder();
  let got: string | null = null;
  await withGateway(async () => {
    got = await createDiscordThread("111222333", "999", "a thread name", { fetch: stub.fetchLike, retry: { sleep: clock.sleep } });
  });
  eq(got, "thread-1", "gateway 11g: the thread open survives a 429 and returns the new thread id");
  eq(clock.slept, [4000], "🔴 gateway 11g: it waited the full 4 s — the thread open keeps the SHARED policy, NOT the 2 s affordance cap");
}

console.log(`  ${n} assertions passed`);
