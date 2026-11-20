import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chainScratchRoot, ensureShardMemoryDir, freshLegDbEnv, sweepDeadScratchRoots } from "./_setup.js";
import { runLegInProcess, runLegInSubprocess } from "./_run-shard.js";
import type { ChainLeg } from "./_legs.js";
import { pgliteLockPath, pgliteOperationalDataDir } from "../../packages/core/agent/operational/pglite-client.js";
import { _resetOperationalDbForTest, sqliteOperationalDbPath, sqliteOperationalStore } from "../../packages/core/agent/operational/sqlite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR_PROBE = join(HERE, "__fixtures__", "memory-dir-probe.ts");
const SPEND_PROBE = join(HERE, "__fixtures__", "spend-probe.ts");
const PGLITE_FLOOR_PROBE = join(HERE, "__fixtures__", "pglite-floor-probe.ts");
const BROKEN_LEG = join(HERE, "__fixtures__", "broken-leg.ts");
const SUBPROCESS_LEG_DIR = join(HERE, "__fixtures__", "subprocess-leg");

function probeLeg(): ChainLeg {
  return { pkg: "<fixture>", dir: HERE, script: "memory-dir-probe", file: MEMORY_DIR_PROBE };
}

function readMemoryDirProbe(): string | undefined {
  return (globalThis as unknown as { __oeMemoryDirProbe?: string }).__oeMemoryDirProbe;
}

function readPgliteDirProbe(): string | undefined {
  return (globalThis as unknown as { __oePgliteDirProbe?: string }).__oePgliteDirProbe;
}

function readSpendProbe(): number | undefined {
  return (globalThis as unknown as { __oeSpendProbe?: number }).__oeSpendProbe;
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const before = { ...process.env };
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

async function withEnvAsync<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

describe("two legs run through the real chain runner in two workers (AC3)", () => {
  test("a leg run in worker A and the same leg run in worker B resolve two different dbPath() values", async () => {
    const run = (worker: string) =>
      withEnvAsync({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: worker }, async () => {
        ensureShardMemoryDir();
        const workerDir = process.env.OE_MEMORY_DIR!;
        await runLegInProcess(probeLeg());
        return { seen: readMemoryDirProbe(), workerDir };
      });
    const a = await run("leg-worker-a");
    const b = await run("leg-worker-b");
    for (const { seen, workerDir } of [a, b]) {
      expect(seen?.startsWith(chainScratchRoot() + sep)).toBe(true);
      expect(seen?.startsWith(workerDir + sep)).toBe(false);
    }
    expect(a.seen).not.toBe(b.seen);
  });
});

describe("ensureShardMemoryDir()", () => {
  test("two workers resolve two different dbPath() values", () => {
    const pathA = withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-a" }, () => {
      ensureShardMemoryDir();
      return sqliteOperationalDbPath();
    });
    const pathB = withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-b" }, () => {
      ensureShardMemoryDir();
      return sqliteOperationalDbPath();
    });
    expect(pathA).not.toBe(pathB);
    const pathA2 = withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-a" }, () => {
      ensureShardMemoryDir();
      return sqliteOperationalDbPath();
    });
    expect(pathA2).toBe(pathA);
  });

  test("an already-set OE_SQLITE_PATH wins — the 158 suites that pin their own path are unaffected", () => {
    const explicit = join(tmpdir(), "oe-983-explicit-probe.sqlite3");
    const resolved = withEnv({ OE_SQLITE_PATH: explicit, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-c" }, () => {
      ensureShardMemoryDir();
      return sqliteOperationalDbPath();
    });
    expect(resolved).toBe(explicit);
  });

  test("an already-set OE_MEMORY_DIR wins — an external override is never clobbered", () => {
    const explicitDir = join(tmpdir(), "oe-983-explicit-memdir-probe");
    const resolved = withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: explicitDir, VITEST_POOL_ID: "worker-d" }, () => {
      ensureShardMemoryDir();
      return sqliteOperationalDbPath();
    });
    expect(resolved).toBe(join(explicitDir, "open-everywhere.sqlite3"));
  });
});

