import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function pinSuiteStore(label: string): string {
  const dir = join(tmpdir(), `open-everywhere-suite-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  pinnedPath = join(dir, "ops.sqlite3");
  process.env.OE_SQLITE_PATH = pinnedPath;
  return dir;
}

let pinnedPath: string | null = null;

export function pinnedSuiteStorePath(): string {
  if (pinnedPath === null) throw new Error("pinnedSuiteStorePath(): this suite never called pinSuiteStore()");
  return pinnedPath;
}
