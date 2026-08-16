
import type { AttachSessionFn } from "eve/channels";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-control-read-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_CONTROL_READ_TOKENS;
const prevPricing = process.env.OE_MODEL_PRICING;
process.env.OE_MODEL_PRICING = JSON.stringify({ "test/model-a": { inPerMtok: 1, outPerMtok: 2 } });

const {
  handleUsageWindowRead,
  handleAuditWindowRead,
  handleSessionTranscriptRead,
  handleRuntimeSignalRead,
  CONTROL_READ_USAGE_PATH,
  CONTROL_READ_AUDIT_PATH,
  CONTROL_READ_TRANSCRIPT_PATH,
  CONTROL_READ_RUNTIME_SIGNAL_PATH,
} = await import("../agent/control/read-route.js");
const { appendUsageEvent } = await import("../agent/spend/usage-events.js");
const { readAudit, appendAudit } = await import("../agent/audit/audit.js");
const { _resetPricingCacheForTest } = await import("../agent/spend/pricing.js");
_resetPricingCacheForTest();

type _EveSession = ReturnType<AttachSessionFn>;
const _eveLookupShapePin: (attach: AttachSessionFn) => {
  byDurableId: (id: string) => _EveSession;
  replay: (s: _EveSession) => Promise<ReadableStream<unknown>>;
  probe: (s: _EveSession) => Promise<number>;
} = (attach) => ({
  byDurableId: (id: string) => attach(id),
  replay: async (s) => await s.getEventStream({ startIndex: 0 }),
  probe: async (s) => await s.getStreamTailIndex(),
});
void _eveLookupShapePin;

const SECRET = "control-read-test-token";
const SHA = createHash("sha256").update(SECRET, "utf-8").digest("hex");
const goodQuery = `?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&workspaces=${encodeURIComponent("slack/T1")}`;

