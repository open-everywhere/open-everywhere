import { afterAll, expect, test } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { registerA2aInbound } from "@open-everywhere/core/agent/a2a/inbound/declaration.js";
import { connectA2aAgent, delegateA2aTask, followA2aTask } from "@open-everywhere/core/agent/a2a/client.js";
import { auditCursor, bootAgent, disposeLater, registerScript, rowsSinceCursor, waitFor, type AuditRow, type ScriptedHandle } from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const ISSUER = "https://login.oe-it-a2a.test/tenant/v2.0";
const JWKS_ORIGIN = "https://login.oe-it-a2a.test";
const JWKS_URL = `${JWKS_ORIGIN}/tenant/discovery/keys`;
const AUDIENCE = "api://oe-it-a2a-inbound";
const SUBJECT = "sp-it2448-partner-agent";
const CALLER = "it2448-partner";
const DOMAIN = "it-fire-seat";
const TASK_TEXT = "it2448 which widgets shipped this week?";
const CHILD_RESULT = "it2448 three widgets shipped: alpha, beta and gamma";

const DECLARATION = {
  name: "OE integration agent",
  description: "The integration tier's inbound A2A fixture.",
  skills: [{ id: "it2448-questions", name: "Questions", description: "Answers questions about the fixture's widgets." }],
  callers: [{ name: CALLER, description: "The integration tier's partner agent.", domain: DOMAIN, auth: { scheme: "jwt" as const, issuer: ISSUER, jwksUrl: JWKS_URL, audience: AUDIENCE, subject: SUBJECT } }],
};

const KEYS = generateKeyPair("ES256");

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

async function arm(): Promise<{ readonly base: string; readonly sign: (sub: string) => Promise<string> }> {
  const { base } = await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ a2a: { inbound: true } });
  cleanups.push(() => settings.overrideSettingsForTest({ a2a: { inbound: false } }));
  const keys = await KEYS;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "it2448", alg: "ES256", use: "sig" };
  createLocalJWKSet({ keys: [jwk] });
  const jwksNet = installHostFetchStub(JWKS_ORIGIN, (url) =>
    url.href === JWKS_URL ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } }) : undefined,
  );
  cleanups.push(() => jwksNet.uninstall());
  registerA2aInbound(DECLARATION);
  cleanups.push(() => registerA2aInbound({ name: "", description: "", skills: [], callers: [] }));
  const sign = (sub: string): Promise<string> =>
    new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "it2448" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  return { base, sign };
}

