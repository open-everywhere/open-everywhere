
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORE_DIR = join(HERE, "..");
const REPO_ROOT = join(CORE_DIR, "..", "..");
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(HERE, "verify-audit-chain.ts");
const SEAL_CLI = join(HERE, "seal-audit-epoch.ts");

const workDir = mkdtempSync(join(tmpdir(), "oe-chain-cli-"));
const DB = join(workDir, "audit.sqlite3");
const EMPTY_DB = join(workDir, "empty.sqlite3");

process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = DB;
delete process.env.DATABASE_URL;

interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runCli(args: string[], sqlitePath: string = DB): CliResult {
  const r = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    encoding: "utf8",
    cwd: CORE_DIR,
    env: { ...process.env, OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: sqlitePath },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function runSeal(args: string[], sqlitePath: string = DB): CliResult {
  const r = spawnSync(process.execPath, [TSX_CLI, SEAL_CLI, ...args], {
    encoding: "utf8",
    cwd: CORE_DIR,
    env: { ...process.env, OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: sqlitePath },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const { sqliteOperationalStore: store } = await import("../agent/operational/sqlite.js");

async function seed(org: string, rows: number): Promise<void> {
  for (let i = 0; i < rows; i++) {
    await store.appendAudit({
      ts: `2026-07-01T00:${String(i).padStart(2, "0")}:00Z`,
      org,
      platform: "slack",
      workspace: "T1",
      surface: "C1",
      principalId: "U1",
      action: `a.${i}`,
      detail: { n: i },
    });
  }
}

await seed("intact", 3);
await seed("mutated", 3);
await seed("deleted", 3);
await seed("windowed", 6);
await seed("headless", 4);
await seed("manybreaks", 12);
await seed("sealed", 4);

function seqsOf(org: string): number[] {
  const db = new DatabaseSync(DB);
  try {
    return (db.prepare("SELECT seq FROM audit_entry WHERE org_id = ? ORDER BY seq ASC").all(org) as { seq: number }[]).map((r) => Number(r.seq));
  } finally {
    db.close();
  }
}

const mutatedSeqs = seqsOf("mutated");
const manySeqs = seqsOf("manybreaks");
const deletedSeqs = seqsOf("deleted");

{
  const db = new DatabaseSync(DB);
  try {
    db.prepare("UPDATE audit_entry SET detail = ? WHERE seq = ?").run(JSON.stringify({ n: 999 }), mutatedSeqs[1]);
    db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(deletedSeqs[1]);
    db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(seqsOf("headless")[0]);
    for (const i of [2, 5, 8]) db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(manySeqs[i]);
  } finally {
    db.close();
  }
}

{
  const r = runCli(["--org", "intact"]);
  ok(r.code === 0, `intact: --org on a sound chain exits 0 (got ${r.code})`);
  ok(/chain intact/.test(r.out), "intact: stdout reports the chain intact");
  ok(/3 row\(s\)/.test(r.out), "intact: stdout names the number of rows walked");
}

{
  const r = runCli(["--org", "mutated"]);
  ok(r.code === 1, `mutated: a mutated row exits 1 (got ${r.code})`);
  ok(new RegExp(`seq ${mutatedSeqs[2]} \\(`).test(r.out), `mutated: stdout names the SUCCESSOR's seq ${mutatedSeqs[2]}`);
  ok(/1 BROKEN LINK\(S\)/.test(r.out), "mutated: the per-org line counts the broken links");
  ok(!/chain intact/.test(r.out), "mutated: stdout never calls a broken chain intact");
  ok(/broken link\(s\) across/.test(r.out), "mutated: the summary states the broken-link total");
  ok(/Broken links by action/.test(r.out), "mutated: the summary breaks the count down by action — the write-side diagnostic");
  ok(/^\s+1\s+a\.2$/m.test(r.out), "mutated: the per-action table names the action the broken row carries (a.2, the successor)");
}

{
  const r = runCli(["--org", "deleted"]);
  ok(r.code === 1, `deleted: a deleted row exits 1 (got ${r.code})`);
  ok(new RegExp(`seq ${deletedSeqs[2]} \\(`).test(r.out), `deleted: stdout names the next surviving row's seq ${deletedSeqs[2]}`);
}

{
  const r = runCli(["--org", "windowed", "--tail", "3"]);
  ok(r.code === 0, `window: a mid-chain --tail window exits 0 (got ${r.code}) — the genesis assertion stays OFF`);
  ok(/chain intact/.test(r.out), "window: a sound window reports intact");
  ok(!/genesis/.test(r.out), "window: no genesis complaint on a legitimate mid-chain window");

  const db = new DatabaseSync(DB);
  try {
    const rows = db.prepare("SELECT prev_sha FROM (SELECT seq, prev_sha FROM audit_entry WHERE org_id = 'windowed' ORDER BY seq DESC LIMIT 3) ORDER BY seq ASC").all() as { prev_sha: string | null }[];
    ok(rows.length === 3 && rows[0].prev_sha !== null, "window: the window's first row carries a NON-null prev_sha (the control is real)");
  } finally {
    db.close();
  }
}

{
  const sound = runCli(["--org", "windowed", "--tail", "99"]);
  ok(sound.code === 0, `tail-overshoot: an intact chain under an oversized --tail exits 0 (got ${sound.code})`);

  const truncated = runCli(["--org", "headless", "--tail", "99"]);
  ok(truncated.code === 1, `tail-overshoot: a REMOVED GENESIS under an oversized --tail exits 1 (got ${truncated.code})`);
  ok(/genesis/.test(truncated.out), "tail-overshoot: the break names the genesis assertion");
}

{
  const r = runCli(["--org", "nosuchorg"]);
  ok(r.code === 3, `zero-rows: --org on an unknown org exits 3, not 0 (got ${r.code})`);
  ok(!/chain intact/.test(r.out), "zero-rows: stdout NEVER calls an unmatched org intact");
  ok(!/verified intact/.test(r.out), "zero-rows: the summary NEVER claims a verified chain");
  ok(/NOTHING VERIFIED|nothing was verified/i.test(r.out), "zero-rows: stdout says explicitly that nothing was verified");
  ok(/0 rows? matched/i.test(r.out), "zero-rows: stdout states that 0 rows matched");
}

{
  const fresh = runCli([], EMPTY_DB);
  ok(fresh.code === 0, `empty-log: a bare all-orgs scan of a fresh deployment exits 0 (got ${fresh.code})`);
  ok(!/verified intact/.test(fresh.out), "empty-log: a fresh deployment is never reported as verified");
  ok(/NOTHING VERIFIED|nothing was verified/i.test(fresh.out), "empty-log: stdout says nothing was verified");

  const guarded = runCli(["--require-rows"], EMPTY_DB);
  ok(guarded.code === 3, `empty-log: --require-rows turns an empty all-orgs scan into exit 3 (got ${guarded.code})`);

  const populated = runCli(["--org", "intact", "--require-rows"]);
  ok(populated.code === 0, `empty-log: --require-rows leaves a real verified chain at exit 0 (got ${populated.code})`);
}

{
  for (const bad of ["0", "-1", "abc", "2.5", ""]) {
    const r = runCli(["--tail", bad]);
    ok(r.code === 2, `arg: --tail ${JSON.stringify(bad)} exits 2 (got ${r.code})`);
    ok(!/chain intact/.test(r.out), `arg: --tail ${JSON.stringify(bad)} verifies nothing`);
  }
  ok(runCli(["--org", "intact", "--tail", "2"]).code === 0, "arg: --tail 2 is still a valid window");
}

{
  const r = runCli(["--org", "--tail", "3"]);
  ok(r.code === 2, `arg: --org followed by a flag exits 2 (got ${r.code})`);
  ok(!/org=--tail/.test(r.out), "arg: the CLI never adopts a flag as the org name");
  ok(!/chain intact/.test(r.out), "arg: a mangled scope verifies nothing");

  const missing = runCli(["--org"]);
  ok(missing.code === 2, `arg: a trailing --org with no value exits 2 (got ${missing.code})`);
  const missingTail = runCli(["--tail"]);
  ok(missingTail.code === 2, `arg: a trailing --tail with no value exits 2 (got ${missingTail.code})`);
}

{
  const r = runCli(["--orgs", "intact"]);
  ok(r.code === 2, `arg: an unknown flag exits 2 (got ${r.code})`);
  const stray = runCli(["intact"]);
  ok(stray.code === 2, `arg: a stray positional argument exits 2 (got ${stray.code})`);
  const dupe = runCli(["--org", "intact", "--org", "windowed"]);
  ok(dupe.code === 2, `arg: a repeated flag exits 2 (got ${dupe.code})`);

  const eq = runCli(["--org=intact"]);
  ok(eq.code === 2, `arg: --org=X exits 2 (got ${eq.code})`);
  ok(eq.err.includes("--org intact"), "arg: the --org=X error names the separate-argument form");
}

{
  const r = runCli(["--help"]);
  ok(r.code === 0, `help: --help exits 0 (got ${r.code})`);
  for (const code of ["0", "1", "2", "3"]) {
    ok(new RegExp(`^\\s*${code}\\s`, "m").test(r.out), `help: the exit contract documents code ${code}`);
  }
  ok(!r.out.includes("✓") && !r.out.includes("✗"), "help: --help prints no per-org verdict marker");
  ok(!/row\(s\) walked/.test(r.out), "help: --help walks no rows");
}

{
  const r = runCli([]);
  ok(r.code === 1, `all-orgs: a scan that includes a broken org exits 1 (got ${r.code})`);
  for (const org of ["intact", "mutated", "deleted", "windowed", "headless"]) {
    ok(r.out.includes(org), `all-orgs: the scan reports org ${org}`);
  }
  ok(/across 4 org\(s\)/.test(r.out), "all-orgs: the summary counts every broken org (mutated, deleted, headless, manybreaks)");
}

{
  const r = runCli(["--org", "manybreaks"]);
  ok(r.code === 1, `enumerate: a chain with three deletions exits 1 (got ${r.code})`);
  ok(/3 BROKEN LINK\(S\)/.test(r.out), "enumerate: the per-org line counts all three, not one");
  for (const i of [3, 6, 9]) {
    ok(new RegExp(`seq ${manySeqs[i]} \\(`).test(r.out), `enumerate: the successor of each deleted row is named (seq ${manySeqs[i]})`);
  }
  ok(/3 broken link\(s\) across 1 org\(s\)/.test(r.out), "enumerate: the summary totals the broken links");

  const capped = runCli(["--org", "manybreaks", "--max-detail", "1"]);
  ok(capped.code === 1, `enumerate: --max-detail does not change the exit code (got ${capped.code})`);
  ok(/3 BROKEN LINK\(S\)/.test(capped.out), "enumerate: --max-detail leaves the count at three");
  ok(/2 more not printed/.test(capped.out), "enumerate: --max-detail says how many it withheld");
  ok(!new RegExp(`seq ${manySeqs[9]} \\(`).test(capped.out), "enumerate: --max-detail really withholds the later sites");
  ok(runCli(["--org", "manybreaks", "--max-detail", "0"]).code === 2, "enumerate: --max-detail 0 is an argument error");
}

{
  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("UPDATE audit_entry SET prev_sha = NULL WHERE org_id = 'sealed'").run();
    } finally {
      db.close();
    }
  }
  const unsealed = runCli(["--org", "sealed"]);
  ok(unsealed.code === 1, `epoch: an unsealed pre-chain era exits 1 (got ${unsealed.code})`);
  ok(/prev_sha is null mid-chain/.test(unsealed.out), "epoch: the unsealed era is reported as null links, not silently accepted");

  const dry = runSeal(["--org", "sealed", "--sealed-by", "rowan"]);
  ok(dry.code === 0, `epoch: a dry-run seal exits 0 (got ${dry.code})`);
  ok(/DRY RUN/.test(dry.out), "epoch: without --go the command says it wrote nothing");
  ok(runCli(["--org", "sealed"]).code === 1, "epoch: the dry run really wrote nothing — the era is still unsealed");

  const sealed = runSeal(["--org", "sealed", "--sealed-by", "rowan", "--go"]);
  ok(sealed.code === 0, `epoch: --go seals and exits 0 (got ${sealed.code})`);
  ok(/Epoch marker appended/.test(sealed.out), "epoch: the command confirms the marker landed");
  ok(/--accept-epoch \d+/.test(sealed.out), "epoch: the sealer prints the exact --accept-epoch the verifier needs");

  const unvouched = runCli(["--org", "sealed"]);
  ok(unvouched.code === 4, `epoch: an UNACKNOWLEDGED epoch exits 4, not 0 (got ${unvouched.code})`);
  ok(/NOT ACKNOWLEDGED/.test(unvouched.out), "epoch: the run says the epoch was not acknowledged");
  ok(!/chain intact/.test(unvouched.out), "epoch: an unacknowledged epoch never yields the words 'chain intact'");
  ok(/does not certify the chain/.test(unvouched.out), "epoch: the summary refuses to certify");

  const sealedSeq = seqsOf("sealed").at(-1)!;
  const after = runCli(["--org", "sealed", "--accept-epoch", String(sealedSeq)]);
  ok(after.code === 0, `epoch: an ACKNOWLEDGED epoch verifies (got ${after.code}) — the marker is not a break`);
  ok(!/chain intact/.test(after.out), "epoch: an org whose sealed era covered breaks is never called 'chain intact'");
  ok(/no broken link OUTSIDE the sealed era/.test(after.out), "epoch: the verdict says exactly what was and was not checked by link");
  ok(runCli(["--org", "sealed", "--accept-epoch", "999999"]).code === 4, "epoch: acknowledging the WRONG seq does not vouch for the epoch that is there");
  ok(runCli(["--accept-epoch", "abc"]).code === 2, "epoch: --accept-epoch takes a seq, not a word");
  ok(runCli(["--accept-epoch"]).code === 2, "epoch: a trailing --accept-epoch with no value exits 2");
  ok(/sealed chain epoch at seq/.test(after.out), "epoch: the verifier REPORTS the epoch it crossed");
  ok(/seal VERIFIED/.test(after.out), "epoch: a full walk re-verifies the era digest");
  ok(/already broken when sealed/.test(after.out), "epoch: the marker's recorded break count is printed — the seal hides nothing");
  ok(/3 of them already broken when sealed/.test(after.out), "epoch: the recorded count is the era's REAL break count, not zero");
  ok(/3 link break\(s\) inside the sealed era are covered by the seal/.test(after.out), "epoch: the verifier says how many link breaks the seal covers");
  ok(/ERA-DIGEST evidence/.test(after.out), "epoch: the verifier states what evidence pre-epoch rows still carry");

  ok(runSeal(["--org", "sealed", "--sealed-by", "rowan", "--go"]).code === 1, "epoch: sealing again with no rows since exits 1");
  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("UPDATE audit_entry SET detail = ? WHERE seq = ?").run(JSON.stringify({ n: 4242 }), seqsOf("sealed")[1]);
    } finally {
      db.close();
    }
  }
  const tampered = runCli(["--org", "sealed", "--accept-epoch", String(sealedSeq)]);
  ok(tampered.code === 1, `epoch: mutating a pre-epoch row exits 1 even with the epoch acknowledged (got ${tampered.code})`);
  ok(/era digest/.test(tampered.out), "epoch: the break names the era digest — pre-epoch rows are still under detection");
  ok(!/chain intact/.test(tampered.out), "epoch: a failed seal is never called intact");

  const sealHelp = runSeal(["--help"]);
  ok(sealHelp.code === 0, `epoch: the sealer's --help exits 0 (got ${sealHelp.code})`);
  for (const code of ["0", "1", "2", "5"]) {
    ok(new RegExp(`(^|[^0-9])${code}\\s`, "m").test(sealHelp.out), `epoch: the sealer's --help documents exit code ${code}`);
  }
  ok(/READ-ONLY/.test(sealHelp.out), "epoch: the sealer's --help says the dry run opens the store read-only");

  ok(runSeal(["--sealed-by", "rowan"]).code === 2, "epoch: seal without --org exits 2 — an epoch row is permanent, so the org is never guessed");
  ok(runSeal(["--org", "sealed"]).code === 2, "epoch: seal without --sealed-by exits 2 — an operator act carries a name");
  ok(runSeal(["--org", "nosuchorg", "--sealed-by", "t", "--go"]).code === 1, "epoch: sealing an org with no rows exits 1 and writes nothing");
}

