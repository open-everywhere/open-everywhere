import { _resetPolicySpanAtomicityWarnForTest, auditIntegrityCause, initOperationalSchema, verifyAppendOnlyAudit, type PgClient } from "../agent/operational/postgres.js";
import { closeAllTestPg, openTestPg } from "./test-pg-driver.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

interface Seen {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly pinned: boolean;
}

async function advisoryLocks(client: PgClient): Promise<{ classid: number; objid: number }[]> {
  const { rows } = await client.query("SELECT classid, objid FROM pg_locks WHERE locktype = 'advisory'");
  return (rows as { classid: number | string; objid: number | string }[]).map((r) => ({ classid: Number(r.classid), objid: Number(r.objid) }));
}

async function policyNames(client: PgClient, table: string): Promise<string[]> {
  const { rows } = await client.query("SELECT p.polname AS name FROM pg_policy p WHERE p.polrelid = to_regclass($1) ORDER BY p.polname", [table]);
  return (rows as { name: string }[]).map((r) => r.name);
}

async function latestIntegrityDetail(client: PgClient): Promise<Record<string, unknown> | undefined> {
  const { rows } = await client.query("SELECT detail FROM audit_entry WHERE action = 'audit.integrity' ORDER BY seq DESC LIMIT 1");
  const r = rows[0] as { detail: string | null } | undefined;
  return r?.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined;
}

function recordingClient(
  raw: PgClient,
  opts: { failOn?: (sql: string) => boolean; probeLocksAfter?: (sql: string) => boolean } = {},
): { client: PgClient; seen: Seen[]; probed: { classid: number; objid: number }[][] } {
  const seen: Seen[] = [];
  const probed: { classid: number; objid: number }[][] = [];
  const make = (pinned: boolean): PgClient => ({
    query: async (sql, params) => {
      seen.push({ sql, params: params ?? [], pinned });
      if (opts.failOn?.(sql)) throw new Error(`simulated abort inside the policy span: ${sql.slice(0, 40)}`);
      const result = await raw.query(sql, params);
      if (opts.probeLocksAfter?.(sql)) probed.push(await advisoryLocks(raw));
      return result;
    },
    withConnection: async <T>(fn: (c: PgClient) => Promise<T>): Promise<T> => fn(make(true)),
  });
  return { client: make(false), seen, probed };
}

const isDropPolicy = (s: string): boolean => s.startsWith("DROP POLICY");
const isCreatePolicy = (s: string): boolean => s.startsWith("CREATE POLICY");
const isAdvisoryLock = (s: string): boolean => s.includes("pg_advisory_xact_lock");

function policyTarget(sql: string): string | undefined {
  const m = /^(?:CREATE|DROP) POLICY (?:IF EXISTS )?(\w+) ON (\w+)/u.exec(sql);
  return m ? `${m[2]}.${m[1]}` : undefined;
}

const pg = await openTestPg();
const raw: PgClient = pg.client;

