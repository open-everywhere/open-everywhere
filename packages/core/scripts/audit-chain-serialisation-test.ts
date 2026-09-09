
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-audit-chain-"));
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "chain.sqlite3");

const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { initOperationalSchema, makeOperationalPostgresStore, auditChainLockKey, _resetAuditChainSerialisationWarnForTest } = await import("../agent/operational/postgres.js");
const { openTestPg, closeAllTestPg } = await import("./test-pg-driver.js");
const {
  AUDIT_CHAIN_EPOCH_ACTION,
  auditEpochDetail,
  auditEraDigest,
  auditRowSha,
  breaksByAction,
  readAuditEpochSeal,
  walkAuditChain,
} = await import("../agent/audit/chain.js");
import type { PgClient } from "../agent/operational/postgres.js";
import type { AuditChainRow, AuditEntry, OperationalStore } from "../agent/operational/store.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "acme";
const OTHER_ORG = "globex";

function entry(action: string, n: number, org = ORG): AuditEntry {
  return {
    ts: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(),
    org,
    platform: "slack",
    workspace: "T1",
    surface: `slack/T1/C${n % 3}`,
    principalId: `U${n % 5}`,
    action,
    detail: { n, note: "concurrent writer" },
  };
}

async function breakCount(store: OperationalStore, org = ORG): Promise<number> {
  const rows = await store.readAuditChain(org);
  return walkAuditChain(rows, { expectGenesis: true }).breaks.length;
}

const pg = await openTestPg();
const client: PgClient = pg.client;
await initOperationalSchema(client);

{
  const writerA = makeOperationalPostgresStore(client);
  const writerB = makeOperationalPostgresStore(client);
  const WRITES = 24;
  await Promise.all(
    Array.from({ length: WRITES }, (_, i) =>
      (i % 2 === 0 ? writerA : writerB).appendAudit(entry(i % 2 === 0 ? "control.service_call" : "surface.wake_dropped", i)),
    ),
  );

  const rows = await writerA.readAuditChain(ORG);
  ok(rows.length === WRITES, `postgres: all ${WRITES} concurrent appends landed (got ${rows.length})`);
  ok(rows[0].prevSha === null, "postgres: the org's first row is the genesis (null prev_sha)");
  const walk = walkAuditChain(rows, { expectGenesis: true });
  ok(walk.breaks.length === 0, `postgres: ${WRITES} concurrent appends chain with NO broken link (found ${walk.breaks.length})`);
  const withoutOne: AuditChainRow[] = rows.filter((r) => r.seq !== rows[5].seq);
  ok(
    walkAuditChain(withoutOne, { expectGenesis: true }).breaks.length === 1,
    "postgres: negative control — the same walk reports a break when one row is removed from the chain",
  );

  await Promise.all(Array.from({ length: 6 }, (_, i) => writerB.appendAudit(entry("connector.grant", i, OTHER_ORG))));
  ok((await breakCount(writerA)) === 0, "postgres: a second org's concurrent appends leave the first org's chain intact");
  ok((await breakCount(writerA, OTHER_ORG)) === 0, "postgres: the second org's own chain is intact");
}