{
  const { auditEpochDetail, auditEraDigest, walkAuditChain, AUDIT_CHAIN_EPOCH_ACTION } = await import("../agent/audit/chain.js");
  const forgeOrg = "forged";
  await seed(forgeOrg, 6);
  const forgeSeqs = seqsOf(forgeOrg);
  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(forgeSeqs[2]);
    } finally {
      db.close();
    }
  }
  const broken = runCli(["--org", forgeOrg]);
  ok(broken.code === 1, `forged: the era really is broken before the forgery (got ${broken.code})`);

  const era = await store.readAuditChain(forgeOrg);
  const forged = auditEpochDetail({
    rowsBefore: era.length,
    firstSeqBefore: era[0].seq,
    lastSeqBefore: era.at(-1)!.seq,
    breaksBefore: walkAuditChain(era, { expectGenesis: true }).breaks.length,
    eraDigest: auditEraDigest(era),
  });
  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare(
        "INSERT INTO audit_entry (ts, org_id, platform, workspace, principal_id, action, detail, prev_sha) VALUES (?, ?, 'db', 'sqlite', 'mallory', ?, ?, NULL)",
      ).run("2026-07-02T00:00:00Z", forgeOrg, AUDIT_CHAIN_EPOCH_ACTION, JSON.stringify(forged));
    } finally {
      db.close();
    }
  }
  const forgedRun = runCli(["--org", forgeOrg]);
  ok(forgedRun.code !== 0, `forged: a forged epoch does NOT turn the chain green (got ${forgedRun.code})`);
  ok(forgedRun.code === 4, `forged: the run exits 4 — an unacknowledged epoch (got ${forgedRun.code})`);
  ok(!/chain intact/.test(forgedRun.out), "forged: the words 'chain intact' never appear");
  ok(/seal VERIFIED/.test(forgedRun.out), "forged: the seal itself does verify — which is exactly why verification alone is not enough");
  ok(/NOT ACKNOWLEDGED/.test(forgedRun.out), "forged: the run names the epoch nobody vouched for");
  ok(/link break\(s\) inside the sealed era/.test(forgedRun.out), "forged: the run says how many link breaks the seal covers");
}

