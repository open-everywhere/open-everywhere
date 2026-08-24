import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ISOLATED_EVE_ENTRY = ".workflow-data";

export const FORK_APP_ROOT_PREFIX = "oe-it-approot-";

export const FORK_APP_ROOT_MARKER = ".oe-integration-fork-app-root";

export function constructForkAppRoot(repoRoot: string): string {
  const forkRoot = mkdtempSync(join(tmpdir(), FORK_APP_ROOT_PREFIX));
  writeFileSync(join(forkRoot, FORK_APP_ROOT_MARKER), `${process.pid}\n`, "utf8");
  for (const entry of readdirSync(repoRoot)) {
    if (entry === ".eve") continue;
    symlinkSync(join(repoRoot, entry), join(forkRoot, entry));
  }
  const forkEve = join(forkRoot, ".eve");
  mkdirSync(forkEve);
  const repoEve = join(repoRoot, ".eve");
  if (existsSync(repoEve)) {
    for (const entry of readdirSync(repoEve)) {
      if (entry === ISOLATED_EVE_ENTRY) continue;
      symlinkSync(join(repoEve, entry), join(forkEve, entry));
    }
  }
  mkdirSync(join(forkEve, ISOLATED_EVE_ENTRY));
  return forkRoot;
}

export function removeForkAppRoot(forkRoot: string): void {
  removeTreeWithoutFollowingLinks(forkRoot);
}

export function sweepStaleForkAppRoots(searchDir: string = tmpdir()): number {
  let removed = 0;
  for (const entry of readdirSync(searchDir)) {
    if (!entry.startsWith(FORK_APP_ROOT_PREFIX)) continue;
    const path = join(searchDir, entry);
    if (!isForkAppRoot(path)) continue;
    removeTreeWithoutFollowingLinks(path);
    removed += 1;
  }
  return removed;
}

function isForkAppRoot(path: string): boolean {
  const dir = lstatSync(path, { throwIfNoEntry: false });
  if (dir === undefined || !dir.isDirectory() || dir.isSymbolicLink()) return false;
  const marker = lstatSync(join(path, FORK_APP_ROOT_MARKER), { throwIfNoEntry: false });
  return marker !== undefined && marker.isFile() && !marker.isSymbolicLink();
}

function removeTreeWithoutFollowingLinks(dir: string): void {
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