{
  interface Stmt {
    readonly conn: number;
    readonly text: string;
    readonly params: readonly unknown[];
  }
  const log: Stmt[] = [];
  let connSeq = 0;
  function recording(inner: PgClient, failInsert = false): PgClient {
    const wrap = (conn: number): PgClient => ({
      query: async (text, params = []) => {
        log.push({ conn, text: text.trim().split("\n")[0].trim(), params });
        if (failInsert && text.includes("INSERT INTO audit_entry")) throw new Error("insert refused (test)");
        return inner.query(text, params);
      },
    });
    return {
      query: (text, params) => wrap(0).query(text, params),
      withConnection: async (fn) => {
        const id = ++connSeq;
        return await fn(wrap(id));
      },
    };
  }

  const store = makeOperationalPostgresStore(recording(client));
  log.length = 0;
  await store.appendAudit(entry("egress.policy", 99));

  const pinned = log.filter((s) => s.conn > 0);
  ok(pinned.length === log.length && pinned.length > 0, "postgres protocol: every statement of the append ran on the PINNED connection");
  ok(new Set(pinned.map((s) => s.conn)).size === 1, "postgres protocol: the append used exactly ONE pinned connection");
  const shape = pinned.map((s) =>
    s.text.startsWith("SELECT pg_advisory_xact_lock")
      ? "LOCK"
      : s.text.startsWith("SET LOCAL lock_timeout")
        ? "LOCK_TIMEOUT"
        : s.text.startsWith("SELECT ts,")
          ? "READ_TAIL"
          : s.text.startsWith("INSERT INTO audit_entry")
            ? "INSERT"
            : s.text.split(" ")[0].toUpperCase(),
  );
  assert.deepEqual(shape, ["BEGIN", "LOCK_TIMEOUT", "LOCK", "READ_TAIL", "INSERT", "COMMIT"], `unexpected append statement shape: ${shape.join(" → ")}`);
  passed++;
  const timeout = pinned.find((s) => s.text.startsWith("SET LOCAL lock_timeout"))!;
  ok(/^SET LOCAL lock_timeout = [1-9][0-9]*$/.test(timeout.text), `postgres protocol: the append bounds its lock wait with SET LOCAL (got ${JSON.stringify(timeout.text)})`);
  const lock = pinned.find((s) => s.text.startsWith("SELECT pg_advisory_xact_lock"))!;
  ok(lock.params[1] === auditChainLockKey(ORG), `postgres protocol: the lock is keyed on the ORG (${String(lock.params[1])} === ${auditChainLockKey(ORG)})`);

  const failing = makeOperationalPostgresStore(recording(client, true));
  log.length = 0;
  await assert.rejects(() => failing.appendAudit(entry("egress.policy", 100)), /insert refused/);
  passed++;
  const failShape = log.filter((s) => s.conn > 0).map((s) => s.text.split(" ").slice(0, 2).join(" "));
  ok(failShape.some((t) => t.startsWith("ROLLBACK")), `postgres protocol: a failed INSERT rolls back (got ${failShape.join(" → ")})`);
  ok(!failShape.some((t) => t.startsWith("COMMIT")), "postgres protocol: a failed INSERT never commits");
  ok((await breakCount(makeOperationalPostgresStore(client))) === 0, "postgres protocol: the chain is still intact after the rolled-back append");

  const bare: PgClient = { query: (text, params) => client.query(text, params) };
  const plain = makeOperationalPostgresStore(bare);
  await plain.appendAudit(entry("reply.post", 101));
  ok((await breakCount(plain)) === 0, "postgres: a client with no pinning seam still chains correctly in one process");
}

{
  let nested = 0;
  let nestedDone = false;
  const reentrant: PgClient = {
    query: async (text, params) => {
      if (nested === 0 && text.includes("FROM audit_entry")) {
        nested++;
        await inner.appendAudit(entry("audit.integrity", 200, "reentrant"));
        nestedDone = true;
      }
      return client.query(text, params);
    },
  };
  const inner = makeOperationalPostgresStore(reentrant);
  const done = await Promise.race([
    inner.appendAudit(entry("control.service_call", 201, "reentrant")).then(() => "returned" as const),
    new Promise<"deadlocked">((r) => setTimeout(() => r("deadlocked"), 4000).unref?.()),
  ]);
  ok(done === "returned", "postgres reentrancy: an append that triggers a nested append RETURNS — the critical section does not wait on itself");
  ok(nestedDone, "postgres reentrancy: the nested append really ran (the control is not vacuous)");
  const rows = await makeOperationalPostgresStore(client).readAuditChain("reentrant");
  ok(rows.length === 2, `postgres reentrancy: both rows landed (got ${rows.length})`);
  ok(rows[0].action === "audit.integrity", "postgres reentrancy: the nested row lands FIRST, before the outer tail read");
  ok(walkAuditChain(rows, { expectGenesis: true }).breaks.length === 0, "postgres reentrancy: the outer row chains onto the nested one — no fork");
}

{
  _resetAuditChainSerialisationWarnForTest();
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    await initOperationalSchema({ query: (text, params) => client.query(text, params) });
    await initOperationalSchema({ query: (text, params) => client.query(text, params) });
  } finally {
    console.warn = realWarn;
  }
  const seamWarns = warned.filter((w) => w.includes("no withConnection seam"));
  ok(seamWarns.length === 1, `boot note: a Postgres client with no pinning seam warns exactly ONCE per process (got ${seamWarns.length})`);
  ok(seamWarns[0].includes("IN-PROCESS ONLY"), "boot note: the warning says what the missing seam costs");

  _resetAuditChainSerialisationWarnForTest();
  const quiet: string[] = [];
  console.warn = (...args: unknown[]) => void quiet.push(args.map(String).join(" "));
  try {
    await initOperationalSchema({ query: (text, params) => client.query(text, params), withConnection: async (fn) => fn(client) });
  } finally {
    console.warn = realWarn;
  }
  ok(
    quiet.filter((w) => w.includes("no withConnection seam")).length === 0,
    "boot note: negative control — a client that CAN pin a connection draws no warning",
  );
}

