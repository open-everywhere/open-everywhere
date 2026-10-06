import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const dir = mkdtempSync(join(tmpdir(), "oe-control-write-driver-"));
const db = join(dir, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = db;

const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { ControlWriteDriver, resolveControlWriteConfig, tailStderrLines, composeControlConnectFailure, CONTROL_WRITE_CONNECT_TIMEOUT_MS } = await import(
  "./e2e/control-write-driver.js"
);

let n = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  n++;
}

ok(CONTROL_WRITE_CONNECT_TIMEOUT_MS >= 120_000, `the connect timeout (${CONTROL_WRITE_CONNECT_TIMEOUT_MS} ms) is well past the ~30 s owner-mode start`);

ok(tailStderrLines("a\nb\n\n  c  \nd\n", 2) === "  c\nd", "tailStderrLines keeps the newest non-blank lines, trailing space trimmed and leading indentation (a stack frame) kept");
ok(tailStderrLines("", 5) === "", "tailStderrLines on empty stderr is empty");
{
  const msg = composeControlConnectFailure(new Error("MCP request timed out"), "Error: password authentication failed\n  at connectOperatorStoreForCli");
  ok(msg.includes("could not start against the pinned store"), "the composed failure keeps the base sentence");
  ok(msg.includes("MCP request timed out"), "…and carries the SDK's original error, which the old catch {} threw away");
  ok(msg.includes("password authentication failed"), "…and the child's stderr, which names the real cause");
  const noStderr = composeControlConnectFailure(new Error("MCP request timed out"), "");
  ok(noStderr.includes("MCP request timed out") && noStderr.includes("no stderr"), "with no stderr it still names the cause and says the child was silent");
}

{
  let threw: unknown;
  try {
    await ControlWriteDriver.connect({ org: "fixture-org", storeEnv: { OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: db } }, "slack/T1/C-OWNED", { connectTimeoutMs: 1 });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error, "a 1 ms connect budget cannot cover the child's start and throws");
  ok(threw instanceof Error && threw.message.includes("could not start against the pinned store"), "…and the throw is the composed failure, not a raw SDK error");
  ok(threw instanceof Error && threw.message.includes(":"), "…carrying the surfaced cause after the base sentence, which the old fixed string never did");
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

  ok((await driver.inspectOrgHalt()) === undefined, "the org-wide read sees no halt on a clean store");
  await sqliteOperationalStore.setHalt(org, { orgWide: true }, { setBy: "U-driver", setAt: "2026-02-11T10:42:05.000Z", setRef: "wake-org" });
  ok((await driver.inspectHalt()) === undefined, "the surface read does NOT see the org-wide row — the blind spot OPE-2191 names");
  const orgHalt = await driver.inspectOrgHalt();
  ok(orgHalt?.orgWide === true && orgHalt.setBy === "U-driver" && orgHalt.setAt === "2026-02-11T10:42:05.000Z" && orgHalt.setRef === "wake-org", "the org-wide read returns the exact ownership facts from the stdio store");
  await sqliteOperationalStore.setHalt(org, { orgWide: true }, { setBy: "U-operator" });
  ok((await driver.clearOwnedOrgHalt(orgHalt!)) === "changed", "a stale org-wide handle cannot clear a concurrent operator restamp");
  const currentOrg = await driver.inspectOrgHalt();
  ok(currentOrg?.setBy === "U-operator", "the operator's org-wide halt remains active after the stale clear");
  ok((await driver.clearOwnedOrgHalt(currentOrg!)) === "cleared" && (await driver.inspectOrgHalt()) === undefined, "the exact unchanged org-wide handle clears through stdio");

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
  await removeTempDir(dir);
}

console.log(`✓ e2e control write driver: ${n} assertions passed`);
