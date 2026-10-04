import { rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

function isInsideDir(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function removeTempDir(dir: string): Promise<void> {
  if (process.platform !== "win32") {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const storeFile = process.env.OE_SQLITE_PATH;
  if (storeFile !== undefined && storeFile !== ":memory:" && isInsideDir(storeFile, dir)) {
    const { _resetOperationalDbForTest } = await import("@open-everywhere/core/agent/adapter-api.js");
    _resetOperationalDbForTest();
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
