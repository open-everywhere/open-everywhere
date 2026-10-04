import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-model-call-capture-"));
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_CONTROL_READ_TOKENS;

const { readAudit } = await import("../agent/audit/audit.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { resolvePrimaryModel } = await import("../agent/model/routing.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { OPERATIONAL_TABLES } = await import("../agent/operational/store.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { STEP_BOUNDARY_MARKER, _resetStepBoundaryCountsForTest } = await import("../agent/model/step-boundary.js");
const {
  CAPTURE_GAP_ACTION,
  CAPTURE_SCHEMA_VERSION,
  _resetCaptureCountsForTest,
  bodySha256,
  captureArmed,
  capturePrefixList,
  captureCountsFor,
  captureCoversSurface,
  captureSiteFrom,
  noteCompletedModelStep,
  serialiseCallBody,
  withCapture,
} = await import("../agent/model/call-capture.js");
const { handleSessionModelCallsRead, handleModelCallSessionsRead } = await import("../agent/control/read-route.js");
const { openTestPg, closeAllTestPg } = await import("./test-pg-driver.js");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type ModelBackend = import("../agent/model/routing.js").ModelBackend;
type RoutedCallOptions = import("../agent/model/routing.js").RoutedCallOptions;
type RoutingDeps = import("../agent/model/routing.js").RoutingDeps;

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepEqual(a, b, label);
  n++;
};

const DEFAULT_ID = "vendor/default-model";
const DEFAULTS = { primary: { id: DEFAULT_ID } };

interface FakeCall {
  id: string;
  options: RoutedCallOptions;
}

function fakeBackend(calls: FakeCall[]): ModelBackend {
  return {
    model: (id) => ({
      specificationVersion: "v4",
      provider: "fake",
      modelId: id,
      supportedUrls: {},
      doGenerate: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
      doStream: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
    }),
    applyOptions: (_route, options) => options,
  };
}

function turnCtx(sessionId: string, channel = "C_TXN"): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      id: sessionId,
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: channel, channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as unknown as BindableContext;
}

function stepEvent(turnId: string): unknown {
  return { type: "step.started", data: { turnId } };
}

