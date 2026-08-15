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

function seqsOf(org: string): number[] {
  const db = new DatabaseSync(DB);
  try {
    return (db.prepare("SELECT seq FROM audit_entry WHERE org_id = ? ORDER BY seq ASC").all(org) as { seq: number }[]).map((r) => Number(r.seq));
  } finally {
    db.close();
  }
}

const mutatedSeqs = seqsOf("mutated");
const deletedSeqs = seqsOf("deleted");

{
  const db = new DatabaseSync(DB);
  try {
    db.prepare("UPDATE audit_entry SET detail = ? WHERE seq = ?").run(JSON.stringify({ n: 999 }), mutatedSeqs[1]);
    db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(deletedSeqs[1]);
    db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(seqsOf("headless")[0]);
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
  ok(r.out.includes(`BREAK at seq ${mutatedSeqs[2]}`), `mutated: stdout names the SUCCESSOR's seq ${mutatedSeqs[2]}`);
  ok(!/chain intact/.test(r.out), "mutated: stdout never calls a broken chain intact");
  ok(/broken chain/.test(r.out), "mutated: the summary states a broken chain");
}

{
  const r = runCli(["--org", "deleted"]);
  ok(r.code === 1, `deleted: a deleted row exits 1 (got ${r.code})`);
  ok(r.out.includes(`BREAK at seq ${deletedSeqs[2]}`), `deleted: stdout names the next surviving row's seq ${deletedSeqs[2]}`);
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
  ok(r.out.includes("3 org(s) with a broken chain"), "all-orgs: the summary counts exactly the three broken orgs");
}

rmSync(workDir, { recursive: true, force: true });
console.log(`✓ verify-audit-chain CLI: ${n} assertions passed`);