describe("cross-worker sqlite sharing (demonstration)", () => {
  test("without isolation, worker B observes worker A's spend row — the bug this ticket fixes", async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "oe-983-shared-"));
    try {
      await withEnvAsync({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: sharedDir }, async () => {
        _resetOperationalDbForTest();
        await sqliteOperationalStore.recordSpend("org-983-cross-contamination", {
          surfaceKey: "chain-worker-a",
          period: "2026-08",
          usdMicros: 1_000_000,
          usdMicrosMeasured: 1_000_000,
          costSource: "measured",
        });
      });
      const totalsSeenByWorkerB = await withEnvAsync({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: sharedDir }, async () => {
        _resetOperationalDbForTest();
        return sqliteOperationalStore.spendTotals("org-983-cross-contamination");
      });
      expect(totalsSeenByWorkerB.usdMicros).toBe(1_000_000);
    } finally {
      _resetOperationalDbForTest();
      rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  test("with per-worker dirs, worker B never observes worker A's spend row — the fix", async () => {
    let dirA = "";
    try {
      await withEnvAsync({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-e" }, async () => {
        ensureShardMemoryDir();
        _resetOperationalDbForTest();
        dirA = process.env.OE_MEMORY_DIR!;
        await sqliteOperationalStore.recordSpend("org-983-isolated", {
          surfaceKey: "chain-worker-e",
          period: "2026-08",
          usdMicros: 1_000_000,
          usdMicrosMeasured: 1_000_000,
          costSource: "measured",
        });
      });
      const totalsSeenByWorkerF = await withEnvAsync({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-f" }, async () => {
        ensureShardMemoryDir();
        _resetOperationalDbForTest();
        return sqliteOperationalStore.spendTotals("org-983-isolated");
      });
      expect(totalsSeenByWorkerF.usdMicros).toBe(0);
    } finally {
      _resetOperationalDbForTest();
      if (dirA) rmSync(dirA, { recursive: true, force: true });
    }
  });
});

