import assert from "node:assert/strict";
import { getSettings, overrideSettingsForTest, RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import {
  teamsAppCredentials,
  teamsAppId,
  teamsConnectorWrite,
  sendTeamsActivityBackedOff,
  replyToTeamsActivityBackedOff,
  updateTeamsActivityBackedOff,
} from "../agent/channels/teams-connector.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("teams connector rate limit (OPE-1237):");

const priorAppId = getSettings().teams.appId;
const priorEnvAppId = process.env.MICROSOFT_APP_ID;
const priorAppPassword = process.env.MICROSOFT_APP_PASSWORD;
const realFetch = globalThis.fetch;

function stubGlobalFetch(queue: Response[]): { requests: Array<{ url: string; init: { method?: string; body?: unknown } | undefined }> } {
  const requests: Array<{ url: string; init: { method?: string; body?: unknown } | undefined }> = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "connector-test-token", token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const next = queue[requests.length];
    requests.push({ url, init });
    if (next === undefined) throw new Error("stub fetch ran out of responses");
    return next;
  }) as typeof fetch;
  return { requests };
}

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ error: "TooManyRequests" }), { status: 429, headers });
}

function posted(id = "activity-1"): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

try {
  process.env.MICROSOFT_APP_PASSWORD = "test-secret";

  {
    process.env.MICROSOFT_APP_ID = "env-app";
    overrideSettingsForTest({ teams: { appId: "" } });
    ok(teamsAppId() === undefined, "🔴 OPE-2650: env MICROSOFT_APP_ID with the setting unset ⇒ teamsAppId() is undefined");
    let thrown: unknown;
    try {
      teamsAppCredentials().appId();
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof Error && thrown.message.includes("teams.appId is required"), "🔴 OPE-2650: teamsAppCredentials().appId() throws when the setting is unset, even with env MICROSOFT_APP_ID set");
    const stub = stubGlobalFetch([posted()]);
    let writeErr: unknown;
    try {
      await teamsConnectorWrite({ operation: "conversations.activities.send", serviceUrl: "https://smba.trafficmanager.net/amer", path: "/v3/conversations/c1/activities" });
    } catch (err) {
      writeErr = err;
    }
    ok(writeErr instanceof Error, "OPE-2650: a Connector write with only the env id refuses");
    eq(stub.requests.length, 0, "OPE-2650: …and no Connector request leaves this host");

    overrideSettingsForTest({ teams: { appId: "settings-app" } });
    eq(teamsAppId(), "settings-app", "OPE-2650: teamsAppId() returns the setting");
    eq(teamsAppCredentials().appId(), "settings-app", "OPE-2650: teamsAppCredentials().appId() returns the setting, not the env value");
    delete process.env.MICROSOFT_APP_ID;
  }

  {
    overrideSettingsForTest({ teams: { appId: "acceptance-app" } });
    const stub = stubGlobalFetch([rateLimited("3"), rateLimited("1"), posted("act-42")]);
    const clock = recorder();
    const res = await teamsConnectorWrite(
      { operation: "conversations.activities.send", serviceUrl: "https://smba.trafficmanager.net/amer", path: "/v3/conversations/c1/activities" },
      { retry: { sleep: clock.sleep } },
    );
    eq(clock.slept, [3000, 1000], "429 sequence: the honoured delays are EXACTLY the Retry-After values (3 s, then 1 s)");
    eq(stub.requests.length, 3, "429 sequence: the activity POST is repeated until Teams accepts it");
    ok(res.ok && (res.body as { id: string }).id === "act-42", "429 sequence: the eventual success is returned");
  }

  {
    overrideSettingsForTest({ teams: { appId: "negative-app" } });
    const stub = stubGlobalFetch([posted()]);
    const clock = recorder();
    const res = await teamsConnectorWrite(
      { operation: "conversations.activities.send", serviceUrl: "https://smba.trafficmanager.net/amer", path: "/v3/conversations/c1/activities" },
      { retry: { sleep: clock.sleep } },
    );
    eq(clock.slept, [], "negative control: zero sleeps");
    eq(stub.requests.length, 1, "negative control: a 2xx is requested EXACTLY once");
    ok(res.ok, "negative control: the response comes back untouched");
  }

  {
    overrideSettingsForTest({ teams: { appId: "exhaustion-app" } });
    const stub = stubGlobalFetch([rateLimited("1"), rateLimited("1"), rateLimited("1"), rateLimited("1")]);
    const clock = recorder();
    let caught: unknown;
    try {
      await teamsConnectorWrite(
        { operation: "conversations.activities.send", serviceUrl: "https://smba.trafficmanager.net/amer", path: "/v3/conversations/c1/activities" },
        { retry: { sleep: clock.sleep } },
      );
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof RateLimitExhaustedError, "exhaustion: the NAMED RateLimitExhaustedError, not a bare 429");
    const e = caught as RateLimitExhaustedError;
    eq(e.surface, "teams", "exhaustion: the surface names teams");
    eq(e.operation, "conversations.activities.send", "exhaustion: the operation is the vendor route name");
    eq(e.attempts, 4, "exhaustion: four attempts under the shared default");
    eq(clock.slept, [1000, 1000, 1000], "exhaustion: three waits, one fewer than the attempts");
    eq(stub.requests.length, 4, "exhaustion: the fourth refusal is not followed by a fifth request");
  }

  {
    overrideSettingsForTest({ teams: { appId: "shape-app" } });
    const stub = stubGlobalFetch([posted("send-1"), posted("reply-1"), posted("update-1")]);
    const send = await sendTeamsActivityBackedOff({ serviceUrl: "https://smba.trafficmanager.net/amer", conversationId: "conv-1", body: { type: "message", text: "hi" } });
    const reply = await replyToTeamsActivityBackedOff({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      conversationId: "conv-1",
      activityId: "root-1",
      body: { type: "message", text: "hi" },
    });
    const update = await updateTeamsActivityBackedOff({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      conversationId: "conv-1",
      activityId: "act-1",
      body: { type: "message", text: "edited" },
    });
    eq(send.id, "send-1", "shape: sendTeamsActivityBackedOff returns the posted activity id");
    eq(reply.id, "reply-1", "shape: replyToTeamsActivityBackedOff returns the posted activity id");
    eq(update.id, "update-1", "shape: updateTeamsActivityBackedOff returns the posted activity id");
    eq(stub.requests[0].url, "https://smba.trafficmanager.net/amer/v3/conversations/conv-1/activities", "shape: send hits the plain activities collection");
    eq(stub.requests[1].url, "https://smba.trafficmanager.net/amer/v3/conversations/conv-1/activities/root-1", "shape: reply hits the root activity's own path");
    eq(stub.requests[2].url, "https://smba.trafficmanager.net/amer/v3/conversations/conv-1/activities/act-1", "shape: update hits the SAME path a reply would, PUT instead of POST");
    eq(stub.requests[2].init?.method, "PUT", "shape: update is a PUT, not a POST");
  }

  console.log(`  ${n} assertions passed`);
} finally {
  globalThis.fetch = realFetch;
  overrideSettingsForTest({ teams: { appId: priorAppId } });
  if (priorEnvAppId === undefined) delete process.env.MICROSOFT_APP_ID;
  else process.env.MICROSOFT_APP_ID = priorEnvAppId;
  if (priorAppPassword === undefined) delete process.env.MICROSOFT_APP_PASSWORD;
  else process.env.MICROSOFT_APP_PASSWORD = priorAppPassword;
}
