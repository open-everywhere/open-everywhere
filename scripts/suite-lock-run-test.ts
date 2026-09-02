import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock, pidAlive, readHolder, reclaimDeadLock, releaseLock, runLocked, type LockHolder } from "./suite-lock-run.js";

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

async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

async function reapedPid(): Promise<number> {
  const pid = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "0"]);
    child.on("error", reject);
    child.on("close", () => resolve(child.pid ?? -1));
  });
  const deadline = Date.now() + 5_000;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return pid;
}

function plantHeldLock(lockDir: string, pid: number, startedAt: string): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "holder.json"), JSON.stringify({ pid, startedAt, command: "vitest run" }, null, 2));
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

  await check("dead holder: the lock is reclaimed immediately, with one line naming the dead pid", async () => {
    const lockDir = join(scratch, "lock-dead-holder");
    const gonePid = await reapedPid();
    assert.equal(pidAlive(gonePid), false, "the fixture pid must really be gone, or this leg proves nothing");
    plantHeldLock(lockDir, gonePid, "2026-09-01T10:00:00.000Z");

    const started = Date.now();
    const lines = await captureStderr(async () => {
      await acquireLock(lockDir, 400, { pollMs: 20, noticeIntervalMs: 60_000, command: "leg-5" });
    });
    assert.ok(Date.now() - started < 400, "the reclaim must not wait out the ceiling");
    assert.equal(lines.filter((l) => l.includes("reclaimed")).length, 1, `expected exactly one reclaim line, got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes(`pid ${gonePid}`)), `the reclaim line must name the dead pid, got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes("2026-09-01T10:00:00.000Z")), "the reclaim line must say since when the dead holder held it");

    const holder = readHolder(lockDir);
    assert.equal(holder?.pid, process.pid, "after a reclaim the lock must record THIS process as its holder");
    assert.equal(holder?.command, "leg-5", "the holder record carries the command that took the lock");
    releaseLock(lockDir);
    assert.equal(existsSync(lockDir), false, "the reclaimed lock releases normally");
  });

  await check("live holder: the acquirer never waits silently — it names the holder, first and again", async () => {
    const lockDir = join(scratch, "lock-live-holder");
    plantHeldLock(lockDir, process.pid, "2026-09-01T11:00:00.000Z");
    try {
      let threw: unknown;
      const lines = await captureStderr(async () => {
        try {
          await acquireLock(lockDir, 250, { pollMs: 20, noticeIntervalMs: 60 });
        } catch (err) {
          threw = err;
        }
      });
      assert.ok(threw instanceof Error && /timed out after 250ms/.test(threw.message), `expected a named timeout, got ${String(threw)}`);
      assert.ok(threw instanceof Error && threw.message.includes(`pid ${process.pid}`), "the timeout must name the holder it waited for");

      const holderLines = lines.filter((l) => l.includes(`held by pid ${process.pid}`));
      assert.ok(holderLines.length >= 2, `expected the holder line at the first wait AND on repeat, got ${JSON.stringify(lines)}`);
      assert.ok(holderLines.every((l) => l.includes("2026-09-01T11:00:00.000Z")), "every holder line says since when");
      assert.equal(lines.filter((l) => l.includes("reclaimed")).length, 0, "a live holder must never be reclaimed");
      assert.equal(existsSync(lockDir), true, "the live holder's lock is still there after the failed acquire");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  await check("no holder record: the acquirer waits out the ceiling and never reclaims on a guess", async () => {
    const lockDir = join(scratch, "lock-legacy");
    mkdirSync(lockDir);
    try {
      let threw: unknown;
      const lines = await captureStderr(async () => {
        try {
          await acquireLock(lockDir, 250, { pollMs: 20, noticeIntervalMs: 60_000 });
        } catch (err) {
          threw = err;
        }
      });
      assert.ok(threw instanceof Error && /timed out after 250ms/.test(threw.message), `expected a named timeout, got ${String(threw)}`);
      assert.ok(threw instanceof Error && /unrecorded holder/.test(threw.message), "the timeout must say the holder was never recorded");
      assert.ok(lines.some((l) => l.includes("no holder.json")), `expected the legacy-shape wait line, got ${JSON.stringify(lines)}`);
      assert.equal(lines.filter((l) => l.includes("reclaimed")).length, 0, "an unrecorded lock is never reclaimed");
      assert.equal(existsSync(lockDir), true, "the unrecorded lock must survive — this acquirer never owned it");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  await check("runLocked records its holder for the life of the wrapped command", async () => {
    const lockDir = join(scratch, "lock-holder-live");
    const outFile = join(scratch, "holder-seen.json");
    const readerCode = `require("node:fs").copyFileSync(${JSON.stringify(join(lockDir, "holder.json"))}, ${JSON.stringify(outFile)});`;
    const code = await runLocked(process.execPath, ["-e", readerCode], { manual: false, lockDir, maxWaitMs: 20_000 });
    assert.equal(code, 0, "the wrapped command must have found and copied the holder record");
    const seen = JSON.parse(readFileSync(outFile, "utf8")) as { pid: number; command: string };
    assert.equal(seen.pid, process.pid, "the record names the wrapper process, not the child");
    assert.ok(seen.command.includes("-e"), `the record carries the wrapped command, got ${JSON.stringify(seen.command)}`);
    assert.equal(existsSync(lockDir), false, "the lock (and its record) is gone once the command finishes");
  });

  await check("releaseLock leaves a lock that another live process holds", async () => {
    const lockDir = join(scratch, "lock-foreign");
    plantHeldLock(lockDir, process.ppid, "2026-09-01T12:00:00.000Z");
    try {
      assert.notEqual(process.ppid, process.pid, "the fixture needs a live pid that is NOT this process");
      await captureStderr(async () => releaseLock(lockDir));
      assert.equal(existsSync(lockDir), true, "a foreign holder's lock must survive our release");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  await check("reclaim: a lock that is no longer the dead holder's is put back, not taken", async () => {
    const lockDir = join(scratch, "lock-raced");
    const gonePid = await reapedPid();
    plantHeldLock(lockDir, process.pid, "2026-09-01T13:00:00.000Z");
    const stale: LockHolder = { pid: gonePid, startedAt: "2026-09-01T12:00:00.000Z", command: "vitest run" };
    try {
      const lines = await captureStderr(async () => {
        assert.equal(reclaimDeadLock(lockDir, stale), "not-stale", "the reclaim must refuse a directory that no longer records the dead pid");
      });
      assert.equal(existsSync(lockDir), true, "the live holder's lock must be back in place");
      assert.equal(readHolder(lockDir)?.pid, process.pid, "and untouched — still recording the live holder");
      assert.equal(lines.filter((l) => l.includes("reclaimed")).length, 0, "a refused reclaim must not announce one");
      const okDir = join(scratch, "lock-raced-control");
      plantHeldLock(okDir, gonePid, "2026-09-01T12:00:00.000Z");
      await captureStderr(async () => {
        assert.equal(reclaimDeadLock(okDir, stale), "reclaimed", "a directory that still records the dead pid IS reclaimed");
      });
      assert.equal(existsSync(okDir), false, "the reclaimed lock is gone");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  await check("reclaim: a failed reclaim is announced, and never claims to have succeeded", async () => {
    const missing = join(scratch, "lock-not-there");
    const gonePid = await reapedPid();
    const lines = await captureStderr(async () => {
      assert.equal(reclaimDeadLock(missing, { pid: gonePid, startedAt: "2026-09-01T14:00:00.000Z", command: "vitest run" }), "failed");
    });
    assert.equal(lines.filter((l) => l.includes("could NOT reclaim")).length, 1, `the failure must be announced once, got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes(`pid ${gonePid}`)), "the failure line names the dead holder it could not evict");
    assert.equal(lines.filter((l) => l.includes("reclaimed ")).length, 0, "a failed reclaim must never announce a reclaim");
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