describe("every leg gets its own database (OPE-2838)", () => {
  const NO_HOST_PIN = { OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, OE_PGLITE_DIR: undefined };

  test("two workers resolve two different PGlite dirs — the shared lock that made a parallel boot throw LOCKED", () => {
    const dirA = withEnv({ ...NO_HOST_PIN, VITEST_POOL_ID: "pglite-worker-a" }, () => {
      ensureShardMemoryDir();
      return pgliteOperationalDataDir();
    });
    const dirB = withEnv({ ...NO_HOST_PIN, VITEST_POOL_ID: "pglite-worker-b" }, () => {
      ensureShardMemoryDir();
      return pgliteOperationalDataDir();
    });
    expect(dirA).not.toBe(dirB);
    expect(dirA.startsWith(chainScratchRoot() + sep)).toBe(true);
    expect(dirB.startsWith(chainScratchRoot() + sep)).toBe(true);
  });

  test("two legs run in the SAME worker see two different sqlite paths and two different PGlite dirs", async () => {
    const seen = await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "same-worker" }, async () => {
      ensureShardMemoryDir();
      const out: { sqlite?: string; pglite?: string }[] = [];
      for (let i = 0; i < 2; i++) {
        await runLegInProcess(probeLeg());
        out.push({ sqlite: readMemoryDirProbe(), pglite: readPgliteDirProbe() });
      }
      return out;
    });
    expect(seen[0]!.sqlite).toBeDefined();
    expect(seen[0]!.pglite).toBeDefined();
    expect(seen[0]!.sqlite).not.toBe(seen[1]!.sqlite);
    expect(seen[0]!.pglite).not.toBe(seen[1]!.pglite);
  });

  test("a row one leg writes is not there for the next leg in the same worker — each leg starts from an empty store", async () => {
    const spendLeg: ChainLeg = { pkg: "<fixture>", dir: HERE, script: "spend-probe", file: SPEND_PROBE };
    const seen = await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "spend-worker" }, async () => {
      ensureShardMemoryDir();
      const out: (number | undefined)[] = [];
      for (let i = 0; i < 2; i++) {
        await runLegInProcess(spendLeg);
        out.push(readSpendProbe());
      }
      return out;
    });
    expect(seen).toEqual([0, 0]);
  });

  test("a subprocess leg gets a fresh memory dir too, and inherits no PGlite dir", async () => {
    const out = join(mkdtempSync(join(chainScratchRoot(), "subprocess-probe-")), "probe.jsonl");
    const leg: ChainLeg = { pkg: "<fixture>", dir: SUBPROCESS_LEG_DIR, script: "db-env-probe", file: join(SUBPROCESS_LEG_DIR, "db-env-probe.mjs") };
    await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "subprocess-worker", OE_CHAIN_PROBE_OUT: out }, async () => {
      ensureShardMemoryDir();
      await runLegInSubprocess(leg);
      await runLegInSubprocess(leg);
    });
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { memoryDir: string | null; pgliteDir: string | null });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.memoryDir?.startsWith(chainScratchRoot() + sep)).toBe(true);
    expect(lines[0]!.memoryDir).not.toBe(lines[1]!.memoryDir);
    expect(lines.map((l) => l.pgliteDir)).toEqual([null, null]);
  });

  test("the runner restores the worker's memory dir after a leg", async () => {
    await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "restore-worker" }, async () => {
      ensureShardMemoryDir();
      const before = process.env.OE_MEMORY_DIR;
      await runLegInProcess(probeLeg());
      expect(readMemoryDirProbe()?.startsWith(before! + sep)).toBe(false);
      expect(process.env.OE_MEMORY_DIR).toBe(before);
    });
  });

  test("a host pin is never replaced per leg — OE_SQLITE_PATH, or an OE_MEMORY_DIR outside the scratch root", () => {
    const explicitDir = join(tmpdir(), "oe-2838-explicit-memdir-probe");
    expect(withEnv({ ...NO_HOST_PIN, OE_MEMORY_DIR: explicitDir }, () => freshLegDbEnv("probe"))).toEqual({});
    expect(withEnv({ ...NO_HOST_PIN, OE_SQLITE_PATH: join(explicitDir, "x.sqlite3") }, () => freshLegDbEnv("probe"))).toEqual({});
  });

  test("a live PGlite lock in one worker does not refuse a boot in another worker", async () => {
    const lockedDir = await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "lock-holder" }, async () => {
      ensureShardMemoryDir();
      return pgliteOperationalDataDir();
    });
    mkdirSync(dirname(lockedDir), { recursive: true });
    writeFileSync(pgliteLockPath(lockedDir), JSON.stringify({ pid: process.ppid, acquiredAt: "2000-01-01T00:00:00.000Z" }));
    try {
      const leg: ChainLeg = { pkg: "<fixture>", dir: HERE, script: "pglite-floor-probe", file: PGLITE_FLOOR_PROBE };
      await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "lock-booter" }, async () => {
        ensureShardMemoryDir();
        await runLegInProcess(leg);
      });
    } finally {
      rmSync(pgliteLockPath(lockedDir), { force: true });
    }
  });

  test("a broken leg still fails, in-process and in a subprocess — the isolation hides no red", async () => {
    await withEnvAsync({ ...NO_HOST_PIN, VITEST_POOL_ID: "broken-worker" }, async () => {
      ensureShardMemoryDir();
      await expect(runLegInProcess({ pkg: "<fixture>", dir: HERE, script: "broken", file: BROKEN_LEG })).rejects.toThrow(
        "a deliberately broken leg",
      );
      await expect(
        runLegInSubprocess({ pkg: "<fixture>", dir: SUBPROCESS_LEG_DIR, script: "broken", file: join(SUBPROCESS_LEG_DIR, "package.json") }),
      ).rejects.toThrow("failed in its own process");
    });
  });

  test("a scratch root left by a dead process is removed; a live owner's root and other dirs stay", () => {
    const parent = mkdtempSync(join(chainScratchRoot(), "sweep-"));
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    const deadRoot = join(parent, `oe-chain-db-${deadPid}-abc`);
    const liveRoot = join(parent, `oe-chain-db-${process.ppid}-abc`);
    const other = join(parent, "oe-chain-sqlite-worker-1");
    for (const d of [deadRoot, liveRoot, other]) mkdirSync(d);
    sweepDeadScratchRoots(parent);
    expect(existsSync(deadRoot)).toBe(false);
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
