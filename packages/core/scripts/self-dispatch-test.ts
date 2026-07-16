import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-self-dispatch-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.OE_UNIFIED_SUPERVISOR = "1";
process.env.OE_CROSS_SURFACE_WINDOW = "1";
delete process.env.OE_SPAWN_DISPATCH_SECRET;
delete process.env.OE_PUBLIC_BASE_URL;
delete process.env.VERCEL_URL;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { unifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import { formatWindowToken, taskWindowId, parseWindowToken } from "../agent/channels/window-key.js";
import { verifyWebhookSignature } from "../agent/webhooks/gate.js";
import { readAudit } from "../agent/audit/audit.js";
import {
  SELF_DISPATCH_PATH,
  SELF_DISPATCH_SIGNATURE_HEADER,
  SELF_DISPATCH_MAX_BODY_BYTES,
  selfDispatchSecret,
  selfDispatchBaseUrl,
  selfDispatchConfigured,
  signSelfDispatchBody,
  parseSelfDispatchPayload,
  readCappedBody,
  handleSelfDispatch,
  postSelfDispatch,
  type UnifiedDispatchPayload,
} from "../agent/channels/self-dispatch.js";
import {
  divertToUnifiedWindow,
  dispatchTaskWindow,
  dispatchWindowWake,
  buildRedriveReinject,
  OE_SPAWN_TAINTED_ATTR,
  type UnifiedReceiveTarget,
} from "../agent/channels/unified.js";
import type { RouteHandlerArgs } from "eve/channels";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const DOMAIN = "payments";
const SURFACE = "slack/T1/C1";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: DOMAIN, channels: [SURFACE], ambientSupervisor: true, unifiedSupervisor: true, crossSurfaceWindow: true }),
  ],
  loadSilos: () => [],
  loadRoles: () => [],
  domainsForSurface: () => [],
});

const SECRET = "self-dispatch-test-secret";
const standingToken = unifiedSupervisorToken(DOMAIN, 42);
const generation = parseWindowToken(standingToken)!.generation;
const taskToken = formatWindowToken({ domain: DOMAIN, windowId: taskWindowId("slack_T1_C1", "thr1", "nonce1"), generation });
const slackOrigin = { platform: "slack", channelId: "C1" } as const;

function goodPayload(over: Partial<Record<keyof UnifiedDispatchPayload | "issuedAt", unknown>> = {}): Record<string, unknown> {
  return {
    message: "hello from the workflow process",
    context: ["ctx: issue title"],
    token: standingToken,
    window: { wakeId: "w-123", origin: slackOrigin, addressing: "direct-mention" },
    surfaceKey: SURFACE,
    auth: { attributes: { team_id: "T1", oe_grain: "task" } },
    excludeTaskResultId: "task-9",
    issuedAt: Date.now(),
    ...over,
  };
}

console.log("1. env helpers (secret / base-URL precedence / configured):");
{
  eq(selfDispatchSecret({} as NodeJS.ProcessEnv), undefined, "no secret env → undefined");
  eq(selfDispatchSecret({ OE_SPAWN_DISPATCH_SECRET: "  " } as NodeJS.ProcessEnv), undefined, "blank secret → undefined");
  eq(selfDispatchSecret({ OE_SPAWN_DISPATCH_SECRET: "s3cr3t" } as NodeJS.ProcessEnv), "s3cr3t", "set secret → value");

  eq(selfDispatchBaseUrl({} as NodeJS.ProcessEnv), undefined, "nothing set → no base URL");
  eq(
    selfDispatchBaseUrl({ OE_PUBLIC_BASE_URL: "https://oe.example/" } as NodeJS.ProcessEnv),
    "https://oe.example",
    "OE_PUBLIC_BASE_URL wins, trailing slash stripped",
  );
  eq(
    selfDispatchBaseUrl({ OE_PUBLIC_BASE_URL: "oe.example" } as NodeJS.ProcessEnv),
    "https://oe.example",
    "OE_PUBLIC_BASE_URL without scheme gets https://",
  );
  eq(
    selfDispatchBaseUrl({ OE_PUBLIC_BASE_URL: "https://a.example", VERCEL_PROJECT_PRODUCTION_URL: "b.example" } as NodeJS.ProcessEnv),
    "https://a.example",
    "explicit override beats VERCEL_PROJECT_PRODUCTION_URL",
  );
  eq(
    selfDispatchBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "prod.example", VERCEL_URL: "dep-abc.vercel.app" } as NodeJS.ProcessEnv),
    "https://prod.example",
    "VERCEL_PROJECT_PRODUCTION_URL (stable alias) beats VERCEL_URL",
  );
  eq(selfDispatchBaseUrl({ VERCEL_URL: "dep-abc.vercel.app" } as NodeJS.ProcessEnv), "https://dep-abc.vercel.app", "VERCEL_URL last resort");

  ok(!selfDispatchConfigured({} as NodeJS.ProcessEnv), "unconfigured → false");
  ok(!selfDispatchConfigured({ OE_SPAWN_DISPATCH_SECRET: "x" } as NodeJS.ProcessEnv), "secret without base URL → false");
  ok(!selfDispatchConfigured({ VERCEL_URL: "x.example" } as NodeJS.ProcessEnv), "base URL without secret → false");
  ok(selfDispatchConfigured({ OE_SPAWN_DISPATCH_SECRET: "x", VERCEL_URL: "x.example" } as NodeJS.ProcessEnv), "secret + base URL → true");
}

