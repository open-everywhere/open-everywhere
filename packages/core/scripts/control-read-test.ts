
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

const { handleUsageWindowRead, handleAuditWindowRead, CONTROL_READ_USAGE_PATH, CONTROL_READ_AUDIT_PATH } = await import("../agent/control/read-route.js");
const { appendUsageEvent } = await import("../agent/spend/usage-events.js");
const { readAudit, appendAudit } = await import("../agent/audit/audit.js");
const { _resetPricingCacheForTest } = await import("../agent/spend/pricing.js");
_resetPricingCacheForTest();

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

  const gh = (await (await getAudit(`${sinceQ}&platform=github`, SECRET)).json()) as { entries: { platform: string }[] };
  ok(gh.entries.length > 0 && gh.entries.every((e) => e.platform === "github"), "audit platform=github narrows to the github surface");
  const capped = (await (await getAudit(`${sinceQ}&limit=1`, SECRET)).json()) as { entries: unknown[]; capped: boolean };
  ok(capped.entries.length === 1 && capped.capped === true, "audit limit=1 caps the result and reports capped:true");

  const svc = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(svc.some((e) => (e.detail as { view?: string }).view === "audit"), "audit read is self-audited as control.service_call view=audit");
}

{
  const channel = (await import("../agent/channels/control-read.js")).default as unknown as {
    routes: { method: string; path: string }[];
  };
  ok(channel.routes.length === 2 && channel.routes.every((r) => r.method === "GET"), "the channel mounts exactly two GET routes (usage + audit)");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_USAGE_PATH), "…one at /control/v1/usage");
  ok(channel.routes.some((r) => r.path === CONTROL_READ_AUDIT_PATH), "…one at /control/v1/audit");

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
console.log(`✓ control-read route: ${passed} assertions passed (fail-closed 404 / 401 / 400 / priced 200 / audited / structurally read-only)`);
