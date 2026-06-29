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

rmSync(dir, { recursive: true, force: true });
console.log(`✓ spend: ${passed} assertions passed`);