console.log("2. sign ↔ verify:");
{
  const body = JSON.stringify(goodPayload());
  const sig = signSelfDispatchBody(SECRET, body);
  ok(sig.startsWith("sha256="), "signature carries the sha256= prefix (house ingress format)");
  ok(verifyWebhookSignature(SECRET, body, sig), "signed body verifies with the proven constant-time compare");
  ok(!verifyWebhookSignature(SECRET, body + " ", sig), "any body mutation breaks the signature");
  ok(!verifyWebhookSignature("other-secret", body, sig), "wrong secret never verifies");
}

console.log("3. parseSelfDispatchPayload (fail-closed structural validation):");
{
  const bad = (v: unknown, label: string) => ok("error" in (parseSelfDispatchPayload(v) as object), label);
  bad(null, "null → error");
  bad([], "array → error");
  bad(goodPayload({ message: "" }), "empty message → error");
  bad(goodPayload({ message: 42 }), "non-string message → error");
  bad(goodPayload({ context: "not-an-array" }), "non-array context → error");
  bad(goodPayload({ token: "not-a-window-token" }), "non-supervisor token → error");
  bad(goodPayload({ surfaceKey: "" }), "empty surfaceKey → error");
  bad(goodPayload({ window: { wakeId: "", origin: slackOrigin } }), "empty wakeId → error");
  bad(goodPayload({ window: { wakeId: "w", origin: { platform: "slack" } } }), "structurally-invalid origin → error");
  bad(goodPayload({ window: { wakeId: "w", origin: slackOrigin, addressing: "channel-watch" } }), "non-direct-mention addressing → error");
  bad(goodPayload({ auth: undefined }), "missing auth → error");
  bad(goodPayload({ auth: { attributes: ["nope"] } }), "array attributes → error");
  bad(goodPayload({ excludeTaskResultId: "" }), "empty excludeTaskResultId → error");

  const parsed = parseSelfDispatchPayload(goodPayload());
  ok("payload" in parsed, "the good payload parses");
  const p = (parsed as { payload: UnifiedDispatchPayload }).payload;
  eq(p.token, standingToken, "token round-trips");
  eq(p.window.addressing, "direct-mention", "addressing round-trips");
  eq(p.auth.attributes, { team_id: "T1", oe_grain: "task" }, "attributes round-trip");
  eq(p.excludeTaskResultId, "task-9", "excludeTaskResultId round-trips");
  const noAddr = parseSelfDispatchPayload(goodPayload({ window: { wakeId: "w-1", origin: slackOrigin } }));
  ok("payload" in noAddr && (noAddr as { payload: UnifiedDispatchPayload }).payload.window.addressing === undefined, "absent addressing stays absent");
}

