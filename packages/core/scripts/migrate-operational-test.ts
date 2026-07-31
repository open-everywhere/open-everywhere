import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { OPERATIONAL_TABLES } from "../agent/operational/store.js";
import { migrateOperational } from "./migrate-operational-lib.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "oe-mig-")), name);
}
function newPg(): PgClient {
  const db = new PGlite();
  return { query: (text, params) => db.query(text, params ? [...params] : undefined) };
}
async function pgTableNames(target: PgClient): Promise<string[]> {
  const { rows } = await target.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  return (rows as { tablename: string }[]).map((r) => r.tablename);
}
const sortedEq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

{
  process.env.OE_SQLITE_PATH = ":memory:";
  const sqliteMod = await import("../agent/operational/sqlite.js");
  sqliteMod._resetOperationalDbForTest();
  const sqliteTables = sqliteMod.sqliteOperationalTableNames();
  ok(sortedEq(sqliteTables, [...OPERATIONAL_TABLES]), "honesty: sqlite creates exactly OPERATIONAL_TABLES");

  const pg = newPg();
  await initOperationalSchema(pg);
  const pgTables = await pgTableNames(pg);
  ok(sortedEq(pgTables, [...OPERATIONAL_TABLES]), "honesty: a freshly-init'd Postgres has exactly OPERATIONAL_TABLES");
}

