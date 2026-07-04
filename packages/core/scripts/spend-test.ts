import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { periodOf, emptyWindow, addUsage, windowTokens, checkCap } from "../agent/spend/spend.js";
import { isSpendLimitActive, activeSpendLimits, applyCapOverrides } from "../agent/spend/caps.js";
import type { SpendLimitRow } from "../agent/operational/store.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(periodOf("2026-06-24T09:30:00Z") === "2026-06", "periodOf -> YYYY-MM");
let w = emptyWindow();
w = addUsage(w, { inputTokens: 100, outputTokens: 50 });
w = addUsage(w, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 999 });
ok(w.calls === 2 && w.inputTokens === 110 && w.outputTokens === 55, "addUsage accumulates input/output + call count");
ok(windowTokens(w) === 165, "windowTokens = input + output");
ok(windowTokens(undefined) === 0, "windowTokens defensive on missing window");

const caps = { surfaceMonthlyTokens: 1000, workspaceMonthlyTokens: 5000 };
ok(!checkCap({ mode: "channel", surfaceTokens: 999, workspaceTokens: 100, caps }).over, "under surface cap -> not over");
ok(checkCap({ mode: "channel", surfaceTokens: 1000, workspaceTokens: 100, caps }).over, "at surface cap -> over");
ok(checkCap({ mode: "channel", surfaceTokens: 0, workspaceTokens: 5000, caps }).over, "workspace cap breached -> over");
ok(!checkCap({ mode: "dm", surfaceTokens: 99999, workspaceTokens: 99999, caps }).over, "DM is exempt from caps");
ok(!checkCap({ mode: "channel", surfaceTokens: 99999, workspaceTokens: 99999, caps: {} }).over, "no caps configured -> never over");
const reason = checkCap({ mode: "channel", surfaceTokens: 1200, workspaceTokens: 0, caps }).reason;
ok(typeof reason === "string" && reason.includes("channel"), "over-cap verdict carries a human reason");

const NOW = 1_000_000;
ok(isSpendLimitActive({ org: "o", scopeKey: "p/w", level: "workspace", monthlyTokens: 1 }, NOW), "no expiresAt → always active");
ok(isSpendLimitActive({ org: "o", scopeKey: "p/w", level: "workspace", monthlyTokens: 1, expiresAt: NOW + 1 }, NOW), "future expiry → active");
ok(!isSpendLimitActive({ org: "o", scopeKey: "p/w", level: "workspace", monthlyTokens: 1, expiresAt: NOW }, NOW), "expiry at now → expired");
const expired: SpendLimitRow = { org: "o", scopeKey: "p/w/s", level: "surface", monthlyTokens: 9, expiresAt: NOW - 1 };
const sticky: SpendLimitRow = { org: "o", scopeKey: "p/w/s", level: "surface", monthlyTokens: 9 };
ok(activeSpendLimits([expired, sticky], NOW).length === 1, "activeSpendLimits drops expired, keeps sticky");
const baseline = { surfaceMonthlyTokens: 2 };
ok(applyCapOverrides(baseline, activeSpendLimits([expired], NOW), "p/w", "p/w/s").surfaceMonthlyTokens === 2, "expired bridge reverts to the (tighter) config cap");
ok(applyCapOverrides(baseline, activeSpendLimits([sticky], NOW), "p/w", "p/w/s").surfaceMonthlyTokens === 9, "active bridge overlays the config cap");

{
  const { turnKind } = await import("../agent/hooks/spend.js");
  const ctxWith = (mode: string, attributes: Record<string, string> = {}) => ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { channel_type: mode === "dm" ? "im" : "channel", channel_id: mode === "dm" ? "D1" : "C1", ...attributes } } } },
  });
  ok(turnKind(ctxWith("channel") as never) === "channel", "turnKind: an ordinary channel turn -> \"channel\"");
  ok(turnKind(ctxWith("dm") as never) === "dm", "turnKind: a DM turn -> \"dm\"");
  const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
  const routineCtx = ctxWith("channel", {
    [ROUTINE_MARKER.id]: "r-1",
    [ROUTINE_MARKER.surface]: "slack/T1/C1",
    [ROUTINE_MARKER.org]: "default",
  });
  ok(turnKind(routineCtx as never) === "routine", "turnKind: a routine-fired session -> \"routine\" (checked before mode)");
  ok(turnKind({} as never) === "channel", "turnKind: an unusual/empty ctx degrades to \"channel\", never throws");
}

