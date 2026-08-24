import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { constructForkAppRoot, ISOLATED_EVE_ENTRY, removeForkAppRoot } from "./fork-app-root";

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
  const fake = mkdtempSync(join(tmpdir(), "oe-it-approot-fixture-"));
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
  const victim = mkdtempSync(join(tmpdir(), "oe-it-approot-victim-"));
  mkdirSync(join(victim, "deep", "deeper"), { recursive: true });
  const sentinel = join(victim, "deep", "deeper", "precious.txt");
  writeFileSync(sentinel, "must survive", "utf8");

  const forkRoot = mkdtempSync(join(tmpdir(), "oe-it-approot-under-test-"));
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