{
  await seed("orphanedera", 3);
  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("UPDATE audit_entry SET prev_sha = NULL WHERE org_id = 'orphanedera'").run();
    } finally {
      db.close();
    }
  }
  const sealed = runSeal(["--org", "orphanedera", "--sealed-by", "rowan", "--go"]);
  ok(sealed.code === 0, `orphaned-epoch: the era seals first (got ${sealed.code})`);
  const markerSeq = seqsOf("orphanedera").at(-1)!;
  await seed("orphanedera", 1);

  {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("DELETE FROM audit_entry WHERE org_id = 'orphanedera' AND seq < ?").run(markerSeq);
    } finally {
      db.close();
    }
  }
  ok(seqsOf("orphanedera")[0] === markerSeq, "orphaned-epoch: the marker really is the first row now");

  const full = runCli(["--org", "orphanedera"]);
  ok(full.code === 1, `orphaned-epoch: a full walk exits 1 — the seal claims an era that is gone (got ${full.code})`);
  ok(!/chain intact/.test(full.out), "orphaned-epoch: the words 'chain intact' never appear");
  ok(/sealed chain epoch at seq/.test(full.out), "orphaned-epoch: the epoch at row 0 is REPORTED, not read as a genesis row");
  ok(/claims 3 preceding row\(s\) but 0 are present/.test(full.out), "orphaned-epoch: the break names the row-count disagreement");

  const windowed = runCli(["--org", "orphanedera", "--tail", "2"]);
  ok(windowed.code === 4, `orphaned-epoch: a window whose first row is the marker exits 4, not 0 (got ${windowed.code})`);
  ok(/NOT ACKNOWLEDGED/.test(windowed.out), "orphaned-epoch: the window names the epoch nobody vouched for");
  ok(!/chain intact/.test(windowed.out), "orphaned-epoch: the window never calls it intact either");
}

