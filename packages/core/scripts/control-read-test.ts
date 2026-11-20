// proves: const CONTROL_READ_AUDIT_PATH, authorizeRead, const AUDIT_MAX_LIMIT, handleAuditWindowRead, handleAuditWindowRead` (scan truncated), handleUsageWindowRead, handleRuntimeSignalRead, handleAuditWindowRead` (org pin)

import type { AttachSessionFn } from "eve/channels";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-control-read-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
delete process.env.OE_CONTROL_READ_TOKENS;

const {
  handleUsageWindowRead,
  handleAuditWindowRead,
  handleSessionTranscriptRead,
  handleRuntimeSignalRead,
  CONTROL_READ_USAGE_PATH,
  CONTROL_READ_AUDIT_PATH,
  CONTROL_READ_TRANSCRIPT_PATH,
  CONTROL_READ_RUNTIME_SIGNAL_PATH,
  CONTROL_READ_MODEL_CALL_SESSIONS_PATH,
  AUDIT_MAX_LIMIT,
} = await import("../agent/control/read-route.js");
const { appendUsageEvent } = await import("../agent/spend/usage-events.js");
const { readAudit, appendAudit } = await import("../agent/audit/audit.js");
const { registerModelPricing, _resetModelPricingForTest } = await import("../agent/spend/pricing.js");
registerModelPricing({ "test/model-a": { inPerMtok: 1, outPerMtok: 2 } });

type _EveSession = ReturnType<AttachSessionFn>;
const _eveLookupShapePin: (attach: AttachSessionFn) => {
  byDurableId: (id: string) => _EveSession;
  replay: (s: _EveSession) => AsyncIterable<unknown>;
} = (attach) => ({
  byDurableId: (id: string) => attach(id),
  replay: (s) => s.stream({ startIndex: 0, follow: false, signal: AbortSignal.timeout(1) }),
});
// eve's public Session type no longer declares getStreamTailIndex (it moved to the internal handle
// type), so the probe has no compile-time pin. probeSessionExists treats a missing method as
// "unknown", never "missing", and the drain backstop below covers that path.
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

  const refused = await get(goodQuery, "not-the-token");
  ok((refused.headers.get("www-authenticate") ?? "").toLowerCase().includes("bearer"), "the 401 advertises the Bearer challenge this door accepts");
  ok((refused.headers.get("cache-control") ?? "").includes("no-store"), "the 401 is never cached");
  ok((await get(goodQuery, SECRET)).headers.get("www-authenticate") === null, "a 200 carries no www-authenticate (the challenge is the refusal's, not the route's)");
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
  const withBoundBody = (await withBoundRes.json()) as {
    rows: { surfaceKey: string; calls: number }[];
    sessionStartedAfter?: string;
    excluded?: { surfaceKeys: string[]; calls: number; estimatedUsd: number; sessionsUpperBound: number };
  };
  ok(withBoundBody.rows.find((r) => r.surfaceKey === "slack/T1/C3") === undefined, "OPE-402: with sessionStartedAfter set, s-late's session is excluded wholesale over HTTP");
  ok(withBoundBody.sessionStartedAfter === boundIso, "OPE-402: the response echoes the applied sessionStartedAfter bound");

  ok(withBoundBody.excluded?.calls === 1, "OPE-1622: 🔴 the wire response reports the excluded call count beside the total — the dropped row is named, not merely absent");
  ok(withBoundBody.excluded?.surfaceKeys.join(",") === "slack/T1/C3", "OPE-1622: …naming the surface whose figure is short");
  ok(withBoundBody.excluded?.sessionsUpperBound === 1, "OPE-1622: …with the excluded session upper bound");
  ok(!("excluded" in withoutBoundBody), "OPE-1622: an unbounded query gets NO excluded block — absent means 'no bound applied', never 'nothing excluded'");

  const badBound = await get(`${q}&sessionStartedAfter=not-a-date`, SECRET);
  ok(badBound.status === 400, "OPE-402: unparseable sessionStartedAfter → 400, same contract as since");
}

