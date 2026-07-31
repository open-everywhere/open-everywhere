import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  operationalPgliteFloorNotice,
  operationalSqliteFloorWarning,
  resolveOperationalSelection,
  registerOperationalStore,
  resetOperationalStore,
  getOperationalStore,
  _resetFloorNagForTest,
} from "../agent/operational/provider.js";
import {
  acquirePgliteLock,
  releasePgliteLock,
  pgliteLockPath,
  registerOperationalPglite,
} from "../agent/operational/pglite-client.js";
import { findChainBreak } from "../agent/audit/chain.js";
import type { OperationalStore } from "../agent/operational/store.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

delete process.env.OE_OPERATIONAL_PROVIDER;
delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = ":memory:";

function withWarnTap<T>(run: (warns: string[]) => T): T {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
  try {
    return run(warns);
  } finally {
    console.warn = real;
  }
}

{
  const r = (env: NodeJS.ProcessEnv) => resolveOperationalSelection(env);
  ok(r({}).id === "postgres" && r({}).floor === "pglite", "resolve: no env ⇒ embedded-Postgres (pglite) floor, id postgres");
  ok(r({ OE_OPERATIONAL_PROVIDER: "sqlite" }).floor === "sqlite", "resolve: explicit sqlite ⇒ sqlite floor");
  ok(r({ OE_OPERATIONAL_PROVIDER: "sqlite" }).id === "sqlite", "resolve: explicit sqlite ⇒ id sqlite");
  ok(r({ OE_OPERATIONAL_PROVIDER: "postgres" }).floor === "none", "resolve: explicit postgres ⇒ hosted (floor none)");
  const dbOnly = r({ DATABASE_URL: "postgres://x/y" });
  ok(dbOnly.id === "sqlite" && dbOnly.floor === "sqlite", "resolve: DATABASE_URL only (no provider) ⇒ legacy sqlite default, UNTOUCHED (no pglite)");
  const hosted = r({ OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: "postgres://x/y" });
  ok(hosted.id === "postgres" && hosted.floor === "none", "resolve: postgres + DATABASE_URL ⇒ hosted path untouched");
}

{
  const pg = operationalPgliteFloorNotice();
  ok(/embedded Postgres/i.test(pg), "notice: names the embedded Postgres floor");
  ok(pg.includes("DATABASE_URL"), "notice: points at DATABASE_URL for production");
  ok(pg.includes("migrate-operational"), "notice: names the migration command");
  const sq = operationalSqliteFloorWarning();
  ok(/DEPRECATED/.test(sq), "sqlite warning: says the floor is DEPRECATED");
  ok(sq.includes("SQLite"), "sqlite warning: identifies the sqlite store");
  ok(sq.includes("migrate-operational"), "sqlite warning: names the way out (migrate-operational)");
}

{
  const dir1 = join(mkdtempSync(join(tmpdir(), "oe-pglite-lock-")), "data");
  const lock1 = pgliteLockPath(dir1);
  acquirePgliteLock(dir1);
  ok(existsSync(lock1), "lock: clean acquire writes the lockfile");
  ok(JSON.parse(readFileSync(lock1, "utf8")).pid === process.pid, "lock: lockfile records our PID");
  releasePgliteLock(dir1);
  ok(!existsSync(lock1), "lock: clean release removes the lockfile");

  acquirePgliteLock(dir1);
  acquirePgliteLock(dir1);
  ok(existsSync(lock1), "lock: re-entrant acquire (same PID) does not refuse");
  releasePgliteLock(dir1);

  const dir2 = join(mkdtempSync(join(tmpdir(), "oe-pglite-lock-")), "data");
  const lock2 = pgliteLockPath(dir2);
  rmSync(dir2, { recursive: true, force: true });
  writeFileSync(lock2, JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }));
  let refused = false;
  try {
    acquirePgliteLock(dir2);
  } catch (e) {
    refused = /LOCKED by a LIVE process/.test(String(e)) && String(e).includes("PID 1");
  }
  ok(refused, "lock: a LIVE-PID lock is refused (fail-closed), naming the PID");
  ok(JSON.parse(readFileSync(lock2, "utf8")).pid === 1, "lock: a refused acquire does NOT overwrite the live lock");

  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid ?? 2147483000;
  const dir3 = join(mkdtempSync(join(tmpdir(), "oe-pglite-lock-")), "data");
  const lock3 = pgliteLockPath(dir3);
  rmSync(dir3, { recursive: true, force: true });
  writeFileSync(lock3, JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }));
  const staleLog = withWarnTap((warns) => {
    acquirePgliteLock(dir3);
    return warns.some((w) => /replacing a STALE pglite lock/.test(w));
  });
  ok(staleLog, "lock: a STALE-PID lock is taken over with a loud one-line log");
  ok(JSON.parse(readFileSync(lock3, "utf8")).pid === process.pid, "lock: takeover rewrites the lockfile to our PID");
  releasePgliteLock(dir3);
}

