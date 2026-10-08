import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tsxCommand } from "./npm-command.js";
import { mkdtempSync, mkdirSync, existsSync, globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


import vitestConfig from "../vitest.config.js";
import { DurationShardSequencer } from "./it-shard-sequencer.js";
import { mergeTimings, timingsFileText } from "./it-timings-generate.js";
import { SIGKILL_EXIT_CODE, acquireLock, classifyExit, fencedSpawn, pidAlive, readHolder, reclaimDeadLock, releaseLock, runLocked, spawnPlan, spawnPrepareStep, type LockHolder } from "./suite-lock-run.js";
import { DAC_BYPASS_CAPS, assertWriteBitsBite, dacFenceScript, posixWriteBitsAbsentReason, writeBitsBite } from "./dac-fence.js";
import type { BoxProbe } from "./ci-max-workers.js";
import {
  INTEGRATION_INCLUDE_GLOBS,
  LOCAL_SHARDS,
  TIER_TIMINGS_PATH,
  balanceShards,
  SANDBOX_FILES_PER_SHARD,
  SANDBOX_MIN_SHARDS,
  countTierFiles,
  itShardCount,
  itShardSelector,
  itShardsOverride,
  listTierFiles,
  parseTierTimings,
  planShards,
  readTierTimings,
  sandboxShardCount,
  shardFiles,
  shardWeights,
  tierFilesDigest,
  tierProofLine,
  worstExit,
  type DirEntry,
  type TierFileProbe,
} from "./it-shards.js";
import { fmtBytes, ppidOf, rssBytesOf, treeRssBytes, type ProcProbe } from "./proc-rss.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = (args: string[]): [string, string[]] => tsxCommand(repoRoot, args);
const wrapperScript = join(repoRoot, "scripts", "suite-lock-run.ts");

const scratch = mkdtempSync(join(tmpdir(), "oe-suite-lock-test-"));

const HAS_PROC = existsSync("/proc/self/status");

function vitestCountSplit(files: readonly string[], index: number, total: number): string[] {
  const base = Math.floor(files.length / total);
  const remainder = files.length % total;
  const start = index <= remainder ? (base + 1) * (index - 1) : remainder * (base + 1) + (index - remainder - 1) * base;
  const size = index <= remainder ? base + 1 : base;
  return files
    .map((file) => ({ file, hash: createHash("sha1").update(`/${file}`).digest("hex") }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .slice(start, start + size)
    .map(({ file }) => file);
}

const BALANCE_FIXTURE: readonly (readonly [string, number])[] = [
  ["tests/integration/f00.test.ts", 360_000],
  ["tests/integration/f01.test.ts", 360_000],
  ["tests/integration/f02.test.ts", 49_000],
  ["tests/integration/f03.test.ts", 49_000],
  ["tests/integration/f04.test.ts", 34_000],
  ["tests/integration/f05.test.ts", 32_000],
  ["tests/integration/f06.test.ts", 28_000],
  ["tests/integration/f07.test.ts", 21_000],
  ["tests/integration/f08.test.ts", 21_000],
  ["tests/integration/f09.test.ts", 18_000],
  ["tests/integration/f10.test.ts", 18_000],
  ["tests/integration/f11.test.ts", 17_000],
  ["tests/integration/f12.test.ts", 16_000],
  ["tests/integration/f13.test.ts", 16_000],
  ["tests/integration/f14.test.ts", 13_000],
  ["tests/integration/f15.test.ts", 13_000],
  ["tests/integration/f16.test.ts", 12_000],
  ["tests/integration/f17.test.ts", 11_000],
  ["tests/integration/f18.test.ts", 11_000],
  ["tests/integration/f19.test.ts", 11_000],
  ["tests/integration/f20.test.ts", 10_000],
  ["tests/integration/f21.test.ts", 10_000],
  ["tests/integration/f22.test.ts", 9_000],
  ["tests/integration/f23.test.ts", 9_000],
  ["tests/integration/f24.test.ts", 8_000],
  ["tests/integration/f25.test.ts", 8_000],
  ["tests/integration/f26.test.ts", 7_000],
  ["tests/integration/f27.test.ts", 7_000],
  ["tests/integration/f28.test.ts", 6_000],
  ["tests/integration/f29.test.ts", 5_000],
  ["tests/integration/f30.test.ts", 5_000],
  ["tests/integration/f31.test.ts", 4_000],
  ["tests/integration/f32.test.ts", 4_000],
  ["tests/integration/f33.test.ts", 4_000],
  ["tests/integration/f34.test.ts", 3_000],
  ["tests/integration/f35.test.ts", 3_000],
  ["tests/integration/f36.test.ts", 3_000],
  ["tests/integration/f37.test.ts", 2_000],
  ["tests/integration/f38.test.ts", 2_000],
  ["tests/integration/f39.test.ts", 1_000],
];
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

function writeFakeVitest(dir: string, body: string): string {
  if (process.platform !== "win32") {
    const fake = join(dir, "vitest");
    writeFileSync(fake, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
    return fake;
  }
  writeFileSync(join(dir, "vitest.js"), body);
  const shim = join(dir, "vitest.cmd");
  writeFileSync(shim, `@"${process.execPath}" "%~dp0vitest.js" %*\r\n`);
  return shim;
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
    const child = spawn(...tsx([wrapperScript, "--", "node", ...args]), {
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

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
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

  if (process.platform === "win32") {
    console.log("– skipped on Windows: a wrapped command killed by SIGKILL exits 137 and says so (Windows reports a SIGKILL as exit 1 with no signal)");
  } else await check("a wrapped command killed by SIGKILL exits 137 and says so", async () => {
    const lockDir = join(scratch, "lock-killed");
    let code = 0;
    const lines = await captureStderr(async () => {
      code = await runLocked(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], { manual: false, lockDir, maxWaitMs: 20_000 });
    });
    assert.equal(code, SIGKILL_EXIT_CODE, "a SIGKILLed command must exit 137, so the kill is legible in an EXIT= line");
    const killLine = lines.find((l) => l.includes("KILLED"));
    assert.ok(killLine, `expected one line naming the kill, got ${JSON.stringify(lines)}`);
    assert.ok(/OOM/.test(killLine), "the line must name the OOM killer — that is the cause a reader would otherwise reach dmesg for");
    assert.ok(/OE_IT_CI_MAX_WORKERS=1/.test(killLine), "…and must name the remedy, not just the diagnosis");
    assert.equal(existsSync(lockDir), false, "the lock must be released even after the command was killed");
  });

  await check("classifyExit leaves an ordinary exit and a non-KILL signal alone", async () => {
    const quiet = await captureStderr(async () => {
      assert.equal(classifyExit(7, null, "node -e"), 7, "a real failing exit code passes through unchanged");
      assert.equal(classifyExit(0, null, "node -e"), 0, "a success stays a success");
      assert.equal(classifyExit(null, "SIGTERM", "node -e"), 1, "a non-KILL signal keeps the old flat 1");
    });
    assert.deepEqual(quiet, [], "🔴 none of those may print the OOM line — an OOM notice on an ordinary red is how a real failure gets excused");
    const noisy = await captureStderr(async () => {
      assert.equal(classifyExit(SIGKILL_EXIT_CODE, null, "node -e"), SIGKILL_EXIT_CODE, "a shell-reported 137 is classified too, not only a raw signal");
    });
    assert.equal(noisy.length, 1, `a shell-reported 137 must also print the notice, got ${JSON.stringify(noisy)}`);
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

  await check("shard policy: OE_IT_SHARDS wins, then the box decides (the file-count plan in a sandbox, 1 uncapped)", () => {
    const capped: BoxProbe = { readFile: (p) => (p === "/proc/self/cgroup" ? "0::/x\n" : "1000"), totalMemoryBytes: () => 16_000_000_000, cpuCount: () => 4 };
    const uncapped: BoxProbe = {
      readFile: (p) => {
        if (p === "/proc/self/cgroup") return "0::/x\n";
        throw new Error("ENOENT");
      },
      totalMemoryBytes: () => 16_000_000_000,
      cpuCount: () => 4,
    };
    const bigTier = () => 2 * SANDBOX_FILES_PER_SHARD + 1;
    const bigTierShards = 3;
    const noCount = () => undefined;
    assert.equal(itShardCount({ OE_IT_SHARDS: "7" }, capped, bigTier), 7, "an explicit OE_IT_SHARDS is honoured over the box read");
    assert.equal(itShardCount({ OE_IT_SHARDS: "1" }, capped, bigTier), 1, "OE_IT_SHARDS=1 is how a caller forces the single-process tier back");
    assert.ok(bigTierShards < SANDBOX_MIN_SHARDS, "the fixture must sit BELOW the floor, or the row below proves the floor and not the cap");
    assert.equal(itShardCount({}, capped, bigTier), SANDBOX_MIN_SHARDS, `🔴 a cgroup-capped process plans one shard per ${SANDBOX_FILES_PER_SHARD} files, never fewer than ${SANDBOX_MIN_SHARDS}`);
    assert.equal(itShardCount({}, capped, () => 4 * SANDBOX_FILES_PER_SHARD + 1), 5, "🔴 …and PAST the floor the file cap is what decides — one file past four caps buys a fifth shard");
    assert.equal(itShardCount({}, uncapped, bigTier), LOCAL_SHARDS, "NEGATIVE CONTROL: an uncapped box keeps today's single process");
    assert.equal(itShardCount({ CI: "1" }, uncapped, () => 4 * SANDBOX_FILES_PER_SHARD + 1), 5, "a declared CI runner plans from the file count even where no cgroup cap is readable");
    assert.equal(itShardCount({ CI: "false" }, uncapped, bigTier), LOCAL_SHARDS, "NEGATIVE CONTROL: CI=false is not a CI runner");
    assert.equal(itShardCount({}, capped, noCount), SANDBOX_MIN_SHARDS, "a tier count the tree cannot answer falls back to the floor, never to a guess");
    let counted = 0;
    const counting = (): number => {
      counted++;
      return 110;
    };
    itShardCount({ OE_IT_SHARDS: "3" }, capped, counting);
    itShardCount({}, uncapped, counting);
    assert.equal(counted, 0, "neither an override nor an uncapped box walks the tier");
    for (const bad of ["", "   ", "0", "-2", "2.5", "nope", "3abc"]) {
      assert.equal(itShardsOverride({ OE_IT_SHARDS: bad }), undefined, `a malformed OE_IT_SHARDS (${JSON.stringify(bad)}) says nothing, never NaN or 0`);
    }
  });

  await check(`shard sizing: the plan holds at most ${SANDBOX_FILES_PER_SHARD} files per process, with ${SANDBOX_MIN_SHARDS} as a floor`, () => {
    assert.equal(SANDBOX_FILES_PER_SHARD, 32, "🔴 the per-shard file cap is 32 (OPE-2229's re-derivation) — restate the derivation above before moving it");
    assert.equal(SANDBOX_MIN_SHARDS, 4, "🔴 the shard floor is 4 — the split that recovered the tier");
    const floorCapacity = SANDBOX_MIN_SHARDS * SANDBOX_FILES_PER_SHARD;
    assert.equal(sandboxShardCount(floorCapacity), SANDBOX_MIN_SHARDS, "an exact multiple of the floor's capacity does not buy an extra shard");
    assert.equal(sandboxShardCount(floorCapacity + 1), SANDBOX_MIN_SHARDS + 1, "🔴 …and one file past it does — the cap, not the floor, is what grows the plan");
    assert.equal(sandboxShardCount(5 * SANDBOX_FILES_PER_SHARD), SANDBOX_MIN_SHARDS + 1, "a tier of five caps is five shards");
    assert.equal(sandboxShardCount(400), Math.ceil(400 / SANDBOX_FILES_PER_SHARD), "🔴 NO CEILING: a much larger tier keeps the per-process count flat, or the pin is back");
    const realList = listTierFiles(repoRoot);
    assert.ok(realList !== undefined, "the repository's own tier must be countable");
    const realFiles = realList!.length;
    const realPlan = sandboxShardCount(realFiles);
    assert.equal(realPlan, Math.max(SANDBOX_MIN_SHARDS, Math.ceil(realFiles / SANDBOX_FILES_PER_SHARD)), `🔴 the tier (${realFiles} files) plans the floor or one shard per ${SANDBOX_FILES_PER_SHARD} files, whichever is more`);
    const realShards = balanceShards(realList!, realPlan, readTierTimings(repoRoot));
    assert.ok(
      realShards.every((shard) => shard.length <= SANDBOX_FILES_PER_SHARD),
      `🔴 a shard of the real ${realPlan}-shard plan holds more than ${SANDBOX_FILES_PER_SHARD} files (${realShards.map((shard) => shard.length).join("/")}) — re-read the sizing note above and re-measure, do not just move the number`,
    );
    assert.equal(sandboxShardCount(SANDBOX_FILES_PER_SHARD), SANDBOX_MIN_SHARDS, "a tier that fits in one process still takes the floor the OOM was recovered on");
    assert.equal(sandboxShardCount(undefined), SANDBOX_MIN_SHARDS, "an unreadable count takes the floor");
    for (const files of [undefined, 0, -3, 1, 12, 13, 110, 4000]) {
      const n = sandboxShardCount(files);
      assert.ok(Number.isInteger(n) && n >= SANDBOX_MIN_SHARDS, `every answer is a whole shard count at or above the floor — ${String(files)} gave ${n}`);
    }
  });

  await check("tier file count: the include globs are walked, and an unreadable tree answers nothing", () => {
    const tree: Record<string, DirEntry[]> = {
      "tests/integration": [
        { name: "memory", isDirectory: true },
        { name: "a.test.ts", isDirectory: false },
        { name: "harness.ts", isDirectory: false },
      ],
      "tests/integration/memory": [
        { name: "deep", isDirectory: true },
        { name: "b.test.ts", isDirectory: false },
      ],
      "tests/integration/memory/deep": [{ name: "c.test.ts", isDirectory: false }],
    };
    const probe: TierFileProbe = {
      readDir: (path) => {
        const entries = tree[path.replaceAll("\\", "/").replace(/^\/root\//u, "")];
        if (entries === undefined) throw new Error(`ENOENT ${path}`);
        return entries;
      },
    };
    assert.equal(countTierFiles("/root", INTEGRATION_INCLUDE_GLOBS, probe), 3, "every matching file at every depth is counted, and a non-test file is not");
    const halfBlind: TierFileProbe = {
      readDir: (path) => {
        if (path.endsWith("deep")) throw new Error("EACCES");
        return probe.readDir(path);
      },
    };
    assert.equal(countTierFiles("/root", INTEGRATION_INCLUDE_GLOBS, halfBlind), undefined, "🔴 a directory the walk cannot read answers nothing — never the 2 it managed to see");
    for (const glob of ["tests/integration", "tests/**/integration/**/*.test.ts", "tests/integration/*.test.ts", "tests/integration/**/*"]) {
      assert.equal(countTierFiles("/root", [glob], probe), undefined, `a glob shape this reader does not cover (${glob}) answers nothing`);
    }
    const real = countTierFiles(repoRoot);
    assert.ok(real !== undefined && real > 50, `the repository's own integration tier is countable — got ${String(real)}`);
    assert.equal(
      itShardCount({}, { readFile: (p) => (p === "/proc/self/cgroup" ? "0::/x\n" : "1000"), totalMemoryBytes: () => 16_000_000_000, cpuCount: () => 4 }),
      sandboxShardCount(countTierFiles()),
      "🔴 the default (no injected counter) reads the tier off the tree — the wiring, not just the arithmetic",
    );
  });

  await check("prepare: the step runs ONCE and BEFORE any shard, and a red there runs no shard at all", async () => {
    const dir = mkdtempSync(join(scratch, "prepare-"));
    const marker = join(dir, "prepared");
    const asksIfPrepared = ["-e", `process.exit(require("node:fs").existsSync(${JSON.stringify(marker)}) ? 0 : 7)`];
    let prepareCalls = 0;
    const ok = await runLocked("node", asksIfPrepared, {
      manual: true,
      lockDir: join(dir, "lock"),
      maxWaitMs: 1_000,
      prepare: async () => {
        prepareCalls++;
        writeFileSync(marker, "1");
        return 0;
      },
    });
    assert.equal(ok, 0, "🔴 the shard ran AFTER the prepare step — ordering, not merely presence");
    assert.equal(prepareCalls, 1, "once per run, never once per shard: that repeat is what OPE-2235 removed");

    rmSync(marker, { force: true });
    const unprepared = await runLocked("node", asksIfPrepared, { manual: true, lockDir: join(dir, "lock-2"), maxWaitMs: 1_000 });
    assert.equal(unprepared, 7, "a non-vitest command is not prepared, and the fixture says so");

    let ran = 0;
    const red = await runLocked("node", ["-e", "process.exit(0)"], {
      manual: true,
      lockDir: join(dir, "lock-3"),
      maxWaitMs: 1_000,
      prepare: async () => {
        ran++;
        return 3;
      },
    });
    assert.equal(red, 3, "the run reports the prepare step's exit, not a shard's");
    assert.equal(ran, 1, "and it did not retry the step per shard");

    assert.equal(typeof spawnPrepareStep, "function");
    const wrapperSource = readFileSync(wrapperScript, "utf8");
    assert.ok(wrapperSource.includes('spawn("npm", ["run", "test:integration:prepare"]'), "the wrapper spawns the documented npm script");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts["test:integration:prepare"]?.includes("tests/integration/prepare.ts"), "and that script names the step's own file");
  });

  await check("shard plan: the unfiltered tier splits; a targeted leg and an unreadable call never do", () => {
    const tier = planShards("vitest", ["run"], 4);
    assert.equal(tier.wholeTier, true, "an unfiltered `vitest run` IS the tier, so it owes the tier proof line");
    assert.deepEqual(
      tier.runs.map((r) => r.args.join(" ")),
      ["run --shard=1/4", "run --shard=2/4", "run --shard=3/4", "run --shard=4/4"],
      "every shard of the series runs, and each names the same N",
    );
    assert.deepEqual(
      tier.runs.map((r) => r.suite),
      ["test:integration--shard=1/4", "test:integration--shard=2/4", "test:integration--shard=3/4", "test:integration--shard=4/4"],
      "the per-shard suite names are exactly the shape collapseShardSeries parses",
    );
    const targeted = planShards("vitest", ["run", "tests/integration/memory/fence.test.ts"], 4);
    assert.equal(targeted.runs.length, 1, "a file filter is a targeted leg and must run as one process");
    assert.equal(targeted.wholeTier, false, "…and it must NEVER claim the tier's proof line");
    assert.ok(/file filter/.test(targeted.reason ?? ""), "…and it says why, so a reader is not left guessing");
    for (const filter of ["-t", "--testNamePattern=redelivery", "--project=core", "--dir=tests/integration/memory", "--changed", "--exclude=**/slow.test.ts", "--related"]) {
      const flagged = planShards("vitest", ["run", filter], 4);
      assert.equal(flagged.runs.length, 1, `\`${filter}\` narrows the tier, so it must run as ONE process`);
      assert.equal(flagged.wholeTier, false, `🔴 …and \`${filter}\` must NEVER claim the tier's proof line — it ran a subset`);
    }
    const reporter = planShards("vitest", ["run", "--reporter=dot"], 4);
    assert.equal(reporter.runs.length, 4, "a flag that narrows nothing (--reporter) leaves the tier shardable");
    assert.equal(reporter.wholeTier, true, "…and it is still the tier");
    const already = planShards("vitest", ["run", "--shard=2/3"], 4);
    assert.equal(already.runs.length, 1, "a caller that already chose a --shard is left alone");
    const notVitest = planShards("node", ["run"], 4);
    assert.equal(notVitest.runs.length, 1, "a wrapped command that is not vitest is never sharded");
    assert.equal(notVitest.wholeTier, false, "…and never claims the tier");
    const single = planShards("vitest", ["run"], 1);
    assert.deepEqual(single.runs.map((r) => r.args.join(" ")), ["run"], "OE_IT_SHARDS=1 runs the bare command, with no --shard at all");
    assert.equal(single.wholeTier, true, "…and it is still the tier, so it still owes the one proof line");
    assert.equal(planShards("/usr/x/node_modules/.bin/vitest", ["run"], 2).runs.length, 2, "vitest is recognised through an absolute path");
  });

  await check("shard exit: the tier reports the WORST shard, so a killed shard is never hidden", () => {
    assert.equal(worstExit([0, 0, 0, 0]), 0, "four green shards are a green tier");
    assert.equal(worstExit([0, SIGKILL_EXIT_CODE, 0, 0]), SIGKILL_EXIT_CODE, "one OOM-killed shard reds the tier, and keeps the 137 a reader acts on");
    assert.equal(worstExit([1, 0, 0, 0]), 1, "a failing first shard is not erased by three green ones after it");
    assert.equal(worstExit([]), 0, "no shards is a vacuous 0 — planShards never produces this, and it must not be NaN");
    assert.equal(
      tierProofLine("abc1234", 0),
      "OE_PROOF sha=abc1234 suite=test:integration exit=0",
      "the tier line is byte-exact to what cloud-proof-verify-lib.ts parses",
    );
  });

  await check("runLocked: four shards run in order, one tier line is printed, and a red shard still lets the rest run", async () => {
    const lockDir = join(scratch, "lock-shards");
    const marks = join(scratch, "shard-marks.txt");
    const fakeDir = mkdtempSync(join(tmpdir(), "oe-fake-vitest-"));
    const fake = writeFakeVitest(
      fakeDir,
      `require("node:fs").appendFileSync(${JSON.stringify(marks)}, process.argv.slice(2).join(" ") + ` +
        `" skip=" + (process.env.OE_IT_SKIP_BUILD ?? "unset") + "\\n");\n` +
        `process.exit(process.argv.includes("--shard=2/4") ? 3 : 0);\n`,
    );
    let out: string[] = [];
    const logged = await captureStderr(async () => {
      out = await captureStdout(async () => {
        const code = await runLocked(fake, ["run"], {
          manual: false,
          lockDir,
          maxWaitMs: 20_000,
          env: { OE_IT_SHARDS: "4" },
          emitProof: true,
          prepare: async () => 0,
        });
        assert.equal(code, 3, "the tier takes the worst shard's code");
      });
    });
    assert.deepEqual(
      readFileSync(marks, "utf8").trim().split("\n"),
      ["run --shard=1/4 skip=unset", "run --shard=2/4 skip=unset", "run --shard=3/4 skip=unset", "run --shard=4/4 skip=unset"],
      "🔴 all four shards ran IN ORDER — the loop must not stop on the red, or the series is incomplete and proves nothing. " +
        "And NO shard is handed OE_IT_SKIP_BUILD (OPE-2235): the prepare step built the target, so every shard starts on the " +
        "same prepared tree and none of them differs from the first.",
    );
    const proof = out.filter((l) => l.startsWith("OE_PROOF "));
    assert.equal(proof.length, 1, `exactly ONE tier line, after every shard — got ${JSON.stringify(proof)}`);
    assert.ok(/^OE_PROOF sha=[0-9a-f]{7,40} suite=test:integration exit=3$/.test(proof[0]!), `the tier line carries the worst exit — got ${proof[0]}`);
    const shardLabels = logged.filter((l) => l.includes("--shard="));
    assert.equal(shardLabels.length, 4, `each shard reports its own exit on STDERR — got ${JSON.stringify(shardLabels)}`);
    assert.ok(
      shardLabels.every((l) => l.startsWith("suite-lock-run: ") && !l.includes("OE_PROOF")),
      `…as a human log label and never as an evidence line — got ${JSON.stringify(shardLabels)}`,
    );
    assert.ok(
      shardLabels.every((l) =>
        (HAS_PROC ? /exit=\d+ peak-tree-rss=\d+(\.\d+)? [A-Za-z]+ wall=\d+\.\d+s workers=\d+$/u : /exit=\d+ peak-tree-rss=not measured wall=\d+\.\d+s workers=\d+$/u).test(l),
      ),
      `each shard label carries its exit, peak tree RSS, wall clock and worker count — got ${JSON.stringify(shardLabels)}`,
    );
    assert.ok(
      shardLabels.every((l) => !l.includes("build=")),
      `🔴 …and no build field, because no shard builds — got ${JSON.stringify(shardLabels)}`,
    );
    const shardingLine = logged.find((l) => l.includes("sharding the integration tier"));
    assert.ok(shardingLine !== undefined, "the sharded tier announces itself");
    assert.ok(
      !/test file\(s\)|file count could NOT be read/u.test(shardingLine),
      `🔴 an explicit OE_IT_SHARDS reads no file count, so it must report none — got ${JSON.stringify(shardingLine)}`,
    );
    assert.deepEqual(
      logged.filter((l) => l.includes("reuses its tree")),
      [],
      "no shard reuses another shard's tree any more, so nothing may warn that one does",
    );
    assert.equal(existsSync(lockDir), false, "the lock is released after a sharded run like any other");
    rmSync(fakeDir, { recursive: true, force: true });
  });

  await check("shard selector: OE_IT_SHARD reads k/N, and a value it cannot read is REFUSED, never ignored", () => {
    assert.deepEqual(itShardSelector({}), { kind: "none" }, "unset is the full tier");
    assert.deepEqual(itShardSelector({ OE_IT_SHARD: "  " }), { kind: "none" }, "blank is the full tier");
    assert.deepEqual(itShardSelector({ OE_IT_SHARD: "2/4" }), { kind: "shard", selector: { index: 2, total: 4 } });
    assert.deepEqual(itShardSelector({ OE_IT_SHARD: "1/1" }), { kind: "shard", selector: { index: 1, total: 1 } }, "a one-shard series is a valid series");
    assert.deepEqual(itShardSelector({ OE_IT_SHARD: "3/4", OE_IT_SHARDS: "4" }), { kind: "shard", selector: { index: 3, total: 4 } }, "an agreeing OE_IT_SHARDS is fine");
    for (const bad of ["0/4", "5/4", "2/0", "2", "2/4/1", "a/b", "-1/4", "2 / 4", "1.5/4"]) {
      assert.equal(itShardSelector({ OE_IT_SHARD: bad }).kind, "invalid", `OE_IT_SHARD=${JSON.stringify(bad)} is refused`);
    }
    assert.equal(itShardSelector({ OE_IT_SHARD: "2/4", OE_IT_SHARDS: "3" }).kind, "invalid", "an OE_IT_SHARDS that names another N is refused");
  });

  await check("shard plan: single-shard mode runs the full series' k-th pass, and names the SHARD as its proof suite", () => {
    const full = planShards("vitest", ["run"], 4);
    assert.equal(full.proofSuite, "test:integration", "the full mode's proof line names the tier, as before");
    const one = planShards("vitest", ["run"], 99, { index: 2, total: 4 });
    assert.equal(one.wholeTier, true, "one shard of the unfiltered tier still owes a proof line");
    assert.deepEqual(one.runs, [full.runs[1]], "🔴 the single run IS the full series' second pass — same argv, same suite name — whatever OE_IT_SHARDS planned");
    assert.equal(one.proofSuite, "test:integration--shard=2/4", "…and its proof line names the shard, never the tier");
    const targeted = planShards("vitest", ["run", "tests/integration/memory/fence.test.ts"], 4, { index: 2, total: 4 });
    assert.equal(targeted.wholeTier, false, "a targeted leg is never one shard of the tier");
    assert.equal(targeted.runs[0]!.args.some((a) => a.startsWith("--shard")), false, "…and it is not handed a --shard");
  });

  await check("shard plan: N single-shard plans cover every tier file EXACTLY once, on one deterministic split", async () => {
    const files = listTierFiles(repoRoot);
    assert.ok(files !== undefined && files.length > 0, "the live tier's file list reads");
    const globbed = INTEGRATION_INCLUDE_GLOBS.flatMap((g) => globSync(g, { cwd: repoRoot })).map((f) => f.split("\\").join("/")).sort();
    assert.deepEqual(files, globbed, `the walk names the same ${globbed.length} files the include glob matches`);
    assert.equal(files.length, countTierFiles(repoRoot), "and the count the shard plan sizes from is that list's length");
    const timings = readTierTimings(repoRoot);
    assert.ok(timings.size > 0, `the checked-in ${TIER_TIMINGS_PATH} reads and holds measurements`);

    const planned = sandboxShardCount(files.length);
    const counts = new Set([1, 2, 3, planned, planned + 1, 7, files.length, files.length + 3]);
    for (const total of counts) {
      const seen = new Map<string, number>();
      let sum = 0;
      for (let k = 1; k <= total; k++) {
        const share = shardFiles(files, k, total, timings);
        sum += share.length;
        if (total <= files.length) assert.ok(share.length > 0, `N=${total}: shard ${k} is not empty while N does not exceed the tier`);
        for (const f of share) seen.set(f, (seen.get(f) ?? 0) + 1);
      }
      assert.equal(sum, files.length, `N=${total}: the shards hold ${sum} files in all, and the tier holds ${files.length}`);
      assert.deepEqual([...seen.keys()].sort(), files, `N=${total}: no tier file is missed`);
      assert.ok([...seen.values()].every((n) => n === 1), `N=${total}: no tier file runs twice`);
    }

    const shuffled = [...files].reverse();
    for (let k = 1; k <= planned; k++) {
      assert.deepEqual(shardFiles(shuffled, k, planned, timings), shardFiles(files, k, planned, timings), `shard ${k}/${planned} ignores the input order`);
    }
    assert.equal(tierFilesDigest(files), tierFilesDigest([...files]), "the logged digest is a function of the list");

    assert.equal(vitestConfig.test?.sequence?.sequencer, DurationShardSequencer, "vitest.config.ts installs DurationShardSequencer, so --shard=k/N runs the balanced split");

    const otherRoot = mkdtempSync(join(tmpdir(), "oe-other-checkout-"));
    mkdirSync(join(otherRoot, dirname(TIER_TIMINGS_PATH)), { recursive: true });
    writeFileSync(join(otherRoot, TIER_TIMINGS_PATH), readFileSync(join(repoRoot, TIER_TIMINGS_PATH)));
    for (const root of [repoRoot, otherRoot]) {
      for (let k = 1; k <= planned; k++) {
        const sequencer = new DurationShardSequencer({ config: { root, shard: { index: k, count: planned } } } as unknown as ConstructorParameters<typeof DurationShardSequencer>[0]);
        const specs = shuffled.map((f) => ({ moduleId: `${root}/${f}` }));
        const picked = (await sequencer.shard(specs as unknown as Parameters<DurationShardSequencer["shard"]>[0])) as unknown as { moduleId: string }[];
        assert.deepEqual(
          picked.map((spec) => spec.moduleId.slice(root.length + 1)).sort(),
          shardFiles(files, k, planned, timings),
          `the sequencer's --shard=${k}/${planned} at root ${root} picks exactly the files shardFiles names`,
        );
      }
    }
    rmSync(otherRoot, { recursive: true, force: true });
  });

  await check("balanced split: on a fixed timings fixture the slowest shard is within 1.3x of the mean", () => {
    const fixture = new Map<string, number>(BALANCE_FIXTURE.map(([file, ms]) => [file, ms]));
    const files = [...fixture.keys()].sort();
    const total = 4;
    const loads = balanceShards(files, total, fixture).map((share) => share.reduce((sum, f) => sum + fixture.get(f)!, 0));
    const mean = loads.reduce((a, b) => a + b, 0) / total;
    const ratio = Math.max(...loads) / mean;
    assert.ok(ratio <= 1.3, `🔴 the slowest shard is ${ratio.toFixed(2)}x the mean — loads ${loads.map((l) => Math.round(l / 1000)).join("/")} s`);
    const countLoads = Array.from({ length: total }, (_, i) => vitestCountSplit(files, i + 1, total).reduce((sum, f) => sum + fixture.get(f)!, 0));
    const countRatio = Math.max(...countLoads) / mean;
    assert.ok(countRatio > 1.3, `the fixture must unbalance the count split — got ${countRatio.toFixed(2)}x (loads ${countLoads.map((l) => Math.round(l / 1000)).join("/")} s)`);
  });

  await check("balanced split: a file with no measurement weighs the MEDIAN, and the plan stays deterministic", () => {
    const timings = new Map([
      ["a.test.ts", 10],
      ["b.test.ts", 30],
      ["c.test.ts", 50],
      ["gone.test.ts", 999_999],
    ]);
    const weights = shardWeights(["a.test.ts", "b.test.ts", "c.test.ts", "new.test.ts"], timings);
    assert.equal(weights.get("new.test.ts"), 30, "an unmeasured file weighs the median of the tier's MEASURED files — a deleted spec's entry does not count");
    assert.equal(shardWeights(["a.test.ts", "b.test.ts", "x.test.ts"], timings).get("x.test.ts"), 20, "an even count takes the mean of the two middle values");
    assert.equal(shardWeights(["x.test.ts", "y.test.ts"], new Map()).get("x.test.ts"), 1, "a tier with no measurement at all weighs every file the same");
    const even = balanceShards(["d", "c", "b", "a", "e"], 2, new Map());
    assert.deepEqual(even.map((s) => s.length).sort(), [2, 3], "equal weights split by count");
    assert.deepEqual(balanceShards(["a", "b", "c"], 3, new Map([["a", 0], ["b", 0], ["c", 0]])).map((s) => s.length), [1, 1, 1], "a zero weight still fills every shard");
    assert.deepEqual(balanceShards(["c", "a", "b"], 2, timings), balanceShards(["b", "c", "a"], 2, timings), "the input order never moves a file");
    assert.deepEqual(balanceShards(["a.test.ts", "b.test.ts", "c.test.ts"], 2, timings), [["c.test.ts"], ["a.test.ts", "b.test.ts"]], "longest first, each into the least-loaded shard");
    const heavy = new Map<string, number>([["heavy.test.ts", 1_000_000]]);
    const many = ["heavy.test.ts", ...Array.from({ length: 63 }, (_, i) => `cheap-${String(i).padStart(2, "0")}.test.ts`)];
    for (const f of many.slice(1)) heavy.set(f, 1);
    const capped = balanceShards(many, 2, heavy).map((s) => s.length);
    assert.ok(capped.every((n) => n <= SANDBOX_FILES_PER_SHARD), `🔴 no shard passes the ${SANDBOX_FILES_PER_SHARD}-file cap under a skewed duration (${capped.join("/")})`);
    assert.equal(capped.reduce((a, b) => a + b, 0), many.length, "…and every file still lands in a shard");
    const past = Array.from({ length: 70 }, (_, i) => `p-${String(i).padStart(2, "0")}.test.ts`);
    const pastSplit = balanceShards(past, 2, new Map()).map((s) => s.length);
    assert.deepEqual(pastSplit, [35, 35], `a fixed total past the cap splits evenly (${pastSplit.join("/")})`);
    assert.equal(pastSplit.reduce((a, b) => a + b, 0), 70, "…and places every file");
  });

  await check("timings file: a malformed file throws, a missing one is empty, and a regeneration merges by rule", () => {
    assert.deepEqual([...parseTierTimings('{"files":{"a.test.ts":12}}')], [["a.test.ts", 12]]);
    for (const bad of ["{}", '{"files":[]}', '{"files":{"a":-1}}', '{"files":{"a":"5"}}', "not json"]) {
      assert.throws(() => parseTierTimings(bad), `🔴 ${bad} is refused, never half-read`);
    }
    const empty = mkdtempSync(join(tmpdir(), "oe-no-timings-"));
    assert.equal(readTierTimings(empty).size, 0, "a tree with no timings file weighs every file the same");
    rmSync(empty, { recursive: true, force: true });

    const root = "/r";
    const report = (entries: [string, number, number][]) => ({ testResults: entries.map(([name, startTime, endTime]) => ({ name, startTime, endTime })) });
    const merge = mergeTimings(
      [report([["/r/tests/integration/a.test.ts", 100, 1_100], ["/r/tests/integration/b.test.ts", 0, 400]]), report([["/r/tests/integration/a.test.ts", 0, 3_000], ["/r/tests/integration/other.test.ts", 0, 5]])],
      root,
      ["tests/integration/a.test.ts", "tests/integration/b.test.ts", "tests/integration/c.test.ts", "tests/integration/d.test.ts"],
      new Map([["tests/integration/c.test.ts", 77], ["tests/integration/b.test.ts", 1], ["tests/integration/deleted.test.ts", 9]]),
    );
    assert.deepEqual(
      merge.files,
      { "tests/integration/a.test.ts": 3_000, "tests/integration/b.test.ts": 400, "tests/integration/c.test.ts": 77 },
      "a file measured twice takes the LONGEST; a fresh measurement replaces the old one; an unmeasured tier file keeps its entry",
    );
    assert.deepEqual(merge.dropped, ["tests/integration/deleted.test.ts"], "an entry for a file outside the tier is dropped");
    assert.deepEqual(merge.unmeasured, ["tests/integration/d.test.ts"], "a tier file with no entry is named, so the median is visible");
    assert.equal(merge.kept, 1);
    assert.deepEqual([...parseTierTimings(timingsFileText(merge.files))], Object.entries(merge.files), "the written text reads back as the same timings");
    assert.throws(() => mergeTimings([{ testResults: [{ name: "/r/x", startTime: 5 }] }], root, [], new Map()), "an entry with no end time is refused, never skipped");
    assert.throws(
      () => mergeTimings([{ testResults: [{ name: "/r/tests/integration/a.test.ts", status: "failed", startTime: 5, endTime: 5 }] }], root, ["tests/integration/a.test.ts"], new Map()),
      /green runs only/,
      "🔴 a failed file is refused: a beforeAll that failed would otherwise record ~0 ms for the slowest file",
    );
  });

  await check("runLocked: OE_IT_SHARD=k/N runs ONLY shard k and prints ONE line that names the shard", async () => {
    const lockDir = join(scratch, "lock-single-shard");
    const marks = join(scratch, "single-shard-marks.txt");
    const fakeDir = mkdtempSync(join(tmpdir(), "oe-fake-vitest-"));
    const fake = writeFakeVitest(
      fakeDir,
      `require("node:fs").appendFileSync(${JSON.stringify(marks)}, process.argv.slice(2).join(" ") + "\\n");\n` +
        `process.exit(process.argv.includes("--shard=2/4") ? 3 : 0);\n`,
    );
    let prepared = 0;
    let out: string[] = [];
    const logged = await captureStderr(async () => {
      out = await captureStdout(async () => {
        const code = await runLocked(fake, ["run"], {
          manual: false,
          lockDir,
          maxWaitMs: 20_000,
          env: { OE_IT_SHARD: "2/4", OE_IT_SHARDS: "4" },
          emitProof: true,
          prepare: async () => {
            prepared++;
            return 0;
          },
        });
        assert.equal(code, 3, "the run reports its one shard's exit");
      });
    });
    assert.equal(prepared, 1, "the prepare step runs once, before the shard");
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["run --shard=2/4"], "🔴 ONLY shard 2 of 4 ran — no other shard, no unsharded tier");
    const proof = out.filter((l) => l.startsWith("OE_PROOF "));
    assert.equal(proof.length, 1, `exactly ONE evidence line — got ${JSON.stringify(proof)}`);
    assert.ok(
      /^OE_PROOF sha=[0-9a-f]{40} suite=test:integration--shard=2\/4 exit=3$/.test(proof[0]!),
      `🔴 the line names the SHARD with its exit, never the tier — got ${proof[0]}`,
    );
    const mode = logged.find((l) => l.includes("single-shard mode"));
    assert.ok(mode !== undefined && /holds \d+ file\(s\) \(digest [0-9a-f]{12}\), and this shard runs \d+/.test(mode), `the run logs its share of the plan — got ${mode}`);
    assert.equal(existsSync(lockDir), false, "the lock is released");

    writeFileSync(marks, "");
    const redOut = await captureStdout(async () => {
      await captureStderr(async () => {
        const code = await runLocked(fake, ["run"], { manual: true, lockDir, maxWaitMs: 1_000, env: { OE_IT_SHARD: "4/4" }, emitProof: true, prepare: async () => 5 });
        assert.equal(code, 5);
      });
    });
    assert.equal(readFileSync(marks, "utf8"), "", "a red prepare runs no shard");
    assert.ok(/^OE_PROOF sha=[0-9a-f]{40} suite=test:integration--shard=4\/4 exit=5$/.test(redOut.find((l) => l.startsWith("OE_PROOF ")) ?? ""), `got ${JSON.stringify(redOut)}`);

    mkdirSync(lockDir);
    const foreign: LockHolder = { pid: process.ppid, startedAt: new Date().toISOString(), command: "a foreign holder" };
    writeFileSync(join(lockDir, "holder.json"), JSON.stringify(foreign));
    for (const [env, args, why] of [
      [{ OE_IT_SHARD: "5/4" }, ["run"], "an out-of-range shard"],
      [{ OE_IT_SHARD: "2/4", OE_IT_SHARDS: "3" }, ["run"], "a disagreeing OE_IT_SHARDS"],
      [{ OE_IT_SHARD: "1/4" }, ["run", "tests/integration/oe-status.test.ts"], "a targeted leg"],
    ] as const) {
      let refusedPrepare = 0;
      let refusedOut: string[] = [];
      const refusedLog = await captureStderr(async () => {
        refusedOut = await captureStdout(async () => {
          const code = await runLocked(fake, [...args], {
            manual: false,
            lockDir,
            maxWaitMs: 1_000,
            env: { ...env },
            emitProof: true,
            prepare: async () => {
              refusedPrepare++;
              return 0;
            },
          });
          assert.equal(code, 2, `${why} exits 2`);
        });
      });
      assert.equal(refusedPrepare, 0, `${why}: the prepare step never ran`);
      assert.equal(readFileSync(marks, "utf8"), "", `${why}: vitest never ran`);
      assert.deepEqual(refusedOut.filter((l) => l.startsWith("OE_PROOF ")), [], `${why}: no evidence line`);
      assert.ok(refusedLog.some((l) => l.includes("Nothing ran")), `${why}: the refusal says so — got ${JSON.stringify(refusedLog)}`);
      assert.equal(readHolder(lockDir)?.pid, process.ppid, `${why}: the lock was never taken — its foreign holder is unchanged`);
    }
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  await check("runLocked: a targeted leg runs once and prints NO tier proof line", async () => {
    const lockDir = join(scratch, "lock-targeted");
    const fakeDir = mkdtempSync(join(tmpdir(), "oe-fake-vitest-t-"));
    const fake = writeFakeVitest(fakeDir, "process.exit(0);\n");
    const out = await captureStdout(async () => {
      const code = await runLocked(fake, ["run", "tests/integration/x.test.ts"], {
        manual: false,
        lockDir,
        maxWaitMs: 20_000,
        env: { OE_IT_SHARDS: "4" },
        emitProof: true,
        prepare: async () => 0,
      });
      assert.equal(code, 0, "the targeted leg still reports its own code");
    });
    assert.deepEqual(out.filter((l) => l.startsWith("OE_PROOF ")), [], "🔴 a filtered run must print no tier evidence line at all");
    rmSync(fakeDir, { recursive: true, force: true });
  });

  await check("proc-rss: a tree's peak sums the whole spawned tree, and a reaped pid costs nothing", () => {
    const status = (ppid: number, rssKb: number | undefined) =>
      `Name:\tnode\nPPid:\t${ppid}\n${rssKb === undefined ? "" : `VmRSS:\t${rssKb} kB\n`}VmSize:\t999 kB\n`;
    const tree: Record<number, string> = {
      100: status(1, 1024),
      101: status(100, 2048),
      102: status(101, 4096),
      200: status(1, 8192),
      300: status(100, undefined),
    };
    const probe: ProcProbe = {
      listPids: () => Object.keys(tree).map(Number),
      readStatus: (pid) => {
        const s = tree[pid];
        if (s === undefined) throw new Error("ESRCH");
        return s;
      },
    };
    assert.equal(treeRssBytes(100, probe), (1024 + 2048 + 4096) * 1024, "the sum covers children and grandchildren");
    assert.equal(treeRssBytes(200, probe), 8192 * 1024, "NEGATIVE CONTROL: an unrelated tree contributes nothing to this one");
    assert.equal(treeRssBytes(999, probe), 0, "a root that is not there reads 0, never a throw");
    const racing: ProcProbe = {
      listPids: () => [100, 101],
      readStatus: (pid) => {
        if (pid === 101) throw new Error("ESRCH");
        return tree[100]!;
      },
    };
    assert.equal(treeRssBytes(100, racing), 1024 * 1024, "a process that exits mid-sample is skipped, not fatal");
    assert.equal(rssBytesOf("VmSize:\t10 kB\n"), undefined, "a status with no VmRSS answers undefined, never 0");
    assert.equal(ppidOf("Name:\tx\n"), undefined, "a status with no PPid answers undefined");
    assert.equal(fmtBytes(0), "not measured", "an unmeasured peak says so rather than printing 0 GB");
    assert.equal(fmtBytes(12 * 1024 ** 3), "12.0 GB", "a gigabyte-scale peak reads in binary GB");
    assert.equal(fmtBytes(300 * 1024), "300 KB", "🔴 a sub-megabyte peak must not round to `0 MB`, which reads as `not measured`");
  });

  await check("the wrapper drops the DAC bypass for vitest, and only for vitest", () => {
    const bits = writeBitsBite();

    const node = fencedSpawn(process.execPath, ["-e", "0"]);
    assert.equal(node.cmd, process.execPath, "a non-vitest command is spawned exactly as it was asked for");
    assert.deepEqual(node.args, ["-e", "0"], "…with its arguments untouched");

    const vitest = fencedSpawn("/repo/node_modules/.bin/vitest", ["run", "--shard=1/4"]);
    if (posixWriteBitsAbsentReason() !== null) {
      assert.equal(vitest.cmd, "/repo/node_modules/.bin/vitest", "a host with no POSIX write bits spawns vitest unwrapped");
    } else if (bits) {
      assert.equal(vitest.cmd, "/repo/node_modules/.bin/vitest", "a runner the write bits already bite is spawned unwrapped");
      assert.deepEqual(vitest.args, ["run", "--shard=1/4"], "…with its arguments untouched");
    } else {
      assert.match(vitest.cmd, /capsh$/u, "a runner that bypasses the write bits spawns vitest behind capsh");
      assert.equal(vitest.args[0], `--drop=${DAC_BYPASS_CAPS.join(",")}`, "…dropping exactly the two DAC bypass capabilities, and no others");
      assert.match(vitest.args.at(-1) ?? "", /vitest'? '?run/u, "…and the wrapped command still runs vitest with its own arguments");
    }
  });

  await check("on Windows the wrapper spawns vitest unwrapped and prints why", async () => {
    const err = await captureStderr(async () => {
      const win = fencedSpawn("C:\\repo\\node_modules\\.bin\\vitest.cmd", ["run", "a.test.ts"], "win32");
      assert.equal(win.cmd, "C:\\repo\\node_modules\\.bin\\vitest.cmd", "a Windows host spawns vitest itself, not capsh");
      assert.deepEqual(win.args, ["run", "a.test.ts"], "…with its arguments untouched");
    });
    assert.match(err.join("\n"), /no DAC fence on this host — Windows/u, "…and it prints the reason by name");
  });

  await check("spawnPlan: no shell off Windows; on Windows a real executable runs direct and a shim gets one quoted line", () => {
    const script = 'process.exit(require("node:fs").existsSync("a b") ? 0 : 7)';
    assert.deepEqual(spawnPlan("vitest", ["run"], "linux"), { cmd: "vitest", args: ["run"], shell: false }, "Linux spawns the command as given, with no shell");
    assert.deepEqual(spawnPlan("node", ["-e", script], "win32"), { cmd: "node", args: ["-e", script], shell: false }, "🔴 Windows spawns node directly, so a script argument stays one word");
    assert.equal(spawnPlan("C:\\nodejs\\node.exe", ["-e", "0"], "win32").shell, false, "…and any .exe directly");
    const shim = spawnPlan("C:\\my tools\\vitest.cmd", ["run", "--shard=1/4", 'a "b"'], "win32");
    assert.equal(shim.shell, true, "a .cmd shim goes through cmd.exe");
    assert.deepEqual(shim.args, [], "…as ONE command line, never an argv for Node to join");
    assert.equal(shim.cmd, '"C:\\my tools\\vitest.cmd" run --shard=1/4 "a \\"b\\""', "…with a spaced path and an embedded quote quoted, and plain words left alone");
  });

  await check("dacFenceScript quotes every word, so a path with a space cannot split", () => {
    const script = dacFenceScript("/opt/my tools/vitest", ["run", "--reporter=it's-fine"]);
    assert.ok(script.includes(`'/opt/my tools/vitest'`), "a command path with a space is quoted whole");
    assert.ok(script.includes(`'--reporter=it'\\''s-fine'`), "…and an embedded single quote is escaped rather than ending the quoting");
  });

  await check("posixWriteBitsAbsentReason names Windows, and only Windows", () => {
    assert.equal(posixWriteBitsAbsentReason("linux"), null, "Linux has POSIX write bits, so it gets no skip reason");
    assert.equal(posixWriteBitsAbsentReason("darwin"), null, "macOS has POSIX write bits, so it gets no skip reason");
    const win = posixWriteBitsAbsentReason("win32");
    assert.ok(typeof win === "string" && /Windows/u.test(win), "Windows gets a reason that names the host");
  });

  await check("assertWriteBitsBite names the runner it refuses, and passes once the bits bite", () => {
    if (writeBitsBite()) {
      assertWriteBitsBite("this leg");
      return;
    }
    assert.throws(
      () => assertWriteBitsBite("this leg"),
      /this leg .*BYPASSES them \(CAP_DAC_OVERRIDE\)/su,
      "an unfenced runner is refused BY NAME — never a silent pass",
    );
  });

  rmSync(scratch, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} suite-lock-run test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll suite-lock-run tests passed.");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