function callOptions(text: string): RoutedCallOptions {
  return {
    prompt: [
      { role: "system", content: "You are the org agent." },
      { role: "user", content: [{ type: "text", text }] },
    ],
    tools: [{ name: "reply", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    temperature: 0.7,
  };
}

function deps(calls: FakeCall[]): RoutingDeps {
  return { domains: () => [], backend: fakeBackend(calls) };
}

async function driveCall(ctx: BindableContext, turnId: string, options: RoutedCallOptions, calls: FakeCall[]): Promise<void> {
  const model = await resolvePrimaryModel(ctx, DEFAULTS, deps(calls), stepEvent(turnId));
  await model.doGenerate(options);
}

const store = getOperationalStore();
const ORG = resolvePartition(turnCtx("probe")).org;

function armed(on: boolean): void {
  resetSettingsForTest();
  registerSettings({ soak: { capture: on }, turn: { stepBudget: 0 } });
  _resetCaptureCountsForTest();
  _resetStepBoundaryCountsForTest();
}

{
  ok(OPERATIONAL_TABLES.includes("model_call_capture"), "tables: model_call_capture is in OPERATIONAL_TABLES (the migrator's canonical list)");
}

{
  armed(false);
  ok(captureArmed() === false, "disarmed: captureArmed() is false with soak.capture off — the shipped default");
  const d = deps([]);
  ok(withCapture(d, undefined) === d, "disarmed: withCapture returns the IDENTICAL deps object with no site — no wrapper, no allocation on the disarmed path");
  ok(captureSiteFrom(turnCtx("s-off"), stepEvent("turn_0")) !== undefined, "disarmed: a site is still resolvable — arming, not resolution, is what gates the recorder (so the next assertion means something)");

  const calls: FakeCall[] = [];
  for (let i = 0; i < 3; i++) await driveCall(turnCtx("s-off"), "turn_0", callOptions(`hello ${i}`), calls);
  eq(calls.length, 3, "disarmed: the model really was called three times (the drive is not a no-op)");
  const rows = await store.modelCallCapturesForSession(ORG, "s-off");
  eq(rows.length, 0, "🔴 disarmed: ZERO capture rows — the transcript-grade store does not grow on ordinary traffic");
}

{
  armed(true);
  ok(captureArmed() === true, "armed: captureArmed() reads the registered override");
  const calls: FakeCall[] = [];
  const bodies = [callOptions("first message"), callOptions("second message")];
  for (const b of bodies) await driveCall(turnCtx("s-on"), "turn_7", b, calls);

  const rows = await store.modelCallCapturesForSession(ORG, "s-on");
  eq(rows.length, 2, "armed: one capture row per model call");
  eq(
    rows.map((r) => r.stepIndex),
    [0, 1],
    "armed: stepIndex is the 0-based position of the call within its turn",
  );
  eq(rows[0].sessionId, "s-on", "armed: the row carries eve's session id");
  eq(rows[0].turnId, "turn_7", "armed: the row carries the turn id off the step.started event");
  eq(rows[0].model, DEFAULT_ID, "armed: the row carries the model id the router RESOLVED for this call");
  eq(rows[0].provider, "fake", "armed: the row carries the transport's provider label");
  eq(rows[0].schemaVersion, CAPTURE_SCHEMA_VERSION, "armed: the row is stamped with the serialised-shape version");
  eq(rows[0].truncated, false, "armed: a normal body is not truncated");

  for (let i = 0; i < rows.length; i++) {
    const inflated = gunzipSync(Buffer.from(rows[i].bodyGzipB64, "base64")).toString("utf8");
    eq(inflated, serialiseCallBody(calls[i].options), `armed: row ${i} inflates to the exact serialised body the transport received`);
    eq(rows[i].sha256, createHash("sha256").update(inflated, "utf8").digest("hex"), `armed: row ${i}'s sha256 is the sha of the stored body`);
    eq(rows[i].bodyBytes, Buffer.byteLength(inflated, "utf8"), `armed: row ${i}'s bodyBytes is the uncompressed length`);
  }

  ok(
    gunzipSync(Buffer.from(rows[0].bodyGzipB64, "base64")).toString("utf8").includes("first message"),
    "armed: the member-authored message text is stored VERBATIM — a redacted prefix is a different prompt",
  );

  const meta = await store.modelCallCapturesForSession(ORG, "s-on", { includeBody: false });
  eq(meta.length, 2, "read: includeBody:false returns the same row count");
  eq(meta[0].bodyGzipB64, "", "read: includeBody:false carries no body bytes (the cheap counting read)");
  eq(meta[0].sha256, rows[0].sha256, "read: includeBody:false still carries the sha — enough to pick a cut point");

  const oneTurn = await store.modelCallCapturesForSession(ORG, "s-on", { turnId: "turn_nope" });
  eq(oneTurn.length, 0, "read: a turnId filter narrows (and an unknown turn is empty, not everything)");
  eq((await store.modelCallCapturesForSession(ORG, "s-on", { limit: 1 })).length, 1, "read: limit caps the page");
}

{
  resetSettingsForTest();
  registerSettings({ soak: { capture: true }, turn: { stepBudget: 1, stepBackstopMultiple: 5 } });
  _resetCaptureCountsForTest();
  _resetStepBoundaryCountsForTest();

  const calls: FakeCall[] = [];
  await driveCall(turnCtx("s-soft"), "turn_1", callOptions("under budget"), calls);
  await driveCall(turnCtx("s-soft"), "turn_1", callOptions("over budget"), calls);

  const rows = await store.modelCallCapturesForSession(ORG, "s-soft");
  eq(rows.length, 2, "ordering: both calls captured");
  const first = gunzipSync(Buffer.from(rows[0].bodyGzipB64, "base64")).toString("utf8");
  const second = gunzipSync(Buffer.from(rows[1].bodyGzipB64, "base64")).toString("utf8");
  ok(!first.includes(STEP_BOUNDARY_MARKER), "ordering: the under-budget call's captured body carries NO harness notice (negative control)");
  ok(
    second.includes(STEP_BOUNDARY_MARKER),
    "🔴 ordering: the over-budget call's captured body CARRIES the harness wrap-up notice — the recorder sits INSIDE our own prompt edits, so it records the bytes the model saw",
  );
}

{
  armed(true);
  const calls: FakeCall[] = [];
  const ctx = turnCtx("s-xcheck-ok");
  for (let i = 0; i < 3; i++) await driveCall(ctx, "turn_2", callOptions(`m${i}`), calls);
  for (let i = 0; i < 3; i++) noteCompletedModelStep("s-xcheck-ok", "turn_2", ctx);
  const counts = captureCountsFor("s-xcheck-ok", "turn_2");
  eq(counts?.attempted, 3, "cross-check: attempted counts every call the decorator SAW");
  eq(counts?.captured, 3, "cross-check: captured counts every row the store ACCEPTED");
  eq(counts?.completed, 3, "cross-check: completed counts every step eve reported");
  eq(counts?.reported, false, "cross-check: no gap row when the two agree — NEGATIVE CONTROL, the flag is present and false");
  eq((await readAudit({ org: deploymentOrg(), action: CAPTURE_GAP_ACTION })).length, 0, "cross-check: and no audit row exists at all yet");
}
{
  armed(true);
  const calls: FakeCall[] = [];
  const ctx = turnCtx("s-xcheck-gap");
  for (let i = 0; i < 2; i++) await driveCall(ctx, "turn_3", callOptions(`m${i}`), calls);
  for (let i = 0; i < 3; i++) noteCompletedModelStep("s-xcheck-gap", "turn_3", ctx);
  await new Promise((r) => setTimeout(r, 50));

  const gapRows = await readAudit({ org: deploymentOrg(), action: CAPTURE_GAP_ACTION });
  eq(gapRows.length, 1, "🔴 cross-check: a completed step with no capture writes ONE soak.capture_gap audit row");
  const detail = gapRows[0].detail as { attempted?: number; captured?: number; completed?: number; uncalled?: number; turnId?: string };
  eq(detail.captured, 2, "cross-check: the row carries the capture count");
  eq(detail.completed, 3, "cross-check: the row carries the completed-step count");
  eq(detail.uncalled, 0, "cross-check: the row carries the excused count");
  eq(detail.attempted, 2, "cross-check: the row carries the attempted count, so a failed WRITE stays distinguishable from a bypassed CALL");
  eq(detail.turnId, "turn_3", "cross-check: the row names the turn");

  for (let i = 0; i < 5; i++) noteCompletedModelStep("s-xcheck-gap", "turn_3", ctx);
  await new Promise((r) => setTimeout(r, 50));
  eq((await readAudit({ org: deploymentOrg(), action: CAPTURE_GAP_ACTION })).length, 1, "cross-check: the gap is reported once per turn, not once per step");
}
{
  resetSettingsForTest();
  registerSettings({ soak: { capture: true }, turn: { stepBudget: 1, stepBackstopMultiple: 1 } });
  _resetCaptureCountsForTest();
  _resetStepBoundaryCountsForTest();
  const calls: FakeCall[] = [];
  const ctx = turnCtx("s-backstop");
  await driveCall(ctx, "turn_4", callOptions("one"), calls);
  const stub = await resolvePrimaryModel(ctx, DEFAULTS, deps(calls), stepEvent("turn_4"));
  await stub.doGenerate(callOptions("two"));
  eq(calls.length, 1, "backstop: the stub makes NO backend call (so there are no bytes to capture)");
  noteCompletedModelStep("s-backstop", "turn_4", ctx);
  noteCompletedModelStep("s-backstop", "turn_4", ctx);
  await new Promise((r) => setTimeout(r, 50));
  const c = captureCountsFor("s-backstop", "turn_4");
  eq(c?.uncalled, 1, "backstop: the uncalled step is excused explicitly");
  eq(c?.reported, false, "backstop: captured + uncalled covers completed ⇒ no gap (negative control)");
  eq((await readAudit({ org: deploymentOrg(), action: CAPTURE_GAP_ACTION })).length, 1, "backstop: still only the ONE earlier gap row — the backstop wrote none");
}
{
  armed(false);
  noteCompletedModelStep("s-off-counts", "turn_9");
  eq(captureCountsFor("s-off-counts", "turn_9"), undefined, "disarmed: the cross-check counters are not allocated");
}

{
  armed(true);
  const liveKey = captureSiteFrom(turnCtx("probe"))!.surfaceKey;
  const otherKey = "discord/g-soak/c-soak";
  ok(liveKey !== otherKey, "scope: the fixture's surface key is not the off-scope key the next assertions use");

  ok(captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: liveKey } }), "scope: a surface matching the prefix is covered");
  ok(!captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: otherKey } }), "scope: a surface outside the prefix is NOT covered");
  ok(captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: "" } }), "scope: an empty prefix covers every surface (the shipped, deliberately wide default)");

  ok(captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: [otherKey, liveKey] } }), "list: a surface matching ANY listed prefix is covered");
  ok(!captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: [otherKey, "discord/g-other/c-other"] } }), "🔴 list: a surface matching NONE of the listed prefixes is not covered");
  ok(captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: [] } }), "list: an EMPTY list covers every surface — the same wide default as an empty string");
  ok(captureCoversSurface(liveKey, { soak: { capture: true, captureSurfacePrefix: [otherKey, ""] } }), "list: a list CONTAINING an empty-string prefix covers every surface, even alongside a real one");
  ok(capturePrefixList("a/b/") .length === 1 && capturePrefixList("a/b/")[0] === "a/b/", "capturePrefixList: a bare string normalises to a one-element list — the string/array shorthand is symmetric");
  eq(capturePrefixList(["a/", "b/"]), ["a/", "b/"], "capturePrefixList: an array passes through unchanged");
  eq(capturePrefixList(undefined), [""], "capturePrefixList: an absent setting normalises to the wide-default sentinel, same as the shipped empty string");

  resetSettingsForTest();
  registerSettings({ soak: { capture: true, captureSurfacePrefix: otherKey }, turn: { stepBudget: 0 } });
  _resetCaptureCountsForTest();
  _resetStepBoundaryCountsForTest();

  const calls: FakeCall[] = [];
  const offCtx = turnCtx("s-scope-off");
  await driveCall(offCtx, "turn_5", callOptions("ordinary traffic"), calls);
  eq(calls.length, 1, "scope: the off-scope model call really happened");
  eq((await store.modelCallCapturesForSession(ORG, "s-scope-off")).length, 0, "🔴 scope: a surface outside the armed prefix records NOTHING even with capture armed");

  for (let i = 0; i < 3; i++) noteCompletedModelStep("s-scope-off", "turn_5", offCtx);
  await new Promise((r) => setTimeout(r, 50));
  eq(captureCountsFor("s-scope-off", "turn_5"), undefined, "🔴 scope: the cross-check does not count an off-scope turn — no false gap on ordinary traffic");

  resetSettingsForTest();
  registerSettings({ soak: { capture: true, captureSurfacePrefix: liveKey }, turn: { stepBudget: 0 } });
  _resetCaptureCountsForTest();
  const onCtx = turnCtx("s-scope-on");
  await driveCall(onCtx, "turn_6", callOptions("soak traffic"), []);
  eq((await store.modelCallCapturesForSession(ORG, "s-scope-on")).length, 1, "scope: the in-scope surface records normally");
  noteCompletedModelStep("s-scope-on", "turn_6", onCtx);
  eq(captureCountsFor("s-scope-on", "turn_6")?.completed, 1, "scope: …and the cross-check counts its steps");
}

