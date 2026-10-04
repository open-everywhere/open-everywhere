import { rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export function isInsideDir(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface OperationalSqlite {
  _openedOperationalDbPathForTest(): string | null;
  _resetOperationalDbForTest(): void;
}
interface MemorySqlite {
  _openedMemoryDbPathForTest(): string | null;
  _resetDbForTest(): void;
}

function closeInside(dir: string, operational: OperationalSqlite, memory: MemorySqlite): void {
  const opened = operational._openedOperationalDbPathForTest();
  if (opened !== null && isInsideDir(opened, dir)) operational._resetOperationalDbForTest();
  const memoryOpened = memory._openedMemoryDbPathForTest();
  if (memoryOpened !== null && isInsideDir(memoryOpened, dir)) memory._resetDbForTest();
}

async function closeStoreHandlesInside(dir: string): Promise<void> {
  closeInside(dir, await import("../agent/operational/sqlite.js"), await import("../agent/memory/sqlite.js"));
  closeInside(
    dir,
    await import("@open-everywhere/core/agent/operational/sqlite.js"),
    await import("@open-everywhere/core/agent/memory/sqlite.js"),
  );
}

export async function releaseStoreHandles(path: string): Promise<void> {
  if (process.platform === "win32") await closeStoreHandlesInside(path);
}

export async function removeTempDir(dir: string): Promise<void> {
  if (process.platform !== "win32") {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  await closeStoreHandlesInside(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
