import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function pinSuiteStore(label: string): string {
  const dir = join(tmpdir(), `open-everywhere-suite-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  return dir;
}