{
  const ac = new AbortController();
  const body = serialiseCallBody({ prompt: [{ role: "user", content: "hi" }], abortSignal: ac.signal, onChunk: () => undefined } as unknown as RoutedCallOptions);
  ok(!body.includes("abortSignal"), "serialise: the per-invocation abortSignal is dropped (transport state, not wire content)");
  ok(!body.includes("onChunk"), "serialise: functions are dropped (not serialisable, never sent)");
  ok(body.includes('"hi"'), "serialise: the message content survives");
  eq(bodySha256(body), createHash("sha256").update(body, "utf8").digest("hex"), "serialise: bodySha256 is a plain sha256 of the serialised body");
  const cyclic: Record<string, unknown> = { prompt: [] };
  cyclic.self = cyclic;
  ok(serialiseCallBody(cyclic as RoutedCallOptions).includes("[circular]"), "serialise: a cycle degrades to a marker rather than throwing inside a model call");

  const schema = { type: "object", properties: { text: { type: "string" } } };
  const shared = serialiseCallBody({ tools: [{ name: "a", inputSchema: schema }, { name: "b", inputSchema: schema }] } as unknown as RoutedCallOptions);
  ok(!shared.includes("[circular]"), "serialise: one schema object referenced by TWO tools is not mistaken for a cycle");
  eq(
    (shared.match(/"properties"/g) ?? []).length,
    2,
    "serialise: …and both references serialise in full — the bytes a replay resends are the bytes the model saw",
  );
}

