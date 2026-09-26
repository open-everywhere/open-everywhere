// proves: memory applyPolicyStatements, verifyMemoryIsolation, memoryIsolationCause

import {
  _resetMemoryPolicySpanAtomicityWarnForTest,
  initPostgresSchema,
  memoryIsolationCause,
  setOrgContext,
  verifyMemoryIsolation,
  type PgClient,
} from "../agent/memory/postgres.js";
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

async function captured(channel: "error" | "warn", fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console[channel];
  console[channel] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console[channel] = real;
  }
  return lines;
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
  await initPostgresSchema(client);

  const begin = seen.findIndex((s) => s.sql === "BEGIN" && s.pinned);
  const lock = seen.findIndex((s) => isAdvisoryLock(s.sql));
  const firstDrop = seen.findIndex((s) => isDropPolicy(s.sql));
  const lastCreate = seen.map((s) => isCreatePolicy(s.sql)).lastIndexOf(true);
  const commit = seen.findIndex((s, i) => s.sql === "COMMIT" && s.pinned && i > lastCreate);

  ok(begin >= 0 && lock > begin && firstDrop > lock, "🔴 OPE-2015: BEGIN, then the advisory lock, then the FIRST DROP POLICY — the memory span never drops a policy outside the transaction");
  ok(lastCreate > firstDrop && commit > lastCreate, "OPE-2015: the last CREATE POLICY commits inside the same transaction that dropped it");
  ok(seen.slice(begin, commit + 1).every((s) => s.pinned), "OPE-2015: every statement of the span runs on the PINNED connection, not through the pool");
  ok(
    seen.filter((s) => isDropPolicy(s.sql) || isCreatePolicy(s.sql)).every((s) => s.pinned),
    "OPE-2015: no policy statement runs outside the pinned connection",
  );

  const lockParams = seen[lock]?.params ?? [];
  ok(lockParams.length === 2 && lockParams.every((p) => Number.isInteger(p)), "OPE-2015: the span takes pg_advisory_xact_lock(class, key) from two tracked int32 literals");
  ok(probed.length === 1 && probed[0]?.length === 1, "🔴 OPE-2015: Postgres REPORTS the advisory lock as held inside the span — the statement took a lock, it did not merely run");
  ok((await advisoryLocks(raw)).length === 0, "OPE-2015: the xact lock is gone after COMMIT — no lock survives the connection's return to the pool");

  const inSpan = seen.slice(begin, commit + 1).map((s) => s.sql);
  ok(inSpan.every((s) => isDropPolicy(s) || isCreatePolicy(s) || s === "BEGIN" || s === "COMMIT" || isAdvisoryLock(s) || s.startsWith("SET LOCAL lock_timeout")), "🔴 OPE-2015: the transaction holds the POLICY statements and nothing else — no CREATE TABLE, no ALTER");
  ok(seen.some((s) => s.sql.startsWith("CREATE TABLE") && !s.pinned), "OPE-2015: the table DDL still runs in autocommit, outside the span's transaction");
  ok(seen.some((s) => s.sql.startsWith("ALTER TABLE") && s.sql.includes("ENABLE ROW LEVEL SECURITY") && !s.pinned), "OPE-2015: so does the idempotent ENABLE ROW LEVEL SECURITY");
  ok(seen.some((s) => s.sql.startsWith("SET LOCAL lock_timeout")), "OPE-2015: the span bounds its lock waits, so a blocked apply rolls back instead of hanging on ACCESS EXCLUSIVE");

  const drops = new Set(inSpan.filter(isDropPolicy).map(policyTarget));
  const creates = inSpan.filter(isCreatePolicy).map(policyTarget);
  ok(creates.length === 2 && creates.includes("memory_file.memory_file_org_isolation") && creates.includes("memory_tier.memory_tier_org_isolation"), `OPE-2015: the span carries both isolation policies (${creates.join(", ")})`);
  ok(
    creates.every((t) => t !== undefined && drops.has(t)),
    "🔴 OPE-2015: every CREATE POLICY in the span is preceded by its own DROP POLICY IF EXISTS — a second pass recreates from a clean slate instead of raising duplicate_object",
  );
  ok((await verifyMemoryIsolation(raw)).length === 0, "OPE-2015: a completed apply leaves a sound isolation posture");
}