{
  await appendUsageEvent({
    org: "acme",
    surfaceKey: "slack/T1/C2",
    sessionId: "s3",
    principalId: "u1",
    kind: "channel",
    model: "test/deployer-only",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
  });

  const before = await get(goodQuery, SECRET);
  const beforeBody = (await before.json()) as { rows: { model?: string; estimatedUsd?: number }[]; unpricedModels: string[] };
  ok(beforeBody.unpricedModels.includes("test/deployer-only"), "an id no code table prices is listed under unpricedModels, never given another model's rate");
  ok(beforeBody.rows.find((r) => r.model === "test/deployer-only")?.estimatedUsd === undefined, "…and its row carries no estimatedUsd");

  registerModelPricing({ "test/model-a": { inPerMtok: 1, outPerMtok: 2 }, "test/deployer-only": { inPerMtok: 2, outPerMtok: 4 } });
  const res = await get(goodQuery, SECRET);
  ok(res.status === 200, "deployer-priced read still 200");
  const body = (await res.json()) as { rows: { model?: string; estimatedUsd?: number }[]; unpricedModels: string[] };
  const row = body.rows.find((r) => r.model === "test/deployer-only");
  ok(Math.abs((row?.estimatedUsd ?? 0) - 4) < 1e-9, "a deployer-table-only model prices on the view read: 1M in @$2 + 0.5M out @$4 = $4");
  ok(!body.unpricedModels.includes("test/deployer-only"), "…and is no longer listed under unpricedModels");
}

