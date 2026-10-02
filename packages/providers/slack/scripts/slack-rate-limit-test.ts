import assert from "node:assert/strict";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import { SlackWebApiError, callSlackWebApi, encodeSlackForm } from "../agent/channels/slack-web-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("slack-web-api (OPE-1211):");

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response("{\"ok\":false,\"error\":\"ratelimited\"}", { status: 429, headers });
}

function stubFetch(queue: Response[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
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
  const stub = stubFetch([rateLimited("3"), rateLimited("1"), new Response("{\"ok\":true,\"ts\":\"1724760000.001\"}", { status: 200 })]);
  const clock = recorder();
  const json = await callSlackWebApi(
    { botToken: "xoxb-test", operation: "chat.postMessage", body: { channel: "C1", text: "hi" } },
    { fetch: stub.fetchLike, sleep: clock.sleep },
  );

  eq(clock.slept, [3000, 1000], "429 sequence: the honoured delays are EXACTLY the Retry-After values (3 s, then 1 s)");
  eq(stub.requests.length, 3, "429 sequence: the post is repeated until Slack accepts it");
  eq(json.ok, true, "429 sequence: the caller receives the eventual success envelope");
  eq(json.ts, "1724760000.001", "429 sequence: the message ts survives the retries");
  eq(stub.requests[0].url, "https://slack.com/api/chat.postMessage", "429 sequence: the operation resolves against the Slack API base");
  eq(stub.requests[2].init.body, "channel=C1&text=hi", "429 sequence: the RETRY re-sends the identical form body");
  eq(
    (stub.requests[2].init.headers as Record<string, string>).authorization,
    "Bearer xoxb-test",
    "429 sequence: the retry re-sends the bot token",
  );
}

{
  const stub = stubFetch([rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await callSlackWebApi(
      { botToken: "xoxb-test", operation: "chat.postMessage", body: { channel: "C1" } },
      { fetch: stub.fetchLike, sleep: clock.sleep, maxAttempts: 3 },
    );
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "exhausted: the seam throws the NAMED rate-limit failure");
  eq((caught as Error).name, "RateLimitExhaustedError", "exhausted: the error name is the named failure");
  eq((caught as RateLimitExhaustedError).surface, "slack", "exhausted: the failure names the Slack surface");
  eq((caught as RateLimitExhaustedError).operation, "chat.postMessage", "exhausted: the failure names the refused operation");
  eq(stub.requests.length, 3, "exhausted: the attempt count is bounded");
}

{
  const stub = stubFetch([rateLimited("1"), rateLimited("1")]);
  const clock = recorder();
  const failSoft = await callSlackWebApi(
    { botToken: "xoxb-test", operation: "chat.postMessage", body: {} },
    { fetch: stub.fetchLike, sleep: clock.sleep, maxAttempts: 2 },
  ).catch(() => undefined);
  eq(failSoft, undefined, "fail-soft caller: an exhausted retry yields undefined, and never a false success");
}

{
  const stub = stubFetch([new Response("{\"ok\":false,\"error\":\"channel_not_found\"}", { status: 200 })]);
  const clock = recorder();
  const json = await callSlackWebApi({ botToken: "t", operation: "chat.postMessage", body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep });
  eq(json, { ok: false, error: "channel_not_found" }, "negative control: an ok:false body is RETURNED, not thrown and not retried");
  eq(stub.requests.length, 1, "negative control: ok:false is requested exactly once");
  eq(clock.slept, [], "negative control: ok:false sleeps ZERO times");
}
{
  const stub = stubFetch([new Response("{\"ok\":false,\"error\":\"server_error\"}", { status: 500 })]);
  const clock = recorder();
  let caught: unknown;
  try {
    await callSlackWebApi({ botToken: "t", operation: "chat.update", body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SlackWebApiError, "negative control: a 500 throws SlackWebApiError, the ported eve posture");
  eq((caught as SlackWebApiError).status, 500, "negative control: the thrown error carries the status");
  eq((caught as SlackWebApiError).method, "chat.update", "negative control: the thrown error carries the method");
  eq(stub.requests.length, 1, "negative control: a 500 is requested exactly once — never retried");
  eq(clock.slept, [], "negative control: a 500 sleeps ZERO times");
}

{
  const stub = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const clock = recorder();
  let caught: unknown;
  try {
    await callSlackWebApi({ botToken: "t", operation: "auth.test", body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "probe: auth.test still ends in the named failure");
  eq(clock.slept, [2000], "probe: auth.test waits ONCE and clamps a 30 s Retry-After to the 2 s probe cap");
  eq(stub.requests.length, 2, "probe: auth.test makes 2 attempts, not the shared 4");
}
{
  const stub = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30")]);
  const clock = recorder();
  await callSlackWebApi({ botToken: "t", operation: "chat.postMessage", body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep }).catch(() => undefined);
  eq(clock.slept, [30_000, 30_000], "probe scoping: chat.postMessage keeps the SHARED policy (30 s waits), not the probe's 2 s");
}

{
  const PINNED_PROBES: readonly [string, string][] = [
    ["auth.test", "the bot's own identity, awaited before OK()"],
    ["conversations.info", "channelFactsFor → channelInternalAndMeta, awaited before OK()"],
    ["users.info", "authorFactsFor → slackAuthorIsMember, awaited before OK()"],
    ["conversations.open", "a GLOBAL shortcut's DM landing place (OPE-1376) — openDirectMessageChannel, awaited before the interactivity ack"],
  ];

  for (const [operation, why] of PINNED_PROBES) {
    const stub = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30")]);
    const clock = recorder();
    let caught: unknown;
    try {
      await callSlackWebApi({ botToken: "t", operation, body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep });
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof RateLimitExhaustedError, `probe set: ${operation} ends in the named failure (${why})`);
    eq(clock.slept, [2000], `probe set: ${operation} clamps a 30 s Retry-After to the 2 s probe cap — a drop from the set reads 30_000 here`);
    eq(stub.requests.length, 2, `probe set: ${operation} makes 2 attempts, not the shared 4`);
  }

  for (const operation of ["conversations.list", "users.list", "conversations.history", "chat.update"]) {
    const stub = stubFetch([rateLimited("30"), rateLimited("30"), rateLimited("30")]);
    const clock = recorder();
    await callSlackWebApi({ botToken: "t", operation, body: {} }, { fetch: stub.fetchLike, sleep: clock.sleep }).catch(() => undefined);
    eq(clock.slept, [30_000, 30_000], `probe set: ${operation} is NOT a probe — it keeps the SHARED 30 s policy`);
  }
}

{
  eq(encodeSlackForm({ channel: "C1", text: "a b" }), "channel=C1&text=a+b", "encode: form-encoded, spaces included");
  eq(encodeSlackForm({ a: 1, b: true }), "a=1&b=true", "encode: numbers and booleans stringify");
  eq(encodeSlackForm({ a: "x", b: null, c: undefined }), "a=x", "encode: null and undefined values are DROPPED, as eve dropped them");
  eq(encodeSlackForm({ blocks: [{ type: "section" }] }), "blocks=%5B%7B%22type%22%3A%22section%22%7D%5D", "encode: a non-scalar is JSON-encoded");
  eq(encodeSlackForm(undefined), "", "encode: a non-object body encodes to nothing");
}

{
  const saved = process.env.SLACK_BOT_TOKEN;
  try {
    process.env.SLACK_BOT_TOKEN = "xoxb-from-env";
    const stub = stubFetch([new Response("{\"ok\":true}", { status: 200 })]);
    await callSlackWebApi({ botToken: undefined, operation: "auth.test", body: {} }, { fetch: stub.fetchLike });
    eq(
      (stub.requests[0].init.headers as Record<string, string>).authorization,
      "Bearer xoxb-from-env",
      "token: an absent explicit token falls back to SLACK_BOT_TOKEN",
    );

    const stub2 = stubFetch([new Response("{\"ok\":true}", { status: 200 })]);
    await callSlackWebApi({ botToken: "xoxb-explicit", operation: "auth.test", body: {} }, { fetch: stub2.fetchLike });
    eq(
      (stub2.requests[0].init.headers as Record<string, string>).authorization,
      "Bearer xoxb-explicit",
      "token: an explicit token WINS over the env (the multi-bot seam)",
    );

    delete process.env.SLACK_BOT_TOKEN;
    const stub3 = stubFetch([new Response("{\"ok\":true}", { status: 200 })]);
    let caught: unknown;
    try {
      await callSlackWebApi({ botToken: undefined, operation: "auth.test", body: {} }, { fetch: stub3.fetchLike });
    } catch (err) {
      caught = err;
    }
    eq((caught as Error | undefined)?.message, "SLACK_BOT_TOKEN is required.", "token: no token anywhere is fail-loud, with eve's exact message");
    eq(stub3.requests.length, 0, "token: a missing token throws BEFORE any request leaves the host");
  } finally {
    if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
}

{
  const saved = process.env.SLACK_BOT_TOKEN;
  try {
    delete process.env.SLACK_BOT_TOKEN;

    const stub = stubFetch([new Response("{\"ok\":true,\"access_token\":\"xoxb-minted\"}", { status: 200 })]);
    const res = await callSlackWebApi(
      { unauthenticated: true, operation: "oauth.v2.access", body: { client_id: "1111.2222", client_secret: "fake", code: "c", redirect_uri: "https://x/setup/callback" } },
      { fetch: stub.fetchLike },
    );
    eq(res.ok, true, "unauthenticated: the call goes through with no token configured");
    eq(stub.requests.length, 1, "unauthenticated: exactly one request left the host");
    const headers = stub.requests[0].init.headers as Record<string, string>;
    eq(headers.authorization, undefined, "🔴 unauthenticated: NO authorization header is sent");
    eq(headers["content-type"], "application/x-www-form-urlencoded", "unauthenticated: the content type is unchanged");
    eq(
      String(stub.requests[0].init.body).includes("client_secret=fake"),
      true,
      "unauthenticated: the client credentials ride the form body",
    );

    const stub2 = stubFetch([new Response("{\"ok\":true}", { status: 200 })]);
    let caught: unknown;
    try {
      await callSlackWebApi({ operation: "chat.postMessage", body: {} }, { fetch: stub2.fetchLike });
    } catch (err) {
      caught = err;
    }
    eq((caught as Error | undefined)?.message, "SLACK_BOT_TOKEN is required.", "unauthenticated absent: an ordinary call still fails loud with no token");
    eq(stub2.requests.length, 0, "🔴 unauthenticated absent: nothing left the host unauthenticated");

    const stub3 = stubFetch([new Response("{\"ok\":true}", { status: 200 })]);
    caught = undefined;
    try {
      await callSlackWebApi({ unauthenticated: false, operation: "chat.postMessage", body: {} }, { fetch: stub3.fetchLike });
    } catch (err) {
      caught = err;
    }
    eq((caught as Error | undefined)?.message, "SLACK_BOT_TOKEN is required.", "unauthenticated:false is the DEFAULT path, not an opt-out");
    eq(stub3.requests.length, 0, "…and it too sends nothing");
  } finally {
    if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
}

console.log(`✓ slack-web-api: ${n} assertions passed (honoured Retry-After, named exhaustion, non-429 negative controls, the probe policy on all three PROBE_OPERATIONS members, ported encoding + token rules, the unauthenticated arm)`);