{
  const { openOperationalPglite } = await import("../agent/operational/pglite-client.js");
  const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
  const floorDir = join(workDir, "pglite-floor");
  const floorEnv: NodeJS.ProcessEnv = { ...process.env, OE_PGLITE_DIR: floorDir };
  delete floorEnv.OE_OPERATIONAL_PROVIDER;
  delete floorEnv.OE_SQLITE_PATH;
  delete floorEnv.DATABASE_URL;

  async function floorState(): Promise<{ readonly actions: string[]; readonly forced: boolean }> {
    const open = await openOperationalPglite(floorDir);
    try {
      const rows = await open.client.query("SELECT action FROM audit_entry WHERE org_id = 'floor' ORDER BY seq ASC");
      const posture = await open.client.query("SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = to_regclass('audit_entry')");
      return {
        actions: (rows.rows as { action: string }[]).map((r) => r.action),
        forced: (posture.rows[0] as { force: boolean }).force === true,
      };
    } finally {
      await open.close();
    }
  }

  {
    const open = await openOperationalPglite(floorDir);
    await initOperationalSchema(open.client);
    const floorStore = makeOperationalPostgresStore(open.client);
    for (let i = 0; i < 3; i++) {
      await floorStore.appendAudit({
        ts: `2026-07-03T00:0${i}:00Z`,
        org: "floor",
        platform: "slack",
        workspace: "T1",
        action: `f.${i}`,
        detail: { n: i },
      });
    }
    await open.client.query("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY");
    await open.close();
  }
  const before = await floorState();
  ok(before.actions.length === 3 && !before.forced, "floor: the fixture starts at 3 rows with the append-only posture BROKEN");

  const verified = spawnSync(process.execPath, [TSX_CLI, CLI, "--org", "floor"], { encoding: "utf8", cwd: CORE_DIR, env: floorEnv });
  ok(verified.status === 0, `floor: the verifier walks the floor chain and exits 0 (got ${verified.status}) — ${verified.stderr?.slice(0, 200) ?? ""}`);
  ok(/embedded Postgres floor/.test(verified.stdout ?? ""), "floor: the run really went to the embedded floor, not the sqlite stand-in");
  const afterVerify = await floorState();
  assert.deepEqual(afterVerify.actions, before.actions, "floor: the verifier appended NO row — the chain it walked is byte-for-byte the one it found");
  n++;
  ok(!afterVerify.actions.includes("audit.integrity"), "floor: no audit.integrity row was written into the chain under inspection");
  ok(!afterVerify.forced, "floor: the verifier repaired NO posture — it reports, it does not act");

  const dry = spawnSync(process.execPath, [TSX_CLI, SEAL_CLI, "--org", "floor", "--sealed-by", "rowan"], { encoding: "utf8", cwd: CORE_DIR, env: floorEnv });
  ok(dry.status === 0, `floor: the sealer's dry run exits 0 (got ${dry.status}) — ${dry.stderr?.slice(0, 200) ?? ""}`);
  ok(/DRY RUN/.test(dry.stdout ?? ""), "floor: the sealer's dry run says it wrote nothing");
  const afterDry = await floorState();
  assert.deepEqual(afterDry.actions, before.actions, "floor: the sealer's DRY RUN appended no row either");
  n++;
  ok(!afterDry.forced, "floor: the dry run repaired no posture — the evidence an operator came to read is untouched");

  const control = spawnSync(process.execPath, [TSX_CLI, SEAL_CLI, "--org", "floor", "--sealed-by", "rowan", "--go"], { encoding: "utf8", cwd: CORE_DIR, env: floorEnv });
  ok(control.status === 0, `floor control: the sealer's --go run exits 0 (got ${control.status}) — ${control.stderr?.slice(0, 200) ?? ""}`);
  const afterControl = await floorState();
  ok(afterControl.actions.includes("audit.integrity"), "floor control: a WRITING connect does append an audit.integrity row on this same fixture");
  ok(afterControl.forced, "floor control: a writing connect also repairs the posture — which is exactly what a read command must not do");
  ok(afterControl.actions.at(-1) === "audit.chain_epoch", "floor control: the --go run also appended its epoch marker");
}

rmSync(workDir, { recursive: true, force: true });
console.log(`✓ verify-audit-chain CLI: ${n} assertions passed`);