{
  const store = sqliteOperationalStore;
  const WRITES = 24;
  await Promise.all(Array.from({ length: WRITES }, (_, i) => store.appendAudit(entry(i % 2 === 0 ? "control.service_call" : "surface.wake_dropped", i))));
  const rows = await store.readAuditChain(ORG);
  ok(rows.length === WRITES, `sqlite: all ${WRITES} concurrent appends landed (got ${rows.length})`);
  ok(walkAuditChain(rows, { expectGenesis: true }).breaks.length === 0, "sqlite: concurrent appends chain with NO broken link");
  await Promise.all(Array.from({ length: 6 }, (_, i) => store.appendAudit(entry("connector.grant", i, OTHER_ORG))));
  ok((await breakCount(store)) === 0, "sqlite: a second org's concurrent appends leave the first org's chain intact");
}

{
  const preChain: AuditChainRow[] = [1, 2, 3].map((n) => ({
    seq: n,
    ts: `2026-01-0${n}T00:00:00.000Z`,
    org: ORG,
    platform: "slack",
    workspace: "T1",
    action: "memory.write",
    detail: { n },
    prevSha: null,
  }));
  ok(walkAuditChain(preChain, { expectGenesis: true }).breaks.length === 2, "epoch: without a marker, every null link after the genesis is a break");

  const seal = {
    rowsBefore: preChain.length,
    firstSeqBefore: preChain[0].seq,
    lastSeqBefore: preChain[preChain.length - 1].seq,
    breaksBefore: 2,
    eraDigest: auditEraDigest(preChain),
  };
  const marker: AuditChainRow = {
    seq: 4,
    ts: "2026-01-04T00:00:00.000Z",
    org: ORG,
    platform: "db",
    workspace: "postgres",
    principalId: "rowan",
    action: AUDIT_CHAIN_EPOCH_ACTION,
    detail: auditEpochDetail(seal),
    prevSha: null,
  };
  const after: AuditChainRow = {
    seq: 5,
    ts: "2026-01-05T00:00:00.000Z",
    org: ORG,
    platform: "slack",
    workspace: "T1",
    action: "reply.post",
    prevSha: auditRowSha(marker, null),
  };
  const sealed = [...preChain, marker, after];
  const walk = walkAuditChain(sealed, { expectGenesis: true });
  ok(walk.breaks.length === 0, "epoch: a VERIFIED seal covers the era — its link breaks stop being listed one by one");
  ok(walk.breaksInsideSealedEra === 2, "epoch: the walk says how many link breaks the seal covers, so nothing vanishes silently");
  ok(walk.sealedThroughIndex === 3, "epoch: the walk names where the sealed era ends");
  ok(walk.epochs.length === 1 && walk.epochs[0].seq === 4, "epoch: the walk REPORTS the epoch it crossed (an unexplained epoch is a finding)");
  ok(walk.epochs[0].sealVerified, "epoch: a full walk re-verifies the era digest and says so");
  const understated: AuditChainRow = { ...marker, detail: auditEpochDetail({ ...seal, breaksBefore: 0 }) };
  const understatedWalk = walkAuditChain([...preChain, understated, { ...after, prevSha: auditRowSha(understated, null) }], { expectGenesis: true });
  ok(!understatedWalk.epochs[0].sealVerified, "epoch: a marker that under-reports its era's breaks does NOT verify");
  ok(
    understatedWalk.breaks.some((b) => b.seq === 4 && b.reason.includes("broken link(s) in the era it covers")),
    "epoch: the walk names the break-count disagreement",
  );
  ok(understatedWalk.breaksInsideSealedEra === 0, "epoch: an under-reporting seal suppresses nothing — its era's breaks stay listed");
  ok(understatedWalk.breaks.length === 3, "epoch: the era's two null links are still reported alongside the seal complaint");

  const tampered = sealed.map((r) => (r.seq === 2 ? { ...r, detail: { n: 999 } } : r));
  const tamperedWalk = walkAuditChain(tampered, { expectGenesis: true });
  ok(
    tamperedWalk.breaks.some((b) => b.seq === 4 && b.reason.includes("era digest")),
    "epoch: mutating a PRE-epoch row breaks the seal — the era digest is real tamper evidence for rows before the chain",
  );
  ok(!tamperedWalk.epochs[0].sealVerified, "epoch: the boundary is reported with sealVerified false");

  const shortened = [preChain[0], preChain[1], marker, { ...after, seq: 5 }];
  ok(
    walkAuditChain(shortened, { expectGenesis: true }).breaks.some((b) => b.seq === 4 && b.reason.includes("preceding row")),
    "epoch: deleting a pre-epoch row is caught — the seal's row count disagrees",
  );

  for (const bad of [
    { ...marker, detail: {} },
    { ...marker, detail: { epoch: { rows_before: 3, breaks_before: 2 } } },
    { ...marker, detail: { epoch: { ...auditEpochDetail(seal).epoch as Record<string, unknown>, era_digest: "not-a-sha" } } },
    { ...marker, action: "memory.write" },
    { ...marker, prevSha: "0".repeat(64) },
  ]) {
    ok(readAuditEpochSeal(bad) === null, `epoch: a malformed marker is NOT read as a seal (${JSON.stringify(bad.detail).slice(0, 48)})`);
  }
  ok(
    walkAuditChain([...preChain, { ...marker, detail: {} }], { expectGenesis: true }).breaks.some((b) => b.seq === 4),
    "epoch: a marker with no seal is an ordinary null link — a break",
  );

  const windowWalk = walkAuditChain([preChain[1], preChain[2], marker, after], { expectGenesis: false });
  ok(windowWalk.epochs.length === 1 && !windowWalk.epochs[0].sealVerified, "epoch: a window reports the epoch UNVERIFIED — it does not hold the era");
  ok(windowWalk.breaksInsideSealedEra === 0 && windowWalk.sealedThroughIndex === -1, "epoch: a window suppresses nothing behind an unverifiable seal");
  ok(windowWalk.breaks.length === 1, "epoch: the window still reports the pre-epoch null link it can see");

  ok(
    tamperedWalk.breaks.length > 1 && tamperedWalk.breaksInsideSealedEra === 0,
    "epoch: a seal that fails its own digest hides no link break",
  );

  const orphaned = walkAuditChain([marker, after], { expectGenesis: true });
  ok(orphaned.epochs.length === 1 && orphaned.epochs[0].index === 0, "epoch: a marker at index 0 is REPORTED as an epoch, not read as a genesis row");
  ok(!orphaned.epochs[0].sealVerified, "epoch: a marker at index 0 whose era is gone does NOT verify");
  ok(
    orphaned.breaks.some((b) => b.seq === marker.seq && b.reason.includes("preceding row")),
    "epoch: the walk names the disagreement — the seal claims an era that is not present",
  );
  ok(orphaned.breaksInsideSealedEra === 0 && orphaned.sealedThroughIndex === -1, "epoch: a marker at index 0 with a missing era suppresses nothing");

  const orphanedWindow = walkAuditChain([marker, after], { expectGenesis: false });
  ok(orphanedWindow.epochs.length === 1 && !orphanedWindow.epochs[0].sealVerified, "epoch: a window whose first row is a marker still reports the epoch");
  ok(orphanedWindow.breaks.length === 0, "epoch: that window reports no break — the rows it holds do link");

  const emptyEra: AuditChainRow = { ...marker, detail: auditEpochDetail({ rowsBefore: 0, firstSeqBefore: null, lastSeqBefore: null, breaksBefore: 0, eraDigest: auditEraDigest([]) }) };
  const emptyEraWalk = walkAuditChain([emptyEra, { ...after, prevSha: auditRowSha(emptyEra, null) }], { expectGenesis: true });
  ok(emptyEraWalk.epochs.length === 1 && emptyEraWalk.epochs[0].sealVerified, "epoch: a marker at index 0 that seals ZERO rows verifies");
  ok(emptyEraWalk.breaks.length === 0, "epoch: that walk reports no break");
}

