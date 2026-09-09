import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PgClient } from "./postgres.js";
import { initOperationalSchema } from "./postgres.js";
import { registerOperationalPostgres } from "./provider.js";
import type { OperationalStore } from "./store.js";

import type { PGlite } from "@electric-sql/pglite";

export function pgliteOperationalDataDir(): string {
  if (process.env.OE_PGLITE_DIR) return process.env.OE_PGLITE_DIR;
  const memRoot = process.env.OE_MEMORY_DIR ?? join(process.cwd(), ".open-everywhere-memory");
  return join(dirname(memRoot), ".open-everywhere-data", "pglite");
}

export function pgliteLockPath(dir: string): string {
  return `${dir}.lock`;
}

function pgliteClient(pg: PGlite): PgClient {
  return { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
}

interface LockContent {
  readonly pid: number;
  readonly acquiredAt: string;
}

function readLock(lockPath: string): LockContent | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockContent>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
      return { pid: parsed.pid, acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "" };
    }
  } catch {
  }
  return null;
}

function pidIsLive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const heldLocks = new Set<string>();
let exitHookInstalled = false;
function installReleaseHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const releaseAll = (): void => {
    for (const lockPath of heldLocks) {
      try {
        if (readLock(lockPath)?.pid === process.pid) rmSync(lockPath, { force: true });
      } catch {
      }
    }
  };
  process.once("exit", releaseAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      releaseAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

function liveLockError(dir: string, lockPath: string, existing: LockContent): Error {
  return new Error(
    `operational pglite floor: data dir "${dir}" is LOCKED by a LIVE process (PID ${existing.pid}, ` +
      `since ${existing.acquiredAt || "unknown"}). PGlite has NO cross-process lock — opening it from a ` +
      "second process would corrupt the data dir unrecoverably. Refusing to boot. Stop the other " +
      `instance, or point this one at a different OE_PGLITE_DIR / at hosted Postgres (DATABASE_URL). ` +
      `If PID ${existing.pid} is genuinely dead, remove ${lockPath} by hand.`,
  );
}

export function acquirePgliteLock(dir: string): void {
  const lockPath = pgliteLockPath(dir);
  mkdirSync(dirname(lockPath), { recursive: true });

  const existing = readLock(lockPath);
  if (existing) {
    if (existing.pid === process.pid) {
      heldLocks.add(lockPath);
      installReleaseHook();
      return;
    }
    if (pidIsLive(existing.pid)) throw liveLockError(dir, lockPath, existing);
    console.warn(
      `[open-everywhere:operational] ⚠ replacing a STALE pglite lock at ${lockPath} ` +
        `(PID ${existing.pid} is no longer running — likely a kill -9'd previous instance).`,
    );
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() } satisfies LockContent));
  heldLocks.add(lockPath);
  installReleaseHook();
}

export function releasePgliteLock(dir: string): void {
  const lockPath = pgliteLockPath(dir);
  try {
    if (readLock(lockPath)?.pid === process.pid) rmSync(lockPath, { force: true });
  } catch {
  }
  heldLocks.delete(lockPath);
}

async function loadPglite(): Promise<new (dataDir?: string) => PGlite> {
  const pkg = ["@electric-sql", "pglite"].join("/");
  const mod = (await import(pkg)) as { PGlite: new (dataDir?: string) => PGlite };
  return mod.PGlite;
}

export interface OpenPglite {
  readonly pg: PGlite;
  readonly client: PgClient;
  readonly close: () => Promise<void>;
}

export async function openOperationalPglite(dir = pgliteOperationalDataDir()): Promise<OpenPglite> {
  acquirePgliteLock(dir);
  let pg: PGlite;
  try {
    const PGliteCtor = await loadPglite();
    pg = new PGliteCtor(dir);
    await pg.waitReady;
  } catch (err) {
    releasePgliteLock(dir);
    throw err;
  }
  return {
    pg,
    client: pgliteClient(pg),
    close: async () => {
      try {
        await pg.close();
      } finally {
        releasePgliteLock(dir);
      }
    },
  };
}

export async function registerOperationalPglite(dir = pgliteOperationalDataDir()): Promise<OperationalStore> {
  const { client } = await openOperationalPglite(dir);
  await initOperationalSchema(client);
  return registerOperationalPostgres(client);
}

export function registerOperationalPgliteLazy(
  dir = pgliteOperationalDataDir(),
  onFirstOpen?: () => void | Promise<void>,
  opts: { readonly readOnly?: boolean } = {},
): OperationalStore {
  const preexisting = readLock(pgliteLockPath(dir));
  if (preexisting && preexisting.pid !== process.pid && pidIsLive(preexisting.pid)) {
    throw liveLockError(dir, pgliteLockPath(dir), preexisting);
  }

  let opening: Promise<PgClient> | null = null;
  const open = async (): Promise<PgClient> => {
    opening ??= (async () => {
      const { client } = await openOperationalPglite(dir);
      if (!opts.readOnly) await initOperationalSchema(client);
      void (async () => {
        try {
          await onFirstOpen?.();
        } catch {
        }
      })();
      return client;
    })();
    return await opening;
  };
  const lazy: PgClient = { query: async (text, params) => await (await open()).query(text, params) };
  return registerOperationalPostgres(lazy);
}
