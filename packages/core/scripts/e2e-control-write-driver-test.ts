import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oe-control-write-driver-"));
const db = join(dir, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = db;

const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { ControlWriteDriver, resolveControlWriteConfig } = await import("./e2e/control-write-driver.js");

let n = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  n++;
}

const off = resolveControlWriteConfig({});
ok(!off.ok && off.missing.includes("E2E_CONTROL_LOCAL_WRITE=1") && off.missing.includes("DATABASE_URL"), "live config fails closed without explicit arming and hosted store");
const live = resolveControlWriteConfig({ E2E_CONTROL_LOCAL_WRITE: "1", E2E_ORG: "acme", OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: "postgres://not-opened.example.invalid/db" });
ok(live.ok && live.cfg.org === "acme" && Object.keys(live.cfg.storeEnv).sort().join(",") === "DATABASE_URL,OE_OPERATIONAL_PROVIDER", "live config forwards only the pinned store selector/credential");

const org = "fixture-org";
const surfaceKey = "slack/T1/C-OWNED";
const driver = await ControlWriteDriver.connect({ org, storeEnv: { OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: db } }, surfaceKey);
try {
  await driver.assertReady();
  ok((await driver.inspectHalt()) === undefined && (await driver.inspectSpendLimit()) === undefined, "read-only preflight sees an empty exact address");

  await sqliteOperationalStore.setHalt(org, { orgWide: false, level: "surface", scopeKey: surfaceKey }, { setBy: "U-driver", setAt: "2026-05-26T05:32:00.123Z", setRef: "wake-owned" });
  const halt = await driver.inspectHalt();
  ok(halt?.scopeKey === surfaceKey && halt.setBy === "U-driver" && halt.setAt === "2026-05-26T05:32:00.123Z" && halt.setRef === "wake-owned", "halt inspection returns exact time + wake ownership facts from the stdio store");
  await sqliteOperationalStore.setHalt(org, { orgWide: false, level: "surface", scopeKey: surfaceKey }, { setBy: "U-operator" });
  ok((await driver.clearOwnedHalt(halt!)) === "changed", "a stale halt handle cannot clear a concurrent operator restamp");
  const currentHalt = await driver.inspectHalt();
  ok(currentHalt?.setBy === "U-operator", "the concurrent operator halt remains active after the stale clear");
  ok((await driver.clearOwnedHalt(currentHalt!)) === "cleared", "the exact unchanged halt handle clears through stdio");

  const first = await driver.setTemporarySpendLimit({ monthlyTokens: 1, ttlSeconds: 1800, reason: "run-owned" });
  ok(first.outcome === "created" && first.handle.scopeKey === surfaceKey && first.handle.setBy === "local-operator", "temporary spend insert returns an exact ownership handle");
  const occupied = await driver.setTemporarySpendLimit({ monthlyTokens: 99, ttlSeconds: 1800, reason: "must-not-replace" });
  ok(occupied.outcome === "occupied" && (await driver.inspectSpendLimit())?.monthlyTokens === 1, "insert-if-absent refuses to replace an occupied address");
  if (first.outcome !== "created") throw new Error("fixture setup did not create spend handle");
  await sqliteOperationalStore.setSpendLimit(org, surfaceKey, "surface", { monthlyTokens: 2 }, { expiresAt: first.handle.expiresAt, reason: "operator-changed", setBy: "somebody-else" });
  ok((await driver.clearOwnedSpendLimit(first.handle)) === "changed", "a stale spend handle cannot clear a concurrent operator replacement");
  const changed = await driver.inspectSpendLimit();
  ok(changed?.monthlyTokens === 2 && changed.setBy === "somebody-else", "the concurrent spend override remains after the stale clear");
  await sqliteOperationalStore.clearSpendLimit(org, surfaceKey, "surface");
  const final = await driver.setTemporarySpendLimit({ monthlyTokens: 1, ttlSeconds: 1800, reason: "run-owned-final" });
  if (final.outcome !== "created") throw new Error("final fixture spend insert did not create");
  ok((await driver.clearOwnedSpendLimit(final.handle)) === "cleared", "the exact unchanged spend handle clears through stdio");
} finally {
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ e2e control write driver: ${n} assertions passed`);