const dir = join(tmpdir(), `open-everywhere-spend-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
const store = await import("../agent/spend/store.js");

const pA = { org: "default", platform: "slack", workspace: "T1", surface: "C1", workspaceKey: "slack/T1", surfaceKey: "slack/T1/C1", key: "slack/T1/C1" };
const pB = { ...pA, surface: "C2", surfaceKey: "slack/T1/C2", key: "slack/T1/C2" };
const pOther = { org: "default", platform: "slack", workspace: "T2", surface: "C9", workspaceKey: "slack/T2", surfaceKey: "slack/T2/C9", key: "slack/T2/C9" };

await store.recordUsage(pA as never, "2026-06", { inputTokens: 100, outputTokens: 100 });
await store.recordUsage(pA as never, "2026-06", { inputTokens: 0, outputTokens: 50 });
await store.recordUsage(pB as never, "2026-06", { inputTokens: 200, outputTokens: 0 });
await store.recordUsage(pOther as never, "2026-06", { inputTokens: 5000, outputTokens: 0 });

ok((await store.surfaceTokens("default", "slack/T1/C1", "2026-06")) === 250, "store: surface tokens accumulate across calls");
ok((await store.surfaceTokens("default", "slack/T1/C1", "2026-07")) === 0, "store: other period is empty");
ok((await store.workspaceTokens("default", "slack/T1", "2026-06")) === 450, "store: workspace tokens = sum of its surfaces (not other workspaces)");
ok((await store.workspaceTokens("default", "slack/T2", "2026-06")) === 5000, "store: workspace isolation in the rollup");
const pOrg2 = { ...pA, org: "acme" };
await store.recordUsage(pOrg2 as never, "2026-06", { inputTokens: 777, outputTokens: 0 });
ok((await store.surfaceTokens("default", "slack/T1/C1", "2026-06")) === 250, "store: other org's usage does not bleed into this org's surface total");
ok((await store.surfaceTokens("acme", "slack/T1/C1", "2026-06")) === 777, "store: the other org has its own isolated ledger");
ok((await store.workspaceTokens("default", "slack/T1", "2026-06")) === 450, "store: workspace rollup stays within one org");

{
  const usageEvents = await import("../agent/spend/usage-events.js");
  const base = { org: "default", surfaceKey: "slack/T1/C1", sessionId: "sess-1" };

  await usageEvents.appendUsageEvent({ ...base, ts: "2026-06-24T10:00:00Z", principalId: "U1", kind: "channel", inputTokens: 100, outputTokens: 50 });
  await usageEvents.appendUsageEvent({ ...base, ts: "2026-06-24T10:05:00Z", principalId: "U1", kind: "channel", inputTokens: 10, outputTokens: 5, cacheReadTokens: 999 });
  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C2", sessionId: "sess-2", ts: "2026-06-24T10:10:00Z", principalId: "U2", kind: "dm", inputTokens: 200 });
  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C1", sessionId: "sess-1", ts: "2026-06-24T10:06:00Z", kind: "sandbox", detail: { sandboxSeconds: 42 } });
  await usageEvents.appendUsageEvent({ org: "acme", surfaceKey: "slack/T1/C1", sessionId: "sess-9", ts: "2026-06-24T10:00:00Z", inputTokens: 777 });

  const forSession = await usageEvents.usageForSession("default", "sess-1");
  ok(forSession.length === 3, "usageForSession: returns every row for the session (2 model calls + 1 sandbox stop)");
  ok(forSession[0].ts === "2026-06-24T10:00:00Z" && forSession[1].ts === "2026-06-24T10:05:00Z", "usageForSession: oldest-first");
  ok(forSession[2].kind === "sandbox" && forSession[2].inputTokens === 0 && forSession[2].detail?.sandboxSeconds === 42, "usageForSession: zero-token detail event round-trips");
  ok((await usageEvents.usageForSession("default", "sess-9")).length === 0, "usageForSession: another org's session is invisible");

  const summary = await usageEvents.usageSummary("default");
  const c1Channel = summary.find((r) => r.surfaceKey === "slack/T1/C1" && r.kind === "channel");
  ok(c1Channel?.inputTokens === 110 && c1Channel.outputTokens === 55 && c1Channel.events === 2 && c1Channel.sessions === 1, "usageSummary: sums tokens + counts events/sessions per (surface, principal, kind, model)");
  const sandboxGroup = summary.find((r) => r.kind === "sandbox");
  ok(sandboxGroup?.inputTokens === 0 && sandboxGroup.events === 1, "usageSummary: a zero-token group still sums/counts correctly");
  ok(summary.every((r) => r.surfaceKey !== "slack/T1/C1" || r.kind !== "dm"), "usageSummary: acme's row never surfaces under default's org");
  const prefixed = await usageEvents.usageSummary("default", { surfaceKeyPrefix: "slack/T1/C2" });
  ok(prefixed.length === 1 && prefixed[0].principalId === "U2", "usageSummary: surfaceKeyPrefix filters to one surface");
  const windowed = await usageEvents.usageSummary("default", { sinceTs: "2026-06-24T10:05:00Z", untilTs: "2026-06-24T10:06:00Z" });
  ok(windowed.reduce((n, r) => n + r.events, 0) === 2, "usageSummary: sinceTs/untilTs narrow the window (inclusive bounds, excludes the 10:10 row)");

  const removed = await usageEvents.pruneUsageEvents("default", "2026-06-24T10:05:30Z");
  ok(removed === 2, "pruneUsageEvents: removes rows older than the cutoff (the two 10:00/10:05 slack/T1/C1 channel rows)");
  ok((await usageEvents.usageForSession("default", "sess-1")).length === 1, "pruneUsageEvents: the pruned session keeps only its newer row");
  ok((await usageEvents.usageForSession("acme", "sess-9")).length === 1, "pruneUsageEvents: another org's rows are untouched by this org's prune");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ spend: ${passed} assertions passed`);