{
  const entries = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(entries.length > 0, "authenticated read is audited as control.service_call under svc:<name>");
  ok(
    entries.some((e) => {
      const detail = e.detail as { view?: string; workspaces?: string };
      return detail.view === "usage_window" && detail.workspaces === "slack/T1";
    }),
    "audit detail names the view + workspace filter",
  );
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
  ok(manyActions.has("notion.no_reply") && manyActions.has("github.dispatched") && !manyActions.has("notion.replied"), "audit actions=<csv> keeps only the named actions (one store-narrowed scan each)");

  await appendAudit({ org: "other", platform: "notion", workspace: "wsOther", action: "notion.cross_tenant_marker", detail: {} });
  const crossOrg = (await (await getAudit(`${sinceQ}&org=other&actions=notion.cross_tenant_marker`, SECRET)).json()) as { entries: unknown[] };
  ok(crossOrg.entries.length === 0, "audit ?org=other is IGNORED (pinned to the deployment org) — a cross-tenant row is never returned (F10)");

  const gh = (await (await getAudit(`${sinceQ}&platform=github`, SECRET)).json()) as { entries: { platform: string }[] };
  ok(gh.entries.length > 0 && gh.entries.every((e) => e.platform === "github"), "audit platform=github narrows to the github surface");
  const capped = (await (await getAudit(`${sinceQ}&limit=1`, SECRET)).json()) as { entries: unknown[]; capped: boolean };
  ok(capped.entries.length === 1 && capped.capped === true, "audit limit=1 caps the result and reports capped:true");

  const seqPage = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,notion.replied`, SECRET)).json()) as {
    entries: { action: string; ts: string; seq: number }[];
  };
  ok(seqPage.entries.length > 0, "audit seq: the page under test is not empty");
  ok(
    seqPage.entries.every((e) => typeof e.seq === "number" && Number.isInteger(e.seq) && e.seq > 0),
    "audit: every returned row carries a positive integer seq",
  );
  ok(
    seqPage.entries.every((e, i) => i === 0 || seqPage.entries[i - 1]!.ts > e.ts || seqPage.entries[i - 1]!.seq > e.seq),
    "audit: a newest-first page is ordered by ts then seq, both descending",
  );

  await appendAudit({ org: "acme", platform: "notion", workspace: "ws1", action: "notion.clock_step_marker", detail: { leg: "before" } });
  const beforeStep = (await (await getAudit(`${sinceQ}&actions=notion.clock_step_marker`, SECRET)).json()) as { entries: { seq: number; ts: string }[] };
  ok(beforeStep.entries.length === 1, "audit seq: the pre-step marker landed");
  const stepped = new Date(Date.parse(beforeStep.entries[0]!.ts) - 5_000).toISOString();
  await appendAudit({ org: "acme", platform: "notion", workspace: "ws1", action: "notion.clock_step_marker", ts: stepped, detail: { leg: "after" } });
  const afterStep = (await (await getAudit(`${sinceQ}&actions=notion.clock_step_marker`, SECRET)).json()) as {
    entries: { seq: number; ts: string; detail?: { leg?: string } }[];
  };
  ok(afterStep.entries.length === 2, "audit seq: both clock-step markers are in the window");
  const legBefore = afterStep.entries.find((e) => e.detail?.leg === "before")!;
  const legAfter = afterStep.entries.find((e) => e.detail?.leg === "after")!;
  ok(legAfter.ts < legBefore.ts, "audit seq: the second marker's ts really is EARLIER (the step is reproduced)");
  ok(
    legAfter.seq > legBefore.seq,
    "audit seq: the row written LATER carries the HIGHER seq even though its ts is earlier — seq is the monotonic locator",
  );
  ok(
    afterStep.entries.filter((e) => e.ts >= legBefore.ts).length === 1,
    "audit seq: a ts >= anchor over the same pair loses the later row — the negative control for anchoring on seq",
  );

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(svc.some((e) => (e.detail as { view?: string }).view === "audit"), "audit read is self-audited as control.service_call view=audit");

  const untruncated = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,github.dispatched`, SECRET)).json()) as {
    capped: boolean;
    scanTruncated?: boolean;
  };
  ok(
    untruncated.capped === false && untruncated.scanTruncated === undefined,
    "audit actions=<csv> over a SMALL window reports no truncation (negative control)",
  );
  for (let i = 0; i < 1000; i++) {
    await appendAudit({ org: "acme", platform: "noise", workspace: "ws1", action: "noise.filler", detail: { i } });
  }
  const buried = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,github.dispatched`, SECRET)).json()) as {
    entries: { action: string }[];
    capped: boolean;
    scanTruncated?: boolean;
  };
  const buriedActions = new Set(buried.entries.map((e) => e.action));
  ok(
    buriedActions.has("notion.no_reply") && buriedActions.has("github.dispatched"),
    "audit actions=<csv> still finds BOTH actions' rows behind 1000 newer rows of an unrelated action",
  );
  ok(
    buried.entries.every((e) => e.action === "notion.no_reply" || e.action === "github.dispatched"),
    "audit actions=<csv> returns only the named actions (the unrelated flood is not in the answer)",
  );
  ok(
    buried.scanTruncated === undefined && buried.capped === false,
    "audit actions=<csv> claims no truncation when the flood is of an action nobody asked for",
  );
  for (let i = 0; i < 1000; i++) {
    await appendAudit({ org: "acme", platform: "github", workspace: "ws1", action: "github.dispatched", detail: { i } });
  }
  const truncated = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,github.dispatched&limit=5`, SECRET)).json()) as {
    capped: boolean;
    scanTruncated?: boolean;
    scanned?: number;
    entries: unknown[];
  };
  ok(truncated.scanTruncated === true, "audit actions=<csv> reports scanTruncated:true when ONE named action fills its own page");
  ok(truncated.capped === true, "audit actions=<csv> over a TRUNCATED scan reports capped:true");
  ok(
    truncated.scanned !== undefined && truncated.scanned >= 1000,
    "audit actions=<csv> names how many rows the per-action scans actually read",
  );
  const squeezed = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,github.dispatched&limit=5`, SECRET)).json()) as {
    entries: { action: string }[];
    capped: boolean;
  };
  ok(
    squeezed.entries.length === 5 && squeezed.entries.every((e) => e.action === "github.dispatched"),
    "a multi-action answer capped by `limit` can hold NONE of a rare action's rows — the scan found them, the cut dropped them",
  );
  ok(squeezed.capped === true, "🔴 …and it says so through `capped`, which is the ONLY flag set in that case");

  const repeated = (await (await getAudit(`${sinceQ}&actions=notion.no_reply,notion.no_reply`, SECRET)).json()) as {
    entries: { ts: string; action: string }[];
  };
  const once = (await (await getAudit(`${sinceQ}&actions=notion.no_reply`, SECRET)).json()) as { entries: { ts: string }[] };
  ok(
    repeated.entries.length === once.entries.length,
    `audit actions=<csv> de-duplicates a repeated action — got ${repeated.entries.length} rows for the repeat against ${once.entries.length} for one`,
  );

  const tooMany = Array.from({ length: 26 }, (_, i) => `ope1933.fanout_${i}`).join(",");
  const refused = await getAudit(`${sinceQ}&actions=${tooMany}`, SECRET);
  ok(refused.status === 400, "audit refuses a CSV naming more distinct actions than it will scan in one request");
  ok((await refused.text()).includes("26"), "…and the refusal names how many it was asked for, so the caller can narrow");
  const atCeiling = await getAudit(`${sinceQ}&actions=${Array.from({ length: 25 }, (_, i) => `ope1933.fanout_${i}`).join(",")}`, SECRET);
  ok(atCeiling.status === 200, "audit ACCEPTS a CSV naming exactly the ceiling (negative control for the bound)");

  const single = (await (await getAudit(`${sinceQ}&actions=notion.no_reply&limit=5`, SECRET)).json()) as {
    entries: { action: string }[];
    scanTruncated?: boolean;
  };
  ok(
    single.scanTruncated === undefined && single.entries.length > 0 && single.entries.every((e) => e.action === "notion.no_reply"),
    "audit actions=<one> still narrows at the store and finds its rows behind 2000 newer ones",
  );

  const legSince = new Date(Date.now() - 1_800_000).toISOString();
  const legUntil = new Date(Date.now() - 1_700_000).toISOString();
  await appendAudit({ org: "acme", platform: "control", workspace: "ws1", ts: new Date(Date.now() - 1_750_000).toISOString(), action: "oe1886.in_window", detail: { wakeId: "inside" } });
  await appendAudit({ org: "acme", platform: "control", workspace: "ws1", ts: new Date(Date.now() - 1_600_000).toISOString(), action: "oe1886.after_window", detail: { wakeId: "nextLeg" } });
  const markers = "actions=oe1886.in_window,oe1886.after_window";

  ok((await getAudit(`${sinceQ}&until=not-a-date`, SECRET)).status === 400, "audit: unparseable until → 400");
  ok(
    (await getAudit(`?since=${encodeURIComponent(legUntil)}&until=${encodeURIComponent(legSince)}`, SECRET)).status === 400,
    "audit: until BEFORE since → 400 (an inverted window would answer empty and read as 'nothing happened')",
  );

  await appendAudit({
    org: "acme",
    platform: "github",
    workspace: "ws1",
    ts: new Date(Date.now() - 1_750_000).toISOString(),
    action: "github.dispatched",
    detail: { wakeId: "inside" },
  });
  const floodedMarkers = "actions=github.dispatched,oe1886.after_window";
  const unbounded = (await (await getAudit(`?since=${encodeURIComponent(legSince)}&${floodedMarkers}`, SECRET)).json()) as {
    entries: { action: string; detail?: { wakeId?: string } }[];
    scanTruncated?: boolean;
  };
  ok(
    unbounded.entries.every((e) => e.detail?.wakeId !== "inside") && unbounded.scanTruncated === true,
    "audit since-only over an action's OWN full page cannot reach a CLOSED window's row (the live-run shape) and reports the truncation",
  );
  const boundedFlooded = (await (
    await getAudit(`?since=${encodeURIComponent(legSince)}&until=${encodeURIComponent(legUntil)}&${floodedMarkers}`, SECRET)
  ).json()) as { entries: { detail?: { wakeId?: string } }[]; scanTruncated?: boolean };
  ok(
    boundedFlooded.entries.some((e) => e.detail?.wakeId === "inside") && boundedFlooded.scanTruncated === undefined,
    "audit since+until reaches the flooded action's closed-window row however many newer rows exist",
  );
  const boundedBody = (await (await getAudit(`?since=${encodeURIComponent(legSince)}&until=${encodeURIComponent(legUntil)}&${markers}`, SECRET)).json()) as {
    entries: { action: string; detail?: { wakeId?: string } }[];
    scanTruncated?: boolean;
  };
  ok(boundedBody.entries.length === 1, "audit since+until returns the closed window's rows however many newer rows exist");
  ok(boundedBody.entries[0].action === "oe1886.in_window", "audit until EXCLUDES a row written after the window closed");
  ok(boundedBody.scanTruncated === undefined, "a bounded window's scan is not truncated — the window IS the page");
  const inclusive = (await (
    await getAudit(`?since=${encodeURIComponent(legSince)}&until=${encodeURIComponent(new Date(Date.now() - 1_750_000).toISOString())}&${markers}`, SECRET)
  ).json()) as { entries: unknown[] };
  ok(inclusive.entries.length === 1, "audit until is INCLUSIVE — a row stamped exactly on the bound is inside the window");

  const offsetUntil = new Date(Date.parse(legSince) + 3_600_000).toISOString().replace("Z", "+01:00");
  const offsetBody = (await (await getAudit(`?since=${encodeURIComponent(legSince)}&until=${encodeURIComponent(offsetUntil)}&${markers}`, SECRET)).json()) as {
    entries: { action: string }[];
  };
  ok(
    offsetBody.entries.length === 0,
    "audit normalises an OFFSET-form until to UTC before the text compare — a +01:00 bound does not silently widen the window by an hour",
  );
  const secondTs = "2026-05-11T11:31:00.500Z";
  await appendAudit({ org: "acme", platform: "control", workspace: "ws1", ts: secondTs, action: "oe1886.second_precision", detail: {} });
  const secondBody = (await (
    await getAudit(`?since=${encodeURIComponent("2026-05-11T11:31:00Z")}&until=${encodeURIComponent("2026-05-11T11:32:00Z")}&actions=oe1886.second_precision`, SECRET)
  ).json()) as { entries: { action: string }[] };
  ok(
    secondBody.entries.length === 1,
    "audit normalises a SECOND-PRECISION since — a row at .500 inside that second is inside the window, not behind the bound",
  );

  const capNamed = (await (await getAudit(`${sinceQ}&limit=1`, SECRET)).json()) as { capped: boolean; maxLimit?: number };
  ok(capNamed.capped === true && capNamed.maxLimit === AUDIT_MAX_LIMIT, "audit reports its row ceiling as maxLimit beside capped (single-action arm)");
  const capNamedMulti = (await (await getAudit(`${sinceQ}&${markers}`, SECRET)).json()) as { maxLimit?: number };
  ok(capNamedMulti.maxLimit === AUDIT_MAX_LIMIT, "audit reports maxLimit on the multi-action arm too");

  const ordered = (await (await getAudit(`${sinceQ}&limit=50`, SECRET)).json()) as { entries: { ts: string }[] };
  ok(ordered.entries.length > 1, "ordering check has rows to order");
  ok(
    ordered.entries.every((e, i) => i === 0 || ordered.entries[i - 1].ts >= e.ts),
    "audit still serves rows NEWEST-first (ordering contract — the until bound narrows, it never reorders)",
  );
  const boundedSvc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(
    boundedSvc.some((e) => (e.detail as { until?: string }).until === legUntil),
    "a bounded audit read is self-audited with the until bound it used",
  );
}

{
  type FixtureEvent = { type: string; data: unknown; scope?: { turnId?: string; runId?: string }; meta: { at: string; position: { line: number; index: number }; endOfLine: boolean } };
  let lastSignal: AbortSignal | undefined;
  const makeStream = (events: readonly FixtureEvent[], park: boolean, startIndex: number, signal: AbortSignal | undefined, failFirst = false): AsyncIterable<unknown> => {
    lastSignal = signal;
    return (async function* () {
      if (failFirst) throw new Error("no such session");
      for (const e of events) if (e.meta.position.line >= startIndex) yield e;
      if (park) {
        await new Promise<void>((resolve) => {
          if (signal === undefined) return;
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    })();
  };
  const lineOf = (line: number, ...events: [string, unknown][]): FixtureEvent[] =>
    events.map(([type, data], index) => ({
      type,
      data,
      meta: { at: "2026-03-07T16:10:00.000Z", position: { line, index }, endOfLine: index === events.length - 1 },
    }));
  const completedEvents = [
    ...lineOf(0, ["session.started", {}]),
    ...lineOf(1, ["delivery.admitted", { deliveryId: "d1" }], ["turn.started", { turnId: "t1" }], ["delivery.consumed", { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: "hi" }] }]),
    ...lineOf(2, ["content.completed", { partId: "p1", kind: "reasoning", value: "thinking about it", phase: "narration" }]),
    ...lineOf(3, ["call.requested", { callId: "c1", owner: { turnId: "t1" }, capability: { kind: "tool", name: "memory_read" }, input: {} }]),
    ...lineOf(4, ["call.settled", { callId: "c1", outcome: "completed", output: "recalled X" }]),
    ...lineOf(
      5,
      ["content.completed", { partId: "p2", kind: "text", value: "the answer", phase: "reply" }],
      ["model.settled", { runId: "r1", outcome: "completed", finishReason: "stop", generationId: "gen_1" }],
      ["usage.recorded", { kind: "model", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } }],
    ),
    ...lineOf(6, ["turn.settled", { turnId: "t1", outcome: "completed" }], ["delivery.settled", { deliveryId: "d1", outcome: "handled" }], ["session.ended", { outcome: "completed" }]),
  ];
  const COMPLETED_LINES = 7;
  const parkedEvents = [
    ...lineOf(0, ["session.started", {}]),
    ...lineOf(1, ["turn.started", { turnId: "t1" }], ["delivery.consumed", { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: "parked" }] }]),
  ];
  const partialEvents = [...parkedEvents, { ...lineOf(2, ["call.requested", {}], ["call.started", {}])[0]! }];
  let lastStartIndex = -1;
  let lastFollow: boolean | undefined;
  let probeCalls = 0;
  const tailFor = (id: string): number => (id === "wrun_parked" ? parkedEvents.length - 1 : completedEvents.length - 1);
  const getSession = ((id: string) => ({
    getStreamTailIndex: async () => {
      probeCalls += 1;
      if (id === "wrun_missing") throw new Error("no such session");
      if (id === "wrun_gone" || id.includes("oe-sup:g")) return -1;
      return tailFor(id);
    },
    stream: (o?: { startIndex?: number; follow?: boolean; signal?: AbortSignal }) => {
      lastStartIndex = o?.startIndex ?? 0;
      lastFollow = o?.follow;
      if (id === "wrun_tail") return makeStream(parkedEvents, false, lastStartIndex, o?.signal);
      if (id === "wrun_scoped") return makeStream([{ ...lineOf(0, ["model.settled", { runId: "r1", outcome: "completed" }])[0]!, scope: { turnId: "t1", runId: "r1" } } as FixtureEvent], false, 0, o?.signal);
      if (id === "wrun_missing") return makeStream([], false, 0, o?.signal, true);
      if (id === "wrun_gone" || id.includes("oe-sup:g")) return makeStream([], true, 0, o?.signal);
      if (id === "wrun_parked") return makeStream(parkedEvents, true, lastStartIndex, o?.signal);
      if (id === "wrun_partial") return makeStream(partialEvents, true, lastStartIndex, o?.signal);
      return makeStream(completedEvents, false, lastStartIndex, o?.signal);
    },
  })) as unknown as Parameters<typeof handleSessionTranscriptRead>[1];
  const getSessionNoProbe = ((id: string) => ({
    stream: (o?: { startIndex?: number; signal?: AbortSignal }) => {
      lastStartIndex = o?.startIndex ?? 0;
      if (id === "wrun_gone") return makeStream([], true, 0, o?.signal);
      return makeStream(completedEvents, false, lastStartIndex, o?.signal);
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
  ok(body.complete === true && body.nextIndex === COMPLETED_LINES, "transcript: a terminal session.ended sets complete:true, and nextIndex counts stored LINES, not events");
  ok(body.events[0]!.type === "session.started" && body.events[0]!.index === 0, "transcript: events keep stream order + carry their 0-based line");
  ok(
    body.events.every((e, i) => e.index === completedEvents[i]!.meta.position.line),
    "transcript: each event's index is its stored line, so the events of one line share it",
  );
  ok(body.events[0]!.at === "2026-03-07T16:10:00.000Z", "transcript: each event hoists its meta.at timestamp");
  const callSettled = body.events.find((e) => e.type === "call.settled");
  ok((callSettled?.data as { outcome?: string } | undefined)?.outcome === "completed", "transcript: tool-result data (outcome/output) is preserved unmodified");
  const usage = body.events.find((e) => e.type === "usage.recorded");
  const scoped = (await (await getTranscript("wrun_scoped", "", SECRET)).json()) as { events: { type: string; scope?: { turnId?: string; runId?: string } }[] };
  ok(scoped.events[0]?.scope?.turnId === "t1" && scoped.events[0]?.scope?.runId === "r1", "🔴 transcript: each event keeps eve's scope (its turn and run) — on v27 most events name their turn only there");
  ok(body.events.every((e) => !("scope" in e)), "…and an event with no scope gets no scope key");
  ok((usage?.data as { usage?: { costUsd?: number } } | undefined)?.usage?.costUsd === 0.01, "transcript: usage.recorded data is preserved");

  const capped = (await (await getTranscript("wrun_done", "?limit=2", SECRET)).json()) as { count: number; complete: boolean; nextIndex: number; events: { index: number }[] };
  ok(
    capped.count === 4 && capped.complete === false && capped.nextIndex === 2 && capped.events.every((e) => e.index < 2),
    "transcript: ?limit stops at a LINE boundary — a page never splits a stored line (complete:false, nextIndex=next line)",
  );

  const paged = (await (await getTranscript("wrun_done", "?startIndex=5", SECRET)).json()) as { startIndex: number; nextIndex: number; count: number; complete: boolean };
  ok(
    lastStartIndex === 5 && paged.startIndex === 5 && paged.count === 6 && paged.nextIndex === COMPLETED_LINES && paged.complete === true,
    "transcript: ?startIndex is a line position, passed to session.stream, and drives nextIndex",
  );

  const parked = (await (await getTranscript("wrun_parked", "?idleMs=50", SECRET)).json()) as { count: number; complete: boolean; nextIndex: number };
  ok(parked.count === parkedEvents.length && parked.complete === false && parked.nextIndex === 2, "transcript: a parked session returns recorded events with complete:false (idle-stop, no hang)");
  ok(lastFollow === false, "transcript: the route reads recorded history (follow:false), so a stranded session's history still reads instead of throwing");
  const tail = (await (await getTranscript("wrun_tail", "", SECRET)).json()) as { count: number; complete: boolean; nextIndex: number };
  ok(
    tail.count === parkedEvents.length && tail.complete === false && tail.nextIndex === 2,
    "🔴 transcript: a stream that ends at the durable tail with no session.ended is NOT complete — only session.ended ends a run",
  );
  ok(lastSignal?.aborted === true, "transcript: the drain aborts the stream's signal when it stops, so a pending read is released");

  const partial = (await (await getTranscript("wrun_partial", "?idleMs=50", SECRET)).json()) as { count: number; nextIndex: number; events: { type: string }[] };
  ok(
    partial.count === parkedEvents.length && partial.nextIndex === 2 && !partial.events.some((e) => e.type === "call.requested"),
    "transcript: a line read only in part is not committed — the next page reads it again whole",
  );

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
  const prevCredentialKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  const VALID_KEY = createHash("sha256").update("control-read-test-key").digest("base64");
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
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  {
    const res = await getSignal(SECRET);
    ok(res.status === 200, "runtime-signal: good token → 200");
    ok((res.headers.get("content-type") ?? "").includes("application/json"), "runtime-signal 200 is JSON");
    const body = (await res.json()) as { hasDeploymentId: boolean; credentialBrokerArmed: boolean };
    ok(body.hasDeploymentId === false, "runtime-signal: an EMPTY VERCEL_DEPLOYMENT_ID reports hasDeploymentId: false — the incident this route exists to catch");
    ok(
      body.credentialBrokerArmed === false,
      "runtime-signal: an ABSENT OE_CREDENTIAL_ENCRYPTION_KEY reports credentialBrokerArmed: false — the OPE-641 incident this field exists to catch",
    );
  }

  process.env.VERCEL_DEPLOYMENT_ID = "   ";
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = "not-valid-base64-32-bytes";
  {
    const body = (await (await getSignal(SECRET)).json()) as { hasDeploymentId: boolean; credentialBrokerArmed: boolean };
    ok(body.hasDeploymentId === false, "runtime-signal: a whitespace-only VERCEL_DEPLOYMENT_ID also reports false (trimmed, not just falsy-checked)");
    ok(body.credentialBrokerArmed === false, "runtime-signal: a malformed (wrong-length) key also reports credentialBrokerArmed: false");
  }

  process.env.VERCEL_DEPLOYMENT_ID = "dpl_test_only_never_a_real_id";
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = VALID_KEY;
  {
    const res = await getSignal(SECRET);
    const raw = await res.text();
    const body = JSON.parse(raw) as { hasDeploymentId: boolean; credentialBrokerArmed: boolean };
    ok(body.hasDeploymentId === true, "runtime-signal: a non-empty VERCEL_DEPLOYMENT_ID reports hasDeploymentId: true — the positive control");
    ok(body.credentialBrokerArmed === true, "runtime-signal: a well-formed 32-byte base64 key reports credentialBrokerArmed: true — the positive control");
    ok(!raw.includes("dpl_test_only_never_a_real_id"), "🔴 PRESENCE, NEVER VALUE — the raw deployment id never leaves the response body");
    ok(!raw.includes(VALID_KEY), "🔴 PRESENCE, NEVER VALUE — the raw key material never leaves the response body");
    ok(Object.keys(body).length === 2, "the body carries exactly two fields — nothing else about the runtime rides along");
  }

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  const runtimeSignalRows = svc.filter((e) => (e.detail as { view?: string }).view === "runtime_signal");
  ok(runtimeSignalRows.length > 0, "runtime-signal: authenticated read is self-audited as control.service_call view=runtime_signal");
  ok(
    runtimeSignalRows.some((e) => (e.detail as { credentialBrokerArmed?: boolean }).credentialBrokerArmed === true),
    "runtime-signal: the audit row carries credentialBrokerArmed alongside hasDeploymentId (OPE-641)",
  );

  if (prevDeploymentId === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
  else process.env.VERCEL_DEPLOYMENT_ID = prevDeploymentId;
  if (prevCredentialKey === undefined) delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.OE_CREDENTIAL_ENCRYPTION_KEY = prevCredentialKey;
}

{
  const channel = (await import("../agent/channels/control-read.js")).default as unknown as {
    routes: { method: string; path: string }[];
  };
  ok(
    channel.routes.length === 8 && channel.routes.every((r) => r.method === "GET"),
    "the channel mounts exactly eight GET routes (usage + tool-usage + audit + unified-audit + transcript + runtime-signal + model-calls + model-call-sessions)",
  );
  ok(channel.routes.some((r) => r.path === CONTROL_READ_USAGE_PATH), "…one at /control/v1/usage");
  ok(channel.routes.some((r) => r.path === "/control/v1/tool-usage"), "…one at /control/v1/tool-usage (OPE-2435)");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_AUDIT_PATH), "…one at /control/v1/audit");
  ok(channel.routes.some((r) => r.path === "/control/v1/unified-audit"), "…one at /control/v1/unified-audit");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_TRANSCRIPT_PATH), "…one at /control/v1/session/:sessionId/transcript");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_RUNTIME_SIGNAL_PATH), "…one at /control/v1/runtime-signal (OPE-658)");
  ok(channel.routes.some((r) => r.path === "/control/v1/session/:sessionId/model-calls"), "…one at /control/v1/session/:sessionId/model-calls (OPE-846 capture harvest)");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_MODEL_CALL_SESSIONS_PATH), "…one at /control/v1/model-calls/sessions (OPE-857 capture retention listing)");

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

_resetModelPricingForTest();

await removeTempDir(dir);
console.log(`✓ control-read route: ${passed} assertions passed (fail-closed 404 / 401 / 400 / priced 200 / runtime-signal presence-never-value / audited / structurally read-only)`);

// proves: CTRL-usage_window, ROUTE-audit, ROUTE-model-call-sessions, ROUTE-model-calls
// proves: ROUTE-read-token-gate, ROUTE-runtime-signal, ROUTE-transcript, ROUTE-usage