function fetchWith(credential: string): typeof fetch {
  return async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${credential}`);
    const body = req.method === "GET" ? undefined : await req.text();
    return fetch(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) });
  };
}

function sendBody(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: `m-${Date.now()}`, role: "ROLE_USER", parts: [{ text }] } } });
}

test("an official-SDK client calls the agent through its card as a declared caller; the task runs as one unattended job in the caller's own surface and the report comes back through tasks/get", async () => {
  const { base, sign } = await arm();
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [{ say: "it2448 a seat must not speak for an inbound task" }],
      child: [{ calls: [{ tool: "set_spend_limit", input: { monthlyUsd: 9.5, reason: "it2448 unattended probe" }, id: "it2448-probe" }] }, { say: CHILD_RESULT }],
    }),
  );

  const conn = await connectA2aAgent({ name: "oe-inbound", cardUrl: `${base}/.well-known/agent-card.json` }, fetchWith(await sign(SUBJECT)));
  expect(conn.card.name).toBe("OE integration agent");
  expect(JSON.stringify(conn.card), "🔴 the public card names a caller").not.toContain(CALLER);

  const sent = await delegateA2aTask(conn.client, TASK_TEXT, { platform: "slack", workspace: "T0PARTNER", principalId: "U0PARTNER" }, { waitMs: 0 });
  expect(sent.kind).toBe("task");
  if (sent.kind !== "task") return;
  expect(["submitted", "working", "completed"], `the sent task is in state ${sent.state}`).toContain(sent.state);
  const accepted = await waitFor(async () => (await rowsSinceCursor(cursor, ["a2a.inbound_accepted"], { limit: 50 })).find((r) => detailOf(r).taskId === sent.taskId), "it2448: the a2a.inbound_accepted row");
  expect([detailOf(accepted).caller, detailOf(accepted).landed, detailOf(accepted).surface]).toEqual([CALLER, true, `a2a/inbound/${CALLER}`]);
  expect(JSON.stringify(accepted.detail), "🔴 the accepted row carries the task text").not.toContain("widgets");
  const forwarded = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 100 })).find((r) => r.surface === `a2a/inbound/${CALLER}`),
    "it2448: the work.forwarded row for the inbound task",
    150_000,
  );
  expect([detailOf(forwarded).fire, detailOf(forwarded).owesRoom], "the inbound task is not a fire that owes no room").toEqual([true, false]);
  expect(String(detailOf(forwarded).workToken), "the inbound task was not forwarded to a work-session token").toContain(":win:w/");
  expect(String(detailOf(forwarded).workToken), "🔴 the inbound task did not run in the caller's OWN window").toContain(`a2a/inbound/${CALLER}`);

  const probe = await waitFor(
    () => handle.requests.filter((r) => r.role === "child").flatMap((r) => r.toolResults).find((t) => t.name === "set_spend_limit"),
    "it2448: the child's set_spend_limit result",
    150_000,
  );
  expect(probe.isError, "🔴 the child's proposal was NOT refused — the inbound task ran as if a person were acting").toBe(true);
  expect(JSON.stringify(probe.output)).toContain("no acting sender");
  const answered = await waitFor(async () => (await rowsSinceCursor(cursor, ["a2a.inbound_answered"], { limit: 50 })).find((r) => detailOf(r).taskId === sent.taskId), "it2448: the a2a.inbound_answered row", 150_000);
  expect([detailOf(answered).outcome, detailOf(answered).written, detailOf(answered).chars]).toEqual(["completed", true, CHILD_RESULT.length]);
  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).find((r) => detailOf(r).requestId === detailOf(forwarded).requestId), "it2448: the work.result_wake row");
  expect(detailOf(wake).outcome, "🔴 the inbound task's result woke a seat").toBe("a2a-answered");

  const done = await followA2aTask(conn.client, sent.taskId, { waitMs: 0 });
  expect(done.kind === "task" && done.state).toBe("completed");
  expect(done.kind === "task" ? done.text : "").toContain(CHILD_RESULT);
  await new Promise((r) => setTimeout(r, 3_000));
  expect(handle.requests.filter((r) => r.role === "parent"), "🔴 a seat model call was served for an inbound task").toEqual([]);
  assertNoFault(handle, "the inbound task");
});

test("an unauthenticated call and a verified-but-undeclared caller are refused 401 before any job; no declaration or the setting off makes both routes 404", async () => {
  const { base, sign } = await arm();
  const cursor = await auditCursor();
  const rpc = `${base}/a2a/jsonrpc`;

  const anonymous = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: sendBody("it2448 anonymous") });
  expect(anonymous.status, "🔴 an unauthenticated call was not refused").toBe(401);
  const stranger = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await sign("sp-it2448-stranger")}` }, body: sendBody("it2448 stranger") });
  expect(stranger.status, "🔴 a verified token whose subject no caller declares was not refused").toBe(401);
  const refused = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["a2a.inbound_refused"], { limit: 50 });
    const reasons = new Set(rows.map((r) => detailOf(r).reason));
    return reasons.has("no-credential") && reasons.has("undeclared-caller") ? rows : undefined;
  }, "it2448: the two a2a.inbound_refused rows");
  expect(refused.every((r) => !JSON.stringify(r.detail).includes("eyJ")), "🔴 a refusal row carries the credential").toBe(true);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await rowsSinceCursor(cursor, ["a2a.inbound_accepted", "work.forwarded"], { limit: 50 }), "🔴 a refused call started something").toEqual([]);

  registerA2aInbound({ name: "", description: "", skills: [], callers: [] });
  expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(404);
  expect((await fetch(rpc, { method: "POST", headers: { authorization: `Bearer ${await sign(SUBJECT)}` }, body: sendBody("x") })).status).toBe(404);
  registerA2aInbound(DECLARATION);
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ a2a: { inbound: false } });
  expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(404);
  expect((await fetch(rpc, { method: "POST", headers: { authorization: `Bearer ${await sign(SUBJECT)}` }, body: sendBody("x") })).status).toBe(404);
});
