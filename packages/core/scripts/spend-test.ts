import { deepStrictEqual } from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { periodOf, billableTokens, checkCap, assertSpendBudgetsValid, UNKNOWN_MODEL, type SpendBudgets } from "../agent/spend/spend.js";
import { isSpendLimitActive, activeSpendLimits, applyCapOverrides } from "../agent/spend/caps.js";
import type { SpendLimitRow } from "../agent/operational/store.js";

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();

import { turnKind } from "../agent/hooks/spend.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { builtInModelIds, estimateCostUsd, modelPricing } from "../agent/spend/pricing.js";

const PRICED_MODEL = builtInModelIds()[0];

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function eq(actual: unknown, expected: unknown, label: string): void {
  try {
    deepStrictEqual(actual, expected);
  } catch (err) {
    console.error(`✗ ${label}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  passed++;
}

ok(periodOf("2026-06-24T09:30:00Z") === "2026-06", "periodOf -> YYYY-MM");
ok(billableTokens({ inputTokens: 110, outputTokens: 55 }) === 165, "billableTokens = input + output (cache tokens tracked, not cap-billed)");

const caps = { surfaceMonthlyTokens: 1000, workspaceMonthlyTokens: 5000 };
ok(!checkCap({ mode: "channel", surfaceTokens: 999, workspaceTokens: 100, caps }).over, "under surface cap -> not over");
ok(checkCap({ mode: "channel", surfaceTokens: 1000, workspaceTokens: 100, caps }).over, "at surface cap -> over");
ok(checkCap({ mode: "channel", surfaceTokens: 0, workspaceTokens: 5000, caps }).over, "workspace cap breached -> over");
ok(checkCap({ mode: "dm", surfaceTokens: 99999, workspaceTokens: 99999, caps }).over, "OPE-267: a DM is NOT exempt — the same over-cap numbers that block a channel block a DM");
ok(checkCap({ mode: "dm", surfaceTokens: 99999, workspaceTokens: 99999, caps }).reason?.includes("this DM") === true, 'OPE-267: the DM refusal says "this DM", not "this channel" (the reader is not in a channel)');
ok(checkCap({ mode: "mpim", surfaceTokens: 99999, workspaceTokens: 99999, caps }).reason?.includes("this group DM") === true, "OPE-267: a group DM is capped too, and named as one");
ok(!checkCap({ mode: "channel", surfaceTokens: 99999, workspaceTokens: 99999, caps: {} }).over, "no caps configured -> never over");
const reason = checkCap({ mode: "channel", surfaceTokens: 1200, workspaceTokens: 0, caps }).reason;
ok(typeof reason === "string" && reason.includes("channel"), "over-cap verdict carries a human reason");

{
  const usdCaps = { surfaceMonthlyUsd: 10, workspaceMonthlyUsd: 100 };
  const base = { mode: "channel" as const, surfaceTokens: 0, workspaceTokens: 0 };
  ok(!checkCap({ ...base, surfaceUsd: 9.99, workspaceUsd: 9.99, caps: usdCaps }).over, "under surface $ cap -> not over");
  ok(checkCap({ ...base, surfaceUsd: 10, workspaceUsd: 10, caps: usdCaps }).over, "at surface $ cap -> over (>= like tokens)");
  ok(checkCap({ ...base, surfaceUsd: 0, workspaceUsd: 100, caps: usdCaps }).over, "workspace $ cap breached -> over");
  ok(checkCap({ mode: "dm", surfaceTokens: 0, workspaceTokens: 0, surfaceUsd: 9999, workspaceUsd: 9999, caps: usdCaps }).over, "OPE-267: a DM is not exempt from $ caps either");
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

  valid({ perUser: { default: { surfaceMonthlyUsd: 5 } } }, "perUser.default with a surface-shaped USD cap validates");
  valid(
    { perUser: { default: { surfaceMonthlyTokens: 100_000 }, overrides: { "slack/T1/U_BIG": { surfaceMonthlyUsd: 50, surfaceMonthlyTokens: 5_000_000 } } } },
    "perUser with a default AND a named override validates in both denominations",
  );
  throws({ perUser: { default: { workspaceMonthlyUsd: 5 } as never } }, "unknown field", "OPE-268: a WORKSPACE-shaped field under perUser.default is REFUSED, not silently ignored");
  throws({ perUser: { overrides: { "slack/T1/U1": { workspaceMonthlyTokens: 5 } as never } } }, "unknown field", "OPE-268: …and refused under an override too");
  throws({ perUser: { overrides: { "": { surfaceMonthlyUsd: 1 } } } }, "non-empty qualified principal key", "OPE-268: a blank principal id key is rejected");
  throws({ perUser: { default: {} } }, "no cap at all", "OPE-268: a perUser entry that caps nothing is rejected");
  throws({ perUser: { default: { surfaceMonthlyUsd: 0 } } }, "> 0", "OPE-268: a non-positive per-user amount is rejected");
  throws({ perUser: { defaults: { surfaceMonthlyUsd: 5 } } as never }, "unknown field", "OPE-268: a typo on the WRAPPER (`defaults`) fails loud — an allowance nobody receives is invisible in every report");

  valid({ perUser: { overrides: { "slack/T0AB1CD2E/U0123ABCD": { surfaceMonthlyUsd: 50 } } } }, "OPE-274: a QUALIFIED principal key is THE perUser.overrides key (the spelling a runtime override reconciles into)");
  throws({ perUser: { overrides: { U0123ABCD: { surfaceMonthlyUsd: 50 } } } }, "PLATFORM-QUALIFIED", "🔴 OPE-309: a BARE principal id under perUser.overrides is refused at load — it aliases the same id on every platform");
  throws({ perUser: { overrides: { U0123ABCD: { surfaceMonthlyUsd: 50 } } } }, '"<platform>/U0123ABCD"', "OPE-309: …and the error hands the deployer the exact replacement string, needing only the platform name");
  throws({ perUser: { overrides: { "user:slack/U1": { surfaceMonthlyUsd: 1 } } } }, "scope-key marker", "OPE-274: a `user:`-marked SCOPE KEY pasted into the config registry is REFUSED, and the message says what to write instead");
  throws({ perUser: { overrides: { "discord/G1/C1": { surfaceMonthlyUsd: 1 } } } }, "well-formed principal key", "OPE-274: a SURFACE key under perUser.overrides is refused on a VENDOR-GLOBAL platform — it is a place, and it would gate nothing here");
  valid({ perUser: { overrides: { "slack/T1/C1": { surfaceMonthlyUsd: 1 } } } }, "🔴 OPE-309: …but on a TENANT-SCOPED platform that string is a well-formed principal key (id `C1`), so it validates — the shapes are genuinely identical and a shape test cannot separate them");
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
  const config = { surfaceMonthlyTokens: 1000, workspaceMonthlyTokens: 5000 };
  const domainRow: SpendLimitRow = { org: "o", scopeKey: "eng", level: "domain", monthlyTokens: 200 };

  const withDomain = applyCapOverrides(config, [domainRow], "p/w", "p/w/s1", "eng");
  ok(withDomain.surfaceMonthlyTokens === 200, "a domain-level override applies to the surface-shaped token field for any surface classified into that domain");
  const otherSurface = applyCapOverrides(config, [domainRow], "p/w", "p/w/s2", "eng");
  ok(otherSurface.surfaceMonthlyTokens === 200, "…and applies uniformly to every surface in the same domain (not tied to one surfaceKey)");
  ok(applyCapOverrides(config, [domainRow], "p/w", "p/w/s1", "sales").surfaceMonthlyTokens === 1000, "a domain-level override does NOT apply when the surface classifies into a DIFFERENT domain");
  ok(applyCapOverrides(config, [domainRow], "p/w", "p/w/s1").surfaceMonthlyTokens === 1000, "a domain-level override never applies with no domainName to match on (omitted arg = pre-domain-level behaviour)");

  const wsRow: SpendLimitRow = { org: "o", scopeKey: "p/w", level: "workspace", monthlyTokens: 50 };
  const surfaceRow: SpendLimitRow = { org: "o", scopeKey: "p/w/s1", level: "surface", monthlyTokens: 9 };
  const wsAndDomain = applyCapOverrides(config, [wsRow, domainRow], "p/w", "p/w/s1", "eng");
  ok(wsAndDomain.workspaceMonthlyTokens === 50 && wsAndDomain.surfaceMonthlyTokens === 200, "domain overlays the surface field independently of an active workspace override (different fields, no clash)");
  const domainAndSurface = applyCapOverrides(config, [domainRow, surfaceRow], "p/w", "p/w/s1", "eng");
  ok(domainAndSurface.surfaceMonthlyTokens === 9, "surface-row (narrowest) wins over an active domain-row on the SAME surface field");
  const allThree = applyCapOverrides(config, [wsRow, domainRow, surfaceRow], "p/w", "p/w/s1", "eng");
  ok(allThree.surfaceMonthlyTokens === 9 && allThree.workspaceMonthlyTokens === 50, "all three levels active at once: surface wins the surface field, workspace still owns its own field");

  const domainUsd: SpendLimitRow = { org: "o", scopeKey: "eng", level: "domain", monthlyUsd: 12.5 };
  const afterDomainUsd = applyCapOverrides({ surfaceMonthlyTokens: 1000, surfaceMonthlyUsd: 3 }, [domainUsd], "p/w", "p/w/s1", "eng");
  ok(afterDomainUsd.surfaceMonthlyUsd === 12.5 && afterDomainUsd.surfaceMonthlyTokens === 1000, "a USD-only domain override replaces the surface $ field and leaves the token field in force");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { domainNameForScope, resolveCaps } = await import("../agent/spend/caps.js");

  const domains = [
    defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"] }),
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

await store.recordSpend(pA as never, { period: "2026-06", usage: { inputTokens: 100, outputTokens: 100 }, principalId: "U1", model: "m-1" });
await store.recordSpend(pA as never, { period: "2026-06", usage: { outputTokens: 50 }, principalId: "U2" });
await store.recordSpend(pB as never, { period: "2026-06", usage: { inputTokens: 200 } });
await store.recordSpend(pOther as never, { period: "2026-06", usage: { inputTokens: 5000 } });

ok((await store.surfaceTokens("default", "slack/T1/C1", "2026-06")) === 250, "store: surface tokens accumulate across writes, whatever their attribution dimensions");
ok((await store.surfaceTokens("default", "slack/T1/C1", "2026-07")) === 0, "store: other period is empty");
ok((await store.workspaceTokens("default", "slack/T1", "2026-06")) === 450, "store: workspace tokens = sum of its surfaces (not other workspaces)");
ok((await store.workspaceTokens("default", "slack/T2", "2026-06")) === 5000, "store: workspace isolation in the rollup");
ok(billableTokens(await store.spendTotals("default", { surfaceKey: "slack/T1/C1", principalId: "U1", period: "2026-06" })) === 200, "store: a (surface, principal) prefix answers one user's spend directly");
const pOrg2 = { ...pA, org: "acme" };
await store.recordSpend(pOrg2 as never, { period: "2026-06", usage: { inputTokens: 777 } });
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
  const usageEvents = await import("../agent/spend/usage-events.js");
  const { cacheReportedness } = usageEvents;
  const base = { org: "default", surfaceKey: "slack/T1/C7", sessionId: "sess-attr" };

  eq(cacheReportedness({ model: "m", cacheReadTokens: 0 }), { cacheTokensReported: true }, "cacheReportedness: a reported ZERO is a report — the source answered the question");
  eq(cacheReportedness({ model: "m" }), { cacheTokensReported: false }, "cacheReportedness: a model call that gave neither cache figure reported NOTHING");
  eq(cacheReportedness({ model: "m", cacheWriteTokens: 5 }), { cacheTokensReported: true }, "cacheReportedness: either figure alone counts as a report");
  eq(cacheReportedness({}), {}, "cacheReportedness: a model-LESS row (sandbox runtime) is never asked — the column stays absent");
  eq(cacheReportedness({ model: "m", cacheTokensReported: false, cacheReadTokens: 9 }), { cacheTokensReported: false }, "cacheReportedness: an explicit answer from the writer always wins over the inference");

  await usageEvents.appendUsageEvent({ ...base, ts: "2026-06-25T10:00:00Z", kind: "channel", model: "m-attr", inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, reasoningTokens: 33 });
  await usageEvents.appendUsageEvent({ ...base, ts: "2026-06-25T10:01:00Z", kind: "channel", model: "m-attr", inputTokens: 100, outputTokens: 10 });
  await usageEvents.appendUsageEvent({ ...base, ts: "2026-06-25T10:02:00Z", kind: "sandbox", detail: { sandboxSeconds: 4 } });
  const attrRows = await usageEvents.usageForSession("default", "sess-attr");
  ok(attrRows.length === 3, "usage attribution: the three rows round-trip");
  ok(attrRows[0].cacheTokensReported === true, "a call that reported a cache split is recorded as REPORTED");
  ok(attrRows[0].reasoningTokens === 33, "a reported reasoning-token count round-trips as its own dimension");
  ok(attrRows[1].cacheTokensReported === false, "a call whose source published NO cache split says so — its 0 cache tokens assert nothing");
  ok(attrRows[1].reasoningTokens === undefined, "an unreported reasoning count stays ABSENT, never a fabricated 0");
  ok(attrRows[1].cacheReadTokens === 0, "the summed cache column is untouched — the flag adds the missing fact beside it, it does not re-type it");
  ok(attrRows[2].cacheTokensReported === undefined, "a sandbox-runtime row is never asked the cache question at all");

  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C7", sessionId: "sess-attr-zero", ts: "2026-06-25T10:03:00Z", model: "m-attr", inputTokens: 5, reasoningTokens: 0 });
  const zeroRow = (await usageEvents.usageForSession("default", "sess-attr-zero"))[0];
  ok(zeroRow.reasoningTokens === 0, "a REPORTED zero reasoning count reads back as 0, not as absent (the negative control for the read-back guard)");

  const attrSummary = (await usageEvents.usageSummary("default", { surfaceKeyPrefix: "slack/T1/C7" })).filter((r) => r.model === "m-attr" && r.kind === "channel");
  ok(attrSummary.length === 1, "usageSummary: the two model calls group together");
  ok(attrSummary[0].reasoningTokens === 33, "usageSummary: reasoning tokens sum across the group");
  ok(attrSummary[0].cacheReportedCalls === 1 && attrSummary[0].events === 2, "usageSummary: 1 of the 2 calls reported a cache split — the coverage a report must show");
  ok(attrSummary[0].reasoningReportedCalls === 1, "usageSummary: only the call that reported reasoning counts towards its coverage");

  const { tokenAttribution, tokenAttributionNote } = await import("../agent/spend/reporting.js");
  const agg = tokenAttribution(attrSummary);
  ok(agg.calls === 2 && agg.reasoningTokens === 33 && agg.cacheReportedCalls === 1, "tokenAttribution: sums the dimensions and their coverage over rollup rows");
  const note = tokenAttributionNote(agg);
  ok(note.includes("1 of 2"), "tokenAttributionNote: states how many calls actually reported, not just the totals");
  ok(!note.includes("$"), "🔴 tokenAttributionNote NEVER names a dollar figure — a saving inferred from tokens nothing billed against would be a guess");
  const blindNote = tokenAttributionNote({ calls: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheReportedCalls: 0, reasoningReportedCalls: 0 });
  ok(blindNote.includes("UNATTRIBUTED across all 4"), "tokenAttributionNote: a window with no cache tokens says UNATTRIBUTED, never 'no caching'");
  ok(!blindNote.includes("Gateway") && !blindNote.includes("gateway"), "🔴 tokenAttributionNote: the arm where NO call published a cache field names no gateway — that silence is the provider payload's, not a backend's billing behaviour");
  ok(blindNote.includes("no call published a cache field"), "…and it says which silence it is, so the two zero arms are distinguishable");
  const publishedZeroNote = tokenAttributionNote({ calls: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheReportedCalls: 12, reasoningReportedCalls: 0 });
  ok(publishedZeroNote.includes("UNATTRIBUTED across all 12"), "🔴 tokenAttributionNote: 12 calls that all PUBLISHED a zero cache field still read UNATTRIBUTED — a published zero is not a measurement that caching did not happen");
  ok(publishedZeroNote.includes("12 call(s) published a cache field"), "…and the note says the field WAS published, so the limit is stated rather than hidden");
  ok(publishedZeroNote.includes("Vercel AI Gateway backend"), "🔴 tokenAttributionNote: the published-zero arm attributes the discount to the Vercel AI Gateway BACKEND by name, not to 'this deployment's gateway' — ModelBackend is swappable");
  const attributedNote = tokenAttributionNote({ calls: 3, cacheReadTokens: 900, cacheWriteTokens: 10, reasoningTokens: 0, cacheReportedCalls: 3, reasoningReportedCalls: 0 });
  ok(attributedNote.includes("900 read / 10 write") && !attributedNote.includes("UNATTRIBUTED"), "tokenAttributionNote: a window with real cache tokens reports them (the positive control for the zero arm)");
  ok(tokenAttributionNote({ calls: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheReportedCalls: 0, reasoningReportedCalls: 0 }).includes("nothing to attribute"), "tokenAttributionNote: an empty window says so rather than reporting zeros");

  const pAttr = { org: "default", platform: "slack", workspace: "T1", surface: "C8", workspaceKey: "slack/T1", surfaceKey: "slack/T1/C8", key: "slack/T1/C8" };
  await store.recordSpend(pAttr as never, { period: "2026-06", usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 70 }, model: PRICED_MODEL });
  const attrTotals = await store.spendTotals("default", { surfaceKey: "slack/T1/C8", period: "2026-06" });
  ok(attrTotals.reasoningTokens === 70, "the cap ledger records reasoning tokens as their own summed dimension");
  ok(billableTokens(attrTotals) === 150, "🔴 …and they are CAP-NEUTRAL: billableTokens stays input + output, so an attribution dimension can never move a budget");
  const attrUsd = attrTotals.usdMicros;
  await store.recordSpend(pAttr as never, { period: "2026-06", usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 999999 }, model: PRICED_MODEL });
  ok((await store.spendTotals("default", { surfaceKey: "slack/T1/C8", period: "2026-06" })).usdMicros === attrUsd * 2, "🔴 …and UNPRICED: a call with a huge reasoning count costs exactly what the identical call without one costs");
}

{
  const spendHook = (await import("../agent/hooks/spend.js")).default;
  const { stampModelCall } = await import("../agent/model/model-stamp.js");
  const { adoptDelegatedAuthority } = await import("../agent/identity/delegated-binding.js");
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
  const adoptSlackWorkerAuthority = (channelId: string): void => {
    ok(
      adoptDelegatedAuthority(
        {
          binding: {
            org: "default",
            platform: "slack",
            workspace: "T1",
            surface: channelId,
            mode: "channel",
            visibility: "private",
            trust: "external",
            principalId: "U1",
            target: { channelId },
          },
          requester: { kind: "requester", principalId: "U1" },
          nonMemberWake: false,
        },
        "turn-depth2",
      ),
      "fixture: delegated spend call adopts its host-captured dispatch binding",
    );
  };

  await contextStorage.run(new ContextContainer(), async () => {
    stampModelCall("anthropic/claude-sonnet-5");
    await spendHook.events!["step.completed"]!(stepEvent(10, 5) as never, hookCtx("sess-stamped") as never);
  });
  const stampedRows = await usageEvents.usageForSession("default", "sess-stamped");
  ok(stampedRows.length === 1 && stampedRows[0].model === "anthropic/claude-sonnet-5", "hooks/spend: step.completed attaches the model-stamp's id to the usage_events row");

  await contextStorage.run(new ContextContainer(), async () => {
    await spendHook.events!["step.completed"]!(stepEvent(20, 10) as never, hookCtx("sess-unstamped") as never);
  });
  const unstampedRows = await usageEvents.usageForSession("default", "sess-unstamped");
  ok(unstampedRows.length === 1 && unstampedRows[0].model === UNKNOWN_MODEL, "🔴 OPE-369 hooks/spend: no stamp on a TOKEN-BEARING step -> the row is recorded under the explicit unknown-model sentinel, never silently attributed");
  ok(unstampedRows[0].inputTokens === 20 && unstampedRows[0].outputTokens === 10, "…with its tokens intact — the fix withholds the rate-derived $, it never drops the usage");

  await spendHook.events!["step.completed"]!(stepEvent(1, 1) as never, hookCtx("sess-no-context") as never);
  const noContextRows = await usageEvents.usageForSession("default", "sess-no-context");
  ok(noContextRows.length === 1 && noContextRows[0].model === UNKNOWN_MODEL, "hooks/spend: step.completed outside any Eve context still records the row, under the unknown-model sentinel");

  await contextStorage.run(new ContextContainer(), async () => {
    await spendHook.events!["step.completed"]!(stepEvent(2, 2) as never, hookCtx("sess-isolated") as never);
  });
  const isolatedRows = await usageEvents.usageForSession("default", "sess-isolated");
  ok(isolatedRows.length === 1 && isolatedRows[0].model === UNKNOWN_MODEL, "hooks/spend: a fresh session context is unaffected by an earlier session's stamp");

  {
    const ledgerStore = (await import("../agent/operational/provider.js")).getOperationalStore();
    const { MAX_OBSERVABLE_DELEGATION_DEPTH } = await import("../agent/operational/store.js");
    const ledgerPeriod = periodOf(new Date().toISOString());
    const ledgerFor = (surfaceKey: string) => ledgerStore.listSpendLedger("default", { surfaceKey, period: ledgerPeriod });
    const startedEvent = (modelId: string) => ({ data: { modelId, sequence: 0, stepIndex: 0, turnId: "turn-depth2" } });
    const delegatedCtx = (channelId: string) => ({
      channel: { kind: "slack" },
      session: {
        id: "sess-subagent-child",
        parent: { sessionId: "sess-worker", callId: "call-fresh-eyes", rootSessionId: "sess-root" },
        auth: { current: { attributes: { team_id: "T1", channel_id: channelId }, principalId: "U1", principalType: "slack-user" } },
      },
    });
    const delegatedUsage = stepEvent(1_286_000, 152_000);

    await contextStorage.run(new ContextContainer(), async () => {
      adoptSlackWorkerAuthority("C_DEPTH2");
      await spendHook.events!["step.started"]!(startedEvent(PRICED_MODEL) as never, delegatedCtx("C_DEPTH2") as never);
      await spendHook.events!["step.completed"]!(delegatedUsage as never, delegatedCtx("C_DEPTH2") as never);
    });
    const depth2 = await usageEvents.usageForSession("default", "sess-worker");
    ok(depth2.length === 1, "control: the delegated call wrote exactly one usage row");
    ok(depth2[0].delegationDepth === MAX_OBSERVABLE_DELEGATION_DEPTH, "control: the row really is at delegation depth 2 — the assertion below is about the depth the defect was seen at");
    ok(depth2[0].kind === "subagent", "control: the row really is a delegated call");
    ok(
      depth2[0].model === PRICED_MODEL && depth2[0].model !== UNKNOWN_MODEL,
      "🔴 OPE-1878 hooks/spend: a delegated call whose session stamped NOTHING is named from the host's own step.started model reference, never recorded as the unknown-model sentinel",
    );
    const depth2Ledger = (await ledgerFor("slack/T1/C_DEPTH2")).filter((r) => r.model === PRICED_MODEL);
    ok(depth2Ledger.length === 1, "🔴 OPE-1878: the CAP ledger row carries the registry model id too — spend_ledger is the store every cap denomination sums");
    ok(depth2Ledger[0].usdMicros > 0, "…and it is rate-priced, where the unknown-model sentinel priced the same tokens at $0");

    await contextStorage.run(new ContextContainer(), async () => {
      adoptSlackWorkerAuthority("C_DEPTH2_UNSEEN");
      await spendHook.events!["step.completed"]!(delegatedUsage as never, delegatedCtx("C_DEPTH2_UNSEEN") as never);
    });
    const unseenLedger = await ledgerFor("slack/T1/C_DEPTH2_UNSEEN");
    ok(unseenLedger.length === 1 && unseenLedger[0].model === UNKNOWN_MODEL, "🔴 OPE-1878: a delegated call NO source could name still records the unknown-model sentinel — the fix names what was observed, it never guesses");
    ok(unseenLedger[0].usdMicros === 0, "…and is still unpriced, so the evidence rule the sentinel enforces is intact");

    await contextStorage.run(new ContextContainer(), async () => {
      adoptSlackWorkerAuthority("C_DEPTH2_BOTH");
      await spendHook.events!["step.started"]!(startedEvent("some-other/model") as never, delegatedCtx("C_DEPTH2_BOTH") as never);
      stampModelCall(PRICED_MODEL);
      await spendHook.events!["step.completed"]!(delegatedUsage as never, delegatedCtx("C_DEPTH2_BOTH") as never);
    });
    const bothLedger = await ledgerFor("slack/T1/C_DEPTH2_BOTH");
    ok(bothLedger.length === 1 && bothLedger[0].model === PRICED_MODEL, "🔴 OPE-1878: with BOTH a routed stamp and a host reference, the row takes the ROUTED id — the host reference never overwrites the route's own answer");
  }

  {
    const { usdMicrosAtWrite } = await import("../agent/spend/pricing.js");
    const big = { inputTokens: 5_000_000, outputTokens: 5_000_000 };
    ok(usdMicrosAtWrite(big) > 0, "control: a STAMPLESS write still prices at the deploy's sole configured model — the legacy fallback is intact and is what a legacy row still gets");
    ok(
      usdMicrosAtWrite(big, UNKNOWN_MODEL) === 0,
      "🔴 OPE-369: the SAME tokens under the unknown-model sentinel price at $0 — the deploy's sole-model rate is deliberately NOT borrowed for a call whose model was never observed",
    );
  }

  {
    const { spendTotals } = await import("../agent/spend/store.js");
    const { periodOf: periodOfIso } = await import("../agent/spend/spend.js");
    const { generationIdOf } = await import("../agent/spend/usage-events.js");
    const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
    const period = periodOfIso(new Date().toISOString());

    const measuredEvent = {
      data: {
        usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.00025 },
        providerMetadata: { gateway: { generationId: "gen_abc123" } },
      },
    };
    const measuredCtx = () => ({
      channel: { kind: "slack" },
      session: { id: "sess-measured", auth: { current: { attributes: { team_id: "T1", channel_id: "C_MEASURED" }, principalId: "U1", principalType: "slack-user" } } },
    });
    await contextStorage.run(new ContextContainer(), async () => {
      stampModelCall(PRICED_MODEL);
      await spendHook.events!["step.completed"]!(measuredEvent as never, measuredCtx() as never);
    });

    const measuredRows = await usageEvents.usageForSession("default", "sess-measured");
    ok(measuredRows.length === 1 && measuredRows[0].usdMicrosMeasured === 250, "🔴 OPE-369: the gateway-measured cost reaches usage_events in MICROS (0.00025 USD -> 250), instead of being dropped in the cast");
    ok(measuredRows[0].costSource === "measured", "…stamped cost_source='measured', so a reader can tell an exact figure from a rate-derived one");
    ok(generationIdOf(measuredRows[0]) === "gen_abc123", "🔴 OPE-369: the gateway generation id is stamped into detail — the join key between an OE row and the gateway's own billing record");
    ok(measuredRows[0].delegationDepth === 0 && measuredRows[0].rootSessionId === "sess-measured", "…and a ROOT turn records depth 0 with itself as the root of its (so far empty) delegation tree");

    const ledger = (await opStore.listSpendLedger("default")).filter((r) => r.surfaceKey === "slack/T1/C_MEASURED" && r.period === period);
    ok(ledger.length === 1 && ledger[0].costSource === "measured", "🔴 OPE-369: the LEDGER row is keyed by cost_source, so measured and derived calls can never be summed into one bucket");
    ok(ledger[0].usdMicrosMeasured === 250, "…carrying the gateway's own figure in usd_micros_measured");
    ok(ledger[0].usdMicros > 0, "🔴 …AND the rate-derived usd_micros beside it — never displaced, because that column is the one every cap sums (a cap may not depend on a gateway feature)");

    const totals = await spendTotals("default", { surfaceKey: "slack/T1/C_MEASURED", period });
    ok(totals.usdMicrosMeasured === 250 && totals.usdMicros > 0, "spendTotals surfaces BOTH denominations, so the drift read needs no second query");
    const measuredOnly = await spendTotals("default", { surfaceKey: "slack/T1/C_MEASURED", period, costSource: "measured" });
    const derivedOnly = await spendTotals("default", { surfaceKey: "slack/T1/C_MEASURED", period, costSource: "derived" });
    ok(measuredOnly.calls === 1 && derivedOnly.calls === 0, "the costSource filter isolates one cost path — the apples-to-apples half of the drift comparison");

    await contextStorage.run(new ContextContainer(), async () => {
      stampModelCall(PRICED_MODEL);
      await spendHook.events!["step.completed"]!({ data: { usage: { inputTokens: 10, outputTokens: 5 } } } as never, {
        channel: { kind: "slack" },
        session: { id: "sess-unmeasured", auth: { current: { attributes: { team_id: "T1", channel_id: "C_UNMEASURED" }, principalId: "U1", principalType: "slack-user" } } },
      } as never);
    });
    const unmeasured = await usageEvents.usageForSession("default", "sess-unmeasured");
    ok(unmeasured.length === 1 && unmeasured[0].usdMicrosMeasured === undefined && unmeasured[0].costSource === "derived", "a direct-provider step (no gateway cost) records cost_source='derived' and NO measured figure — never a fabricated 0 that would read as 'the gateway billed nothing'");
    ok(generationIdOf(unmeasured[0]) === undefined && unmeasured[0].detail === undefined, "…and carries no detail at all, so an ordinary turn's row is unchanged from before this landed");

    const costOnlyCtx = {
      channel: { kind: "slack" },
      session: { id: "sess-cost-only", auth: { current: { attributes: { team_id: "T1", channel_id: "C_COSTONLY" }, principalId: "U1", principalType: "slack-user" } } },
    };
    await contextStorage.run(new ContextContainer(), async () => {
      stampModelCall(PRICED_MODEL);
      await spendHook.events!["step.completed"]!({ data: { usage: { costUsd: 0.0009 } } } as never, costOnlyCtx as never);
    });
    const costOnly = await usageEvents.usageForSession("default", "sess-cost-only");
    ok(costOnly.length === 1 && costOnly[0].usdMicrosMeasured === 900, "🔴 OPE-369: a step the gateway BILLED but reported no tokens for is recorded — a measured cost is positive evidence of model spend, and dropping it lost real money from the caps");
    const costOnlyLedger = await spendTotals("default", { surfaceKey: "slack/T1/C_COSTONLY", period });
    ok(costOnlyLedger.calls === 1 && costOnlyLedger.usdMicrosMeasured === 900, "…and reaches the LEDGER, which is what the USD caps sum over");

    await contextStorage.run(new ContextContainer(), async () => {
      await spendHook.events!["step.completed"]!({ data: { usage: {} } } as never, {
        channel: { kind: "slack" },
        session: { id: "sess-empty", auth: { current: { attributes: { team_id: "T1", channel_id: "C_EMPTY" }, principalId: "U1", principalType: "slack-user" } } },
      } as never);
    });
    ok((await usageEvents.usageForSession("default", "sess-empty")).length === 0, "…while a step with neither tokens NOR a cost still records nothing — the guard was tightened, not loosened");
  }
}

{
  const spendHook = (await import("../agent/hooks/spend.js")).default;
  const usageEvents = await import("../agent/spend/usage-events.js");
  const { attestSubagentRuns, subagentRunOf } = await import("../agent/spend/subagent-runs.js");
  const { turnKind } = await import("../agent/hooks/spend.js");
  const { adoptDelegatedAuthority } = await import("../agent/identity/delegated-binding.js");
  const { createRequire } = await import("node:module");
  const { dirname, join: pathJoin } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = await import(pathToFileURL(pathJoin(eveRoot, "dist/src/context/container.js")).href);

  const withWorkerAuthority = <T>(channelId: string, principalId: string, fn: () => T | Promise<T>): Promise<T> =>
    Promise.resolve(
      contextStorage.run(new ContextContainer(), async () => {
        ok(
          adoptDelegatedAuthority(
            {
              binding: {
                org: "default",
                platform: "slack",
                workspace: "T1",
                surface: channelId,
                mode: "channel",
                visibility: "private",
                trust: "external",
                principalId,
                target: { channelId },
              },
              requester: { kind: "requester", principalId },
              nonMemberWake: false,
            },
            "turn_0",
          ),
          "fixture: delegated spend call adopts its host-captured dispatch binding",
        );
        return fn();
      }),
    );

  const CHILD_ATTRS = { team_id: "T1", channel_id: "C_DELEG", oe_platform: "slack" } as const;
  const runCtx = (id: string, over: { parent?: { sessionId: string; callId: string; rootSessionId?: string }; token?: string } = {}) => {
    const child = over.parent !== undefined || over.token !== undefined;
    return {
      channel: { kind: child ? "subagent" : "slack", ...(over.token !== undefined ? { continuationToken: over.token } : {}) },
      session: {
        id,
        ...(over.parent ? { parent: { ...over.parent, rootSessionId: over.parent.rootSessionId ?? over.parent.sessionId, turn: { id: "turn_1", sequence: 1 } } } : {}),
        auth: { current: { attributes: { ...CHILD_ATTRS }, principalId: "U1", principalType: "slack-user" } },
      },
    };
  };
  const step = (i: number, o: number) => ({ data: { usage: { inputTokens: i, outputTokens: o } } });

  await spendHook.events!["step.completed"]!(step(100, 10) as never, runCtx("sess-deleg-parent") as never);
  await withWorkerAuthority("C_DELEG", "U1", () =>
    spendHook.events!["step.completed"]!(step(7, 3) as never, runCtx("sess-deleg-child-a", { parent: { sessionId: "sess-deleg-parent", callId: "call_7" } }) as never),
  );
  await withWorkerAuthority("C_DELEG", "U1", () =>
    spendHook.events!["step.completed"]!(step(5, 2) as never, runCtx("sess-deleg-child-b", { token: "subagent:sess-deleg-parent:call_9" }) as never),
  );

  const parentRows = await usageEvents.usageForSession("default", "sess-deleg-parent");
  ok(parentRows.length === 3, `🔴 a delegated child's row files under the PARENT's session id — the parent's own turn plus both children (got ${parentRows.length})`);
  ok((await usageEvents.usageForSession("default", "sess-deleg-child-a")).length === 0, "…and NOT under the child's own id, which eve mints per run and nothing ever queries");
  ok((await usageEvents.usageForSession("default", "sess-deleg-child-b")).length === 0, "…for the token-recognised child either");

  const stamps = parentRows.map((r) => subagentRunOf(r));
  ok(stamps.filter((s) => s === undefined).length === 1, "the parent's OWN turn carries no delegation stamp — filing under the parent is not what makes a row evidence");
  ok(
    stamps.some((s) => s?.sessionId === "sess-deleg-child-a" && s.callId === "call_7"),
    "🔴 the child recognised through eve's TYPED parent projection is stamped with its own session id and the parent's call id",
  );
  ok(
    stamps.some((s) => s?.sessionId === "sess-deleg-child-b" && s.callId === "call_9"),
    "🔴 the child recognised through eve's CONTINUATION TOKEN alone is stamped identically — the two sources are independently sufficient",
  );
  ok(parentRows.filter((r) => r.kind === "subagent").length === 2, "both delegated rows still tag kind 'subagent' — the cost series keeps delegated work separable");
  ok(parentRows.find((r) => subagentRunOf(r) === undefined)?.inputTokens === 100, "the parent's own tokens are unchanged by any of this");

  eq(
    attestSubagentRuns(parentRows),
    { kind: "ledger", runs: 2, events: 2, firstTs: parentRows.filter((r) => subagentRunOf(r)).map((r) => r.ts).sort()[0], lastTs: parentRows.filter((r) => subagentRunOf(r)).map((r) => r.ts).sort()[1] },
    "🔴 the rows the hook wrote are exactly what the attestation reads: 2 delegated runs, 2 model calls",
  );
  eq(attestSubagentRuns(await usageEvents.usageForSession("default", "sess-stamped")).kind, "absent", "a session that delegated NOTHING attests nothing — no false positive from ordinary turns");
  eq(turnKind(runCtx("x", { parent: { sessionId: "p", callId: "c" } }) as never, undefined), "subagent", "turnKind classifies from the SAME parent seam the stamp uses, so the tag and the stamp cannot disagree");

  {
    const { spendTotals } = await import("../agent/spend/store.js");
    const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
    const period = (await import("../agent/spend/spend.js")).periodOf(new Date().toISOString());
    const totals = await spendTotals("default", { surfaceKey: "slack/T1/C_DELEG", period });
    ok(
      billableTokens(totals) === 127 && totals.calls === 3,
      `🔴 the parent's surface ledger holds the parent's own turn (110) PLUS both delegated children (10 + 7) — a surface cap sees delegated spend (got ${billableTokens(totals)} tokens / ${totals.calls} calls)`,
    );
    const delegRows = (await opStore.listSpendLedger("default")).filter((r) => r.surfaceKey === "slack/T1/C_DELEG");
    ok(delegRows.length === 1, `all three writes collapsed into ONE (surface, principal, routine, model) row — the children carried the parent's dimensions, so nothing forked (got ${delegRows.length})`);
    ok(delegRows[0].principalId !== "", "…and the row is principal-attributed (the child ran under the parent's carried auth, not unattributed)");
  }

  {
    const { delegationDepthOf, MAX_OBSERVABLE_DELEGATION_DEPTH } = await import("../agent/spend/subagent-runs.js");

    const rootRow = parentRows.find((r) => subagentRunOf(r) === undefined)!;
    ok(rootRow.delegationDepth === 0 && rootRow.rootSessionId === "sess-deleg-parent", "🔴 OPE-369: a ROOT turn stamps depth 0 and names ITSELF as the root — the column is total, so grouping by it never drops the root's own spend");

    const childRow = parentRows.find((r) => subagentRunOf(r)?.sessionId === "sess-deleg-child-a")!;
    ok(childRow.delegationDepth === 1, "🔴 a DIRECT child (parent === root) stamps depth 1");
    ok(childRow.rootSessionId === "sess-deleg-parent", "…and carries the ROOT session, which is what makes a whole tree one GROUP BY");
    ok(subagentRunOf(childRow)?.rootSessionId === "sess-deleg-parent" && subagentRunOf(childRow)?.depth === 1, "…mirrored into the delegation stamp, so a detail-only reader sees the same lineage");

    const tokenChildRow = parentRows.find((r) => subagentRunOf(r)?.sessionId === "sess-deleg-child-b")!;
    ok(tokenChildRow.delegationDepth === 1 && tokenChildRow.rootSessionId === "sess-deleg-parent", "a child recognised through the CONTINUATION TOKEN alone (no root in the token) still reports depth 1 with the parent as the deepest visible ancestor");

    await withWorkerAuthority("C_DELEG", "U1", () =>
      spendHook.events!["step.completed"]!(
        step(3, 1) as never,
        runCtx("sess-deleg-grandchild", { parent: { sessionId: "sess-deleg-child-a", callId: "call_11", rootSessionId: "sess-deleg-parent" } }) as never,
      ),
    );
    const childFiled = await usageEvents.usageForSession("default", "sess-deleg-child-a");
    ok(childFiled.length === 1, "the grandchild still files under its IMMEDIATE parent — OPE-263's attestation semantics are untouched by this ticket");
    ok(childFiled[0].delegationDepth === MAX_OBSERVABLE_DELEGATION_DEPTH, "🔴 a GRANDCHILD stamps the depth BAND (2 = two-or-more hops) — eve publishes the root and the immediate parent, never the hop count between, so an exact number would be invented");
    ok(childFiled[0].rootSessionId === "sess-deleg-parent", "🔴 …but it names the SAME root as its parent, which is exactly what makes a grandchild's cost reachable from the conversation that caused it");

    ok(delegationDepthOf("p", "p") === 1, "delegationDepthOf: parent IS the root -> depth 1");
    ok(delegationDepthOf("c", "r") === MAX_OBSERVABLE_DELEGATION_DEPTH, "delegationDepthOf: parent is not the root -> the two-or-more band");
    ok(delegationDepthOf("p") === 1, "delegationDepthOf: NO root known (a token-recognised child — eve's continuation token encodes no root) -> 1, the deepest ancestor we can actually see, never a guess");
  }

  {
    const { spendTotals } = await import("../agent/spend/store.js");
    const { bindFrom } = await import("../agent/identity/binding.js");
    const period394 = (await import("../agent/spend/spend.js")).periodOf(new Date().toISOString());

    const parent394 = {
      channel: { kind: "slack" },
      session: { id: "sess-394-parent", auth: { current: { attributes: { team_id: "T1", channel_id: "C_394", oe_platform: "slack" }, principalId: "U394", principalType: "slack-user" } } },
    };
    const child394 = {
      channel: { kind: "subagent" },
      session: {
        id: "sess-394-child",
        parent: { sessionId: "sess-394-parent", callId: "call_394", rootSessionId: "sess-394-parent", turn: { id: "turn_1", sequence: 1 } },
        auth: { current: { attributes: { team_id: "T1", channel_id: "C_394", oe_platform: "slack" }, principalId: "U394", principalType: "slack-user" } },
      },
    };
    const unstamped394 = {
      channel: { kind: "subagent" },
      session: {
        id: "sess-394-unstamped",
        parent: { sessionId: "sess-394-parent", callId: "call_394b", rootSessionId: "sess-394-parent", turn: { id: "turn_1", sequence: 1 } },
        auth: { current: { attributes: { team_id: "T1", channel_id: "C_394" }, principalId: "", principalType: "slack-user" } },
      },
    };

    const unstampedBinding = bindFrom(unstamped394 as never);
    ok(unstampedBinding.platform === "subagent", `🔴 OPE-394 RED: a child with no dispatch snapshot binds platform "subagent" (got "${unstampedBinding.platform}")`);
    ok(unstampedBinding.principalId === undefined || unstampedBinding.principalId === "", "…with no principal, so its rows are unattributed as well as mis-partitioned");
    ok(unstampedBinding.surface !== "C_394", "…and NOT on the parent's surface — which is the whole defect: those tokens escape the parent surface's cap");

    const childBinding = await withWorkerAuthority("C_394", "U394", () => bindFrom(child394 as never));
    const parentBinding = bindFrom(parent394 as never);
    eq(
      { platform: childBinding.platform, workspace: childBinding.workspace, surface: childBinding.surface, mode: childBinding.mode, visibility: childBinding.visibility, trust: childBinding.trust, principalId: childBinding.principalId },
      { platform: parentBinding.platform, workspace: parentBinding.workspace, surface: parentBinding.surface, mode: parentBinding.mode, visibility: parentBinding.visibility, trust: parentBinding.trust, principalId: parentBinding.principalId },
      "🔴 OPE-393: a subagent child binds IDENTICALLY to its dispatch parent through the validated snapshot",
    );

    await spendHook.events!["step.completed"]!(step(50, 5) as never, parent394 as never);
    await withWorkerAuthority("C_394", "U394", () => spendHook.events!["step.completed"]!(step(11, 4) as never, child394 as never));

    const totals394 = await spendTotals("default", { surfaceKey: "slack/T1/C_394", period: period394 });
    ok(
      billableTokens(totals394) === 70 && totals394.calls === 2,
      `🔴 OPE-394: the child's tokens land on the PARENT's surface_key — inside the parent's cap, not on subagent/dev/default (got ${billableTokens(totals394)} tokens / ${totals394.calls} calls)`,
    );
    const escaped = await spendTotals("default", { surfaceKey: "subagent/dev/default", period: period394 });
    ok(escaped.calls === 0, "…and NOTHING landed on the escape partition, which is the assertion the old `kind: \"slack\"` fixture could never make");
    const store394 = (await import("../agent/operational/provider.js")).getOperationalStore();
    const rows394 = (await store394.listSpendLedger("default")).filter((r) => r.surfaceKey === "slack/T1/C_394");
    ok(rows394.length === 1 && rows394[0].principalId === "U394", "…and both writes collapsed into ONE principal-attributed ledger row: the child carried the parent's dimensions, so nothing forked");
  }
}

{
  const { readSubagentAttestation } = await import("../agent/spend/subagent-runs.js");
  const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
  type OperationalStore = import("../agent/operational/store.js").OperationalStore;

  const live = getOperationalStore();
  const broken = { ...live, id: live.id, usageForSession: async () => { throw new Error("connection reset"); } } as OperationalStore;
  registerOperationalStore(broken);
  resetOperationalStore();
  ok(getOperationalStore() === broken, "fail-soft: the broken store is actually in play (else this section would assert nothing)");

  const verdict = await readSubagentAttestation("default", "sess-deleg-parent");
  eq(verdict.kind, "absent", "🔴 an unreadable ledger reports ABSENT — a database failure can never render as 'a reviewer definitely ran'");
  ok(verdict.kind === "absent" && verdict.reason.includes("connection reset"), "…and carries the failure as the reason, so the document says why rather than implying nobody delegated");

  registerOperationalStore(live);
  resetOperationalStore();
  eq((await readSubagentAttestation("default", "sess-deleg-parent")).kind, "ledger", "…and the live store still reads the real evidence back (the swap was restored)");
}

{
  const { registerModelPricing, _resetModelPricingForTest } = await import("../agent/spend/pricing.js");
  registerModelPricing({ [PRICED_MODEL]: { inPerMtok: 1, outPerMtok: 2 } });

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

  const { scopeUsdSpend, scopeOverBudget } = await import("../agent/spend/check.js");
  const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();

  const NOW_ISO = "2026-07-15T12:00:00.000Z";
  const org = "usd-org";
  const seed = (surfaceKey: string, period: string, tokens: { inputTokens?: number; outputTokens?: number }, model?: string) =>
    store.recordSpend({ org, surfaceKey } as never, { period, usage: tokens, model });

  await seed("slack/T9/C1", "2026-07", { inputTokens: 1_000_000 }, PRICED_MODEL);
  await seed("slack/T9/C1", "2026-07", { outputTokens: 1_000_000 });
  await seed("slack/T9/C1", "2026-07", { inputTokens: 9_000_000 }, "mystery/unpriced");
  await seed("slack/T9/C11", "2026-07", { inputTokens: 2_000_000 }, PRICED_MODEL);
  await seed("slack/T9/D1", "2026-07", { inputTokens: 1_000_000 }, PRICED_MODEL);
  await seed("slack/T9/C1", "2026-06", { inputTokens: 50_000_000 }, PRICED_MODEL);
  await seed("slack/T9/C1", "2026-09", { inputTokens: 50_000_000 }, PRICED_MODEL);
  await store.recordSpend({ org: "other-org", surfaceKey: "slack/T9/C1" } as never, { period: "2026-07", usage: { inputTokens: 50_000_000 }, model: PRICED_MODEL });

  const usd = await scopeUsdSpend(org, "slack/T9", "slack/T9/C1", NOW_ISO);
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  ok(close(usd.surfaceUsd, 3), `surfaceUsd sums stamped ($1) + assumed ($2) writes, $0 for unpriced/other-period/other-surface/other-org (got ${usd.surfaceUsd})`);
  ok(close(usd.workspaceUsd, 6), `workspaceUsd = whole workspace incl. the sibling surface ($2) and the DM ($1) (got ${usd.workspaceUsd})`);
  const c11 = await scopeUsdSpend(org, "slack/T9", "slack/T9/C11", NOW_ISO);
  ok(close(c11.surfaceUsd, 2), "surfaceUsd is an exact surfaceKey match, not a prefix match (C1 vs C11)");

  {
    const { rowCostUsd, resolveAssumedModel } = await import("../agent/spend/reporting.js");
    const ledgerRows = (await opStore.listSpendLedger(org)).filter((r) => r.model !== "");
    ok(ledgerRows.length >= 5, `recompute: model rows present to recompute (got ${ledgerRows.length})`);
    const assumed = resolveAssumedModel();
    for (const r of ledgerRows) {
      const re = rowCostUsd({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens }, assumed);
      const reMicros = re === undefined ? 0 : Math.round(re * 1_000_000);
      ok(reMicros === r.usdMicros, `recompute: (tokens + model) reproduces usd_micros for ${r.surfaceKey}/${r.model} (${reMicros} vs stored ${r.usdMicros})`);
    }
    const { usdMicrosAtWrite } = await import("../agent/spend/pricing.js");
    ok(usdMicrosAtWrite({ outputTokens: 1_000_000 }) === 2_000_000, "write-time pricing: a stampless call prices at the deploy's sole configured model, same as the read path's fallback");
    ok(usdMicrosAtWrite({ inputTokens: 9_000_000 }, "mystery/unpriced") === 0, "write-time pricing: an unpriced model contributes $0 — never another model's rate, never a guess");
  }

  const p = { org, platform: "slack", workspace: "T9", surface: "C1", workspaceKey: "slack/T9", surfaceKey: "slack/T9/C1", key: "slack/T9/C1" };

  budgets = {};
  ok(!(await scopeOverBudget(p as never, "channel", NOW_ISO)).over, "no caps configured -> not over");

  budgets = { perSurface: { "slack/T9/C1": { surfaceMonthlyUsd: 2.5 } } };
  const over = await scopeOverBudget(p as never, "channel", NOW_ISO);
  ok(over.over === true, "config $ cap below the month's priced spend -> over (fail closed)");
  ok(!!over.reason?.includes("$3.00") && !!over.reason?.includes("$2.50"), `the refusal names spent vs cap (got: "${over.reason}")`);
  ok((await scopeOverBudget(p as never, "dm", NOW_ISO)).over, "OPE-267: the same over-$ scope is over in DM mode too — end to end through the real gate, not just checkCap");
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
  await store2.recordSpend(p as never, { period: "2026-07", usage: { inputTokens: 5, outputTokens: 5 } });
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
  await store2.recordSpend(pThread as never, { period: "2026-07", usage: { inputTokens: 7 } });
  ok((await store2.surfaceTokens(org, "slack/T9/C1", "2026-07")) === beforeTokens + 7, "thread grain: recordSpend buckets thread usage under the PARENT channel's ledger");
  ok((await store2.surfaceTokens(org, "slack/T9/T_TH1", "2026-07")) === 0, "thread grain: nothing accumulates under the thread's own key");

  {
    const { estimateSandboxCostUsd } = await import("../agent/spend/sandbox-pricing.js");
    const pSbx = { org, platform: "slack", workspace: "T9", surface: "C_SBX", workspaceKey: "slack/T9", surfaceKey: "slack/T9/C_SBX", key: "slack/T9/C_SBX" };
    const fourHoursUsd = estimateSandboxCostUsd(4 * 3600);
    await store2.recordSpend(pSbx as never, { period: "2026-07", usage: {}, model: "", usdMicros: Math.round(fourHoursUsd * 1_000_000) });
    ok((await store2.surfaceTokens(org, "slack/T9/C_SBX", "2026-07")) === 0, "sandbox: the runtime line carries NO tokens — a token cap is unaffected");
    budgets = { perSurface: { "slack/T9/C_SBX": { surfaceMonthlyUsd: 0.1 } } };
    const sbxVerdict = await scopeOverBudget(pSbx as never, "channel", NOW_ISO);
    ok(sbxVerdict.over === true, "🔴 a period with sandbox runtime and NO model spend trips a USD cap set below its runtime cost");
    ok(!!sbxVerdict.reason?.includes("$0.10"), `…and the refusal names the cap (got: "${sbxVerdict.reason}")`);
    const sbxTotals = await store2.spendTotals(org, { surfaceKey: "slack/T9/C_SBX", period: "2026-07" });
    ok(sbxTotals.usdMicros === Math.round(fourHoursUsd * 1_000_000), "sandbox: the ledger holds exactly the platform-rate estimate, in micros");
  }

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

  _resetModelPricingForTest();
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { scopeOverBudget } = await import("../agent/spend/check.js");
  const store3 = await import("../agent/spend/store.js");

  const domains = [
    defineDomain({ name: "txn-team", reach: ["slack/T8/C_TXN"] }),
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
  await store3.recordSpend(mk("C_TXN") as never, { period: "2026-07", usage: { inputTokens: 10 } });
  ok((await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain[explicit]: gates an explicit domain's channel exactly like a perSurface entry would");
  ok(!(await scopeOverBudget(mk("C_OTHER") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain[explicit]: a channel OUTSIDE the domain (no perWorkspace/default either) stays uncapped");

  budgets3 = { perDomain: { "dm-crit": { surfaceMonthlyTokens: 1 }, "public-crit": { surfaceMonthlyTokens: 1 } } };
  await store3.recordSpend(mk("D_USER1") as never, { period: "2026-07", usage: { inputTokens: 100 } });
  ok((await scopeOverBudget(mk("D_USER1") as never, "dm", "2026-07-15T00:00:00.000Z", "internal")).over, 'OPE-267: perDomain["dm-crit"] DECLINES an internal DM whose own spend breached it — the cap that could never gate anything now gates');
  ok(!(await scopeOverBudget(mk("D_USER2") as never, "dm", "2026-07-15T00:00:00.000Z", "internal")).over, 'perDomain["dm"] is a REPEATED per-surface default, never a shared pool: a second person\'s DM is judged on its own ledger and stays under the same cap');
  await store3.recordSpend(mk("C_GUEST") as never, { period: "2026-07", usage: { inputTokens: 100 } });
  ok((await scopeOverBudget(mk("C_GUEST") as never, "channel", "2026-07-15T00:00:00.000Z", "external")).over, 'perDomain["public-crit"]: an externally-shared channel (mode "channel", trust "external") IS gated by its criteria-domain cap');
  ok(!(await scopeOverBudget(mk("C_GUEST") as never, "channel", "2026-07-15T00:00:00.000Z", "internal")).over, "perDomain[criteria]: the SAME surface with trust \"internal\" doesn't classify into public-crit, so no perDomain cap applies (and none else is configured)");

  budgets3 = { perDomain: { "txn-team": { surfaceMonthlyTokens: 1 } }, perSurface: { "slack/T8/C_TXN": { surfaceMonthlyTokens: 1_000_000 } } };
  ok(!(await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain vs perSurface: a perSurface entry wins even though the surface also has a (tighter) perDomain default");

  budgets3 = { default: { surfaceMonthlyTokens: 1_000_000 }, perWorkspace: { [wsKey]: { surfaceMonthlyTokens: 1_000_000 } }, perDomain: { "txn-team": { surfaceMonthlyTokens: 1 } } };
  ok((await scopeOverBudget(mk("C_TXN") as never, "channel", "2026-07-15T00:00:00.000Z")).over, "perDomain vs perWorkspace/default: perDomain wins even though both wider layers are configured (and looser)");

  const DM = "D_SHARED";
  await store3.recordSpend(mk(DM) as never, { period: "2026-07", usage: { inputTokens: 100 }, principalId: "U_HEAVY" });
  await store3.recordSpend(mk(DM) as never, { period: "2026-07", usage: { inputTokens: 1 }, principalId: "U_LIGHT" });

  budgets3 = { perUser: { default: { surfaceMonthlyTokens: 50 } } };
  const heavy = await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY");
  ok(heavy.over === true, "OPE-268: perUser.default declines the person whose OWN rows breached it");
  ok(heavy.reason?.includes("your own monthly budget") === true, `OPE-268: the refusal is about the PERSON, not the place (got: "${heavy.reason}")`);
  ok(!(await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_LIGHT")).over, "OPE-268: …while a second person on the SAME surface key stays under it — two users never share a pool, and the gate is reading principal_id, not the surface total");

  budgets3 = { perUser: { default: { surfaceMonthlyTokens: 50 }, overrides: { "slack/T8/U_HEAVY": { surfaceMonthlyTokens: 1_000_000 } } } };
  ok(!(await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY")).over, "OPE-268: perUser.overrides[principal] beats the default for that person");
  budgets3 = { perUser: { default: { surfaceMonthlyTokens: 1 }, overrides: { "slack/T8/U_OTHER": { surfaceMonthlyTokens: 1_000_000 } } } };
  ok((await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_LIGHT")).over, "OPE-268: …and ONLY for that person — someone else's override doesn't raise everyone's default");

  budgets3 = { perUser: { overrides: { "slack/T8/U_LIGHT": { surfaceMonthlyTokens: 1_000_000 } } }, perSurface: { [`${wsKey}/${DM}`]: { surfaceMonthlyTokens: 5 } } };
  const vsSurface = await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_LIGHT");
  ok(vsSurface.over === true && vsSurface.reason?.includes("this DM") === true, "OPE-268: a huge per-user allowance does NOT disable the SURFACE cap — both are checked, and the surface's breach is what is reported");
  budgets3 = { perUser: { overrides: { "slack/T8/U_LIGHT": { surfaceMonthlyTokens: 1_000_000 } } }, default: { workspaceMonthlyTokens: 5 } };
  const vsWorkspace = await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_LIGHT");
  ok(vsWorkspace.over === true && vsWorkspace.reason?.includes("workspace") === true, "OPE-268: …nor the WORKSPACE cap — person and place are different axes, ORed, never substituted");
  budgets3 = { perUser: { default: { surfaceMonthlyTokens: 50 } }, perSurface: { [`${wsKey}/${DM}`]: { surfaceMonthlyTokens: 1_000_000 } }, default: { workspaceMonthlyTokens: 1_000_000 } };
  ok((await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY")).over, "OPE-268: a person over their own budget is declined even where the surface and workspace have headroom");

  await store3.recordSpend(mk("C_BUSY") as never, { period: "2026-07", usage: { inputTokens: 100 }, principalId: "U_HEAVY" });
  budgets3 = { perUser: { default: { surfaceMonthlyTokens: 1 } } };
  ok(!(await scopeOverBudget(mk("C_BUSY") as never, "channel", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY")).over, "OPE-268: the person axis is DM-scoped — the same principal's channel turns are not gated by their DM allowance");
  ok(!(await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal")).over, "OPE-268: no principal → no per-user cap can apply (never the unattributed bucket by accident)");

  const heavyUsd = estimateCostUsd({ inputTokens: 100 }, modelPricing(PRICED_MODEL));
  ok(heavyUsd !== undefined && heavyUsd > 0, "OPE-268 precondition: the deploy prices its own sole model (else the USD axis below is vacuous)");
  budgets3 = { perUser: { default: { surfaceMonthlyUsd: heavyUsd! / 2 } } };
  const usdVerdict = await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY");
  ok(usdVerdict.over === true && usdVerdict.reason?.includes("your own monthly budget") === true, "OPE-268: a per-user cap trips in USD as well as tokens (both read the same principal-keyed ledger rows)");

  budgets3 = {};
  ok(!(await scopeOverBudget(mk(DM) as never, "dm", "2026-07-15T00:00:00.000Z", "internal", "U_HEAVY")).over, "OPE-268: an empty registry stays uncapped on the person axis too");
}

{
  const { registerModelPricing, _resetModelPricingForTest } = await import("../agent/spend/pricing.js");
  const store4 = await import("../agent/spend/store.js");
  registerModelPricing({ "deployer/only-model": { inPerMtok: 2, outPerMtok: 4 } });

  const org = "deployer-pricing-org";
  const p = { org, platform: "slack", workspace: "T6", surface: "C_COLD", workspaceKey: "slack/T6", surfaceKey: "slack/T6/C_COLD", key: "slack/T6/C_COLD" };
  await store4.recordSpend(p as never, { period: "2026-07", usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: "deployer/only-model" });
  const totals = await store4.spendTotals(org, { surfaceKey: "slack/T6/C_COLD", period: "2026-07" });
  ok(totals.usdMicros === 2_000_000, `OPE-1148: a model priced ONLY by the deployer table writes its real rate at write time (got ${totals.usdMicros} micros, want 2000000)`);

  _resetModelPricingForTest();
  const p2 = { ...p, surface: "C_COLD2", surfaceKey: "slack/T6/C_COLD2", key: "slack/T6/C_COLD2" };
  await store4.recordSpend(p2 as never, { period: "2026-07", usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: "deployer/only-model" });
  const totals2 = await store4.spendTotals(org, { surfaceKey: "slack/T6/C_COLD2", period: "2026-07" });
  ok(totals2.usdMicros === 0, `OPE-1148: with no deployer table the SAME write prices $0 — evidence-only, never a borrowed rate (got ${totals2.usdMicros} micros)`);

  const p3 = { ...p, surface: "C_COLD3", surfaceKey: "slack/T6/C_COLD3", key: "slack/T6/C_COLD3" };
  await store4.recordSpend(p3 as never, { period: "2026-07", usage: {}, model: "", usdMicros: 5 });
  const totals3 = await store4.spendTotals(org, { surfaceKey: "slack/T6/C_COLD3", period: "2026-07" });
  ok(totals3.usdMicros === 5, "OPE-1148: an explicit-usdMicros write (sandbox runtime) is recorded verbatim — no rate is involved");
}

{
  const { registerModelPricing, _resetModelPricingForTest } = await import("../agent/spend/pricing.js");
  registerModelPricing({ [PRICED_MODEL]: { inPerMtok: 1, outPerMtok: 2 } });

  const { scopeUsdSpend } = await import("../agent/spend/check.js");
  const { activeSpendLimitsForOrg } = await import("../agent/spend/caps.js");
  const { spendRollup } = await import("../agent/spend/store.js");
  const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();

  const org = "usd-report-org";
  const wk = "slack/T7";
  const row = (surfaceKey: string, period: string, inputTokens: number) =>
    store.recordSpend({ org, surfaceKey } as never, { period, usage: { inputTokens }, model: PRICED_MODEL });

  await row(`${wk}/C1`, "2026-05", 1_000_000);
  await row(`${wk}/C2`, "2026-05", 2_000_000);
  await row(`${wk}/C1`, "2026-06", 5_000_000);

  const NOW_ISO = "2026-06-20T00:00:00.000Z";

  const june = (await spendRollup()).filter((r) => r.org === org && r.period === "2026-06");
  const viaScope = await scopeUsdSpend(org, wk, `${wk}/C1`, NOW_ISO);
  const juneC1 = june.find((r) => r.surfaceKey === `${wk}/C1`);
  ok(juneC1?.usd === viaScope.surfaceUsd, "spendRollup: a surface's usd equals the gate's scopeUsdSpend for the same period (report == gate)");
  ok(june.reduce((sum, r) => sum + (r.surfaceKey.startsWith(`${wk}/`) ? r.usd : 0), 0) === viaScope.workspaceUsd, "spendRollup: the workspace's summed usd equals the gate's workspaceUsd");
  ok(juneC1?.usd === 5 && juneC1.tokens === 5_000_000, "spendRollup: only June's rows count for June (May's rows are a different period)");

  const may = (await spendRollup()).filter((r) => r.org === org && r.period === "2026-05");
  ok(may.find((r) => r.surfaceKey === `${wk}/C1`)?.usd === 1 && may.find((r) => r.surfaceKey === `${wk}/C2`)?.usd === 2, "spendRollup: a past period's per-surface breakdown is intact ($1 + $2 in May)");

  {
    const everyPeriod = await spendRollup(org);
    ok(new Set(everyPeriod.map((r) => r.period)).size === 2, "fixture control: the unbounded rollup for this org spans BOTH periods — the bounds below are what narrow it");

    const juneOnly = await spendRollup(org, { period: "2026-06" });
    ok(juneOnly.length === 1 && juneOnly.every((r) => r.period === "2026-06"), "🔴 OPE-1653 spendRollup: a `period` filter reaches the store — May's rows never come back");
    ok(juneOnly[0]?.usd === 5, "OPE-1653 spendRollup: the bounded read returns the SAME figures the unbounded one did ($5 in June)");

    const mayOnly = await spendRollup(org, { period: "2026-05" });
    ok(mayOnly.length === 2 && mayOnly.every((r) => r.period === "2026-05"), "OPE-1653 spendRollup: the other period bounds the other way — the filter is not a constant");
    ok(mayOnly.length !== juneOnly.length, "OPE-1653 spendRollup: the two bounded reads DIFFER — neither is the whole ledger");

    const window = await spendRollup(org, { periodFrom: "2026-05", periodTo: "2026-06" });
    ok(window.length === everyPeriod.length, "OPE-1653 spendRollup: a periodFrom..periodTo range covering both months returns both (bounds are INCLUSIVE)");
    ok((await spendRollup(org, { periodFrom: "2026-06" })).length === 1, "OPE-1653 spendRollup: periodFrom alone drops every EARLIER month");
    ok((await spendRollup(org, { periodTo: "2026-05" })).length === 2, "OPE-1653 spendRollup: periodTo alone drops every LATER month");
    ok((await spendRollup(org, { periodFrom: "2026-07", periodTo: "2026-08" })).length === 0, "OPE-1653 spendRollup: a range no row falls in returns nothing — the bound can refuse, not only widen");
  }

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

  _resetModelPricingForTest();
}

rmSync(dir, { recursive: true, force: true });
{
  const chanCtx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T", channel_id: "C", channel_type: "channel" }, principalId: "U", principalType: "slack-user" } } },
  } as unknown as BindableContext;
  const dmCtx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T", channel_id: "D", channel_type: "im" }, principalId: "U", principalType: "slack-user" } } },
  } as unknown as BindableContext;
  ok(turnKind(chanCtx, "C:oe-sup:g3") === "supervisor", "supervisor-shaped continuationToken → kind 'supervisor'");
  ok(turnKind(chanCtx, "C:1720000000.1234") === "channel", "an ordinary thread token → kind 'channel' (not supervisor)");
  ok(turnKind(chanCtx) === "channel", "no continuationToken → falls back to the surface mode (channel)");
  ok(turnKind(dmCtx, "D:1720000000.1234") === "dm", "a DM token → kind 'dm' (unchanged)");
  ok(turnKind(chanCtx, undefined) === "channel", "undefined token → channel (no false supervisor tag)");

  ok(turnKind(chanCtx, "C:oe-sup:g3-ab12cd") === "supervisor", "OPE-58: a salted supervisor token (g<n>-<sha>) STILL tags kind 'supervisor'");
  ok(turnKind(chanCtx, "oe-dom:payments:oe-sup:g1-000000") === "supervisor", "OPE-58: a salted DOMAIN window token still tags kind 'supervisor'");
}

{
  const { readFileSync } = await import("node:fs");
  const fireDispatchers = ["../agent/schedules/dispatch.ts", "../agent/webhooks/dispatch.ts", "../agent/routines/ingress.ts"];
  for (const rel of fireDispatchers) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    ok(!/\bcapBypassFor\s*\(/.test(src), `OPE-267: ${rel.split("/").pop()} never CALLS capBypassFor — an autonomous fire cannot obtain the admin escape`);
    ok(!/from\s+"[^"]*spend\/bypass\.js"/.test(src), `OPE-267: ${rel.split("/").pop()} does not even import spend/bypass.js`);
  }
  const gate = readFileSync(new URL("../agent/spend/ingress-gate.ts", import.meta.url), "utf8");
  ok(/\?\?\s*capBypassFor\b/.test(gate) && /from\s+"\.\/bypass\.js"/.test(gate), "OPE-267: the ATTENDED ingress gate does consult capBypassFor (its live default) — the escape exists, it is just unreachable from a fire");
  const fireWindow = readFileSync(new URL("../agent/routines/fire-window.ts", import.meta.url), "utf8");
  ok(/internalDispatch:\s*true/.test(fireWindow), "OPE-267: fire-window.ts marks its divert `internalDispatch` — a fire never reaches the attended gate, so it never reaches the admin escape");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { scopeOverBudget } = await import("../agent/spend/check.js");
  const { resolveUserCaps, resolveUserCapsWithLayer, applyUserCapOverrides, effectiveUserCaps, userCapInventory } = await import("../agent/spend/caps.js");
  const { userScopeKey, parseScopeKey } = await import("../agent/access/scope-key.js");
  const { spendRefusalCopy } = await import("../agent/spend/ingress-gate.js");
  const store4 = await import("../agent/spend/store.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");

  let budgets4: SpendBudgets = {};
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "org", match: "org", admins: [] })],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => budgets4,
  });

  const org = "peruser-org";
  const wsKey = "slack/T274";
  const mk = (surface: string) => ({ org, platform: "slack", workspace: "T274", surface, workspaceKey: wsKey, surfaceKey: `${wsKey}/${surface}`, key: `${wsKey}/${surface}` });
  const DM = "D_ALICE";
  const ALICE = "U_ALICE";
  const ALICE_SCOPE = userScopeKey("slack", "T274", ALICE);
  await store4.recordSpend(mk(DM) as never, { period: "2026-07", usage: { inputTokens: 100 }, principalId: ALICE });
  const AT = "2026-07-15T00:00:00.000Z";

  budgets4 = { perUser: { default: { surfaceMonthlyTokens: 50 } } };
  const userV = await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE);
  ok(userV.over === true && userV.layer === "user", 'OPE-274: a per-user breach reports layer:"user" structurally, not only in prose');
  ok(userV.scopeKey === ALICE_SCOPE, `OPE-274: …and carries the person's OWN scope key (got: "${userV.scopeKey}")`);
  ok(userV.reason?.includes("per-user cap") === true && userV.reason?.includes(ALICE_SCOPE) === true, `OPE-274: the per-user refusal NAMES the layer and the key (got: "${userV.reason}")`);
  ok(userV.reason?.includes("your own monthly budget") === true, "OPE-274: …while keeping OPE-268's person-not-place wording (the reader is still being told it is about them)");

  budgets4 = { perSurface: { [`${wsKey}/${DM}`]: { surfaceMonthlyTokens: 5 } } };
  const surfV = await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE);
  ok(surfV.layer === "surface" && surfV.scopeKey === `${wsKey}/${DM}`, "OPE-274: a surface breach names the SURFACE key, never the person's");
  ok(surfV.reason?.includes("per-surface cap") === true && surfV.reason?.includes(`${wsKey}/${DM}`) === true, `OPE-274: the surface refusal names its layer + key (got: "${surfV.reason}")`);

  budgets4 = { default: { workspaceMonthlyTokens: 5 } };
  const wsV = await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE);
  ok(wsV.layer === "workspace" && wsV.scopeKey === wsKey, "OPE-274: a workspace breach names the WORKSPACE key");
  ok(wsV.reason?.includes("per-workspace cap") === true && wsV.reason?.includes(wsKey) === true, `OPE-274: the workspace refusal names its layer + key (got: "${wsV.reason}")`);

  ok(new Set([userV.scopeKey, surfV.scopeKey, wsV.scopeKey]).size === 3, "OPE-274: the three layers' verdicts carry three DIFFERENT scope keys — a refusal identifies exactly one cap");

  const bare = checkCap({ mode: "channel", surfaceTokens: 10, workspaceTokens: 0, caps: { surfaceMonthlyTokens: 1 } });
  ok(bare.reason?.includes("per-surface cap (") === true && bare.reason?.includes("`") === false, `OPE-274: with no scope labels the sentence names the layer but invents no key (got: "${bare.reason}")`);

  const dmCopy = spendRefusalCopy({ reason: "you've reached your own monthly budget", surfaceKey: `${wsKey}/${DM}`, workspaceKey: wsKey, mode: "dm", layer: "user", layerKey: ALICE_SCOPE, badge: "⛔" });
  ok(dmCopy.includes(ALICE_SCOPE), "OPE-274: the DM refusal copy names the person's own allowance key, which is the one an admin raises");
  const dmCopyNoUser = spendRefusalCopy({ reason: "this DM reached its monthly budget", surfaceKey: `${wsKey}/${DM}`, workspaceKey: wsKey, mode: "dm", layer: "surface", layerKey: `${wsKey}/${DM}`, badge: "⛔" });
  ok(!dmCopyNoUser.includes("your own allowance"), "OPE-274: a SURFACE breach in a DM does NOT offer to raise the person's allowance — that remedy would change nothing");
  ok(dmCopy.startsWith("⛔ I'm holding off —") && dmCopyNoUser.startsWith("⛔ I'm holding off —"), "OPE-274: the e2e-pinned 'holding off' opening is unchanged in both DM variants");

  {
    const GROUP = "G_TEAM";
    const CHAN = "C_ENG";
    const keyOf = { dm: `${wsKey}/${DM}`, mpim: `${wsKey}/${GROUP}`, channel: `${wsKey}/${CHAN}` } as const;
    const MODES = ["dm", "mpim", "channel"] as const;
    const LAYER_KEY = { user: ALICE_SCOPE, workspace: wsKey } as const;
    const OWN_ALLOWANCE = "your own allowance";

    for (const mode of MODES) {
      const wsCopy = spendRefusalCopy({ reason: "this workspace reached its monthly budget", surfaceKey: keyOf[mode], workspaceKey: wsKey, mode, layer: "workspace", layerKey: LAYER_KEY.workspace, badge: "⛔" });
      ok(wsCopy.includes(`whole workspace = \`${wsKey}\``), `OPE-1860/${mode}: a WORKSPACE breach names the workspace key, LABELLED as the workspace's — the only key that raises it`);
      ok(wsCopy.includes(`\`${keyOf[mode]}\``), `OPE-1860/${mode}: …and still names this conversation, so an admin knows which room is asking`);
      ok(!wsCopy.includes(OWN_ALLOWANCE), `OPE-1860/${mode}: …and never offers the reader's own allowance, which raising would change nothing`);

      const place = mode === "dm" ? "this DM" : mode === "mpim" ? "this group DM" : "this channel";
      const surfCopy = spendRefusalCopy({ reason: `${place} reached its monthly budget`, surfaceKey: keyOf[mode], workspaceKey: wsKey, mode, layer: "surface", layerKey: keyOf[mode], badge: "⛔" });
      ok(surfCopy.includes(`${place} = \`${keyOf[mode]}\``), `OPE-1860/${mode}: a SURFACE breach names this conversation's own key, labelled "${place}"`);
      ok(!surfCopy.includes(OWN_ALLOWANCE), `OPE-1860/${mode}: …and never offers the reader's own allowance for a cap on the room`);
      ok(!surfCopy.includes(`whole workspace`), `OPE-1860/${mode}: …and does not offer the workspace key for a cap the workspace did not set`);

      const inDm = mode !== "channel";
      ok(wsCopy.includes("asking me from a channel") === inDm, `OPE-1860/${mode}: the remedy route follows the VENUE (a DM can't be told "DM me")`);
      ok(wsCopy.includes("DM me to propose") === !inDm, `OPE-1860/${mode}: …and a channel IS told to DM`);
    }

    const userCopy = spendRefusalCopy({ reason: "you've reached your own monthly budget", surfaceKey: keyOf.dm, workspaceKey: wsKey, mode: "dm", layer: "user", layerKey: LAYER_KEY.user, badge: "⛔" });
    ok(userCopy.includes(`your own allowance = \`${ALICE_SCOPE}\``), 'OPE-1860: layer "user" is the ONLY layer that offers the reader\'s own allowance, and it names that key');

    budgets4 = { perUser: { default: { surfaceMonthlyTokens: 1 } }, perSurface: { [`${wsKey}/${GROUP}`]: { surfaceMonthlyTokens: 5 } } };
    await store4.recordSpend(mk(GROUP) as never, { period: "2026-07", usage: { inputTokens: 100 }, principalId: ALICE, surfaceMode: "mpim" });
    const dmControl = await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE);
    ok(dmControl.over === true && dmControl.layer === "user", `fixture control: the same per-user cap DOES bite on a one-to-one DM (over=${dmControl.over}, layer="${dmControl.layer ?? "none"}")`);
    const mpimV = await scopeOverBudget(mk(GROUP) as never, "mpim", AT, "internal", ALICE);
    ok(mpimV.over === true, "fixture control: the group DM is over budget too — so the layer assertion below reads a LIVE verdict, not an under-cap pass");
    ok(mpimV.layer === "surface", `OPE-1860: …and it is the ROOM's cap that bit, never the person's (got layer "${mpimV.layer ?? "none"}") — so "your own usage" there was wrong on every refusal it rendered`);

    const labelFor = (copy: string): string => copy.slice(copy.indexOf("Scope keys for the override: "), copy.indexOf(" = `"));
    const workspaceLabels = new Set(
      MODES.map((mode) => labelFor(spendRefusalCopy({ reason: "r", surfaceKey: keyOf[mode], workspaceKey: wsKey, mode, layer: "workspace", layerKey: wsKey, badge: "⛔" }))),
    );
    ok(workspaceLabels.size === 1, `OPE-1860: the DM, group-DM and channel variants label one layer IDENTICALLY — one table, not three (got ${workspaceLabels.size} spellings)`);
    const surfaceLabels = new Set(MODES.map((mode) => labelFor(spendRefusalCopy({ reason: "r", surfaceKey: keyOf[mode], workspaceKey: wsKey, mode, layer: "surface", layerKey: keyOf[mode], badge: "⛔" }))));
    ok(surfaceLabels.size === 3, `OPE-1860: …while a SURFACE breach names the room in each venue's own words (got ${surfaceLabels.size} of 3)`);

    const layerless = spendRefusalCopy({ reason: "over budget", surfaceKey: keyOf.channel, workspaceKey: wsKey, mode: "channel", badge: "⛔" });
    ok(!layerless.includes(OWN_ALLOWANCE), "OPE-1860: with no layer on the verdict the copy never guesses that the reader's own allowance is what bit");
    ok(layerless.includes(`\`${keyOf.channel}\``) && layerless.includes(`\`${wsKey}\``), "OPE-1860: …and offers both keys, as the channel variant always did");
    budgets4 = {};
  }

  budgets4 = { perUser: { default: { surfaceMonthlyUsd: 1 }, overrides: { [`slack/T274/${ALICE}`]: { surfaceMonthlyTokens: 20 } } } };
  ok(resolveUserCaps(ALICE, "slack", "T274").surfaceMonthlyTokens === 20, "OPE-274: a QUALIFIED perUser.overrides key resolves the named person's allowance");
  ok(resolveUserCapsWithLayer(ALICE, "slack", "T274").layer === "config:overrides" && resolveUserCapsWithLayer(ALICE, "slack", "T274").configKey === `slack/T274/${ALICE}`, "OPE-274: resolveUserCapsWithLayer names WHICH config key matched");
  ok(resolveUserCapsWithLayer("U_NOBODY", "slack", "T274").layer === "config:default", "OPE-274: an unnamed person falls to perUser.default, and the layer says so");

  ok(resolveUserCaps(ALICE, "discord", undefined).surfaceMonthlyTokens === undefined, "🔴 OPE-309: a slack/<id> override does NOT cap the same id on Discord — a bare-id fallback would have handed one person another's budget");
  ok(resolveUserCapsWithLayer(ALICE, "discord", undefined).layer === "config:default" && resolveUserCapsWithLayer(ALICE, "discord", undefined).caps.surfaceMonthlyUsd === 1, "OPE-309: …that person falls to the blanket perUser.default, which names no namespace to get wrong");
  ok(resolveUserCapsWithLayer(ALICE, undefined, undefined).layer === "config:default", "OPE-309: a caller that cannot name the platform matches NO named entry (fail-closed) but still gets the blanket default (skipping it is the only direction that widens)");
  budgets4 = {};
  ok(resolveUserCapsWithLayer(ALICE, "slack", "T274").layer === "none", 'OPE-274: an empty registry resolves layer "none" — never an invented allowance');

  const userRow = (over: Partial<SpendLimitRow>): SpendLimitRow => ({ org, scopeKey: ALICE_SCOPE, level: "user", ...over });
  ok(applyUserCapOverrides({ surfaceMonthlyTokens: 7, surfaceMonthlyUsd: 3 }, [userRow({ monthlyUsd: 99 })], ALICE_SCOPE).surfaceMonthlyTokens === 7, "OPE-274: a USD-only user override leaves the config TOKEN allowance in force (an override never drops a cap it didn't name)");
  ok(applyUserCapOverrides({ surfaceMonthlyTokens: 7 }, [userRow({ monthlyTokens: 99 })], userScopeKey("slack", "T274", "U_SOMEBODY_ELSE")).surfaceMonthlyTokens === 7, "OPE-274: another person's user override does not touch this person's allowance");
  ok(applyUserCapOverrides({}, [{ org, scopeKey: `${wsKey}/${DM}`, level: "surface", monthlyTokens: 99 }], ALICE_SCOPE).surfaceMonthlyTokens === undefined, 'OPE-274: applyUserCapOverrides ignores every non-user level — the two overlays never meet');
  ok(applyCapOverrides({}, [userRow({ monthlyTokens: 99 })], wsKey, `${wsKey}/${DM}`, "org").surfaceMonthlyTokens === undefined, "🔴 OPE-274: …and the PLACE overlay ignores a user row — an allowance can never replace the cap on the room");

  budgets4 = { perUser: { default: { surfaceMonthlyTokens: 50 } } };
  ok((await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE)).over, "OPE-274 precondition: the config allowance declines Alice");
  await getOperationalStore().setSpendLimit(org, ALICE_SCOPE, "user", { monthlyTokens: 1_000_000 }, { reason: "sprint", setBy: "U_ADMIN" });
  ok((await effectiveUserCaps(org, "slack", "T274", ALICE)).surfaceMonthlyTokens === 1_000_000, "OPE-274: effectiveUserCaps overlays the live user-level override on the config allowance");
  ok(!(await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE)).over, "🔴 OPE-274: …and the GATE honours it — a per-user allowance is raisable without a config PR, which is the ticket's whole point");
  await getOperationalStore().setSpendLimit(org, ALICE_SCOPE, "user", { monthlyTokens: 1_000_000 }, { expiresAt: Date.now() - 1000 });
  ok((await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE)).over, "OPE-274: an EXPIRED user override reverts to the config allowance (expiry narrows, so auto-expiry stays safe)");
  await getOperationalStore().setSpendLimit(org, ALICE_SCOPE, "user", { monthlyTokens: 1_000_000 }, {});
  budgets4 = { perSurface: { [`${wsKey}/${DM}`]: { surfaceMonthlyTokens: 5 } } };
  const stillSurface = await scopeOverBudget(mk(DM) as never, "dm", AT, "internal", ALICE);
  ok(stillSurface.over === true && stillSurface.layer === "surface", "🔴 OPE-274: a live user-level override does NOT disable the room's cap — the person axis stays independent on the runtime plane too");

  budgets4 = { perUser: { default: { surfaceMonthlyUsd: 5 }, overrides: { [`slack/T274/${ALICE}`]: { surfaceMonthlyTokens: 20 } } } };
  const limits = await getOperationalStore().spendLimits(org);
  const inventory = userCapInventory(limits);
  ok(inventory.some((r) => r.principal === "*" && r.source === "config:default" && r.monthlyUsd === 5), "OPE-274: the inventory shows the blanket perUser.default as a row an admin can read");
  ok(inventory.some((r) => r.principal === `slack/T274/${ALICE}` && r.source === "config:overrides" && r.monthlyTokens === 20), "OPE-274: …a named config entry, with its own key");
  const ovRow = inventory.find((r) => r.source === "override");
  ok(ovRow?.principal === ALICE_SCOPE && ovRow?.monthlyTokens === 1_000_000, "OPE-274: …and the live runtime override, keyed on the person's scope key — config-sourced AND override-sourced both visible");
  ok(userCapInventory(limits.filter((l) => l.level !== "user")).every((r) => r.source !== "override"), 'OPE-274: the inventory reads only level:"user" rows — a surface override never appears as somebody\'s allowance');
  budgets4 = {};
  ok(userCapInventory([]).length === 0, "OPE-274: nothing declared anywhere → an empty inventory, never an invented row");

  ok(parseScopeKey(ALICE_SCOPE).kind === "principal", "OPE-274: the `user:` marker makes a principal scope key self-describing to the ONE grammar reader");
  ok(parseScopeKey(`slack/T274/${ALICE}`).kind === "surface", "🔴 OPE-274: …which is exactly why the marker exists — an UNMARKED qualified principal key is indistinguishable from a room key (a tenant key before the rung, a SURFACE key after it)");

  await getOperationalStore().clearSpendLimit(org, ALICE_SCOPE, "user");
}

console.log(`✓ spend: ${passed} assertions passed`);