const { sqliteOperationalStore, _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");

async function seedSource(path: string, seed: (store: typeof sqliteOperationalStore) => Promise<void>): Promise<void> {
  process.env.OE_SQLITE_PATH = path;
  _resetOperationalDbForTest();
  await seed(sqliteOperationalStore);
  _resetOperationalDbForTest();
}
function rawSqlite(path: string): DatabaseSync {
  return new DatabaseSync(path);
}
function roSqlite(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

{
  const srcPath = tmpFile("full.sqlite3");
  await seedSource(srcPath, async (s) => {
    await s.appendAudit({ ts: "2026-07-01T10:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action: "memory.write", detail: { tier: "surface", files: 2 } });
    await s.appendAudit({ ts: "2026-07-01T11:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U2", action: "egress.policy", detail: { hosts: 3, enforced: false } });
    await s.appendAudit({ ts: "2026-07-01T12:00:00Z", org: "acme", platform: "slack", workspace: "T2", surface: "C9", principalId: "U1", action: "spend.set" });
    await s.appendAudit({ ts: "2026-07-01T09:00:00Z", org: "globex", platform: "linear", workspace: "ORG1", surface: "ISS9", principalId: "L3", action: "memory.write" });
    await s.recordSpend("acme", { surfaceKey: "slack/T1/C1", principalId: "U1", model: "m-1", period: "2026-07", inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, usdMicros: 1400 });
    await s.recordSpend("acme", { surfaceKey: "slack/T1/C1", principalId: "U1", model: "m-1", period: "2026-07", inputTokens: 50, outputTokens: 10, usdMicros: 600 });
    await s.addRoutine({ id: "r-1", org: "acme", surfaceKey: "slack/T1/C1", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "do it", createdAt: "2026-07-01T00:00:00Z", status: "active", consecutiveFailures: 0 });
    await s.appendUsageEvent({ org: "acme", surfaceKey: "slack/T1/C1", sessionId: "sess-1", principalId: "U1", ts: "2026-07-01T10:00:00Z", kind: "channel", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await s.setConnectorOverride("acme", "slack/T1/C1", "notion", true, { reason: "granted", setBy: "U1" });
    await s.setConnectorOverride("acme", "slack/T1/C2", "github", false, { reason: "revoked", setBy: "U1" });
    await s.markEngaged("acme", "slack/T1/C1", "1720000000.0001", "2026-07-01T10:00:00Z", { participating: true });
    await s.markEngaged("acme", "slack/T1/C1", "1720000000.0002", "2026-07-01T10:05:00Z", { participating: true });
    await s.markStopped("acme", "slack/T1/C1", "1720000000.0002");
    await s.setMeta("telemetry_instance_id", "inst-abc-123");
    await s.putUnifiedWakeTarget("acme", "w-pending", JSON.stringify({ platform: "slack", channelId: "C_MIG" }), "2026-07-01T10:00:00Z", 6 * 60 * 60 * 1000, "oe-dom:payments:oe-sup:g1");
    await s.putUnifiedWakeTarget("acme", "w-answered", JSON.stringify({ platform: "github", owner: "o", repo: "r", issueNumber: 3 }), "2026-07-01T10:00:00Z", 6 * 60 * 60 * 1000, "oe-dom:payments:oe-sup:g1");
    await s.markUnifiedWakeAnswered("acme", "w-answered", "2026-07-01T10:30:00Z", "turn-mig");
    const srcPending = await s.getUnifiedWakeRecord("acme", "w-pending");
    ok(srcPending?.windowToken === "oe-dom:payments:oe-sup:g1" && srcPending?.answeredAt === undefined, "sqlite: a fresh wake row round-trips its window token and reads PENDING");
    const srcAnswered = await s.getUnifiedWakeRecord("acme", "w-answered");
    ok(srcAnswered?.answeredAt === "2026-07-01T10:30:00Z" && srcAnswered?.answeredTurnId === "turn-mig", "sqlite: markUnifiedWakeAnswered stamps answeredAt + answeredTurnId");
    await s.putUnifiedWakeTarget("acme", "w-answered", JSON.stringify({ platform: "github", owner: "o", repo: "r", issueNumber: 3 }), "2026-07-01T11:00:00Z", 6 * 60 * 60 * 1000, "oe-dom:payments:oe-sup:g1");
    const srcRePut = await s.getUnifiedWakeRecord("acme", "w-answered");
    ok(srcRePut?.answeredAt === "2026-07-01T10:30:00Z" && srcRePut?.createdAt === "2026-07-01T11:00:00Z", "sqlite: re-registering an answered wake refreshes created_at but NEVER clears the mark");
  });

  const source = roSqlite(srcPath);
  const target = newPg();
  const report = await migrateOperational({ source, target, memoryProvider: "git" });
  source.close();

  ok(report.chainOrgs === 2, "full: both org audit chains verified on target");
  ok(report.memory.status.startsWith("git"), "full: git memory backing reported nothing-to-migrate");

  const store = makeOperationalPostgresStore(target);
  const auditAcme = await store.readAudit({ org: "acme" });
  ok(auditAcme.length === 3, "full: acme audit rows copied (3)");
  const spend = await store.spendTotals("acme", { surfaceKey: "slack/T1/C1", period: "2026-07" });
  ok(spend.inputTokens === 150 && spend.cacheReadTokens === 7 && spend.usdMicros === 2000 && spend.calls === 2, "full: spend ledger copied verbatim (dimensions + usd_micros preserved)");
  ok((await store.listRoutines("acme", "slack/T1/C1")).length === 1, "full: routine copied");
  ok((await store.usageForSession("acme", "sess-1")).length === 1, "full: usage_events copied (identity re-assigned)");
  ok((await store.getMeta("telemetry_instance_id")) === "inst-abc-123", "full: instance_meta copied");

  const conns = await store.allConnectorOverrides("acme");
  const notion = conns.find((c) => c.connector === "notion");
  const github = conns.find((c) => c.connector === "github");
  ok(notion?.granted === true && github?.granted === false, "full: connector_override.granted booleans round-trip");
  const eng = await store.getEngagement("acme", "slack/T1/C1", "1720000000.0002");
  ok(eng?.participating === true && eng?.stopped === true, "full: thread_engagement participating/stopped booleans round-trip");

  const migPending = await store.getUnifiedWakeRecord("acme", "w-pending");
  ok(migPending?.windowToken === "oe-dom:payments:oe-sup:g1" && migPending?.answeredAt === undefined, "full: unified_wake_target.window_token migrates (and a PENDING row stays pending)");
  const migAnswered = await store.getUnifiedWakeRecord("acme", "w-answered");
  ok(migAnswered?.answeredAt === "2026-07-01T10:30:00Z" && migAnswered?.answeredTurnId === "turn-mig", "full: unified_wake_target answered_at + answered_turn_id migrate verbatim");

  const rawChain = await store.readAuditChain("acme");
  ok(rawChain[0].prevSha === null, "full: acme genesis row keeps null prev_sha (verbatim)");
  ok(rawChain[1].prevSha !== null && rawChain[2].prevSha !== null, "full: later rows keep their copied prev_sha links");
}

{
  const srcPath = tmpFile("small.sqlite3");
  await seedSource(srcPath, async (s) => {
    await s.recordSpend("acme", { surfaceKey: "slack/T1/C1", period: "2026-07", inputTokens: 1, outputTokens: 1 });
  });
  const source = roSqlite(srcPath);
  const target = newPg();
  await initOperationalSchema(target);
  await target.query("INSERT INTO spend_ledger (org_id, surface_key, period, input_tokens, output_tokens, calls) VALUES ($1,$2,$3,$4,$5,$6)", ["x", "s", "2026-07", 1, 1, 1]);

  let threw = false;
  try {
    await migrateOperational({ source, target, memoryProvider: "git" });
  } catch (e) {
    threw = /not empty/i.test(String(e));
  }
  ok(threw, "non-empty: migrating into a populated target is refused");

  await migrateOperational({ source, target, forceEmptyCheckOff: true, memoryProvider: "git" });
  ok(true, "non-empty: --force-empty-check-off allows migrating into a populated target");
  source.close();
}

{
  const srcPath = tmpFile("corrupt.sqlite3");
  await seedSource(srcPath, async (s) => {
    await s.appendAudit({ ts: "2026-07-01T10:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action: "memory.write", detail: { files: 1 } });
    await s.appendAudit({ ts: "2026-07-01T11:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U2", action: "egress.policy", detail: { hosts: 2 } });
    await s.appendAudit({ ts: "2026-07-01T12:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U3", action: "spend.set", detail: { cap: 9 } });
  });
  const w = rawSqlite(srcPath);
  w.prepare("UPDATE audit_entry SET detail = ? WHERE action = ?").run(JSON.stringify({ hosts: 999 }), "egress.policy");
  w.close();

  const source = roSqlite(srcPath);
  const target = newPg();
  let threw = false;
  try {
    await migrateOperational({ source, target, memoryProvider: "git" });
  } catch (e) {
    threw = /chain/i.test(String(e));
  }
  source.close();
  ok(threw, "corrupt-chain: a tampered source chain fails the migration loud (chain verify on target)");
}

{
  const srcPath = tmpFile("mem.sqlite3");
  await seedSource(srcPath, async (s) => {
    await s.recordSpend("acme", { surfaceKey: "slack/T1/C1", period: "2026-07", inputTokens: 1, outputTokens: 1 });
  });
  const w = rawSqlite(srcPath);
  w.exec(`
    CREATE TABLE IF NOT EXISTS memory_file (org_id TEXT NOT NULL, tier_path TEXT NOT NULL, rel_path TEXT NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (org_id, tier_path, rel_path));
    CREATE TABLE IF NOT EXISTS memory_tier (org_id TEXT NOT NULL, tier_path TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, tier_path));
  `);
  w.prepare("INSERT INTO memory_file (org_id, tier_path, rel_path, content, updated_at) VALUES (?,?,?,?,?)").run("acme", "org/acme", "notes.md", "hello", 1751362800000);
  w.prepare("INSERT INTO memory_tier (org_id, tier_path, version) VALUES (?,?,?)").run("acme", "org/acme", 5);
  w.close();

  const source = roSqlite(srcPath);
  const target = newPg();
  const report = await migrateOperational({ source, target, memoryProvider: "sqlite" });
  source.close();

  ok(report.memory.status.startsWith("sqlite"), "memory: sqlite backing reported copied");
  ok((report.memory.tables ?? []).some((t) => t.table === "memory_file" && t.target === 1), "memory: memory_file row copied");
  const { rows } = await target.query("SELECT content, updated_at FROM memory_file WHERE org_id = $1 AND rel_path = $2", ["acme", "notes.md"]);
  ok(rows.length === 1 && (rows[0] as { content: string }).content === "hello", "memory: memory_file content lands in postgres");
  const ver = await target.query("SELECT version FROM memory_tier WHERE org_id = $1", ["acme"]);
  ok(Number((ver.rows[0] as { version: number | string }).version) === 5, "memory: memory_tier version copied");
}

{
  process.env.OE_SQLITE_PATH = ":memory:";
  const provider = await import("../agent/operational/provider.js");
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  const prevProv = process.env.OE_OPERATIONAL_PROVIDER;
  try {
    process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
    provider._resetFloorNagForTest();
    provider.resetOperationalStore();
    provider.getOperationalStore();
    provider.getOperationalStore();
    const sqliteWarns = warns.filter((w) => w.includes("operational store is SQLite"));
    ok(sqliteWarns.length === 1, "boot-nag: fires exactly once under sqlite");
    ok(sqliteWarns[0].includes("migrate-operational"), "boot-nag: names the migration command");
    ok(provider.operationalSqliteFloorWarning().includes("DATABASE_URL"), "boot-nag: the warning is actionable (DATABASE_URL + postgres)");

    warns.length = 0;
    provider._resetFloorNagForTest();
    provider.resetOperationalStore();
    provider.registerOperationalStore({ id: "postgres" } as unknown as Parameters<typeof provider.registerOperationalStore>[0]);
    process.env.OE_OPERATIONAL_PROVIDER = "postgres";
    provider.getOperationalStore();
    ok(warns.filter((w) => w.includes("operational store is SQLite")).length === 0, "boot-nag: never fires under postgres");
  } finally {
    console.warn = realWarn;
    provider.resetOperationalStore();
    if (prevProv === undefined) delete process.env.OE_OPERATIONAL_PROVIDER;
    else process.env.OE_OPERATIONAL_PROVIDER = prevProv;
  }
}

console.log(`\n✓ migrate-operational: ${n} assertions passed`);
