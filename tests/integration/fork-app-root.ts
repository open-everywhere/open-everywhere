import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOwnedTempDir, removeTreeWithoutFollowingLinks, sweepAbandonedTempDirs } from "./owned-temp-dir";

export const ISOLATED_EVE_ENTRY = ".workflow-data";

export const FORK_APP_ROOT_PREFIX = "oe-it-approot-";

export const FORK_APP_ROOT_MARKER = ".oe-integration-fork-app-root";

export function constructForkAppRoot(repoRoot: string): string {
  const forkRoot = createOwnedTempDir(FORK_APP_ROOT_PREFIX, FORK_APP_ROOT_MARKER);
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
  return sweepAbandonedTempDirs(searchDir, FORK_APP_ROOT_PREFIX, FORK_APP_ROOT_MARKER);
}