{
  const params = { sessionId: "s-on" };
  const url = "https://example.test/control/v1/session/s-on/model-calls";

  delete process.env.OE_CONTROL_READ_TOKENS;
  eq((await handleSessionModelCallsRead(new Request(url), params)).status, 404, "🔴 route: 404 with no service tokens configured — the endpoint does not exist");

  const secret = "soak-harness-token-value";
  const sha = createHash("sha256").update(secret, "utf8").digest("hex");
  process.env.OE_CONTROL_READ_TOKENS = `soak-harness:${sha}`;

  eq((await handleSessionModelCallsRead(new Request(url), params)).status, 401, "route: 401 with no bearer");
  eq(
    (await handleSessionModelCallsRead(new Request(url, { headers: { authorization: "Bearer wrong-value" } }), params)).status,
    401,
    "route: 401 on a non-matching bearer (constant-time hash compare)",
  );

  const authed = { authorization: `Bearer ${secret}` };
  const res = await handleSessionModelCallsRead(new Request(url, { headers: authed }), params);
  eq(res.status, 200, "route: 200 for a valid service token");
  const payload = (await res.json()) as { sessionId: string; count: number; includeBody: boolean; captures: { bodyGzipB64: string; sha256: string }[] };
  eq(payload.sessionId, "s-on", "route: the response names the session");
  eq(payload.count, 2, "route: the session's two captures come back");
  ok(payload.captures[0].bodyGzipB64.length > 0, "route: the body is served by default (the harvest read)");
  ok(
    gunzipSync(Buffer.from(payload.captures[0].bodyGzipB64, "base64")).toString("utf8").includes("first message"),
    "route: the served body inflates to the captured request",
  );

  const metaRes = await handleSessionModelCallsRead(new Request(`${url}?body=0`, { headers: authed }), params);
  const metaPayload = (await metaRes.json()) as { includeBody: boolean; captures: { bodyGzipB64: string }[] };
  eq(metaPayload.includeBody, false, "route: body=0 selects the metadata read");
  eq(metaPayload.captures[0].bodyGzipB64, "", "route: body=0 serves no prompt bytes");

  const unknown = await handleSessionModelCallsRead(new Request("https://example.test/control/v1/session/wrun_nope/model-calls", { headers: authed }), { sessionId: "wrun_nope" });
  eq(unknown.status, 200, "route: an unknown session is an honest empty 200, not a 404 (the store cannot tell 'no session' from 'never armed')");
  eq(((await unknown.json()) as { count: number }).count, 0, "route: …and it carries zero captures");

  const svcRows = await readAudit({ org: deploymentOrg(), action: "control.service_call" });
  ok(
    svcRows.some((r) => (r.detail as { view?: string } | undefined)?.view === "model_calls"),
    "route: every authenticated call writes a control.service_call audit row naming the view",
  );
  ok(
    svcRows.every((r) => !JSON.stringify(r.detail ?? {}).includes("first message")),
    "route: no body byte ever reaches an audit row",
  );
  delete process.env.OE_CONTROL_READ_TOKENS;
}

