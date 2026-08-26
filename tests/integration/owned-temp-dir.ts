import { lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createOwnedTempDir(prefix: string, marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const pending = join(dir, `${marker}.pending`);
  writeFileSync(pending, `${process.pid}\n`, "utf8");
  renameSync(pending, join(dir, marker));
  return dir;
}

export function removeOwnedTempDirOnExit(dir: string): void {
  process.on("exit", () => {
    try {
      removeTreeWithoutFollowingLinks(dir);
    } catch {
    }
  });
}

export function sweepAbandonedTempDirs(searchDir: string, prefix: string, marker: string): number {
  let removed = 0;
  for (const entry of readdirSync(searchDir)) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(searchDir, entry);
    try {
      if (!isOwnedTempDir(path, marker)) continue;
      if (ownerMayBeRunning(path, marker)) continue;
      removeTreeWithoutFollowingLinks(path);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

function isOwnedTempDir(path: string, marker: string): boolean {
  const dir = lstatSync(path, { throwIfNoEntry: false });
  if (dir === undefined || !dir.isDirectory() || dir.isSymbolicLink()) return false;
  const found = lstatSync(join(path, marker), { throwIfNoEntry: false });
  return found !== undefined && found.isFile() && !found.isSymbolicLink();
}

function ownerMayBeRunning(dir: string, marker: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(dir, marker), "utf8");
  } catch {
    return true;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function removeTreeWithoutFollowingLinks(dir: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) removeTreeWithoutFollowingLinks(path);
    else unlinkSync(path);
  }
  try {
    rmdirSync(dir);
  } catch {
  }
}
