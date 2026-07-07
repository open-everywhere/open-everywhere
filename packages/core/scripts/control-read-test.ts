
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

const { handleUsageWindowRead, CONTROL_READ_USAGE_PATH } = await import("../agent/control/read-route.js");
const { appendUsageEvent } = await import("../agent/spend/usage-events.js");
const { readAudit } = await import("../agent/audit/audit.js");
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
  const entries = await readAudit({ org: "acme", action: "control.service_call", principalId: "svc:e2e-harness" });
  ok(entries.length > 0, "authenticated read is audited as control.service_call under svc:<name>");
  const detail = entries[0].detail as { view?: string; workspaces?: string };
  ok(detail.view === "usage_window" && detail.workspaces === "slack/T1", "audit detail names the view + workspace filter");
}

{
  const channel = (await import("../agent/channels/control-read.js")).default as unknown as {
    routes: { method: string; path: string }[];
  };
  ok(channel.routes.length === 1 && channel.routes[0].method === "GET", "the channel mounts exactly one GET route");
  ok(channel.routes[0].path === CONTROL_READ_USAGE_PATH, "…at /control/v1/usage");

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
