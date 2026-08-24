import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  constructForkAppRoot,
  FORK_APP_ROOT_MARKER,
  FORK_APP_ROOT_PREFIX,
  ISOLATED_EVE_ENTRY,
  removeForkAppRoot,
  sweepStaleForkAppRoots,
} from "./fork-app-root";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("this fork runs in its OWN constructed app root, not the repository root (OPE-1070)", () => {
  const cwd = process.cwd();
  expect(cwd).not.toBe(REPO_ROOT);
  expect(realpathSync(cwd)).not.toBe(realpathSync(REPO_ROOT));
});

test("the fork's workflow store is REAL, EMPTY and its own — the store the tier serialises for", () => {
  const forkStore = join(process.cwd(), ".eve", ISOLATED_EVE_ENTRY);
  expect(lstatSync(forkStore).isSymbolicLink()).toBe(false);
  expect(lstatSync(forkStore).isDirectory()).toBe(true);
  expect(realpathSync(forkStore)).not.toBe(join(realpathSync(REPO_ROOT), ".eve", ISOLATED_EVE_ENTRY));
});

test("the fork's sandbox cache is the SHARED, prewarmed one — the store that must NOT be isolated", () => {
  const forkCache = join(process.cwd(), ".eve", "sandbox-cache");
  expect(realpathSync(forkCache)).toBe(join(realpathSync(REPO_ROOT), ".eve", "sandbox-cache"));
  expect(existsSync(join(forkCache, "just-bash", "templates"))).toBe(true);
});

test("the built target and node_modules are reachable through the constructed root", () => {
  expect(existsSync(join(process.cwd(), ".output", "server", "index.mjs"))).toBe(true);
  expect(existsSync(join(process.cwd(), "node_modules", "eve", "package.json"))).toBe(true);
});

test("constructForkAppRoot mirrors every entry as a symlink and splits only the workflow store", () => {
  const fake = mkdtempSync(join(tmpdir(), "oe-it-fixture-src-"));
  mkdirSync(join(fake, "node_modules"));
  writeFileSync(join(fake, "package.json"), "{}\n", "utf8");
  mkdirSync(join(fake, ".eve", "sandbox-cache"), { recursive: true });
  mkdirSync(join(fake, ".eve", ISOLATED_EVE_ENTRY), { recursive: true });
  writeFileSync(join(fake, ".eve", ISOLATED_EVE_ENTRY, "run.json"), "{}\n", "utf8");

  const forkRoot = constructForkAppRoot(fake);
  try {
    expect(lstatSync(join(forkRoot, "node_modules")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(forkRoot, "package.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(forkRoot, ".eve")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(forkRoot, ".eve", "sandbox-cache")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(forkRoot, ".eve", ISOLATED_EVE_ENTRY)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(forkRoot, ".eve", ISOLATED_EVE_ENTRY, "run.json"))).toBe(false);
  } finally {
    removeForkAppRoot(forkRoot);
  }
  expect(existsSync(forkRoot)).toBe(false);
  expect(existsSync(join(fake, "package.json"))).toBe(true);
  expect(existsSync(join(fake, ".eve", ISOLATED_EVE_ENTRY, "run.json"))).toBe(true);
});

test("removeForkAppRoot never deletes THROUGH a symlink — the catastrophic-delete guard", () => {
  const victim = mkdtempSync(join(tmpdir(), "oe-it-fixture-victim-"));
  mkdirSync(join(victim, "deep", "deeper"), { recursive: true });
  const sentinel = join(victim, "deep", "deeper", "precious.txt");
  writeFileSync(sentinel, "must survive", "utf8");

  const forkRoot = mkdtempSync(join(tmpdir(), "oe-it-fixture-target-"));
  symlinkSync(victim, join(forkRoot, "linked-dir"));
  symlinkSync(sentinel, join(forkRoot, "linked-file"));
  mkdirSync(join(forkRoot, "real-dir"));
  writeFileSync(join(forkRoot, "real-dir", "own.txt"), "disposable", "utf8");

  removeForkAppRoot(forkRoot);

  expect(existsSync(forkRoot)).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
  expect(statSync(sentinel).size).toBeGreaterThan(0);
  expect(existsSync(join(victim, "deep", "deeper"))).toBe(true);
});

test("sweepStaleForkAppRoots removes the roots a killed fork left, and touches nothing else", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oe-it-fixture-sweep-"));
  const stale = join(scratch, `${FORK_APP_ROOT_PREFIX}abc123`);
  mkdirSync(join(stale, ".eve", ISOLATED_EVE_ENTRY), { recursive: true });
  writeFileSync(join(stale, FORK_APP_ROOT_MARKER), "999\n", "utf8");
  writeFileSync(join(stale, ".eve", ISOLATED_EVE_ENTRY, "run.json"), "{}\n", "utf8");
  const outside = mkdtempSync(join(tmpdir(), "oe-it-fixture-outside-"));
  writeFileSync(join(outside, "keep.txt"), "keep", "utf8");
  symlinkSync(outside, join(stale, "linked"));
  const namedBystander = join(scratch, "unrelated-dir");
  mkdirSync(namedBystander);
  const unmarkedBystander = join(scratch, `${FORK_APP_ROOT_PREFIX}not-ours`);
  mkdirSync(unmarkedBystander);
  writeFileSync(join(unmarkedBystander, "someone-elses.txt"), "keep", "utf8");

  expect(sweepStaleForkAppRoots(scratch)).toBe(1);

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(namedBystander)).toBe(true);
  expect(existsSync(join(unmarkedBystander, "someone-elses.txt"))).toBe(true);
  expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  expect(sweepStaleForkAppRoots(scratch)).toBe(0);
});

test("a constructed fork app root carries the marker the sweep identifies it by", () => {
  const fake = mkdtempSync(join(tmpdir(), "oe-it-fixture-marker-"));
  mkdirSync(join(fake, ".eve"), { recursive: true });
  const forkRoot = constructForkAppRoot(fake);
  try {
    expect(lstatSync(join(forkRoot, FORK_APP_ROOT_MARKER)).isFile()).toBe(true);
  } finally {
    removeForkAppRoot(forkRoot);
  }
  expect(lstatSync(join(process.cwd(), FORK_APP_ROOT_MARKER)).isFile()).toBe(true);
});
