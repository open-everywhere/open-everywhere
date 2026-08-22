import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureShardMemoryDir } from "./_setup.js";
import { runLegInProcess } from "./_run-shard.js";
import type { ChainLeg } from "./_legs.js";
import { _resetOperationalDbForTest, sqliteOperationalDbPath, sqliteOperationalStore } from "../../packages/core/agent/operational/sqlite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR_PROBE = join(HERE, "__fixtures__", "memory-dir-probe.ts");

function probeLeg(): ChainLeg {
  return { pkg: "<fixture>", dir: HERE, script: "memory-dir-probe", file: MEMORY_DIR_PROBE };
}

function readMemoryDirProbe(): string | undefined {
  return (globalThis as unknown as { __oeMemoryDirProbe?: string }).__oeMemoryDirProbe;
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

describe("two legs run through the real chain runner in two workers (AC3)", () => {
  test("a leg run in worker A and the same leg run in worker B resolve two different dbPath() values", async () => {
    const pathSeenByA = await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "leg-worker-a" }, async () => {
      ensureShardMemoryDir();
      await runLegInProcess(probeLeg());
      return readMemoryDirProbe();
    });
    const pathSeenByB = await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "leg-worker-b" }, async () => {
      ensureShardMemoryDir();
      await runLegInProcess(probeLeg());
      return readMemoryDirProbe();
    });
    expect(pathSeenByA).toBeDefined();
    expect(pathSeenByB).toBeDefined();
    expect(pathSeenByA).not.toBe(pathSeenByB);
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
      await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: sharedDir }, async () => {
        _resetOperationalDbForTest();
        await sqliteOperationalStore.recordSpend("org-983-cross-contamination", {
          surfaceKey: "chain-worker-a",
          period: "2026-08",
          usdMicros: 1_000_000,
          usdMicrosMeasured: 1_000_000,
          costSource: "measured",
        });
      });
      const totalsSeenByWorkerB = await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: sharedDir }, async () => {
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
      await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-e" }, async () => {
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
      const totalsSeenByWorkerF = await withEnv({ OE_SQLITE_PATH: undefined, OE_MEMORY_DIR: undefined, VITEST_POOL_ID: "worker-f" }, async () => {
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