for (const [engine, store] of [
  ["postgres", makeOperationalPostgresStore(client)],
  ["sqlite", sqliteOperationalStore],
] as const) {
  const org = `seal-${engine}`;
  ok((await store.sealAuditChainEpoch(org, "rowan")) === null, `${engine}: sealing an org with no rows seals nothing`);
  for (let i = 0; i < 3; i++) await store.appendAudit(entry("memory.write", i, org));
  const written = await store.sealAuditChainEpoch(org, "rowan");
  ok(written !== null && written.seal.rowsBefore === 3, `${engine}: the seal covers every row that existed (${String(written?.seal.rowsBefore)})`);
  ok(written!.seal.breaksBefore === 0, `${engine}: a sound era seals with zero recorded breaks`);
  const rows = await store.readAuditChain(org);
  ok(rows.length === 4 && rows[3].action === AUDIT_CHAIN_EPOCH_ACTION && rows[3].prevSha === null, `${engine}: the marker is appended with a null prev_sha`);
  ok(rows[3].principalId === "rowan", `${engine}: the marker records WHO sealed it`);
  ok(written!.markerSeq === rows[3].seq, `${engine}: the seal returns the marker's OWN seq (${String(written!.markerSeq)} === ${rows[3].seq})`);
  const walk = walkAuditChain(rows, { expectGenesis: true });
  ok(walk.breaks.length === 0 && walk.epochs.length === 1 && walk.epochs[0].sealVerified, `${engine}: the freshly sealed chain verifies, seal included`);
  ok((await store.sealAuditChainEpoch(org, "rowan")) === null, `${engine}: sealing again with no rows since seals nothing`);
  await store.appendAudit(entry("reply.post", 9, org));
  ok((await breakCount(store, org)) === 0, `${engine}: rows appended AFTER the epoch chain onto the marker`);

  const raceOrg = `seal-race-${engine}`;
  for (let i = 0; i < 4; i++) await store.appendAudit(entry("memory.write", i, raceOrg));
  const raced = await Promise.all([
    store.appendAudit(entry("control.service_call", 10, raceOrg)),
    store.appendAudit(entry("control.service_call", 11, raceOrg)),
    store.sealAuditChainEpoch(raceOrg, "rowan"),
    store.appendAudit(entry("surface.wake_dropped", 12, raceOrg)),
    store.appendAudit(entry("surface.wake_dropped", 13, raceOrg)),
  ]);
  ok(raced[2] !== null, `${engine}: the seal landed even while appends raced it`);
  const racedRows = await store.readAuditChain(raceOrg);
  const racedWalk = walkAuditChain(racedRows, { expectGenesis: true });
  ok(racedWalk.breaks.length === 0, `${engine}: a seal racing appends leaves NO broken link (found ${racedWalk.breaks.length})`);
  ok(racedWalk.epochs.length === 1, `${engine}: exactly one epoch marker landed`);
  ok(racedWalk.epochs[0].sealVerified, `${engine}: the raced seal still describes exactly the rows before it`);
  const racedMarker = racedRows.find((r) => r.action === AUDIT_CHAIN_EPOCH_ACTION)!;
  ok(racedRows.at(-1)!.seq !== racedMarker.seq, `${engine}: the race really put rows after the marker (the hazard is real)`);
  ok(raced[2]!.markerSeq === racedMarker.seq, `${engine}: the raced seal returns the MARKER's seq, not the chain's last row`);
}