{
  const before = await policyNames(raw, "memory_file");
  ok(before.includes("memory_file_org_isolation"), "control: the store starts with the memory_file policy — the assertion below can fail");

  const { client, seen } = recordingClient(raw, { failOn: (s) => s.startsWith("CREATE POLICY memory_file_org_isolation") });
  let threw: unknown;
  await initPostgresSchema(client).catch((err: unknown) => {
    threw = err;
  });
  ok(threw instanceof Error && threw.message.startsWith("simulated abort inside the policy span"), "OPE-2015: an abort inside the span reaches the caller — the init fails loudly");
  ok(
    seen.some((s) => s.pinned && s.sql === "DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file"),
    "control: the DROP really ran before the abort — the survival below is a ROLLBACK, not a statement that never happened",
  );

  ok((await policyNames(raw, "memory_file")).includes("memory_file_org_isolation"), "🔴 OPE-2015: the killed init rolled back — memory_file keeps its policy instead of going deny-all until the next owner boot");
  ok((await policyNames(raw, "memory_tier")).includes("memory_tier_org_isolation"), "🔴 OPE-2015: and so does memory_tier, whose policy the same transaction had already dropped");
  ok((await verifyMemoryIsolation(raw)).length === 0, "🔴 OPE-2015: the isolation posture is intact after the killed init");
  ok((await advisoryLocks(raw)).length === 0, "OPE-2015: ROLLBACK released the advisory lock — a failed pass does not wedge the next one");
}

{
  await raw.query("INSERT INTO memory_file (org_id, tier_path, rel_path, content) VALUES ('deny-org', 'workspace/general', 'MEMORY.md', 'x') ON CONFLICT DO NOTHING");
  await pg.exec(`DROP ROLE IF EXISTS open_everywhere_app;
                 CREATE ROLE open_everywhere_app NOSUPERUSER;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON memory_file, memory_tier TO open_everywhere_app;`);

  try {
    await pg.exec("SET ROLE open_everywhere_app");
    await setOrgContext(raw, "deny-org");
    const withPolicy = await raw.query("SELECT org_id FROM memory_file WHERE org_id = 'deny-org'");
    ok(withPolicy.rows.length === 1, "control: with its policy in place the runtime role reads its own org's memory");

    let soundBoot = true;
    await initPostgresSchema(raw).catch(() => {
      soundBoot = false;
    });
    ok(soundBoot, "🔴 OPE-2015: a non-owner boot onto a SOUND store does NOT refuse — a false positive here is a whole-deployment outage");
  } finally {
    await pg.exec("RESET ROLE");
  }

  await raw.query("DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file");
  try {
    await pg.exec("SET ROLE open_everywhere_app");
    await setOrgContext(raw, "deny-org");
    const denied = await raw.query("SELECT org_id FROM memory_file WHERE org_id = 'deny-org'");
    ok(denied.rows.length === 0, "🔴 OPE-2015: RLS on and NO policy denies the runtime role its own org's memory — this is what the autocommit span exposed on every re-apply");

    let bootErr: unknown;
    await initPostgresSchema(raw).catch((err: unknown) => {
      bootErr = err;
    });
    const msg = bootErr instanceof Error ? bootErr.message : "";
    ok(msg.includes("FAILED verification under the non-owner runtime role"), "🔴 OPE-2015: a non-owner boot onto a policy-less memory store REFUSES instead of serving a store it cannot read");
    ok(msg.includes("cause: aborted-init"), "🔴 OPE-2015: and the refusal NAMES the cause, so a responder is not left reading a bare catalog fact");
    ok(msg.includes("row-level security is on and NO policy"), "OPE-2015: the refusal carries the violation sentence beside the cause");
    ok(msg.includes("Re-run the schema init as the owner/migration role"), "OPE-2015: and names the remedy that WORKS for this cause — a re-run does re-create a policy the span owns");
    ok((await policyNames(raw, "memory_file")).length === 0, "control: the non-owner boot ran no DDL — the policy is still missing, so the refusal is not a repair in disguise");
  } finally {
    await pg.exec("RESET ROLE");
    await raw.query("SELECT set_config('app.current_org', '', false)");
  }

  const { client } = recordingClient(raw);
  const reported = await captured("error", async () => {
    await initPostgresSchema(client);
  });
  ok(reported.some((l) => l.includes("cause: aborted-init")), "🔴 OPE-2015: the owner boot that repairs a broken posture names the cause on the console — a silent repair hides the one thing an incident review needs");
  ok(reported.some((l) => l.includes("the policies this schema owns have been re-created")), "OPE-2015: and says exactly what it re-created — not 'repaired', which a foreign policy would make a lie");
  ok((await verifyMemoryIsolation(raw)).length === 0, "OPE-2015: the owner boot leaves the posture sound");

  const quiet = await captured("error", async () => {
    await initPostgresSchema(client);
  });
  ok(quiet.length === 0, "🔴 OPE-2015: a boot onto a SOUND posture reports nothing — the report is a signal, not boot noise");
}

