import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

delete process.env.NODE_ENV;

delete process.env.DATABASE_URL;

const SCRATCH_ROOT = Symbol.for("oe-chain.db-scratch-root");

const ROOT_PREFIX = "oe-chain-db-";

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes every scratch root whose owner process is gone. The exit hook below is only a best effort:
 * vitest stops a fork with SIGTERM, and a process that dies on a signal runs no `exit` handler. The
 * owner pid is in the root's name, so the next shard process that starts removes what a dead one left.
 */
export function sweepDeadScratchRoots(dir: string = tmpdir()): void {
  for (const name of readdirSync(dir)) {
    const m = /^oe-chain-db-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pidIsLive(pid)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // Another shard process removes the same root at the same time; either one is enough.
    }
  }
}

/**
 * One fresh directory per shard process, made with `mkdtemp` and named for the owner pid
 * (`<tmpdir>/oe-chain-db-<pid>-*`), so no run sees the files an earlier run left. Every database dir
 * the chain hands out lives under it. The symbol name has no `open-everywhere.` prefix, so
 * `resetProcessGlobals()` keeps it.
 */
export function chainScratchRoot(): string {
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  const existing = g[SCRATCH_ROOT];
  if (existing) return existing;
  sweepDeadScratchRoots();
  const root = mkdtempSync(join(tmpdir(), `${ROOT_PREFIX}${process.pid}-`));
  g[SCRATCH_ROOT] = root;
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * The worker's default database location. The memory dir is `<scratch>/worker-<id>/memory`, so the
 * PGlite dir that `pgliteOperationalDataDir()` derives from it
 * (`<scratch>/worker-<id>/.open-everywhere-data/pglite`) is per worker too. Before this, every
 * worker's memory dir sat directly in `tmpdir()`, so all of them derived ONE PGlite dir.
 * A host that pins `OE_SQLITE_PATH` or `OE_MEMORY_DIR` keeps its own value.
 */
export function ensureShardMemoryDir(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OE_SQLITE_PATH || env.OE_MEMORY_DIR) return;
  const workerId = env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID ?? String(process.pid);
  env.OE_MEMORY_DIR = join(chainScratchRoot(), `worker-${workerId}`, "memory");
}

/**
 * The database env for ONE leg: a fresh, empty memory dir that no other leg uses, in this worker or
 * in any other. A leg run alone (`npm run <leg>` on a clean tree) starts from empty stores; this
 * gives it the same start inside the batched chain. `OE_PGLITE_DIR` is left alone, so the PGlite
 * dir derives from the fresh memory dir exactly as it does when the leg runs alone.
 *
 * Returns `{}` when the chain does not own the database location — the host pinned
 * `OE_SQLITE_PATH`, or pinned an `OE_MEMORY_DIR` outside the scratch root — so an explicit
 * override is never replaced.
 */
export function freshLegDbEnv(label: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.OE_SQLITE_PATH) return {};
  const root = chainScratchRoot();
  if (!env.OE_MEMORY_DIR?.startsWith(root + sep)) return {};
  const slug = label.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  const legDir = mkdtempSync(join(root, `leg-${slug}-`));
  return { OE_MEMORY_DIR: join(legDir, "memory") };
}

ensureShardMemoryDir();