{
  const sessions = await store.modelCallCaptureSessions(ORG);
  const sOn = sessions.find((s) => s.sessionId === "s-on");
  ok(sOn !== undefined, "sessions: the store lists every session holding captures, incl. s-on");
  eq(sOn?.rowCount, 2, "sessions: rowCount matches the session's actual capture count");
  ok((sOn?.totalBytes ?? 0) > 0, "sessions: totalBytes sums the session's body_bytes");
  ok(!!sOn && sOn.firstTs <= sOn.lastTs, "sessions: firstTs is never after lastTs");
  ok(!sessions.some((s) => s.sessionId === "s-off"), "🔴 sessions: a disarmed-capture session (zero rows) never appears — negative control");

  const sessUrl = "https://example.test/control/v1/model-calls/sessions";
  delete process.env.OE_CONTROL_READ_TOKENS;
  eq((await handleModelCallSessionsRead(new Request(sessUrl))).status, 404, "🔴 sessions route: 404 with no service tokens configured");

  const secret2 = "soak-harness-sessions-token";
  const sha2 = createHash("sha256").update(secret2, "utf8").digest("hex");
  process.env.OE_CONTROL_READ_TOKENS = `soak-harness:${sha2}`;
  eq((await handleModelCallSessionsRead(new Request(sessUrl))).status, 401, "sessions route: 401 with no bearer");

  const sessRes = await handleModelCallSessionsRead(new Request(sessUrl, { headers: { authorization: `Bearer ${secret2}` } }));
  eq(sessRes.status, 200, "sessions route: 200 for a valid service token");
  const sessPayload = (await sessRes.json()) as { count: number; sessions: { sessionId: string; rowCount: number }[] };
  ok(sessPayload.sessions.some((s) => s.sessionId === "s-on"), "sessions route: s-on is present in the served list");
  ok(!JSON.stringify(sessPayload).includes("first message"), "sessions route: no body byte is ever served (a listing, not a harvest)");

  const sessSvcRows = await readAudit({ org: deploymentOrg(), action: "control.service_call" });
  ok(
    sessSvcRows.some((r) => (r.detail as { view?: string } | undefined)?.view === "model_call_sessions"),
    "sessions route: the authenticated call writes a control.service_call audit row naming the view",
  );
  delete process.env.OE_CONTROL_READ_TOKENS;
}