console.log("4. handleSelfDispatch (fail-closed route):");
const diverted: { payload: UnifiedDispatchPayload }[] = [];
const fakeReceive: any = async () => ({ id: "sess-fake" });
const captureDivert = async (_r: RouteHandlerArgs["receive"], input: UnifiedDispatchPayload): Promise<void> => {
  diverted.push({ payload: input });
};
function mkReq(body: string, sig?: string): Request {
  return new Request(`https://oe.example${SELF_DISPATCH_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig ? { [SELF_DISPATCH_SIGNATURE_HEADER]: sig } : {}) },
    body,
  });
}
const armed = { OE_SPAWN_DISPATCH_SECRET: SECRET } as NodeJS.ProcessEnv;
{
  const body = JSON.stringify(goodPayload());
  const sig = signSelfDispatchBody(SECRET, body);

  eq((await handleSelfDispatch(mkReq(body, sig), fakeReceive, captureDivert, {} as NodeJS.ProcessEnv)).status, 404, "no secret → 404 (route does not exist)");

  eq((await handleSelfDispatch(mkReq(body), fakeReceive, captureDivert, armed)).status, 401, "missing signature → 401");
  eq(
    (await handleSelfDispatch(mkReq(body, signSelfDispatchBody("wrong", body)), fakeReceive, captureDivert, armed)).status,
    401,
    "wrong-secret signature → 401",
  );

  const stale = JSON.stringify(goodPayload({ issuedAt: Date.now() - 10 * 60 * 1000 }));
  eq((await handleSelfDispatch(mkReq(stale, signSelfDispatchBody(SECRET, stale)), fakeReceive, captureDivert, armed)).status, 401, "stale issuedAt → 401 (replay window bounded)");
  const noTs = JSON.stringify(goodPayload({ issuedAt: undefined }));
  eq((await handleSelfDispatch(mkReq(noTs, signSelfDispatchBody(SECRET, noTs)), fakeReceive, captureDivert, armed)).status, 401, "missing issuedAt → 401");

  const huge = JSON.stringify(goodPayload({ message: "x".repeat(SELF_DISPATCH_MAX_BODY_BYTES + 1) }));
  eq((await handleSelfDispatch(mkReq(huge, signSelfDispatchBody(SECRET, huge)), fakeReceive, captureDivert, armed)).status, 413, "oversized body → 413");

  const notJson = "{nope";
  eq((await handleSelfDispatch(mkReq(notJson, signSelfDispatchBody(SECRET, notJson)), fakeReceive, captureDivert, armed)).status, 400, "invalid JSON → 400");
  const badTok = JSON.stringify(goodPayload({ token: "bogus" }));
  eq((await handleSelfDispatch(mkReq(badTok, signSelfDispatchBody(SECRET, badTok)), fakeReceive, captureDivert, armed)).status, 400, "bad token shape → 400");
  const badSurface = JSON.stringify(goodPayload({ surfaceKey: "slack/T1/UNLISTED" }));
  eq(
    (await handleSelfDispatch(mkReq(badSurface, signSelfDispatchBody(SECRET, badSurface)), fakeReceive, captureDivert, armed)).status,
    400,
    "window-disabled surfaceKey → 400 (fail-closed)",
  );
  eq(diverted.length, 0, "no divert on any rejected request");

  const res = await handleSelfDispatch(mkReq(body, sig), fakeReceive, captureDivert, armed);
  eq(res.status, 200, "valid signed dispatch → 200");
  const jb = (await res.json()) as { ok: boolean; wakeId: string };
  ok(jb.ok === true && jb.wakeId === "w-123", "200 body echoes the payload's wakeId");
  eq(diverted.length, 1, "exactly one divert");
  eq(diverted[0].payload, (parseSelfDispatchPayload(goodPayload()) as { payload: UnifiedDispatchPayload }).payload, "divert payload round-trips byte-for-byte");

  const boom = async (): Promise<void> => {
    throw new Error("receive refused");
  };
  const boomBody = JSON.stringify(goodPayload({ message: "divert-failure probe", issuedAt: Date.now() }));
  const boomSig = signSelfDispatchBody(SECRET, boomBody);
  eq((await handleSelfDispatch(mkReq(boomBody, boomSig), fakeReceive, boom, armed)).status, 500, "divert failure → 500");

  const rows = (await readAudit({ org: "acme" })).filter((e) => e.action === "unified.self_dispatch");
  ok(rows.length >= 1, "authenticated dispatch is self-audited (unified.self_dispatch)");
  const d = rows[0].detail as { wakeId?: string; surfaceKey?: string; platform?: string };
  ok(d.wakeId === "w-123" && d.surfaceKey === SURFACE && d.platform === "slack", "audit detail carries ids only");
  ok(!JSON.stringify(rows[0]).includes("hello from the workflow process"), "audit never carries the message text");
  ok(!JSON.stringify(rows[0]).includes(SECRET), "audit never carries the secret");
}

console.log("5. postSelfDispatch (client):");
{
  const env = { OE_SPAWN_DISPATCH_SECRET: SECRET, OE_PUBLIC_BASE_URL: "https://self.test" } as NodeJS.ProcessEnv;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch200 = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await postSelfDispatch(goodPayload() as unknown as UnifiedDispatchPayload, { env, fetchImpl: fetch200 });
  eq(calls.length, 1, "one POST per call (no client-side retry)");
  eq(calls[0].url, `https://self.test${SELF_DISPATCH_PATH}`, "posts to the deployment's own dispatch route");
  const sentBody = String(calls[0].init.body);
  const sentSig = (calls[0].init.headers as Record<string, string>)[SELF_DISPATCH_SIGNATURE_HEADER];
  ok(verifyWebhookSignature(SECRET, sentBody, sentSig), "the sent signature verifies against the sent body");
  eq(JSON.parse(sentBody).token, standingToken, "the sent body carries the payload");

  await assert.rejects(
    () => postSelfDispatch(goodPayload() as unknown as UnifiedDispatchPayload, { env: {} as NodeJS.ProcessEnv, fetchImpl: fetch200 }),
    /not configured/,
    "unconfigured client throws instructively",
  );
  n++;
  const fetch500 = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  await assert.rejects(
    () => postSelfDispatch(goodPayload() as unknown as UnifiedDispatchPayload, { env, fetchImpl: fetch500 }),
    /returned 500/,
    "non-2xx throws with the status",
  );
  n++;
  const fetchBoom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  await assert.rejects(
    () => postSelfDispatch(goodPayload() as unknown as UnifiedDispatchPayload, { env, fetchImpl: fetchBoom }),
    /ECONNREFUSED/,
    "network failure throws with the cause",
  );
  n++;
}

console.log("6. unified.ts callers, cold process (self-call fallback):");
const realFetch = globalThis.fetch;
const fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchStatus = 200;
let fetchThrow = false;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (fetchThrow) throw new Error("ECONNREFUSED (simulated)");
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ ok: true }), { status: fetchStatus });
}) as typeof fetch;
process.env.OE_SPAWN_DISPATCH_SECRET = SECRET;
process.env.OE_PUBLIC_BASE_URL = "https://self.test";
{
  await dispatchTaskWindow({
    token: taskToken,
    message: "the rendered brief",
    wakeId: "child-wake-1",
    domain: DOMAIN,
    origin: slackOrigin,
    parentAuthAttributes: { team_id: "T1" },
    tainted: true,
    grain: "task",
  });
  eq(fetchCalls.length, 1, "cold dispatchTaskWindow self-calls exactly once");
  eq(fetchCalls[0].url, `https://self.test${SELF_DISPATCH_PATH}`, "task dispatch targets the own-deployment route");
  const sent = JSON.parse(String(fetchCalls[0].init.body)) as UnifiedDispatchPayload;
  eq(sent.token, taskToken, "task token rides the hop");
  eq(sent.window, { wakeId: "child-wake-1", origin: slackOrigin, addressing: "direct-mention" }, "window (wakeId+origin+owed-reply addressing) rides the hop");
  eq(sent.surfaceKey, SURFACE, "resolved window-enabled surfaceKey rides the hop");
  eq(sent.auth.attributes?.oe_grain, "task", "grain stamp rides the hop");
  eq(sent.auth.attributes?.[OE_SPAWN_TAINTED_ATTR], "true", "taint-forward stamp rides the hop");
  ok(
    verifyWebhookSignature(SECRET, String(fetchCalls[0].init.body), (fetchCalls[0].init.headers as Record<string, string>)[SELF_DISPATCH_SIGNATURE_HEADER]),
    "the self-call is HMAC-signed",
  );

  const wakeInput = {
    token: standingToken,
    origin: slackOrigin,
    wakeId: "done-wake-1",
    message: "completion notice",
    domain: DOMAIN,
    authAttributes: { team_id: "T1" },
    excludeTaskId: taskToken,
  };
  eq(await dispatchWindowWake(wakeInput), true, "cold dispatchWindowWake self-calls → true on 200");
  eq(fetchCalls.length, 2, "completion wake was one more self-call");
  eq((JSON.parse(String(fetchCalls[1].init.body)) as UnifiedDispatchPayload).excludeTaskResultId, taskToken, "excludeTaskId → excludeTaskResultId rides the hop");
  fetchStatus = 500;
  eq(await dispatchWindowWake(wakeInput), false, "self-call 500 → false (row stays the truth, never throws)");
  fetchStatus = 200;
  fetchThrow = true;
  eq(await dispatchWindowWake(wakeInput), false, "self-call network failure → false (never throws)");

  await assert.rejects(
    () =>
      dispatchTaskWindow({ token: taskToken, message: "m", wakeId: "w", domain: DOMAIN, origin: slackOrigin, tainted: false }),
    /self-dispatch POST/,
    "cold dispatchTaskWindow throws loudly when the self-call fails",
  );
  n++;
  fetchThrow = false;

  const reinject = buildRedriveReinject(DOMAIN, standingToken, { team_id: "T1" });
  ok(reinject !== null, "cold reinject is available via the self-call path");
  const before = fetchCalls.length;
  await reinject!(slackOrigin, "corrective wake body", "orig-wake-9");
  eq(fetchCalls.length, before + 1, "reinject self-calls");
  const rp = JSON.parse(String(fetchCalls[fetchCalls.length - 1].init.body)) as UnifiedDispatchPayload;
  eq(rp.window, { wakeId: "orig-wake-9", origin: slackOrigin }, "reinject re-stamps the ORIGINAL wakeId, ambient (no addressing)");
  eq(rp.token, standingToken, "reinject targets the same session token");

  delete process.env.OE_SPAWN_DISPATCH_SECRET;
  await assert.rejects(
    () => dispatchTaskWindow({ token: taskToken, message: "m", wakeId: "w", domain: DOMAIN, origin: slackOrigin, tainted: false }),
    /OE_SPAWN_DISPATCH_SECRET/,
    "no path at all → dispatchTaskWindow throws the instructive not-configured error",
  );
  n++;
  eq(await dispatchWindowWake(wakeInput), false, "no path at all → dispatchWindowWake false");
  eq(buildRedriveReinject(DOMAIN, standingToken, {}), null, "no path at all → reinject null (redrive skipped, guard unburned)");
  const coldCalls = fetchCalls.length;
  process.env.OE_SPAWN_DISPATCH_SECRET = SECRET;

  console.log("7. loop-back (captured self-call → real handler → real divert → capture receive):");
  const received: { message: string; target: UnifiedReceiveTarget; auth: { attributes?: Record<string, unknown> } }[] = [];
  const captureReceive: any = async (_ch: unknown, options: { message: string; target: unknown; auth: unknown }) => {
    received.push(options as (typeof received)[number]);
    return { id: "sess-loop" };
  };
  const looped = new Request(fetchCalls[0].url, {
    method: "POST",
    headers: fetchCalls[0].init.headers as Record<string, string>,
    body: String(fetchCalls[0].init.body),
  });
  const loopRes = await handleSelfDispatch(looped, captureReceive, (r, i) => divertToUnifiedWindow(r, i), armed);
  eq(loopRes.status, 200, "the caller-signed POST is accepted by the handler");
  eq(received.length, 1, "the real divert delivered to the receive");
  eq(received[0].target.token, taskToken, "loop-back target carries the task token");
  eq(received[0].target.wakeId, "child-wake-1", "loop-back target carries the child wakeId");
  eq(received[0].auth.attributes?.oe_grain, "task", "loop-back auth keeps the task grain (stampUnifiedWindowAuth `??`)");
  eq(received[0].auth.attributes?.oe_platform, "slack", "loop-back auth stamped oe_platform");
  eq(received[0].auth.attributes?.oe_window_token, taskToken, "loop-back auth stamped the dispatched-to window token");
  eq(received[0].message, "the rendered brief", "the brief rides the hop unchanged");

  console.log("8. warm process (captured receive wins, no HTTP hop):");
  await dispatchTaskWindow({
    token: taskToken,
    message: "warm brief",
    wakeId: "child-wake-2",
    domain: DOMAIN,
    origin: slackOrigin,
    tainted: false,
  });
  eq(fetchCalls.length, coldCalls, "warm dispatchTaskWindow makes NO self-call");
  eq(received.length, 2, "warm dispatch delivered in-process to the captured receive");
  eq(received[1].message, "warm brief", "warm delivery carries the message");
  delete process.env.OE_SPAWN_DISPATCH_SECRET;
  delete process.env.OE_PUBLIC_BASE_URL;
  eq(await dispatchWindowWake(wakeInput), true, "warm dispatchWindowWake works with NO self-dispatch config at all (in-process path)");
  ok(buildRedriveReinject(DOMAIN, standingToken, {}) !== null, "warm reinject available with no self-dispatch config");
}

