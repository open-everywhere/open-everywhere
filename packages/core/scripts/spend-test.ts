import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { periodOf, emptyWindow, addUsage, windowTokens, checkCap, assertSpendBudgetsValid, type SpendBudgets } from "../agent/spend/spend.js";
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

{
  const usdCaps = { surfaceMonthlyUsd: 10, workspaceMonthlyUsd: 100 };
  const base = { mode: "channel" as const, surfaceTokens: 0, workspaceTokens: 0 };
  ok(!checkCap({ ...base, surfaceUsd: 9.99, workspaceUsd: 9.99, caps: usdCaps }).over, "under surface $ cap -> not over");
  ok(checkCap({ ...base, surfaceUsd: 10, workspaceUsd: 10, caps: usdCaps }).over, "at surface $ cap -> over (>= like tokens)");
  ok(checkCap({ ...base, surfaceUsd: 0, workspaceUsd: 100, caps: usdCaps }).over, "workspace $ cap breached -> over");
  ok(!checkCap({ mode: "dm", surfaceTokens: 0, workspaceTokens: 0, surfaceUsd: 9999, workspaceUsd: 9999, caps: usdCaps }).over, "DM is exempt from $ caps too");
  const usdReason = checkCap({ ...base, surfaceUsd: 12.345, workspaceUsd: 0, caps: usdCaps }).reason;
  ok(typeof usdReason === "string" && usdReason.includes("$12.35") && usdReason.includes("$10.00"), "over-$ verdict shows spent-of-cap dollars");
  ok(!checkCap({ ...base, caps: usdCaps }).over, "missing USD inputs read as $0 spent");
  const mixed = { surfaceMonthlyTokens: 1000, surfaceMonthlyUsd: 10 };
  ok(checkCap({ mode: "channel", surfaceTokens: 1000, workspaceTokens: 0, surfaceUsd: 1, workspaceUsd: 1, caps: mixed }).over, "mixed caps: token breach blocks despite $ headroom");
  ok(checkCap({ mode: "channel", surfaceTokens: 1, workspaceTokens: 0, surfaceUsd: 10, workspaceUsd: 10, caps: mixed }).over, "mixed caps: $ breach blocks despite token headroom");
  const both = checkCap({
    mode: "channel",
    surfaceTokens: 0,
    workspaceTokens: 99999,
    surfaceUsd: 50,
    workspaceUsd: 50,
    caps: { surfaceMonthlyUsd: 10, workspaceMonthlyTokens: 5000 },
  });
  ok(both.over && !!both.reason?.includes("channel"), "surface breach is reported before a workspace breach (narrowest scope first)");
}