{
  const { client, seen, probed } = recordingClient(raw, { probeLocksAfter: isAdvisoryLock });
  await initOperationalSchema(client);

  const begin = seen.findIndex((s) => s.sql === "BEGIN" && s.pinned);
  const lock = seen.findIndex((s) => isAdvisoryLock(s.sql));
  const firstDrop = seen.findIndex((s) => isDropPolicy(s.sql));
  const lastCreate = seen.map((s) => isCreatePolicy(s.sql)).lastIndexOf(true);
  const commit = seen.findIndex((s, i) => s.sql === "COMMIT" && s.pinned && i > lastCreate);

  ok(begin >= 0 && lock > begin && firstDrop > lock, "🔴 OPE-1994: BEGIN, then the advisory lock, then the FIRST DROP POLICY — the span never drops a policy outside the transaction");
  ok(lastCreate > firstDrop && commit > lastCreate, "OPE-1994: the last CREATE POLICY commits inside the same transaction that dropped it");
  ok(seen.slice(begin, commit + 1).every((s) => s.pinned), "OPE-1994: every statement of the span runs on the PINNED connection, not through the pool");
  ok(
    seen.filter((s) => isDropPolicy(s.sql) || isCreatePolicy(s.sql)).every((s) => s.pinned),
    "OPE-1994: no policy statement runs outside the pinned connection",
  );

  const lockParams = seen[lock]?.params ?? [];
  ok(lockParams.length === 2 && lockParams.every((p) => Number.isInteger(p)), "OPE-1994: the span takes pg_advisory_xact_lock(class, key) from two tracked int32 literals");
  ok(probed.length === 1 && probed[0]?.length === 1, "🔴 OPE-1994: Postgres REPORTS the advisory lock as held inside the span — the statement took a lock, it did not merely run");
  ok((await advisoryLocks(raw)).length === 0, "OPE-1994: the xact lock is gone after COMMIT — no lock survives the connection's return to the pool");

  const inSpan = seen.slice(begin, commit + 1).map((s) => s.sql);
  ok(inSpan.every((s) => isDropPolicy(s) || isCreatePolicy(s) || s === "BEGIN" || s === "COMMIT" || isAdvisoryLock(s) || s.startsWith("SET LOCAL lock_timeout")), "🔴 OPE-1994: the transaction holds the POLICY statements and nothing else — no CREATE TABLE, no ALTER, no index build");
  ok(seen.some((s) => s.sql.startsWith("CREATE TABLE") && !s.pinned), "OPE-1994: the table DDL still runs in autocommit, outside the span's transaction");
  ok(seen.some((s) => s.sql.startsWith("SET LOCAL lock_timeout")), "OPE-1994: the span bounds its lock waits, so a blocked apply rolls back instead of hanging on ACCESS EXCLUSIVE");

  const drops = new Set(inSpan.filter(isDropPolicy).map(policyTarget));
  const creates = inSpan.filter(isCreatePolicy).map(policyTarget);
  ok(creates.length >= 40, `OPE-1994: the span carries the whole policy set (${creates.length} CREATE POLICY statements)`);
  ok(
    creates.every((t) => t !== undefined && drops.has(t)),
    "🔴 OPE-1994: every CREATE POLICY in the span is preceded by its own DROP POLICY IF EXISTS — a second pass recreates from a clean slate instead of raising duplicate_object",
  );
}

{
  const before = await policyNames(raw, "audit_entry");
  ok(before.includes("audit_select") && before.includes("audit_insert"), "control: the store starts with both audit_entry policies — the assertion below can fail");

  const { client, seen } = recordingClient(raw, { failOn: (s) => s.startsWith("CREATE POLICY audit_select") });
  let threw: unknown;
  await initOperationalSchema(client).catch((err: unknown) => {
    threw = err;
  });
  ok(threw instanceof Error && threw.message.startsWith("simulated abort inside the policy span"), "OPE-1994: an abort inside the span reaches the caller — the init fails loudly");
  ok(
    seen.some((s) => s.pinned && s.sql === "DROP POLICY IF EXISTS audit_select ON audit_entry"),
    "control: the DROP really ran before the abort — the survival below is a ROLLBACK, not a statement that never happened",
  );

  const after = await policyNames(raw, "audit_entry");
  ok(after.includes("audit_select") && after.includes("audit_insert"), "🔴 OPE-1994: the killed init rolled back — audit_entry keeps BOTH policies instead of going deny-all until the next boot");
  ok((await verifyAppendOnlyAudit(raw)).length === 0, "🔴 OPE-1994: the append-only posture is intact after the killed init — no audit row is dropped");
  ok((await advisoryLocks(raw)).length === 0, "OPE-1994: ROLLBACK released the advisory lock — a failed pass does not wedge the next one");
}

{
  await raw.query("DROP POLICY IF EXISTS audit_select ON audit_entry");
  await raw.query("CREATE POLICY audit_select ON audit_entry FOR SELECT USING (true)");
  const legacy = await verifyAppendOnlyAudit(raw);
  ok(
    legacy.some((v) => v.includes("audit_select")) && !legacy.some((v) => v.includes("no SELECT policy")),
    "control: the legacy USING (true) policy is an allowlist miss, and audit_entry still HAS a SELECT policy — the heal has something to drop",
  );

  const { client, seen } = recordingClient(raw, { failOn: (s) => s.startsWith("CREATE POLICY audit_select") });
  await initOperationalSchema(client).catch(() => undefined);
  const healDrop = seen.find((s) => s.sql === `DROP POLICY IF EXISTS "audit_select" ON audit_entry`);
  ok(healDrop?.pinned === true, "🔴 OPE-1994: the HEAL's DROP POLICY runs on the pinned connection, inside the span — never committed on its own before the apply");
  const after = await policyNames(raw, "audit_entry");
  ok(after.includes("audit_select") && after.includes("audit_insert"), "🔴 OPE-1994: an init killed after the heal planned a drop still leaves audit_entry with its policies — the heal opens no window of its own");

  const { client: healthy } = recordingClient(raw);
  await initOperationalSchema(healthy);
  ok((await verifyAppendOnlyAudit(raw)).length === 0, "OPE-1994: and a completed init replaces the legacy policy with the allowlisted one, as before");
}

