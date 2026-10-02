import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.NODE_ENV;

delete process.env.DATABASE_URL;

export function ensureShardMemoryDir(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OE_SQLITE_PATH || env.OE_MEMORY_DIR) return;
  const workerId = env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID ?? String(process.pid);
  env.OE_MEMORY_DIR = join(tmpdir(), `oe-chain-sqlite-worker-${workerId}`);
}

ensureShardMemoryDir();