globalThis.fetch = realFetch;

console.log("9. hop idempotency: identical re-delivery deduped, wakeId-reusing redrive NOT suppressed:");
{
  const hopDiverts: UnifiedDispatchPayload[] = [];
  const countDivert = async (_r: RouteHandlerArgs["receive"], input: UnifiedDispatchPayload): Promise<void> => {
    hopDiverts.push(input);
  };
  const mk = (b: string) => mkReq(b, signSelfDispatchBody(SECRET, b));

  const hopBody = JSON.stringify(goodPayload({ message: "hop-dedupe probe", window: { wakeId: "hop-w", origin: slackOrigin }, issuedAt: Date.now() }));
  const first = await handleSelfDispatch(mk(hopBody), fakeReceive, countDivert, armed);
  const second = await handleSelfDispatch(mk(hopBody), fakeReceive, countDivert, armed);
  eq(first.status, 200, "first delivery of a signed dispatch → 200");
  eq(second.status, 200, "identical re-delivery still → 200 (idempotent success, not an error)");
  ok(((await second.json()) as { deduped?: boolean }).deduped === true, "the re-delivery is flagged deduped");
  eq(hopDiverts.length, 1, "the identical HTTP re-delivery diverts EXACTLY ONCE (double-spawn prevented)");

  await new Promise((r) => setTimeout(r, 2));
  const redriveBody = JSON.stringify(goodPayload({ message: "corrective redrive", window: { wakeId: "hop-w", origin: slackOrigin }, issuedAt: Date.now() }));
  const redrive = await handleSelfDispatch(mk(redriveBody), fakeReceive, countDivert, armed);
  eq(redrive.status, 200, "the wakeId-reusing redrive → 200");
  ok(((await redrive.json()) as { deduped?: boolean }).deduped !== true, "the redrive is NOT flagged deduped");
  eq(hopDiverts.length, 2, "the redrive (same wakeId, fresh issuedAt) is NOT suppressed — it diverts");
  eq(hopDiverts[1].window.wakeId, "hop-w", "the redrive kept the original wakeId (proves wakeId alone can't be the dedup key)");
}