{
  await raw.query("DROP POLICY IF EXISTS audit_select ON audit_entry");
  await raw.query("DROP POLICY IF EXISTS audit_insert ON audit_entry");
  const zeroPolicy = await verifyAppendOnlyAudit(raw);
  ok(zeroPolicy.length > 0, "control: a policy-less audit_entry is a violation at all");
  ok(auditIntegrityCause(zeroPolicy, false) === "aborted-init", "🔴 OPE-1994: zero policies + nothing healed classifies as aborted-init — the state an aborted span leaves, and an owner DROP POLICY leaves the same one");
  ok(auditIntegrityCause(zeroPolicy, true) === "tampering", "OPE-1994: the same zero-policy state WITH a healed artifact reads as tampering — an added artifact is the stronger claim");

  const { client } = recordingClient(raw);
  await initOperationalSchema(client);
  const healedRow = await latestIntegrityDetail(raw);
  ok(healedRow?.cause === "aborted-init", "🔴 OPE-1994: the audit.integrity row carries the cause field, so the state is on the permanent record beside the violations");
  ok(healedRow?.healed_artifacts === undefined, "OPE-1994: an aborted init healed no artifact, and the row says so — the empty heal is half the signature");
  ok(Array.isArray(healedRow?.violations) && (healedRow.violations as unknown[]).length > 0, "OPE-1994: the row still carries the violations it was recording before the cause existed");

  await raw.query("CREATE POLICY audit_intruder ON audit_entry FOR SELECT USING (true)");
  const tampered = await verifyAppendOnlyAudit(raw);
  ok(auditIntegrityCause(tampered, false) === "tampering", "🔴 OPE-1994: a foreign policy on an append-only table = tampering, even before the heal drops it");
  await initOperationalSchema(client);
  const tamperRow = await latestIntegrityDetail(raw);
  ok(tamperRow?.cause === "tampering", "OPE-1994: the row written after a foreign policy names tampering");
  ok(tamperRow?.healed_artifacts !== undefined, "OPE-1994: and it keeps the healed_artifacts the heal removed");

  await raw.query("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY");
  const forceOff = await verifyAppendOnlyAudit(raw);
  ok(forceOff.length > 0 && auditIntegrityCause(forceOff, false) === "unknown", "🔴 OPE-1994: FORCE turned off matches neither signature and reads as unknown — the classifier does not guess");
  await initOperationalSchema(client);
  ok((await verifyAppendOnlyAudit(raw)).length === 0, "OPE-1994: and the re-apply repairs it, as before");
}

{
  const floor = await openTestPg();
  _resetPolicySpanAtomicityWarnForTest();
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    await initOperationalSchema(floor.client);
    await initOperationalSchema(floor.client);
  } finally {
    console.warn = realWarn;
  }
  const spanWarns = warned.filter((w) => w.includes("the RLS policy span re-applies in"));
  ok(spanWarns.length === 1, `🔴 OPE-1994: a pooled client with no pinning seam is told ONCE that its policy span is not atomic (got ${spanWarns.length}) — without the warning a hosted deployment carries the defect silently`);
  ok(spanWarns[0]?.includes("withConnection") === true, "OPE-1994: and the warning names the seam that fixes it");

  const pols = await policyNames(floor.client, "audit_entry");
  ok(pols.includes("audit_select") && pols.includes("audit_insert"), "OPE-1994: a client with no withConnection seam (the embedded PGlite floor) still applies the policy span, in autocommit");
  ok((await verifyAppendOnlyAudit(floor.client)).length === 0, "OPE-1994: the floor's posture is sound — the fallback is the old behaviour, not a broken one");
}

await closeAllTestPg();
console.log(`✓ schema policy atomicity: ${passed} assertions passed`);