function get(query: string, token?: string): Promise<Response> {
  return handleUsageWindowRead(
    new Request(`https://oe.example${CONTROL_READ_USAGE_PATH}${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

{
  const res = await get(goodQuery, SECRET);
  ok(res.status === 404, "no OE_CONTROL_READ_TOKENS → 404 even with a well-formed query + bearer (mode fully off)");
  ok((await get(goodQuery)).status === 404, "no OE_CONTROL_READ_TOKENS → 404 without a bearer too");
}

process.env.OE_CONTROL_READ_TOKENS = `e2e-harness:${SHA}`;
{
  ok((await get(goodQuery)).status === 401, "configured + no bearer → 401");
  ok((await get(goodQuery, "not-the-token")).status === 401, "configured + wrong token → 401");
  const basic = await handleUsageWindowRead(
    new Request(`https://oe.example${CONTROL_READ_USAGE_PATH}${goodQuery}`, { headers: { authorization: `Basic ${SECRET}` } }),
  );
  ok(basic.status === 401, "a non-Bearer authorization scheme → 401");
}

{
  ok((await get("", SECRET)).status === 400, "missing since+workspaces → 400");
  ok((await get("?since=2026-03-02T16:10:00Z", SECRET)).status === 400, "missing workspaces → 400");
  const badSince = await get(`?since=not-a-date&workspaces=${encodeURIComponent("slack/T1")}`, SECRET);
  ok(badSince.status === 400, "unparseable since → 400 (usageWindowView's validation surfaces)");
  const badWk = await get(`?since=2026-03-02T16:10:00Z&workspaces=${encodeURIComponent("slack/T1/C1")}`, SECRET);
  ok(badWk.status === 400, "a surface key (3 segments) in workspaces → 400 (must be platform/workspace)");
}

{
  await appendUsageEvent({
    org: "acme",
    surfaceKey: "slack/T1/C1",
    sessionId: "s1",
    principalId: "u1",
    kind: "channel",
    model: "test/model-a",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
  });
  await appendUsageEvent({ org: "acme", surfaceKey: "slack/T2/C9", sessionId: "s2", model: "test/model-a", inputTokens: 7, outputTokens: 7 });

  const res = await get(goodQuery, SECRET);
  ok(res.status === 200, "configured + matching bearer + valid query → 200");
  ok((res.headers.get("content-type") ?? "").includes("application/json"), "200 response is JSON");
  const body = (await res.json()) as {
    org: string;
    since: string;
    workspaceKeys: string[];
    rows: { surfaceKey: string; model?: string; calls: number; inputTokens: number; estimatedUsd?: number }[];
    totalUsd: number;
    unpricedModels: string[];
  };
  ok(body.org === "acme" && Array.isArray(body.rows) && body.rows.length === 1, "body carries org + exactly the filtered workspace's row");
  const row = body.rows[0];
  ok(row.surfaceKey === "slack/T1/C1" && row.model === "test/model-a" && row.calls === 1, "row is grouped by surface × model with a call count");
  ok(Math.abs((row.estimatedUsd ?? 0) - 2) < 1e-9 && Math.abs(body.totalUsd - 2) < 1e-9, "row is priced server-side: 1M in @$1 + 0.5M out @$2 = $2.00");
  ok(body.unpricedModels.length === 0, "nothing unpriced in this window");
}

{
  const boundIso = new Date(Date.now() - 1_800_000).toISOString();
  await appendUsageEvent({
    org: "acme",
    surfaceKey: "slack/T1/C3",
    sessionId: "s-late",
    principalId: "u1",
    kind: "channel",
    model: "test/model-a",
    inputTokens: 10,
    outputTokens: 10,
    ts: new Date(Date.parse(boundIso) - 60_000).toISOString(),
  });
  await appendUsageEvent({
    org: "acme",
    surfaceKey: "slack/T1/C3",
    sessionId: "s-late",
    principalId: "u1",
    kind: "channel",
    model: "test/model-a",
    inputTokens: 20,
    outputTokens: 20,
    ts: new Date(Date.parse(boundIso) + 60_000).toISOString(),
  });

  const q = `?since=${encodeURIComponent(boundIso)}&workspaces=${encodeURIComponent("slack/T1")}`;
  const withoutBoundBody = (await (await get(q, SECRET)).json()) as { rows: { surfaceKey: string; calls: number }[] };
  const lateRowNoBound = withoutBoundBody.rows.find((r) => r.surfaceKey === "slack/T1/C3");
  ok(lateRowNoBound?.calls === 1, "OPE-402: absent sessionStartedAfter, s-late's in-window write still counts (byte-identical default)");

  const withBoundRes = await get(`${q}&sessionStartedAfter=${encodeURIComponent(boundIso)}`, SECRET);
  ok(withBoundRes.status === 200, "OPE-402: sessionStartedAfter query param → 200 on a good ISO value");
  const withBoundBody = (await withBoundRes.json()) as { rows: { surfaceKey: string; calls: number }[]; sessionStartedAfter?: string };
  ok(withBoundBody.rows.find((r) => r.surfaceKey === "slack/T1/C3") === undefined, "OPE-402: with sessionStartedAfter set, s-late's session is excluded wholesale over HTTP");
  ok(withBoundBody.sessionStartedAfter === boundIso, "OPE-402: the response echoes the applied sessionStartedAfter bound");

  const badBound = await get(`${q}&sessionStartedAfter=not-a-date`, SECRET);
  ok(badBound.status === 400, "OPE-402: unparseable sessionStartedAfter → 400, same contract as since");
}

{
  const { registerPricingSource, _resetPricingSourceForTest } = await import("../agent/spend/pricing.js");
  let catalog: Record<string, { inPerMtok: number; outPerMtok: number }> = {};
  registerPricingSource({
    priceFor: (id) => catalog[id],
    ensureReady: async () => {
      await new Promise((r) => setTimeout(r, 5));
      catalog = { "test/catalog-only": { inPerMtok: 2, outPerMtok: 4 } };
    },
  });
  await appendUsageEvent({
    org: "acme",
    surfaceKey: "slack/T1/C2",
    sessionId: "s3",
    principalId: "u1",
    kind: "channel",
    model: "test/catalog-only",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
  });
  const res = await get(goodQuery, SECRET);
  ok(res.status === 200, "cold-catalog read still 200");
  const body = (await res.json()) as { rows: { model?: string; estimatedUsd?: number }[]; unpricedModels: string[] };
  const row = body.rows.find((r) => r.model === "test/catalog-only");
  ok(Math.abs((row?.estimatedUsd ?? 0) - 4) < 1e-9, "a catalog-only model prices on the FIRST read of a cold instance (the view awaits ensureReady): 1M in @$2 + 0.5M out @$4 = $4");
  ok(!body.unpricedModels.includes("test/catalog-only"), "…and is not listed under unpricedModels");
  _resetPricingSourceForTest();
}

{
  const entries = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(entries.length > 0, "authenticated read is audited as control.service_call under svc:<name>");
  const detail = entries[0].detail as { view?: string; workspaces?: string };
  ok(detail.view === "usage_window" && detail.workspaces === "slack/T1", "audit detail names the view + workspace filter");
}

{
  function getAudit(query: string, token?: string): Promise<Response> {
    return handleAuditWindowRead(
      new Request(`https://oe.example${CONTROL_READ_AUDIT_PATH}${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );
  }
  const sinceQ = `?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`;

  ok((await getAudit(sinceQ)).status === 401, "audit: configured + no bearer → 401");
  ok((await getAudit(sinceQ, "not-the-token")).status === 401, "audit: wrong token → 401");
  ok((await getAudit("", SECRET)).status === 400, "audit: missing since → 400");
  ok((await getAudit("?since=not-a-date", SECRET)).status === 400, "audit: unparseable since → 400");

  await appendAudit({ org: "acme", platform: "notion", workspace: "ws1", action: "notion.no_reply", detail: { reason: "off-topic" } });
  await appendAudit({ org: "acme", platform: "notion", workspace: "ws1", action: "notion.replied", detail: { chars: 42 } });
  await appendAudit({ org: "acme", platform: "github", workspace: "ownerX", action: "github.dispatched", detail: {} });

  const all = await getAudit(sinceQ, SECRET);
  ok(all.status === 200, "audit: configured + bearer + valid since → 200");
  ok((all.headers.get("content-type") ?? "").includes("application/json"), "audit 200 is JSON");
  const body = (await all.json()) as { entries: { action: string; platform: string }[]; capped: boolean };
  const seededActions = new Set(body.entries.map((e) => e.action));
  ok(seededActions.has("notion.no_reply") && seededActions.has("notion.replied") && seededActions.has("github.dispatched"), "audit window returns the seeded rows");

  const one = (await (await getAudit(`${sinceQ}&actions=notion.no_reply`, SECRET)).json()) as { entries: { action: string }[] };
  ok(one.entries.length > 0 && one.entries.every((e) => e.action === "notion.no_reply"), "audit actions=notion.no_reply returns only audited-silence rows");
  const many = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,github.dispatched`, SECRET)).json()) as { entries: { action: string }[] };
  const manyActions = new Set(many.entries.map((e) => e.action));
  ok(manyActions.has("notion.no_reply") && manyActions.has("github.dispatched") && !manyActions.has("notion.replied"), "audit actions=<csv> keeps only the named actions (in-process match)");

  await appendAudit({ org: "other", platform: "notion", workspace: "wsOther", action: "notion.cross_tenant_marker", detail: {} });
  const crossOrg = (await (await getAudit(`${sinceQ}&org=other&actions=notion.cross_tenant_marker`, SECRET)).json()) as { entries: unknown[] };
  ok(crossOrg.entries.length === 0, "audit ?org=other is IGNORED (pinned to the deployment org) — a cross-tenant row is never returned (F10)");

  const gh = (await (await getAudit(`${sinceQ}&platform=github`, SECRET)).json()) as { entries: { platform: string }[] };
  ok(gh.entries.length > 0 && gh.entries.every((e) => e.platform === "github"), "audit platform=github narrows to the github surface");
  const capped = (await (await getAudit(`${sinceQ}&limit=1`, SECRET)).json()) as { entries: unknown[]; capped: boolean };
  ok(capped.entries.length === 1 && capped.capped === true, "audit limit=1 caps the result and reports capped:true");

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(svc.some((e) => (e.detail as { view?: string }).view === "audit"), "audit read is self-audited as control.service_call view=audit");
}

{
  const makeStream = (events: unknown[], park = false): ReadableStream<unknown> => {
    let i = 0;
    return new ReadableStream<unknown>({
      pull(controller) {
        if (i < events.length) {
          controller.enqueue(events[i++]);
          return;
        }
        if (!park) controller.close();
      },
    });
  };
  const ev = (type: string, data: unknown, at = "2026-03-07T16:10:00.000Z") => ({ type, data, meta: { at } });
  const completedEvents = [
    ev("session.started", {}),
    ev("turn.started", { turnId: "t1", sequence: 1 }),
    ev("message.received", { message: "hi", turnId: "t1", sequence: 1 }),
    ev("reasoning.completed", { reasoning: "thinking about it" }),
    ev("actions.requested", { actions: [{ callId: "c1", toolName: "memory_read", input: {} }], turnId: "t1" }),
    ev("action.result", { status: "completed", result: { callId: "c1", toolName: "memory_read", output: "recalled X" } }),
    ev("message.completed", { message: "the answer", finishReason: "stop" }),
    ev("step.completed", { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, generationId: "gen_1" }),
    ev("session.completed", {}),
  ];
  const parkedEvents = [ev("session.started", {}), ev("turn.started", { turnId: "t1" }), ev("message.received", { message: "parked" })];
  let lastStartIndex = -1;
  let probeCalls = 0;
  const tailFor = (id: string): number => (id === "wrun_parked" ? parkedEvents.length - 1 : completedEvents.length - 1);
  const getSession = ((id: string) => ({
    getStreamTailIndex: async () => {
      probeCalls += 1;
      if (id === "wrun_missing") throw new Error("no such session");
      if (id === "wrun_gone" || id.includes("oe-sup:g")) return -1;
      return tailFor(id);
    },
    getEventStream: async (o?: { startIndex?: number }) => {
      lastStartIndex = o?.startIndex ?? 0;
      if (id === "wrun_missing") throw new Error("no such session");
      if (id === "wrun_gone" || id.includes("oe-sup:g")) return makeStream([], true);
      if (id === "wrun_parked") return makeStream(parkedEvents, true);
      return makeStream(completedEvents, false);
    },
  })) as unknown as Parameters<typeof handleSessionTranscriptRead>[1];
  const getSessionNoProbe = ((id: string) => ({
    getEventStream: async (o?: { startIndex?: number }) => {
      lastStartIndex = o?.startIndex ?? 0;
      if (id === "wrun_gone") return makeStream([], true);
      return makeStream(completedEvents, false);
    },
  })) as unknown as Parameters<typeof handleSessionTranscriptRead>[1];

  function getTranscript(
    sessionId: string,
    query = "",
    token: string | null = SECRET,
    attach: Parameters<typeof handleSessionTranscriptRead>[1] = getSession,
  ): Promise<Response> {
    return handleSessionTranscriptRead(
      new Request(`https://oe.example/control/v1/session/${encodeURIComponent(sessionId)}/transcript${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      attach,
      { sessionId },
    );
  }

  {
    const saved = process.env.OE_CONTROL_READ_TOKENS;
    delete process.env.OE_CONTROL_READ_TOKENS;
    ok((await getTranscript("wrun_done", "", SECRET)).status === 404, "transcript: no OE_CONTROL_READ_TOKENS → 404 (mode off)");
    process.env.OE_CONTROL_READ_TOKENS = saved;
  }

  ok((await getTranscript("wrun_done", "", null)).status === 401, "transcript: configured + no bearer → 401");
  ok((await getTranscript("wrun_done", "", "not-the-token")).status === 401, "transcript: wrong token → 401");

  const done = await getTranscript("wrun_done", "", SECRET);
  ok(done.status === 200, "transcript: configured + bearer + known session → 200");
  ok((done.headers.get("content-type") ?? "").includes("application/json"), "transcript 200 is JSON");
  const body = (await done.json()) as {
    sessionId: string;
    startIndex: number;
    nextIndex: number;
    complete: boolean;
    count: number;
    events: { index: number; at: string | null; type: string; data: unknown }[];
  };
  ok(body.sessionId === "wrun_done" && body.startIndex === 0, "transcript: body echoes sessionId + startIndex");
  ok(body.count === completedEvents.length && body.events.length === completedEvents.length, "transcript: replays every recorded event");
  ok(body.complete === true && body.nextIndex === completedEvents.length, "transcript: a terminal session.completed sets complete:true + nextIndex");
  ok(body.events[0]!.type === "session.started" && body.events[0]!.index === 0, "transcript: events keep stream order + carry a 0-based index");
  ok(body.events.every((e, i) => e.index === i), "transcript: indices are contiguous from startIndex");
  ok(body.events[0]!.at === "2026-03-07T16:10:00.000Z", "transcript: each event hoists its meta.at timestamp");
  const actionResult = body.events.find((e) => e.type === "action.result");
  ok((actionResult?.data as { status?: string } | undefined)?.status === "completed", "transcript: tool-result data (status/output) is preserved unmodified");
  const stepDone = body.events.find((e) => e.type === "step.completed");
  ok((stepDone?.data as { generationId?: string } | undefined)?.generationId === "gen_1", "transcript: step.completed usage/generationId is preserved");

  const capped = (await (await getTranscript("wrun_done", "?limit=2", SECRET)).json()) as { count: number; complete: boolean; nextIndex: number };
  ok(capped.count === 2 && capped.complete === false && capped.nextIndex === 2, "transcript: ?limit caps the page (complete:false, nextIndex=cursor)");

  const paged = (await (await getTranscript("wrun_done", "?startIndex=5", SECRET)).json()) as { startIndex: number; nextIndex: number; count: number };
  ok(lastStartIndex === 5 && paged.startIndex === 5 && paged.nextIndex === 5 + paged.count, "transcript: ?startIndex is passed to getEventStream + drives nextIndex");

  const parked = (await (await getTranscript("wrun_parked", "?idleMs=50", SECRET)).json()) as { count: number; complete: boolean };
  ok(parked.count === parkedEvents.length && parked.complete === false, "transcript: a parked session returns recorded events with complete:false (idle-stop, no hang)");

  ok((await getTranscript("wrun_done", "?startIndex=-1", SECRET)).status === 400, "transcript: negative startIndex → 400");
  ok((await getTranscript("wrun_done", "?limit=0", SECRET)).status === 400, "transcript: limit=0 → 400");
  ok((await getTranscript("wrun_missing", "", SECRET)).status === 404, "transcript: unknown/unreadable session → 404 (non-enumeration)");

  {
    const goneRes = await getTranscript("wrun_gone", "?idleMs=50", SECRET);
    ok(goneRes.status === 404, "transcript OPE-333: an id whose stream never yields is 404, NOT an empty 200");
    const goneBody = (await goneRes.json()) as { found?: boolean; error?: string; hint?: string; sessionId?: string };
    ok(goneBody.found === false, "transcript OPE-333: the 404 body carries found:false (the caller can tell, not guess)");
    ok(goneBody.sessionId === "wrun_gone", "transcript OPE-333: the 404 echoes the id that was asked for");
    ok(goneBody.hint === undefined, "transcript OPE-333: a durable-shaped id gets NO token hint (the hint is not noise)");

    const foundBody = (await (await getTranscript("wrun_done", "", SECRET)).json()) as { found?: boolean };
    ok(foundBody.found === true, "transcript OPE-333: a real read answers found:true on the 200");

    for (const [label, token] of [
      ["eve-namespaced", "unified:oe-dom:e2e-unified:oe-sup:g106"],
      ["bare", "oe-dom:e2e-unified:win:s/slack/C0EXCHAN003/run/2f307aa6:oe-sup:g106"],
    ] as const) {
      const res = await getTranscript(token, "?idleMs=50", SECRET);
      ok(res.status === 404, `transcript OPE-333: a ${label} window token → 404, not an empty 200`);
      const body = (await res.json()) as { found?: boolean; hint?: string };
      ok(body.found === false, `transcript OPE-333: the ${label} window-token 404 carries found:false`);
      ok(
        (body.hint ?? "").includes("continuation token") && (body.hint ?? "").includes("detail.sessionId"),
        `transcript OPE-333: the ${label} window-token 404 NAMES the right lookup (detail.sessionId on an audit row)`,
      );
    }

    ok(probeCalls > 0, "transcript OPE-333: the existence probe is actually called (not dead code)");
  }

  {
    const okDrift = await getTranscript("wrun_done", "", SECRET, getSessionNoProbe);
    ok(okDrift.status === 200, "transcript OPE-333: no probe method on the session ⇒ a real read still 200s (drift-safe)");
    const goneDrift = await getTranscript("wrun_gone", "?idleMs=50", SECRET, getSessionNoProbe);
    ok(goneDrift.status === 404, "transcript OPE-333: no probe method ⇒ zero events at startIndex 0 is still 404 (drain backstop)");
    const pagedDrift = await getTranscript("wrun_gone", "?startIndex=7&idleMs=50", SECRET, getSessionNoProbe);
    ok(pagedDrift.status === 200, "transcript OPE-333: the drain backstop never fires at a non-zero startIndex (paging stays 200)");
  }

  {
    const { probeSessionExists } = await import("../agent/control/read-route.js");
    ok((await probeSessionExists({ getStreamTailIndex: async () => 4 }, 200)) === "found", "probe: a tail index ≥ 0 ⇒ found");
    ok((await probeSessionExists({ getStreamTailIndex: async () => 0 }, 200)) === "found", "probe: tail index 0 (one chunk) ⇒ found");
    ok(
      (await probeSessionExists({ getStreamTailIndex: async () => -1 }, 200)) === "missing",
      "probe: eve's documented -1 (no chunks ever written) ⇒ missing",
    );
    ok(
      (await probeSessionExists({
        getStreamTailIndex: async () => {
          throw new Error("no such run");
        },
      }, 200)) === "missing",
      "probe: a rejecting probe ⇒ missing",
    );
    ok((await probeSessionExists({}, 200)) === "unknown", "probe: no probe method at all ⇒ unknown (never missing — eve-drift safety)");
    ok(
      (await probeSessionExists({ getStreamTailIndex: () => new Promise<number>(() => {}) }, 30)) === "unknown",
      "probe: a probe that never answers ⇒ unknown after the budget (a slow world is not a missing session)",
    );
  }

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  const transcriptRows = svc.filter((e) => (e.detail as { view?: string }).view === "transcript");
  ok(
    transcriptRows.some((e) => (e.detail as { sessionId?: string }).sessionId === "wrun_done"),
    "transcript: authenticated read is self-audited (view=transcript, sessionId stamped)",
  );
}

{
  const prevDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  function getSignal(token?: string): Promise<Response> {
    return handleRuntimeSignalRead(
      new Request(`https://oe.example${CONTROL_READ_RUNTIME_SIGNAL_PATH}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );
  }

  ok((await getSignal()).status === 401, "runtime-signal: configured + no bearer → 401");
  ok((await getSignal("not-the-token")).status === 401, "runtime-signal: configured + wrong token → 401");

  delete process.env.VERCEL_DEPLOYMENT_ID;
  {
    const res = await getSignal(SECRET);
    ok(res.status === 200, "runtime-signal: good token → 200");
    ok((res.headers.get("content-type") ?? "").includes("application/json"), "runtime-signal 200 is JSON");
    const body = (await res.json()) as { hasDeploymentId: boolean };
    ok(body.hasDeploymentId === false, "runtime-signal: an EMPTY VERCEL_DEPLOYMENT_ID reports hasDeploymentId: false — the incident this route exists to catch");
  }

  process.env.VERCEL_DEPLOYMENT_ID = "   ";
  {
    const body = (await (await getSignal(SECRET)).json()) as { hasDeploymentId: boolean };
    ok(body.hasDeploymentId === false, "runtime-signal: a whitespace-only VERCEL_DEPLOYMENT_ID also reports false (trimmed, not just falsy-checked)");
  }

  process.env.VERCEL_DEPLOYMENT_ID = "dpl_test_only_never_a_real_id";
  {
    const res = await getSignal(SECRET);
    const raw = await res.text();
    const body = JSON.parse(raw) as { hasDeploymentId: boolean };
    ok(body.hasDeploymentId === true, "runtime-signal: a non-empty VERCEL_DEPLOYMENT_ID reports hasDeploymentId: true — the positive control");
    ok(!raw.includes("dpl_test_only_never_a_real_id"), "🔴 PRESENCE, NEVER VALUE — the raw deployment id never leaves the response body");
    ok(Object.keys(body).length === 1, "the body carries exactly one field — nothing else about the runtime rides along");
  }

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(
    svc.some((e) => (e.detail as { view?: string }).view === "runtime_signal"),
    "runtime-signal: authenticated read is self-audited as control.service_call view=runtime_signal",
  );

  if (prevDeploymentId === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
  else process.env.VERCEL_DEPLOYMENT_ID = prevDeploymentId;
}

{
  const channel = (await import("../agent/channels/control-read.js")).default as unknown as {
    routes: { method: string; path: string }[];
  };
  ok(channel.routes.length === 5 && channel.routes.every((r) => r.method === "GET"), "the channel mounts exactly five GET routes (usage + audit + unified-audit + transcript + runtime-signal)");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_USAGE_PATH), "…one at /control/v1/usage");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_AUDIT_PATH), "…one at /control/v1/audit");
  ok(channel.routes.some((r) => r.path === "/control/v1/unified-audit"), "…one at /control/v1/unified-audit");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_TRANSCRIPT_PATH), "…one at /control/v1/session/:sessionId/transcript");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_RUNTIME_SIGNAL_PATH), "…one at /control/v1/runtime-signal (OPE-658)");

  const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent");
  for (const file of ["control/read-route.ts", "channels/control-read.ts"]) {
    const src = readFileSync(join(agentDir, file), "utf-8");
    const imports = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    ok(
      imports.every((s) => !/\/(writes|server)\.js$/.test(s) && !/^\.\/(writes|server)\.js$/.test(s)),
      `${file} imports no write-tool module (structural read-only)`,
    );
  }
}

if (prevPricing === undefined) delete process.env.OE_MODEL_PRICING;
else process.env.OE_MODEL_PRICING = prevPricing;

rmSync(dir, { recursive: true, force: true });
console.log(`✓ control-read route: ${passed} assertions passed (fail-closed 404 / 401 / 400 / priced 200 / runtime-signal presence-never-value / audited / structurally read-only)`);
