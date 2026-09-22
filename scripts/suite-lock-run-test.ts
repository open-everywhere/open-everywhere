import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SIGKILL_EXIT_CODE, acquireLock, classifyExit, fencedSpawn, pidAlive, readHolder, reclaimDeadLock, releaseLock, runLocked, type LockHolder } from "./suite-lock-run.js";
import { DAC_BYPASS_CAPS, assertWriteBitsBite, dacFenceScript, writeBitsBite } from "./dac-fence.js";
import type { MemoryProbe } from "./ci-max-workers.js";
import {
  INTEGRATION_INCLUDE_GLOBS,
  IT_SKIP_BUILD_ENV,
  LOCAL_SHARDS,
  SANDBOX_FILES_PER_SHARD,
  SANDBOX_MIN_SHARDS,
  countTierFiles,
  itShardCount,
  itShardsOverride,
  planShards,
  sandboxShardCount,
  shardReusesBuild,
  tierProofLine,
  worstExit,
  type DirEntry,
  type TierFileProbe,
} from "./it-shards.js";
import { fmtBytes, ppidOf, rssBytesOf, treeRssBytes, type ProcProbe } from "./proc-rss.js";

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

  await check("a wrapped command killed by SIGKILL exits 137 and says so", async () => {
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
    const capped: MemoryProbe = { readFile: (p) => (p === "/proc/self/cgroup" ? "0::/x\n" : "1000"), totalMemoryBytes: () => 16_000_000_000 };
    const uncapped: MemoryProbe = {
      readFile: (p) => {
        if (p === "/proc/self/cgroup") return "0::/x\n";
        throw new Error("ENOENT");
      },
      totalMemoryBytes: () => 16_000_000_000,
    };
    const files110 = () => 110;
    const noCount = () => undefined;
    assert.equal(itShardCount({ OE_IT_SHARDS: "7" }, capped, files110), 7, "an explicit OE_IT_SHARDS is honoured over the box read");
    assert.equal(itShardCount({ OE_IT_SHARDS: "1" }, capped, files110), 1, "OE_IT_SHARDS=1 is how a caller forces the single-process tier back");
    assert.equal(itShardCount({}, capped, files110), 10, "🔴 a cgroup-capped process plans ONE shard per ~12 files — 110 files is 10 shards, not the old 4");
    assert.equal(itShardCount({}, uncapped, files110), LOCAL_SHARDS, "NEGATIVE CONTROL: an uncapped box keeps today's single process");
    assert.equal(itShardCount({ CI: "1" }, uncapped, files110), 10, "a declared CI runner plans from the file count even where no cgroup cap is readable");
    assert.equal(itShardCount({ CI: "false" }, uncapped, files110), LOCAL_SHARDS, "NEGATIVE CONTROL: CI=false is not a CI runner");
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

  await check("shard sizing: the plan holds ~12 files per process, with the old 4 as a floor", () => {
    assert.equal(sandboxShardCount(110), 10, "🔴 the measured tier: 110 files is 10 shards of at most 12, not 4 of 27");
    assert.equal(sandboxShardCount(85), 8, "the tier the old pin was written for also gets ~12 per process, not ~21");
    assert.equal(sandboxShardCount(120), 10, "an exact multiple of the target does not buy an extra shard");
    assert.equal(sandboxShardCount(121), 11, "…and one file past it does");
    assert.equal(sandboxShardCount(400), Math.ceil(400 / SANDBOX_FILES_PER_SHARD), "🔴 NO CEILING: a much larger tier keeps the per-process count flat, or the pin is back");
    assert.equal(sandboxShardCount(12), SANDBOX_MIN_SHARDS, "a tier that fits in one process still takes the floor the OOM was recovered on");
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
        const entries = tree[path.replace(/^\/root\//u, "")];
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
      itShardCount({}, { readFile: (p) => (p === "/proc/self/cgroup" ? "0::/x\n" : "1000"), totalMemoryBytes: () => 16_000_000_000 }),
      sandboxShardCount(countTierFiles()),
      "🔴 the default (no injected counter) reads the tier off the tree — the wiring, not just the arithmetic",
    );
  });

  await check("build reuse: shard 1 builds, every later shard of a sharded tier reuses it", () => {
    const tier = planShards("vitest", ["run"], 4);
    assert.equal(shardReusesBuild(tier, 0), false, "🔴 shard 1 BUILDS — nothing exists for it to reuse, and a skip there is the cold red");
    assert.deepEqual([1, 2, 3].map((i) => shardReusesBuild(tier, i)), [true, true, true], "every shard after the first reuses shard 1's build and prewarm");
    const single = planShards("vitest", ["run"], 1);
    assert.equal(shardReusesBuild(single, 0), false, "an unsharded tier builds for itself");
    const targeted = planShards("vitest", ["run", "tests/integration/memory/fence.test.ts"], 4);
    assert.equal(shardReusesBuild(targeted, 0), false, "🔴 a targeted leg builds for itself — it is one process and never a later shard");
    const setupSource = readFileSync(join(repoRoot, "tests", "integration", "global-setup.ts"), "utf8");
    assert.ok(
      setupSource.includes(`process.env.${IT_SKIP_BUILD_ENV} === "1"`),
      `tests/integration/global-setup.ts must still branch on \`process.env.${IT_SKIP_BUILD_ENV} === "1"\` — the wrapper sets exactly that name`,
    );
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
    const fake = join(fakeDir, "vitest");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(marks)}, process.argv.slice(2).join(" ") + ` +
        `" skip=" + (process.env.OE_IT_SKIP_BUILD ?? "unset") + "\\n");\n` +
        `process.exit(process.argv.includes("--shard=2/4") ? 3 : 0);\n`,
      { mode: 0o755 },
    );
    let out: string[] = [];
    const logged = await captureStderr(async () => {
      out = await captureStdout(async () => {
        const code = await runLocked(fake, ["run"], { manual: false, lockDir, maxWaitMs: 20_000, env: { OE_IT_SHARDS: "4" }, emitProof: true });
        assert.equal(code, 3, "the tier takes the worst shard's code");
      });
    });
    assert.deepEqual(
      readFileSync(marks, "utf8").trim().split("\n"),
      ["run --shard=1/4 skip=unset", "run --shard=2/4 skip=1", "run --shard=3/4 skip=1", "run --shard=4/4 skip=1"],
      "🔴 all four shards ran IN ORDER — the loop must not stop on the red, or the series is incomplete and proves nothing. " +
        "And shard 1 BUILDS while shards 2-4 are handed OE_IT_SKIP_BUILD=1 (OPE-2050): a skip on shard 1 is the cold red, " +
        "and no skip on the rest is four full builds.",
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
      shardLabels.every((l) => /exit=\d+ peak-tree-rss=\d+(\.\d+)? [A-Za-z]+ wall=\d+\.\d+s build=(1|reused)$/u.test(l)),
      `each shard label carries its exit, peak tree RSS, wall clock and build mode — got ${JSON.stringify(shardLabels)}`,
    );
    assert.deepEqual(
      shardLabels.map((l) => (l.endsWith("build=reused") ? "reused" : "1")),
      ["1", "reused", "reused", "reused"],
      "…and the label agrees with what the children were actually handed",
    );
    const shardingLine = logged.find((l) => l.includes("sharding the integration tier"));
    assert.ok(shardingLine !== undefined, "the sharded tier announces itself");
    assert.ok(
      !/test file\(s\)|file count could NOT be read/u.test(shardingLine),
      `🔴 an explicit OE_IT_SHARDS reads no file count, so it must report none — got ${JSON.stringify(shardingLine)}`,
    );
    const staleWarnings = logged.filter((l) => l.includes("reuses its tree"));
    assert.equal(staleWarnings.length, 1, `the stale-tree warning is printed exactly once — got ${JSON.stringify(staleWarnings)}`);
    assert.ok(
      logged.indexOf(staleWarnings[0]!) > logged.findIndex((l) => l.includes("--shard=2/4")),
      "🔴 …and only AFTER the red shard — a warning on shard 2 would be claiming a red that had not happened",
    );
    assert.equal(existsSync(lockDir), false, "the lock is released after a sharded run like any other");
    rmSync(fakeDir, { recursive: true, force: true });
  });

  await check("runLocked: an inherited OE_IT_SKIP_BUILD makes shard 1 report `reused`, not `1`", async () => {
    const lockDir = join(scratch, "lock-inherited-skip");
    const fakeDir = mkdtempSync(join(tmpdir(), "oe-fake-vitest-skip-"));
    const fake = join(fakeDir, "vitest");
    writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    const before = process.env.OE_IT_SKIP_BUILD;
    process.env.OE_IT_SKIP_BUILD = "1";
    try {
      const logged = await captureStderr(async () => {
        await runLocked(fake, ["run"], { manual: false, lockDir, maxWaitMs: 20_000, env: { OE_IT_SHARDS: "2" }, emitProof: false });
      });
      assert.deepEqual(
        logged.filter((l) => l.includes("--shard=")).map((l) => (l.endsWith("build=reused") ? "reused" : "1")),
        ["reused", "reused"],
        "🔴 shard 1 reports the build it did NOT do as `reused` — the receipt may never claim a build that did not happen",
      );
    } finally {
      if (before === undefined) delete process.env.OE_IT_SKIP_BUILD;
      else process.env.OE_IT_SKIP_BUILD = before;
    }
    rmSync(fakeDir, { recursive: true, force: true });
  });

  await check("runLocked: a targeted leg runs once and prints NO tier proof line", async () => {
    const lockDir = join(scratch, "lock-targeted");
    const fakeDir = mkdtempSync(join(tmpdir(), "oe-fake-vitest-t-"));
    const fake = join(fakeDir, "vitest");
    writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    const out = await captureStdout(async () => {
      const code = await runLocked(fake, ["run", "tests/integration/x.test.ts"], {
        manual: false,
        lockDir,
        maxWaitMs: 20_000,
        env: { OE_IT_SHARDS: "4" },
        emitProof: true,
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
    if (bits) {
      assert.equal(vitest.cmd, "/repo/node_modules/.bin/vitest", "a runner the write bits already bite is spawned unwrapped");
      assert.deepEqual(vitest.args, ["run", "--shard=1/4"], "…with its arguments untouched");
    } else {
      assert.match(vitest.cmd, /capsh$/u, "a runner that bypasses the write bits spawns vitest behind capsh");
      assert.equal(vitest.args[0], `--drop=${DAC_BYPASS_CAPS.join(",")}`, "…dropping exactly the two DAC bypass capabilities, and no others");
      assert.match(vitest.args.at(-1) ?? "", /vitest'? '?run/u, "…and the wrapped command still runs vitest with its own arguments");
    }
  });

  await check("dacFenceScript quotes every word, so a path with a space cannot split", () => {
    const script = dacFenceScript("/opt/my tools/vitest", ["run", "--reporter=it's-fine"]);
    assert.ok(script.includes(`'/opt/my tools/vitest'`), "a command path with a space is quoted whole");
    assert.ok(script.includes(`'--reporter=it'\\''s-fine'`), "…and an embedded single quote is escaped rather than ending the quoting");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
