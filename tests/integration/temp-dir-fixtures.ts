import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { onTestFinished } from "vitest";

import { createOwnedTempDir, removeTreeWithoutFollowingLinks, sweepAbandonedTempDirs } from "./owned-temp-dir";

export const FIXTURE_DIR_PREFIX = "oe-it-fixture-";

export const FIXTURE_DIR_MARKER = ".oe-integration-fixture-dir";

export function aPidThatHasExited(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  if (done.pid === undefined || done.status !== 0) {
    throw new Error(`temp-dir fixtures: could not spawn a throwaway process to retire its PID (status ${String(done.status)}).`);
  }
  return done.pid;
}

export function scratchDir(prefix: string): string {
  if (!prefix.startsWith(FIXTURE_DIR_PREFIX)) {
    throw new Error(`temp-dir fixtures: scratch prefix ${JSON.stringify(prefix)} must start with ${JSON.stringify(FIXTURE_DIR_PREFIX)} so the sweep can reclaim it.`);
  }
  const dir = createOwnedTempDir(prefix, FIXTURE_DIR_MARKER);
  onTestFinished(() => removeTreeWithoutFollowingLinks(dir));
  return dir;
}

export function sweepAbandonedFixtureDirs(searchDir: string = tmpdir()): number {
  return sweepAbandonedTempDirs(searchDir, FIXTURE_DIR_PREFIX, FIXTURE_DIR_MARKER);
}