{
  const before = await store.modelCallCapturesForSession(ORG, "s-on", { includeBody: false });
  ok(before.length > 0, "retention: the session has rows to delete");
  const removed = await store.deleteModelCallCapturesForSession(ORG, "s-on");
  eq(removed, before.length, "retention: delete-by-session returns the count removed");
  eq((await store.modelCallCapturesForSession(ORG, "s-on")).length, 0, "retention: the session's captures are gone");
  ok((await store.modelCallCapturesForSession(ORG, "s-soft")).length > 0, "retention: another session's captures are untouched (negative control)");
  ok(!(await store.modelCallCaptureSessions(ORG)).some((s) => s.sessionId === "s-on"), "retention: the purged session drops out of the session listing too");
}

{
  const pg = await openTestPg();
  await initOperationalSchema(pg.client);
  const pgStore = makeOperationalPostgresStore(pg.client);
  const write = {
    org: "default",
    surfaceKey: "slack/T1/C1",
    sessionId: "wrun_pg",
    turnId: "turn_0",
    stepIndex: 0,
    ts: "2026-08-19T10:00:00.000Z",
    model: "vendor/m",
    provider: "gateway",
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    sha256: "a".repeat(64),
    bodyBytes: 12,
    bodyGzipB64: "H4sIAAAAAAAAA",
    truncated: false,
  };
  await pgStore.appendModelCallCapture(write);
  await pgStore.appendModelCallCapture({ ...write, stepIndex: 1, turnId: "turn_1" });
  await pgStore.appendModelCallCapture({ ...write, sessionId: "wrun_other" });

  const rows = await pgStore.modelCallCapturesForSession("default", "wrun_pg");
  eq(rows.length, 2, "postgres: appends and reads back the session's rows");
  eq(rows[0].bodyGzipB64, write.bodyGzipB64, "postgres: the body column round-trips");
  eq(rows[0].truncated, false, "postgres: the boolean column round-trips");
  ok(typeof rows[0].seq === "number" && typeof rows[0].bodyBytes === "number", "postgres: bigint columns are coerced at the seam (never a string to the caller)");
  eq((await pgStore.modelCallCapturesForSession("default", "wrun_pg", { turnId: "turn_1" })).length, 1, "postgres: the turnId filter binds as a parameter");
  eq((await pgStore.modelCallCapturesForSession("default", "wrun_pg", { limit: 1 })).length, 1, "postgres: the limit binds as a parameter");
  eq((await pgStore.modelCallCapturesForSession("default", "wrun_pg", { includeBody: false }))[0].bodyGzipB64, "", "postgres: includeBody:false serves no bytes");

  const pgSessions = await pgStore.modelCallCaptureSessions("default");
  const pgWrunPg = pgSessions.find((s) => s.sessionId === "wrun_pg");
  eq(pgWrunPg?.rowCount, 2, "postgres: sessions listing groups by session and counts rows correctly");
  ok((pgWrunPg?.totalBytes ?? 0) > 0, "postgres: sessions listing sums body_bytes, coerced from a bigint string");
  ok(pgSessions.some((s) => s.sessionId === "wrun_other"), "postgres: sessions listing carries every session, not just the first");

  eq(await pgStore.deleteModelCallCapturesForSession("default", "wrun_pg"), 2, "🔴 postgres: delete-by-session removes the rows and returns the count");
  eq((await pgStore.modelCallCapturesForSession("default", "wrun_pg")).length, 0, "postgres: they are gone");
  eq((await pgStore.modelCallCapturesForSession("default", "wrun_other")).length, 1, "postgres: another session is untouched");
  await closeAllTestPg();
}

ok(deploymentOrg().length > 0, "sanity: the deployment org resolves (the org the read route scopes to)");
await removeTempDir(tmp);
console.log(`✓ model-call capture: ${n} assertions passed`);