{
  const rows = await makeOperationalPostgresStore(client).readAuditChain(ORG);
  ok(rows.length > 10, "enumerate: the fixture chain has rows to damage");
  const removedSeqs = [rows[3].seq, rows[6].seq, rows[9].seq];
  const damaged = rows.filter((r) => !removedSeqs.includes(r.seq));
  const walk = walkAuditChain(damaged, { expectGenesis: true });
  ok(walk.breaks.length === 3, `enumerate: EVERY break is reported, not the first (got ${walk.breaks.length})`);
  assert.deepEqual(
    walk.breaks.map((b) => b.seq),
    [rows[4].seq, rows[7].seq, rows[10].seq],
    "enumerate: the reported seqs are the successors of the removed rows",
  );
  passed++;
  const oneRemoved = rows.filter((r) => r.seq !== rows[3].seq);
  ok(walkAuditChain(oneRemoved, { expectGenesis: true }).breaks.length === 1, "enumerate: the walk resyncs — one damage site is one break, not a cascade");

  const counts = breaksByAction(walk.breaks);
  ok(counts.reduce((n, c) => n + c.count, 0) === 3, "enumerate: the per-action counts total the break count");
  const skewed = breaksByAction([
    { index: 1, seq: 1, ts: "t", org: ORG, action: "surface.wake_dropped", reason: "r", expectedPrev: null, actualPrev: null },
    { index: 2, seq: 2, ts: "t", org: ORG, action: "reply.post", reason: "r", expectedPrev: null, actualPrev: null },
    { index: 3, seq: 3, ts: "t", org: ORG, action: "surface.wake_dropped", reason: "r", expectedPrev: null, actualPrev: null },
  ]);
  assert.deepEqual(
    skewed,
    [
      { action: "surface.wake_dropped", count: 2 },
      { action: "reply.post", count: 1 },
    ],
    "enumerate: the per-action counts come back highest-first",
  );
  passed++;
  ok(breaksByAction([]).length === 0, "enumerate: no breaks means no counts");
}

await closeAllTestPg();
console.log(`✓ audit chain serialisation, epoch + enumerating walk: ${passed} assertions passed`);
