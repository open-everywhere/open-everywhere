import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORE_DIR = join(HERE, "..");
const REPO_ROOT = join(CORE_DIR, "..", "..");
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const workDir = mkdtempSync(join(tmpdir(), "oe-operator-read-store-"));
const NO_ENV_FILE = join(workDir, "absent.env");

interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runCli(entry: string, env: Record<string, string>, args: readonly string[] = []): Promise<CliResult> {
  const child = spawn(process.execPath, [TSX_CLI, join(HERE, entry), "--root-env", NO_ENV_FILE, ...args], {
    cwd: CORE_DIR,
    env: { ...process.env, OE_OPERATIONAL_PROVIDER: "", DATABASE_URL: "", OE_SQLITE_PATH: "", OE_PGLITE_DIR: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<CliResult>((resolvePromise, rejectPromise) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${entry} did not exit within 60s; stderr so far: ${err}`));
    }, 60_000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err });
    });
  });
}

const CLIS = [
  { entry: "audit.ts", report: "Audit log:", args: [] as readonly string[] },
  { entry: "spend.ts", report: "Spend ledger:", args: [] as readonly string[] },
  { entry: "routines.ts", report: "Routine store:", args: [] as readonly string[] },
] as const;

for (const { entry, report, args } of CLIS) {
  const r = await runCli(entry, { OE_OPERATIONAL_PROVIDER: "postgres" }, args);
  ok(r.code !== 0, `${entry}: an unopenable store exits non-zero (got ${String(r.code)})`);
  ok(r.err.includes("DATABASE_URL"), `🔴 ${entry}: the refusal names the missing DATABASE_URL — the connect ran, rather than a lazy read failing later`);
  ok(!r.out.includes(report), `${entry}: no report is printed`);
}

for (const { entry, report, args } of CLIS) {
  const r = await runCli(
    entry,
    {
      OE_OPERATIONAL_PROVIDER: "sqlite",
      OE_SQLITE_PATH: join(workDir, "ops.sqlite3"),
      DATABASE_URL: "postgres://someone:not-a-real-password@db.example.invalid/oe",
    },
    args,
  );
  ok(r.code === 0, `${entry}: an openable store exits 0 (got ${String(r.code)}) — ${r.err.slice(0, 200)}`);
  ok(r.out.includes(report), `${entry}: and prints its report`);
  ok(r.out.includes("store: "), `${entry}: the header names the store it read — the wrong-store tell an operator can read`);
  ok(r.out.includes("sqlite file"), `${entry}: and it is the store the env selected`);
  ok(
    !r.out.includes("postgres://") && !r.out.includes("db.example.invalid") && !r.err.includes("db.example.invalid"),
    `${entry}: no connection string reaches the output`,
  );
}

for (const { entry, report, args } of CLIS) {
  const r = await runCli(entry, { OE_PGLITE_DIR: join(workDir, `pglite-${entry}`) }, args);
  ok(r.code === 0, `${entry}: the DEFAULT env exits 0 (got ${String(r.code)}) — ${r.err.slice(0, 200)}`);
  ok(r.out.includes(report), `${entry}: the default env prints its report`);
  ok(
    r.out.includes("embedded Postgres floor") && !r.out.includes("sqlite file"),
    `🔴 ${entry}: the default env reports the embedded-Postgres FLOOR, not the sqlite stand-in it used to read`,
  );
}

rmSync(workDir, { recursive: true, force: true });
console.log(`✓ operator read-CLI store wiring: ${n} assertions passed`);
