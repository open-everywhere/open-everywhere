import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SIGKILL_EXIT_CODE, acquireLock, classifyExit, pidAlive, readHolder, reclaimDeadLock, releaseLock, runLocked, type LockHolder } from "./suite-lock-run.js";
import type { MemoryProbe } from "./ci-max-workers.js";
import { LOCAL_SHARDS, SANDBOX_SHARDS, itShardCount, itShardsOverride, planShards, tierProofLine, worstExit } from "./it-shards.js";
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

  await check("shard policy: OE_IT_SHARDS wins, then the box decides (4 in a sandbox, 1 uncapped)", () => {
    const capped: MemoryProbe = { readFile: (p) => (p === "/proc/self/cgroup" ? "0::/x\n" : "1000"), totalMemoryBytes: () => 16_000_000_000 };
    const uncapped: MemoryProbe = {
      readFile: (p) => {
        if (p === "/proc/self/cgroup") return "0::/x\n";
        throw new Error("ENOENT");
      },
      totalMemoryBytes: () => 16_000_000_000,
    };
    assert.equal(itShardCount({ OE_IT_SHARDS: "7" }, capped), 7, "an explicit OE_IT_SHARDS is honoured over the box read");
    assert.equal(itShardCount({ OE_IT_SHARDS: "1" }, capped), 1, "OE_IT_SHARDS=1 is how a caller forces the single-process tier back");
    assert.equal(itShardCount({}, capped), SANDBOX_SHARDS, "a cgroup-capped process shards by default — this is the OOM the ticket measured");
    assert.equal(itShardCount({}, uncapped), LOCAL_SHARDS, "NEGATIVE CONTROL: an uncapped box keeps today's single process");
    assert.equal(itShardCount({ CI: "1" }, uncapped), SANDBOX_SHARDS, "a declared CI runner shards even where no cgroup cap is readable");
    assert.equal(itShardCount({ CI: "false" }, uncapped), LOCAL_SHARDS, "NEGATIVE CONTROL: CI=false is not a CI runner");
    for (const bad of ["", "   ", "0", "-2", "2.5", "nope", "3abc"]) {
      assert.equal(itShardsOverride({ OE_IT_SHARDS: bad }), undefined, `a malformed OE_IT_SHARDS (${JSON.stringify(bad)}) says nothing, never NaN or 0`);
    }
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
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(marks)}, process.argv.slice(2).join(" ") + "\\n");\n` +
        `process.exit(process.argv.includes("--shard=2/4") ? 3 : 0);\n`,
      { mode: 0o755 },
    );
    const out = await captureStdout(async () => {
      const code = await runLocked(fake, ["run"], { manual: false, lockDir, maxWaitMs: 20_000, env: { OE_IT_SHARDS: "4" }, emitProof: true });
      assert.equal(code, 3, "the tier takes the worst shard's code");
    });
    assert.deepEqual(
      readFileSync(marks, "utf8").trim().split("\n"),
      ["run --shard=1/4", "run --shard=2/4", "run --shard=3/4", "run --shard=4/4"],
      "🔴 all four shards ran IN ORDER — the loop must not stop on the red, or the series is incomplete and proves nothing",
    );
    const proof = out.filter((l) => l.startsWith("OE_PROOF "));
    assert.equal(proof.length, 1, `exactly ONE tier line, after every shard — got ${JSON.stringify(proof)}`);
    assert.ok(/^OE_PROOF sha=[0-9a-f]{7,40} suite=test:integration exit=3$/.test(proof[0]!), `the tier line carries the worst exit — got ${proof[0]}`);
    assert.equal(existsSync(lockDir), false, "the lock is released after a sharded run like any other");
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
