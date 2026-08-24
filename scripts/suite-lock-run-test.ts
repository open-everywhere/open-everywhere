import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock, releaseLock, runLocked } from "./suite-lock-run.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const wrapperScript = join(repoRoot, "scripts", "suite-lock-run.ts");

const scratch = mkdtempSync(join(tmpdir(), "oe-suite-lock-test-"));
let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      failures++;
      console.error(`✗ ${name}`);
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    });
}

function markerArgs(logFile: string, id: string, sleepMs: number): string[] {
  const code = `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(logFile)}, ${JSON.stringify(id)} + " start " + Date.now() + "\\n");
    setTimeout(() => {
      fs.appendFileSync(${JSON.stringify(logFile)}, ${JSON.stringify(id)} + " end " + Date.now() + "\\n");
    }, ${sleepMs});
  `;
  return ["-e", code];
}

function spawnWrapper(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [wrapperScript, "--", "node", ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    void stderr;
  });
}

function readIntervals(logFile: string): Record<string, { start: number; end: number }> {
  const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  const out: Record<string, { start: number; end: number }> = {};
  for (const line of lines) {
    const [id, kind, ts] = line.split(" ");
    out[id] ??= { start: 0, end: 0 };
    if (kind === "start") out[id].start = Number(ts);
    if (kind === "end") out[id].end = Number(ts);
  }
  return out;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

async function main(): Promise<void> {
  await check("locked: two concurrent invocations serialize (no interval overlap)", async () => {
    const lockDir = join(scratch, "lock-serialize");
    const logFile = join(scratch, "serialize.log");
    const env = { OE_SUITE_LOCK_DIR: lockDir, OE_SUITE_LOCK_MAX_WAIT_MS: "20000" };
    const [codeA, codeB] = await Promise.all([
      spawnWrapper(markerArgs(logFile, "A", 600), env),
      spawnWrapper(markerArgs(logFile, "B", 600), env),
    ]);
    assert.equal(codeA, 0, "wrapper A should exit 0");
    assert.equal(codeB, 0, "wrapper B should exit 0");
    const intervals = readIntervals(logFile);
    assert.ok(intervals.A?.start && intervals.A.end, "A must have both a start and end marker");
    assert.ok(intervals.B?.start && intervals.B.end, "B must have both a start and end marker");
    assert.equal(overlaps(intervals.A, intervals.B), false, `expected NO overlap under the lock, got A=${JSON.stringify(intervals.A)} B=${JSON.stringify(intervals.B)}`);
    assert.equal(existsSync(lockDir), false, "the lock directory must be gone once both runs finish");
  });

  await check("manual bypass: two concurrent invocations DO overlap (proves the lock is load-bearing)", async () => {
    const lockDir = join(scratch, "lock-manual");
    const logFile = join(scratch, "manual.log");
    const env = { OE_SUITE_LOCK_DIR: lockDir, OE_SUITE_LOCK_MANUAL: "1" };
    const [codeA, codeB] = await Promise.all([
      spawnWrapper(markerArgs(logFile, "A", 600), env),
      spawnWrapper(markerArgs(logFile, "B", 600), env),
    ]);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);
    const intervals = readIntervals(logFile);
    assert.equal(overlaps(intervals.A, intervals.B), true, `expected overlap with OE_SUITE_LOCK_MANUAL=1, got A=${JSON.stringify(intervals.A)} B=${JSON.stringify(intervals.B)}`);
    assert.equal(existsSync(lockDir), false, "manual mode must never create the lock directory");
  });

  await check("locked run releases the lock and propagates a non-zero exit on a failing command", async () => {
    const lockDir = join(scratch, "lock-fail");
    const code = await runLocked(process.execPath, ["-e", "process.exit(7)"], { manual: false, lockDir, maxWaitMs: 20_000 });
    assert.equal(code, 7, "the wrapper's own exit code must be the wrapped command's exit code");
    assert.equal(existsSync(lockDir), false, "the lock must be released even after a failing command");
  });

  await check("acquireLock throws a named timeout instead of hanging when the lock is held", async () => {
    const lockDir = join(scratch, "lock-timeout");
    mkdirSync(lockDir);
    try {
      await assert.rejects(
        () => acquireLock(lockDir, 300),
        (err: unknown) => err instanceof Error && /timed out after 300ms waiting for/.test(err.message),
      );
    } finally {
      releaseLock(lockDir);
    }
  });

  rmSync(scratch, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} suite-lock-run test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll suite-lock-run tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
