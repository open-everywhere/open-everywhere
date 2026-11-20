import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-tool-usage-"));
delete process.env.DATABASE_URL;
delete process.env.OE_CONTROL_READ_TOKENS;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "tools.sqlite3");

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
const { registerConfig } = await import("../agent/access/config.js");
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });

const { sqliteOperationalStore: store } = await import("../agent/operational/sqlite.js");
const toolUsageHook = (await import("../agent/hooks/tool-usage.js")).default;
const { recordToolCard, toolUsageNames, toolUsageOutcome, _resetToolUsageBufferForTest } = await import("../agent/spend/tool-usage.js");
const { toolUsageView } = await import("../agent/control/views.js");
const { handleToolUsageRead, CONTROL_READ_TOOL_USAGE_PATH } = await import("../agent/control/read-route.js");
const { stampModelCall } = await import("../agent/model/model-stamp.js");
const { builtInModelIds, modelPricing } = await import("../agent/spend/pricing.js");
const { rowCostUsd, resolveAssumedModel } = await import("../agent/spend/reporting.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { createRequire } = await import("node:module");
const { dirname, join: pathJoin } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = await import(pathToFileURL(pathJoin(eveRoot, "dist/src/context/container.js")).href);

const MODEL = builtInModelIds()[0]!;
const { callViewWith, callSettled, usageEvent } = await import("./_hook-view.js");
const view1 = callViewWith(
  [usageEvent("t1", "r0", { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 200 })],
  { callId: "cx:1", name: "linear__create_issue", turnId: "t1", runId: "r0", outcome: "completed" },
  { callId: "cx", name: "connection_execute", turnId: "t1", runId: "r0", outcome: "completed" },
  { callId: "c-bash-0", name: "bash", turnId: "t1", runId: "r0", outcome: "failed" },
  { callId: "x", name: "w", kind: "agent", turnId: "t1", runId: "r0", outcome: "completed" },
  { callId: "c-linear__delete_issue-1", name: "linear__delete_issue", turnId: "t1", runId: "r1", outcome: "rejected" },
);
const view2 = callViewWith([usageEvent("t2", "r0", { inputTokens: 10, outputTokens: 4 })], { callId: "cy", name: "connection_execute", turnId: "t2", runId: "r0", outcome: "failed" });
const view3 = callViewWith(
  [],
  { callId: "cz-int", name: "linear__create_issue", turnId: "t3", runId: "r0", outcome: "interrupted" },
  { callId: "cz-ctl", name: "eve__task_wait", kind: "control", turnId: "t3", runId: "r0", outcome: "completed" },
);
const ctx = (sessionId: string) => ({
  channel: { kind: "slack" },
  view: sessionId === "sess-3" ? view3 : sessionId === "sess-2" ? view2 : view1,
  session: { id: sessionId, auth: { current: { attributes: { team_id: "T1", channel_id: "C_TOOLS", channel_type: "channel" }, principalId: "U1", principalType: "slack-user" } } },
});
const fire = (event: string, payload: unknown, sessionId: string) => toolUsageHook.events![event as "call.settled"]!(payload as never, ctx(sessionId) as never);
const run = (turnId: string, runId: string) => ({ type: "model.requested", data: { runId, owner: { turnId } }, scope: { turnId, runId } });

ok(toolUsageNames("linear__create_issue").connector === "linear" && toolUsageNames("linear__create_issue").tool === "create_issue", "a connector op splits into (connector, op)");
ok(toolUsageNames("bash").connector === "" && toolUsageNames("bash").tool === "bash", "an authored tool keeps its name, with no connector");
ok(toolUsageOutcome("completed", undefined) === "ok" && toolUsageOutcome("completed", true) === "error" && toolUsageOutcome("failed", undefined) === "error" && toolUsageOutcome("rejected", undefined) === "rejected", "the outcome vocabulary");

_resetToolUsageBufferForTest();
await contextStorage.run(new ContextContainer(), async () => {
  stampModelCall(MODEL);
  await fire("model.requested", run("t1", "r0"), "sess-1");
  await fire("call.settled", callSettled("cx:1", "completed", "t1"), "sess-1");
  await fire("call.settled", callSettled("cx", "completed", "t1"), "sess-1");
  await fire("call.settled", callSettled("c-bash-0", "failed", "t1"), "sess-1");
  await fire("call.settled", callSettled("x", "completed", "t1"), "sess-1");
  await fire("model.requested", run("t1", "r1"), "sess-1");
  await fire("call.settled", callSettled("c-linear__delete_issue-1", "rejected", "t1"), "sess-1");
  await fire("turn.settled", { type: "turn.settled", data: { turnId: "t1", outcome: "completed" }, scope: { turnId: "t1" } }, "sess-1");
  await fire("model.requested", run("t2", "r0"), "sess-2");
  await fire("call.settled", callSettled("cy", "failed", "t2"), "sess-2");
  await fire("turn.settled", { type: "turn.settled", data: { turnId: "t2", outcome: "completed" }, scope: { turnId: "t2" } }, "sess-2");
  await fire("model.requested", run("t3", "r0"), "sess-3");
  await fire("call.settled", callSettled("cz-int", "interrupted", "t3"), "sess-3");
  await fire("call.settled", callSettled("cz-ctl", "completed", "t3"), "sess-3");
  await fire("turn.settled", { type: "turn.settled", data: { turnId: "t3", outcome: "cancelled" }, scope: { turnId: "t3" } }, "sess-3");
});
{
  const third = (await store.runAnalyticsQuery({ table: "tool_usage", select: [{ expr: "tool", alias: "tool" }, { expr: "connector", alias: "connector" }], groupBy: [], where: ["session_id = ?"], params: ["sess-3"], orderBy: null, limit: 10 })) as Record<string, unknown>[];
  ok(third.length === 1 && third[0]!.tool === "eve__task_wait", `a call the cancel closed before it ran writes no row, and a control call still counts (got ${JSON.stringify(third)})`);
  ok(third[0]!.connector === "", "…and eve's own `eve__` control tool is no connector op, so it lands with no connector");
}
const raw = (await store.runAnalyticsQuery({
  table: "tool_usage",
  select: [
    { expr: "tool", alias: "tool" },
    { expr: "connector", alias: "connector" },
    { expr: "outcome", alias: "outcome" },
    { expr: "event", alias: "event" },
    { expr: "model", alias: "model" },
    { expr: "input_tokens", alias: "input_tokens" },
    { expr: "output_tokens", alias: "output_tokens" },
    { expr: "session_id", alias: "session_id" },
    { expr: "surface_key", alias: "surface_key" },
  ],
  groupBy: [],
  where: ["org_id = ?", "session_id = ?"],
  params: ["default", "sess-1"],
  orderBy: null,
  limit: 100,
})) as Record<string, unknown>[];
ok(raw.length === 3, `three call rows: two from step 0 and one flushed at the turn's end (got ${raw.length}: ${JSON.stringify(raw)})`);
ok(!raw.some((r) => r.tool === "connection_execute"), "ONE CALL, ONE ROW: the connection_execute wrapper of a nested op result writes no row of its own");
const lone = (await store.runAnalyticsQuery({ table: "tool_usage", select: [{ expr: "tool", alias: "tool" }, { expr: "outcome", alias: "outcome" }], groupBy: [], where: ["session_id = ?"], params: ["sess-2"], orderBy: null, limit: 10 })) as Record<string, unknown>[];
ok(lone.length === 1 && lone[0]!.tool === "connection_execute" && lone[0]!.outcome === "error", "a wrapper with no nested result still counts, as itself");
const linear = raw.find((r) => r.tool === "create_issue")!;
const bash = raw.find((r) => r.tool === "bash")!;
const refused = raw.find((r) => r.tool === "delete_issue")!;
ok(linear.connector === "linear" && linear.outcome === "ok" && linear.event === "call", "the connector op lands under its connector, outcome ok");
ok(bash.connector === "" && bash.outcome === "error", "the failed authored tool lands with outcome error");
ok(Number(linear.input_tokens) === 500 && Number(linear.output_tokens) === 200 && Number(bash.input_tokens) === 500, "each call carries an EVEN share of its step's tokens");
ok(linear.model === MODEL, "each call carries the stamped model");
ok(refused.outcome === "rejected" && Number(refused.input_tokens) === 0 && refused.model === null, "a call flushed at the turn's end carries no share and no model");
ok(linear.session_id === "sess-1" && linear.surface_key === "slack/T1/C_TOOLS", "the row names its session and the spend-grain surface key");

await recordToolCard({ org: "default", kind: "op.connector", args: { tool: "linear__create_issue", connection: "linear" }, surfaceKey: "slack/T1/C_TOOLS", principalId: "U1" });
await recordToolCard({ org: "default", kind: "pr.open", args: { repo: "a/b" }, surfaceKey: "slack/T1/C_TOOLS", principalId: "U1" });

await store.appendToolUsage({ org: "default", ts: "2020-01-01T00:00:00.000Z", surfaceKey: "slack/T1/C_TOOLS", sessionId: "old", event: "call", tool: "create_issue", connector: "linear", outcome: "ok", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
const since = new Date(Date.now() - 3_600_000).toISOString();
const view = await toolUsageView({ org: "default", sinceIso: since });
const vLinear = view.rows.find((r) => r.connector === "linear" && r.tool === "create_issue");
const vBash = view.rows.find((r) => r.connector === "" && r.tool === "bash");
const vPr = view.rows.find((r) => r.connector === "" && r.tool === "pr.open");
ok(vLinear?.calls === 1 && vLinear.errors === 0 && vLinear.cards === 1, `VIEW: linear/create_issue — 1 call, 0 errors, 1 card; the old row is outside the window (got ${JSON.stringify(vLinear)})`);
ok(vBash?.calls === 1 && vBash.errors === 1, "VIEW: bash — 1 call, 1 error");
ok(vPr?.cards === 1 && vPr.calls === 0, "VIEW: a non-connector card counts under its approval kind");
ok(view.rows.find((r) => r.tool === "delete_issue")?.rejected === 1, "VIEW: the refused call counts as rejected");
const expectedShareUsd = rowCostUsd({ inputTokens: 500, outputTokens: 200, cacheReadTokens: 100, model: MODEL }, resolveAssumedModel(), "one-call")!;
ok(modelPricing(MODEL) !== undefined && typeof vLinear?.estUsd === "number" && Math.abs(vLinear.estUsd - expectedShareUsd) < 1e-9, `VIEW: est_usd prices the attributed share at the stamped model (got ${vLinear?.estUsd}, want ${expectedShareUsd})`);
ok(view.totals.calls === 5 && view.totals.cards === 2 && view.totals.errors === 2, "VIEW: the totals add up (four calls from the first two sessions, one control call from the third)");
ok(view.note.includes("ATTRIBUTED"), "VIEW: the note says the spend is attributed");
const byConnector = await toolUsageView({ org: "default", sinceIso: since, by: "connector" });
const cLinear = byConnector.rows.find((r) => r.connector === "linear");
ok(cLinear?.calls === 2 && cLinear.cards === 1 && cLinear.rejected === 1 && cLinear.tool === undefined, "VIEW by connector: linear folds its two ops into one row");

const SECRET = "tool-usage-test-token";
const get = (query: string, token?: string) =>
  handleToolUsageRead(new Request(`https://oe.example${CONTROL_READ_TOOL_USAGE_PATH}${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
const q = `?since=${encodeURIComponent(since)}`;
ok((await get(q, SECRET)).status === 404, "ROUTE: no read token configured ⇒ 404 (the route does not exist)");
process.env.OE_CONTROL_READ_TOKENS = `ops:${createHash("sha256").update(SECRET, "utf-8").digest("hex")}`;
ok((await get(q, "wrong")).status === 401, "ROUTE: a bad bearer ⇒ 401");
ok((await get("", SECRET)).status === 400, "ROUTE: no since ⇒ 400");
ok((await get(`${q}&by=model`, SECRET)).status === 400, "ROUTE: an unknown by ⇒ 400");
ok((await get(`${q}&domain=no-such-domain`, SECRET)).status === 400, "ROUTE: an unknown domain ⇒ 400, never a 200 that reads as no usage");
const res = await get(`${q}&by=connector`, SECRET);
const body = (await res.json()) as { rows: { connector: string; calls: number }[]; by: string };
ok(res.status === 200 && body.by === "connector" && body.rows.some((r) => r.connector === "linear" && r.calls === 2), "ROUTE: 200 with the view's body");
const audit = await store.readAudit({ org: "default", action: "control.service_call" });
ok(audit.some((r) => (r.detail as { view?: string } | undefined)?.view === "tool_usage"), "ROUTE: the call leaves a control.service_call audit row");
delete process.env.OE_CONTROL_READ_TOKENS;

console.log(`✓ tool-usage: ${passed} assertions passed`);