{
  const throws = (b: SpendBudgets, needle: string, label: string) => {
    try {
      assertSpendBudgetsValid(b);
      ok(false, `${label} (did not throw)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ok(msg.includes(needle), `${label} (message: "${msg}")`);
    }
  };
  const valid = (b: SpendBudgets, label: string) => {
    try {
      assertSpendBudgetsValid(b);
      ok(true, label);
    } catch (e) {
      ok(false, `${label} (threw: ${String(e)})`);
    }
  };
  valid({}, "empty registry is valid (uncapped by default — never invents a budget)");
  valid(
    {
      default: { workspaceMonthlyUsd: 100 },
      perWorkspace: { "slack/T1": { workspaceMonthlyTokens: 1_000_000 } },
      perDomain: { dm: { surfaceMonthlyUsd: 5 }, public: { surfaceMonthlyUsd: 2 }, "team-txn": { surfaceMonthlyTokens: 100_000 } },
      perSurface: { "slack/T1/C1": { surfaceMonthlyUsd: 5, surfaceMonthlyTokens: 10_000 } },
    },
    "a well-formed registry with token + USD components validates (incl. perDomain)",
  );
  throws({ perWorkspace: { "slack/T1/C1": { workspaceMonthlyUsd: 1 } } }, "platform/workspace", "a perWorkspace key with a surface leg is rejected");
  throws({ perSurface: { "slack/T1": { surfaceMonthlyUsd: 1 } } }, "platform/workspace/surface", "a perSurface key missing its surface leg is rejected");
  throws({ perDomain: { "": { surfaceMonthlyUsd: 1 } } }, "non-empty domain name", "a perDomain key that's empty/blank is rejected");
  throws({ default: { surfaceMonthlyUSD: 5 } as never }, "unknown field", "a typo'd cap field fails loud (a silent no-op budget is the worst failure mode)");
  throws({ default: {} }, "no cap at all", "an entry that caps nothing is rejected");
  throws({ default: { surfaceMonthlyUsd: -1 } }, "> 0", "a non-positive amount is rejected");
  throws({ default: { surfaceMonthlyTokens: 1.5 } }, "integer", "a fractional token cap is rejected");
}

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
  const config = { surfaceMonthlyTokens: 1000, surfaceMonthlyUsd: 10, workspaceMonthlyUsd: 100 };
  const usdOnly: SpendLimitRow = { org: "o", scopeKey: "p/w/s", level: "surface", monthlyUsd: 50 };
  const afterUsd = applyCapOverrides(config, [usdOnly], "p/w", "p/w/s");
  ok(afterUsd.surfaceMonthlyUsd === 50, "a USD-only surface override replaces the surface $ cap");
  ok(afterUsd.surfaceMonthlyTokens === 1000, "…and leaves the config token cap in force (per-component overlay)");
  ok(afterUsd.workspaceMonthlyUsd === 100, "…and never touches the other level's caps");
  const tokenOnly: SpendLimitRow = { org: "o", scopeKey: "p/w/s", level: "surface", monthlyTokens: 5 };
  const afterTok = applyCapOverrides(config, [tokenOnly], "p/w", "p/w/s");
  ok(afterTok.surfaceMonthlyTokens === 5 && afterTok.surfaceMonthlyUsd === 10, "a token-only override leaves the config $ cap in force");
  const wsUsd: SpendLimitRow = { org: "o", scopeKey: "p/w", level: "workspace", monthlyUsd: 250 };
  ok(applyCapOverrides(config, [wsUsd], "p/w", "p/w/s").workspaceMonthlyUsd === 250, "a workspace-level USD override targets the workspace $ component");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { domainNameForScope, resolveCaps } = await import("../agent/spend/caps.js");

  const domains = [
    defineDomain({ name: "txn", channels: ["slack/T1/C_TXN"] }),
    defineDomain({ name: "dm-layer", match: "dm" }),
    defineDomain({ name: "public-layer", match: "public" }),
  ];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => ({}),
  });

  ok(domainNameForScope("slack/T1/C_TXN") === "txn", "domainNameForScope: an explicit domain member resolves to that domain's name, even with no mode/trust");
  ok(domainNameForScope("slack/T1/C_OTHER") === undefined, "domainNameForScope: an unassigned channel with no mode/trust resolves to undefined (no criteria layer to fall back on)");
  ok(domainNameForScope("slack/T1/C_OTHER", "dm", "internal") === "dm-layer", 'domainNameForScope: mode "dm" + trust "internal" resolves to the dm criteria domain');
  ok(domainNameForScope("slack/T1/C_OTHER", "dm", "external") === "public-layer", 'domainNameForScope: mode "dm" + trust "external" resolves to the public criteria domain');
  ok(domainNameForScope("slack/T1/C_OTHER", "channel", "external") === "public-layer", "domainNameForScope: an externally-shared channel resolves to the public criteria domain");
  ok(domainNameForScope("slack/T1/C_OTHER", "channel", "internal") === undefined, "domainNameForScope: an ordinary internal channel with no explicit domain resolves to undefined (org is not a perDomain layer)");
  ok(domainNameForScope("slack/T1/C_TXN", "dm", "internal") === "txn", "domainNameForScope: an explicit domain ALWAYS wins over the dm/public criteria layer (channels XOR match)");

  const { registerConfig: reRegister } = await import("../agent/access/config.js");
  let budgets2: SpendBudgets = {};
  reRegister({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => budgets2,
  });

  budgets2 = { default: { surfaceMonthlyUsd: 1 }, perWorkspace: { "slack/T1": { surfaceMonthlyUsd: 2 } }, perDomain: { "dm-layer": { surfaceMonthlyUsd: 3 } }, perSurface: { "slack/T1/C_TXN": { surfaceMonthlyUsd: 4 } } };
  ok(resolveCaps("slack/T1", "slack/T1/C_TXN", "txn").surfaceMonthlyUsd === 4, "resolveCaps: perSurface wins over everything, even a configured perDomain entry");
  ok(resolveCaps("slack/T1", "slack/T1/C_OTHER", "dm-layer").surfaceMonthlyUsd === 3, "resolveCaps: perDomain wins over perWorkspace/default when no perSurface entry exists");
  ok(resolveCaps("slack/T1", "slack/T1/C_OTHER", undefined).surfaceMonthlyUsd === 2, "resolveCaps: no domainName -> falls through to perWorkspace (today's behaviour, unchanged)");
  ok(resolveCaps("slack/T1", "slack/T1/C_OTHER", "unconfigured-domain").surfaceMonthlyUsd === 2, "resolveCaps: a domainName with no perDomain entry falls through to perWorkspace, same as before");
  budgets2 = { default: { surfaceMonthlyUsd: 1 }, perDomain: { "dm-layer": { surfaceMonthlyUsd: 3 } } };
  ok(resolveCaps("slack/T9", "slack/T9/C_X", "dm-layer").surfaceMonthlyUsd === 3, "resolveCaps: perDomain wins over default when no perWorkspace entry exists either");
  ok(resolveCaps("slack/T9", "slack/T9/C_X", undefined).surfaceMonthlyUsd === 1, "resolveCaps: no domainName -> falls all the way through to default, unchanged");
}

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

{
  const spendHook = (await import("../agent/hooks/spend.js")).default;
  const { stampModelCall } = await import("../agent/model/model-stamp.js");
  const usageEvents = await import("../agent/spend/usage-events.js");

  const hookCtx = (sessionId: string) => ({
    channel: { kind: "slack" },
    session: { id: sessionId, auth: { current: { attributes: { team_id: "T1", channel_id: "C_STAMP" }, principalId: "U1", principalType: "slack-user" } } },
  });
  const stepEvent = (inputTokens: number, outputTokens: number) => ({ data: { usage: { inputTokens, outputTokens } } });

  const { createRequire } = await import("node:module");
  const { dirname, join: pathJoin } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(pathJoin(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));

  await contextStorage.run(new ContextContainer(), async () => {
    stampModelCall("anthropic/claude-sonnet-5");
    await spendHook.events["step.completed"](stepEvent(10, 5) as never, hookCtx("sess-stamped") as never);
  });
  const stampedRows = await usageEvents.usageForSession("default", "sess-stamped");
  ok(stampedRows.length === 1 && stampedRows[0].model === "anthropic/claude-sonnet-5", "hooks/spend: step.completed attaches the model-stamp's id to the usage_events row");

  await contextStorage.run(new ContextContainer(), async () => {
    await spendHook.events["step.completed"](stepEvent(20, 10) as never, hookCtx("sess-unstamped") as never);
  });
  const unstampedRows = await usageEvents.usageForSession("default", "sess-unstamped");
  ok(unstampedRows.length === 1 && unstampedRows[0].model === undefined, "hooks/spend: no stamp this session -> model absent (fail-soft, unchanged default)");

  await spendHook.events["step.completed"](stepEvent(1, 1) as never, hookCtx("sess-no-context") as never);
  const noContextRows = await usageEvents.usageForSession("default", "sess-no-context");
  ok(noContextRows.length === 1 && noContextRows[0].model === undefined, "hooks/spend: step.completed outside any Eve context still records the row, unstamped");

  await contextStorage.run(new ContextContainer(), async () => {
    await spendHook.events["step.completed"](stepEvent(2, 2) as never, hookCtx("sess-isolated") as never);
  });
  const isolatedRows = await usageEvents.usageForSession("default", "sess-isolated");
  ok(isolatedRows.length === 1 && isolatedRows[0].model === undefined, "hooks/spend: a fresh session context is unaffected by an earlier session's stamp");
}

{
  process.env.OE_MODEL_PRICING = JSON.stringify({ "zai/glm-5.2": { inPerMtok: 1, outPerMtok: 2 } });
  const { _resetPricingCacheForTest } = await import("../agent/spend/pricing.js");
  _resetPricingCacheForTest();

  let budgets: SpendBudgets = {};
  const { registerConfig } = await import("../agent/access/config.js");
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => budgets,
  });

  const { monthStartISO, scopeUsdSpend, scopeOverBudget } = await import("../agent/spend/check.js");
  const usageEvents = await import("../agent/spend/usage-events.js");
  const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();

  ok(monthStartISO("2026-07-15T12:00:00.000Z") === "2026-07-01T00:00:00.000Z", "monthStartISO -> first instant of the calendar month (matches periodOf's bucketing)");

  const NOW_ISO = "2026-07-15T12:00:00.000Z";
  const org = "usd-org";
  const row = (surfaceKey: string, ts: string, tokens: { inputTokens?: number; outputTokens?: number }, model?: string, kind = "channel") =>
    usageEvents.appendUsageEvent({ org, surfaceKey, sessionId: `s-${ts}`, ts, kind, model, ...tokens });

  await row("slack/T9/C1", "2026-07-02T00:00:00Z", { inputTokens: 1_000_000 }, "zai/glm-5.2");
  await row("slack/T9/C1", "2026-07-03T00:00:00Z", { outputTokens: 1_000_000 });
  await row("slack/T9/C1", "2026-07-04T00:00:00Z", { inputTokens: 9_000_000 }, "mystery/unpriced");
  await row("slack/T9/C11", "2026-07-05T00:00:00Z", { inputTokens: 2_000_000 }, "zai/glm-5.2");
  await row("slack/T9/D1", "2026-07-06T00:00:00Z", { inputTokens: 1_000_000 }, "zai/glm-5.2", "dm");
  await row("slack/T9/C1", "2026-06-29T18:14:59Z", { inputTokens: 50_000_000 }, "zai/glm-5.2");
  await row("slack/T9/C1", "2026-07-14T06:15:01Z", { inputTokens: 50_000_000 }, "zai/glm-5.2");
  await usageEvents.appendUsageEvent({ org: "other-org", surfaceKey: "slack/T9/C1", sessionId: "s-x", ts: "2026-07-02T00:00:00Z", kind: "channel", model: "zai/glm-5.2", inputTokens: 50_000_000 });

  const usd = await scopeUsdSpend(org, "slack/T9", "slack/T9/C1", NOW_ISO);
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  ok(close(usd.surfaceUsd, 3), `surfaceUsd sums stamped ($1) + assumed ($2) rows, $0 for unpriced/out-of-window/other-surface/other-org (got ${usd.surfaceUsd})`);
  ok(close(usd.workspaceUsd, 6), `workspaceUsd = whole workspace incl. the sibling surface ($2) and the DM ($1) (got ${usd.workspaceUsd})`);
  const c11 = await scopeUsdSpend(org, "slack/T9", "slack/T9/C11", NOW_ISO);
  ok(close(c11.surfaceUsd, 2), "surfaceUsd is an exact surfaceKey match, not a prefix match (C1 vs C11)");

  const p = { org, platform: "slack", workspace: "T9", surface: "C1", workspaceKey: "slack/T9", surfaceKey: "slack/T9/C1", key: "slack/T9/C1" };

  budgets = {};
  ok(!(await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "no caps configured -> not over");

  budgets = { perSurface: { "slack/T9/C1": { surfaceMonthlyUsd: 2.5 } } };
  const over = await scopeOverBudget(p as never, "channel", NOW_ISO);
  ok(over.over === true, "config $ cap below the month's priced spend -> over (fail closed)");
  ok(!!over.reason?.includes("$3.00") && !!over.reason?.includes("$2.50"), `the refusal names spent vs cap (got: "${over.reason}")`);
  ok(!(await scopeOverBudget(p as never, "dm", NOW_ISO)).over, "the same over-$ scope is exempt in DM mode");
  ok(!(await scopeOverBudget(p as never, "channel", "2026-04-04T23:30:00.000Z")).over, "the window resets at the calendar-month boundary (August sees $0)");

  await opStore.setSpendLimit(org, "slack/T9/C1", "surface", { monthlyUsd: 10 }, { reason: "bridge while the PR lands", setBy: "admin#1" });
  ok(!(await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "an active USD override above the spend un-blocks the scope");
  await opStore.setSpendLimit(org, "slack/T9/C1", "surface", { monthlyUsd: 10 }, { expiresAt: Date.now() - 1000 });
  ok((await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "an EXPIRED USD override reverts to the tighter config cap (expiry narrows)");
  await opStore.clearSpendLimit(org, "slack/T9/C1", "surface");

  budgets = { default: { workspaceMonthlyUsd: 5 } };
  const wsOver = await scopeOverBudget(p as never, "channel", NOW_ISO);
  ok(wsOver.over && !!wsOver.reason?.includes("workspace"), "a workspace $ default blocks when the workspace's month crosses it");
  budgets = { default: { workspaceMonthlyUsd: 100 } };
  ok(!(await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "under the workspace $ cap -> not over");

  const store2 = await import("../agent/spend/store.js");
  await store2.recordUsage(p as never, "2026-07", { inputTokens: 5, outputTokens: 5 });
  budgets = { perSurface: { "slack/T9/C1": { surfaceMonthlyTokens: 10, surfaceMonthlyUsd: 100 } } };
  const tokOver = await scopeOverBudget(p as never, "channel", NOW_ISO);
  ok(tokOver.over && !!tokOver.reason?.includes("tokens"), "a token cap on the same scope enforces through the same gate");

  const pThread = {
    org, platform: "slack", workspace: "T9", surface: "T_TH1",
    workspaceKey: "slack/T9", surfaceKey: "slack/T9/T_TH1",
    domainKey: "slack/T9/C1", key: "slack/T9/T_TH1",
  };
  budgets = { perSurface: { "slack/T9/C1": { surfaceMonthlyUsd: 2.5 } } };
  ok((await scopeOverBudget(pThread as never, "channel", NOW_ISO)).over, "thread grain: a cap on the PARENT channel gates the thread's turns (via domainKey)");
  ok(!(await scopeOverBudget({ ...pThread, domainKey: undefined } as never, "channel", NOW_ISO)).over, "thread grain: no domainKey (fail-open ingress) → the thread checks its own key, today's behaviour");
  const beforeTokens = await store2.surfaceTokens(org, "slack/T9/C1", "2026-07");
  await store2.recordUsage(pThread as never, "2026-07", { inputTokens: 7, outputTokens: 0 });
  ok((await store2.surfaceTokens(org, "slack/T9/C1", "2026-07")) === beforeTokens + 7, "thread grain: recordUsage buckets thread usage under the PARENT channel's ledger");
  ok((await store2.surfaceTokens(org, "slack/T9/T_TH1", "2026-07")) === 0, "thread grain: nothing accumulates under the thread's own key");

  const { _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");
  const goodPath = process.env.OE_SQLITE_PATH;
  _resetOperationalDbForTest();
  process.env.OE_SQLITE_PATH = "/dev/null/open-everywhere-nope/ops.sqlite3";
  budgets = {};
  ok(!(await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "fast path: no caps -> not over, even with a broken store");
  budgets = { perSurface: { "slack/T9/C1": { surfaceMonthlyUsd: 2.5 } } };
  ok(await scopeOverBudget(p as never, "channel", NOW_ISO).then(() => false, () => true), "a broken store under a configured $ cap makes the CHECK throw (call sites catch -> fail open), never a silent verdict");
  _resetOperationalDbForTest();
  process.env.OE_SQLITE_PATH = goodPath;

  delete process.env.OE_MODEL_PRICING;
  _resetPricingCacheForTest();
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { scopeOverBudget } = await import("../agent/spend/check.js");
  const store3 = await import("../agent/spend/store.js");

  const domains = [
    defineDomain({ name: "txn-team", channels: ["slack/T8/C_TXN"] }),
    defineDomain({ name: "dm-crit", match: "dm" }),
    defineDomain({ name: "public-crit", match: "public" }),
  ];
  let budgets3: SpendBudgets = {};
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => budgets3,
  });

  const org = "perdomain-org";
  const wsKey = "slack/T8";
  const mk = (surface: string) => ({ org, platform: "slack", workspace: "T8", surface, workspaceKey: wsKey, surfaceKey: `${wsKey}/${surface}`, key: `${wsKey}/${surface}` });

  budgets3 = { perDomain: { "txn-team": { surfaceMonthlyTokens: 5 } } };
  await store3.recordUsage(mk("C_TXN") as never, "2026-07", { inputTokens: 10, outputTokens: 0 });
  ok((await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain[explicit]: gates an explicit domain's channel exactly like a perSurface entry would");
  ok(!(await scopeOverBudget(mk("C_OTHER") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain[explicit]: a channel OUTSIDE the domain (no perWorkspace/default either) stays uncapped");

  budgets3 = { perDomain: { "dm-crit": { surfaceMonthlyTokens: 1 }, "public-crit": { surfaceMonthlyTokens: 1 } } };
  await store3.recordUsage(mk("D_USER1") as never, "2026-07", { inputTokens: 100, outputTokens: 0 });
  ok(!(await scopeOverBudget(mk("D_USER1") as never, "dm", "2026-07-15T00:00:00.000Z", "internal")).over, 'perDomain["dm-crit"]: an internal DM stays exempt from blocking even though its own perDomain cap is configured and breached');
  await store3.recordUsage(mk("C_GUEST") as never, "2026-07", { inputTokens: 100, outputTokens: 0 });
  ok((await scopeOverBudget(mk("C_GUEST") as never, "channel", "2026-07-15T00:00:00.000Z", "external")).over, 'perDomain["public-crit"]: an externally-shared channel (mode "channel", trust "external") IS gated by its criteria-domain cap');
  ok(!(await scopeOverBudget(mk("C_GUEST") as never, "channel", "2026-07-15T00:00:00.000Z", "internal")).over, "perDomain[criteria]: the SAME surface with trust \"internal\" doesn't classify into public-crit, so no perDomain cap applies (and none else is configured)");

  budgets3 = { perDomain: { "txn-team": { surfaceMonthlyTokens: 1 } }, perSurface: { "slack/T8/C_TXN": { surfaceMonthlyTokens: 1_000_000 } } };
  ok(!(await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain vs perSurface: a perSurface entry wins even though the surface also has a (tighter) perDomain default");

  budgets3 = { default: { surfaceMonthlyTokens: 1_000_000 }, perWorkspace: { [wsKey]: { surfaceMonthlyTokens: 1_000_000 } }, perDomain: { "txn-team": { surfaceMonthlyTokens: 1 } } };
  ok((await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain vs perWorkspace/default: perDomain wins even though both wider layers are configured (and looser)");
}

{
  process.env.OE_MODEL_PRICING = JSON.stringify({ "zai/glm-5.2": { inPerMtok: 1, outPerMtok: 2 } });
  const { _resetPricingCacheForTest } = await import("../agent/spend/pricing.js");
  _resetPricingCacheForTest();

  const { scopeUsdSpend, workspaceUsdSpendForCurrentMonth, workspaceUsdSpendForPeriod } = await import("../agent/spend/check.js");
  const { activeSpendLimitsForOrg } = await import("../agent/spend/caps.js");
  const usageEvents = await import("../agent/spend/usage-events.js");
  const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();

  const org = "usd-report-org";
  const wk = "slack/T7";
  const row = (surfaceKey: string, ts: string, inputTokens: number) => usageEvents.appendUsageEvent({ org, surfaceKey, sessionId: `s-${surfaceKey}-${ts}`, ts, kind: "channel", model: "zai/glm-5.2", inputTokens });

  await row(`${wk}/C1`, "2026-05-08T18:15:00Z", 1_000_000);
  await row(`${wk}/C2`, "2026-05-09T18:15:00Z", 2_000_000);
  await row(`${wk}/C1`, "2026-06-13T18:15:00Z", 5_000_000);

  const NOW_ISO = "2026-06-20T00:00:00.000Z";

  const ws = await workspaceUsdSpendForCurrentMonth(org, wk, NOW_ISO);
  const viaScope = await scopeUsdSpend(org, wk, `${wk}/C1`, NOW_ISO);
  ok(ws.workspaceUsd === viaScope.workspaceUsd, "workspaceUsdSpendForCurrentMonth: workspaceUsd matches scopeUsdSpend's own arithmetic");
  ok(ws.bySurface.get(`${wk}/C1`) === viaScope.surfaceUsd, "workspaceUsdSpendForCurrentMonth: bySurface's C1 entry matches scopeUsdSpend's surfaceUsd");
  ok(ws.bySurface.get(`${wk}/C1`) === 5 && ws.workspaceUsd === 5, "workspaceUsdSpendForCurrentMonth: only June's row counts for the current-month window (May's rows are out of window)");

  const may = await workspaceUsdSpendForPeriod(org, wk, "2026-05");
  ok(may.workspaceUsd === 3, `workspaceUsdSpendForPeriod: May's two rows sum to $3, June's $5 excluded (got ${may.workspaceUsd})`);
  ok(may.bySurface.get(`${wk}/C1`) === 1 && may.bySurface.get(`${wk}/C2`) === 2, "workspaceUsdSpendForPeriod: per-surface breakdown is correct for the past month");
  ok(may.bySurface.get(`${wk}/C1`) !== undefined, "workspaceUsdSpendForPeriod: a mid-month row (the 10th) is inside the whole-month window");

  await row(`${wk}/C1`, "2026-05-30T18:14:59.999Z", 500_000);
  await row(`${wk}/C1`, "2026-06-01T00:00:00.000Z", 999_000_000);
  const mayAfter = await workspaceUsdSpendForPeriod(org, wk, "2026-05");
  ok(Math.abs(mayAfter.workspaceUsd - 3.5) < 1e-9, "workspaceUsdSpendForPeriod: the month's last millisecond is included, the next month's first instant is not");

  await opStore.setSpendLimit(org, `${wk}/C1`, "surface", { monthlyUsd: 10 }, { reason: "active" });
  await opStore.setSpendLimit(org, wk, "workspace", { monthlyUsd: 20 }, { reason: "expired", expiresAt: Date.now() - 1000 });
  const active = await activeSpendLimitsForOrg(org);
  ok(active.length === 1 && active[0].scopeKey === `${wk}/C1`, "activeSpendLimitsForOrg: drops the expired override, keeps the active one");

  const { _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");
  const goodSpendPath = process.env.OE_SQLITE_PATH;
  _resetOperationalDbForTest();
  process.env.OE_SQLITE_PATH = "/dev/null/open-everywhere-nope-2/ops.sqlite3";
  const softFailed = await activeSpendLimitsForOrg(org).then(
    (v) => v,
    () => "threw",
  );
  ok(Array.isArray(softFailed) && softFailed.length === 0, "activeSpendLimitsForOrg: a broken override store fails SOFT to [] (never throws, never widens)");
  _resetOperationalDbForTest();
  process.env.OE_SQLITE_PATH = goodSpendPath;

  delete process.env.OE_MODEL_PRICING;
  _resetPricingCacheForTest();
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ spend: ${passed} assertions passed`);