console.log("10. bounded body read: oversized rejected before parse, normal body round-trips:");
{
  const big = "y".repeat(SELF_DISPATCH_MAX_BODY_BYTES + 100);
  ok("tooLarge" in (await readCappedBody(new Request("https://x/", { method: "POST", body: big }), SELF_DISPATCH_MAX_BODY_BYTES)), "readCappedBody refuses an oversized body");
  const small = JSON.stringify({ a: "b" });
  const readSmall = await readCappedBody(new Request("https://x/", { method: "POST", body: small }), SELF_DISPATCH_MAX_BODY_BYTES);
  ok("body" in readSmall && readSmall.body === small, "readCappedBody returns a normal body byte-for-byte");

  const hugeInvalid = "{".repeat(SELF_DISPATCH_MAX_BODY_BYTES + 1);
  eq(
    (await handleSelfDispatch(mkReq(hugeInvalid, signSelfDispatchBody(SECRET, hugeInvalid)), fakeReceive, captureDivert, armed)).status,
    413,
    "oversized body → 413 BEFORE parse (size short-circuits, not a 400)",
  );
  const okDivert: UnifiedDispatchPayload[] = [];
  const capDivert = async (_r: RouteHandlerArgs["receive"], i: UnifiedDispatchPayload): Promise<void> => {
    okDivert.push(i);
  };
  const normalBody = JSON.stringify(goodPayload({ message: "normal-size body", window: { wakeId: "sz-w", origin: slackOrigin }, issuedAt: Date.now() }));
  eq(
    (await handleSelfDispatch(mkReq(normalBody, signSelfDispatchBody(SECRET, normalBody)), fakeReceive, capDivert, armed)).status,
    200,
    "a normal-size signed body passes the bounded read → 200",
  );
  eq(okDivert.length, 1, "the normal body reached the divert (bounded read is transparent for in-range bodies)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ self-dispatch: ${n} assertions passed (route fail-closed + client + cold/warm caller fallback + loop-back + hop-dedupe + bounded read)\n`);