{
  const dataDir = join(mkdtempSync(join(tmpdir(), "oe-pglite-floor-")), "pglite");
  process.env.OE_PGLITE_DIR = dataDir;
  delete process.env.OE_OPERATIONAL_PROVIDER;
  delete process.env.DATABASE_URL;
  _resetFloorNagForTest();
  resetOperationalStore();

  await registerOperationalPglite();
  ok(existsSync(pgliteLockPath(dataDir)), "wiring: registerOperationalPglite takes the single-writer lock");

  const store: OperationalStore = withWarnTap((warns) => {
    const s = getOperationalStore();
    const s2 = getOperationalStore();
    ok(s === s2, "wiring: getOperationalStore is memoized (same instance)");
    const notices = warns.filter((w) => w.includes("embedded Postgres floor"));
    ok(notices.length === 1, "wiring: the pglite floor notice fires exactly once");
    return s;
  });
  ok(store.id === "postgres", "wiring: the floor resolves to the postgres store (one dialect everywhere)");

  const ORG = "floororg";
  await store.appendAudit({ ts: "2026-07-25T10:00:00Z", org: ORG, platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action: "memory.write", detail: { files: 1 } });
  await store.appendAudit({ ts: "2026-07-25T11:00:00Z", org: ORG, platform: "slack", workspace: "T1", surface: "C1", principalId: "U2", action: "spend.set", detail: { cap: 9 } });
  const chain = await store.readAuditChain(ORG);
  ok(chain.length === 2, "round-trip: both audit rows landed");
  ok(chain[0].prevSha === null && chain[1].prevSha !== null, "round-trip: hash chain is linked (genesis + link)");
  ok(findChainBreak(chain, { expectGenesis: true }) === null, "round-trip: audit chain verifies (no break)");

  await store.recordSpend(ORG, { surfaceKey: "slack/T1/C1", period: "2026-07", inputTokens: 100, outputTokens: 20, usdMicros: 70 });
  await store.recordSpend(ORG, { surfaceKey: "slack/T1/C1", period: "2026-07", inputTokens: 50, outputTokens: 10, usdMicros: 30 });
  const totals = await store.spendTotals(ORG, { surfaceKey: "slack/T1/C1", period: "2026-07" });
  ok(totals.inputTokens === 150 && totals.usdMicros === 100 && totals.calls === 2, "round-trip: put/get through the store (spend ledger aggregates, usd_micros summed)");

  releasePgliteLock(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgliteLockPath(dataDir), { force: true });
  delete process.env.OE_PGLITE_DIR;
}

{
  delete process.env.DATABASE_URL;
  process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
  _resetFloorNagForTest();
  resetOperationalStore();
  const sqliteWarns = withWarnTap((warns) => {
    getOperationalStore();
    getOperationalStore();
    return warns.filter((w) => w.includes("operational store is SQLite"));
  });
  ok(sqliteWarns.length === 1, "explicit-sqlite: the deprecation nag fires exactly once");
  ok(sqliteWarns[0].includes("DEPRECATED") && sqliteWarns[0].includes("migrate-operational"), "explicit-sqlite: nag is a deprecation notice naming migrate-operational");

  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  process.env.DATABASE_URL = "postgres://fake/does-not-connect";
  _resetFloorNagForTest();
  resetOperationalStore();
  registerOperationalStore({ id: "postgres" } as unknown as OperationalStore);
  const hostedWarns = withWarnTap((warns) => {
    const s = getOperationalStore();
    ok(s.id === "postgres", "hosted: getOperationalStore returns the registered postgres client");
    return warns;
  });
  ok(hostedWarns.filter((w) => w.includes("embedded Postgres floor")).length === 0, "hosted: the pglite floor notice never fires on the hosted path");
  ok(hostedWarns.filter((w) => w.includes("operational store is SQLite")).length === 0, "hosted: the sqlite nag never fires on the hosted path");

  resetOperationalStore();
  delete process.env.OE_OPERATIONAL_PROVIDER;
  delete process.env.DATABASE_URL;
}

console.log(`\n✓ pglite-floor: ${n} assertions passed`);