{
  await raw.query("DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file");
  await raw.query("DROP POLICY IF EXISTS memory_tier_org_isolation ON memory_tier");
  const zeroPolicy = await verifyMemoryIsolation(raw);
  ok(zeroPolicy.length > 0, "control: a policy-less memory store is a violation at all");
  ok(memoryIsolationCause(zeroPolicy) === "aborted-init", "🔴 OPE-2015: RLS on with zero policies classifies as aborted-init — the state an aborted span leaves, and an owner DROP POLICY leaves the same one");

  await raw.query("CREATE POLICY memory_intruder ON memory_file USING (true)");
  const foreign = await verifyMemoryIsolation(raw);
  ok(memoryIsolationCause(foreign) === "tampering", "🔴 OPE-2015: a policy this schema never creates = tampering, and it WINS over the aborted-init signature memory_tier still shows");
  ok(foreign.some((v) => v.includes("memory_intruder")), "OPE-2015: and the violation names the policy a responder has to go look at");
  await raw.query("DROP POLICY memory_intruder ON memory_file");

  for (const [label, sql] of [
    ["AS RESTRICTIVE", "CREATE POLICY memory_file_org_isolation ON memory_file AS RESTRICTIVE USING (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL) WITH CHECK (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL)"],
    ["FOR UPDATE", "CREATE POLICY memory_file_org_isolation ON memory_file FOR UPDATE USING (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL) WITH CHECK (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL)"],
  ] as const) {
    await raw.query("DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file");
    await raw.query(sql);
    const reshaped = await verifyMemoryIsolation(raw);
    ok(reshaped.some((v) => v.includes("memory_file_org_isolation")), `🔴 OPE-2015: a policy declared ${label} under the EXPECTED name is a violation — the check reads polpermissive and polcmd, not just the name`);
    ok(memoryIsolationCause(reshaped) === "tampering", `OPE-2015: and a policy declared ${label} reads as tampering`);
  }
  await raw.query("DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file");

  await raw.query("CREATE POLICY memory_file_org_isolation ON memory_file USING (true) WITH CHECK (true)");
  const widened = await verifyMemoryIsolation(raw);
  ok(widened.some((v) => v.includes("no longer reads app.current_org")), "🔴 OPE-2015: the expected policy widened to USING (true) is a violation — the check reads the PREDICATE, not just the name");
  ok(memoryIsolationCause(widened) === "tampering", "OPE-2015: and a widened policy reads as tampering");

  await raw.query("DROP POLICY memory_file_org_isolation ON memory_file");
  await raw.query("CREATE POLICY memory_file_org_isolation ON memory_file USING (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL) WITH CHECK (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL)");
  await raw.query("CREATE POLICY memory_tier_org_isolation ON memory_tier USING (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL) WITH CHECK (org_id = current_setting('app.current_org', true) OR NULLIF(current_setting('app.current_org', true), '') IS NULL)");
  ok((await verifyMemoryIsolation(raw)).length === 0, "control: a hand-written policy in the shipped shape verifies clean — the predicate check reads names, not the server's formatting");
  await raw.query("ALTER TABLE memory_file DISABLE ROW LEVEL SECURITY");
  const rlsOff = await verifyMemoryIsolation(raw);
  ok(rlsOff.length > 0 && memoryIsolationCause(rlsOff) === "unknown", "🔴 OPE-2015: RLS turned off matches neither signature and reads as unknown — the classifier does not guess");

  const { client } = recordingClient(raw);
  const unknownReport = await captured("error", async () => {
    await initPostgresSchema(client);
  });
  ok(unknownReport.some((l) => l.includes("cause: unknown")), "OPE-2015: the owner boot reports the unknown cause too — a state outside both signatures is still reported, never swallowed");
  ok((await verifyMemoryIsolation(raw)).length === 0, "OPE-2015: and the re-apply repairs it, as before");
}

{
  const floor = await openTestPg();
  _resetMemoryPolicySpanAtomicityWarnForTest();
  const warned = await captured("warn", async () => {
    await initPostgresSchema(floor.client);
    await initPostgresSchema(floor.client);
  });
  const spanWarns = warned.filter((w) => w.includes("the RLS policy span re-applies in"));
  ok(spanWarns.length === 1, `🔴 OPE-2015: a pooled client with no pinning seam is told ONCE that its policy span is not atomic (got ${spanWarns.length}) — without the warning a hosted deployment carries the defect silently`);
  ok(spanWarns[0]?.includes("withConnection") === true, "OPE-2015: and the warning names the seam that fixes it");

  const pols = await policyNames(floor.client, "memory_file");
  ok(pols.includes("memory_file_org_isolation"), "OPE-2015: a client with no withConnection seam (the embedded PGlite floor) still applies the policy span, in autocommit");
  ok((await verifyMemoryIsolation(floor.client)).length === 0, "OPE-2015: the floor's posture is sound — the fallback is the old behaviour, not a broken one");
}

await closeAllTestPg();
console.log(`✓ memory schema policy atomicity: ${passed} assertions passed`);
