import { tmpdir } from "node:os";

import { createOwnedTempDir, removeOwnedTempDirOnExit, sweepAbandonedTempDirs } from "./owned-temp-dir.js";

export const STATE_DIR_PREFIX = "oe-it-state-";

export const STATE_DIR_MARKER = ".oe-integration-state-dir";

export function createStateDir(): string {
  const dir = createOwnedTempDir(STATE_DIR_PREFIX, STATE_DIR_MARKER);
  removeOwnedTempDirOnExit(dir);
  return dir;
}

export function sweepAbandonedStateDirs(searchDir: string = tmpdir()): number {
  return sweepAbandonedTempDirs(searchDir, STATE_DIR_PREFIX, STATE_DIR_MARKER);
}
