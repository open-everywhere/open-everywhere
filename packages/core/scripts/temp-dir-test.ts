import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideDir, releaseStoreHandles, removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

{
  const root = join(tmpdir(), "oe-temp-dir-root");
  ok(isInsideDir(join(root, "ops.sqlite3"), root), "a file directly in the directory is inside it");
  ok(isInsideDir(join(root, "a", "b.sqlite3"), root), "a file in a subdirectory is inside it");
  ok(isInsideDir(root, root), "the directory itself counts as inside (a single-file store path)");
  ok(isInsideDir(join(tmpdir(), "oe-temp-dir-root-2", "x"), root) === false, "a sibling whose name starts with the same text is NOT inside");
  ok(isInsideDir(join(tmpdir(), "x"), root) === false, "the parent's other file is NOT inside");
}

const sqlite = await import("../agent/operational/sqlite.js");

{
  const dir = mkdtempSync(join(tmpdir(), "oe-temp-dir-inside-"));
  const file = join(dir, "ops.sqlite3");
  process.env.OE_SQLITE_PATH = file;
  sqlite._resetOperationalDbForTest();
  ok(sqlite.sqliteOperationalTableNames().length > 0, "the store opened and created its tables");
  ok(sqlite._openedOperationalDbPathForTest() === file, "the handle is open inside the directory");
  await removeTempDir(dir);
  ok(!existsSync(dir), "removeTempDir removed a directory that holds an OPEN store");
  if (process.platform === "win32") {
    ok(sqlite._openedOperationalDbPathForTest() === null, "win32: the helper closed the handle before the removal");
  }
}

{
  const keep = mkdtempSync(join(tmpdir(), "oe-temp-dir-keep-"));
  const other = mkdtempSync(join(tmpdir(), "oe-temp-dir-other-"));
  mkdirSync(join(other, "nested"));
  writeFileSync(join(other, "nested", "file.txt"), "x");
  const file = join(keep, "ops.sqlite3");
  process.env.OE_SQLITE_PATH = file;
  sqlite._resetOperationalDbForTest();
  sqlite.sqliteOperationalTableNames();
  await removeTempDir(other);
  ok(!existsSync(other), "the other directory is removed");
  ok(sqlite._openedOperationalDbPathForTest() === file, "🔴 a handle OUTSIDE the removed directory stays open — the close is scoped to the directory");
  await releaseStoreHandles(join(other, "ops.sqlite3"));
  ok(sqlite._openedOperationalDbPathForTest() === file, "releaseStoreHandles for another path leaves the handle open too");
  await removeTempDir(keep);
  ok(!existsSync(keep), "the store's own directory is removed after it");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-temp-dir-file-"));
  const file = join(dir, "ops.sqlite3");
  process.env.OE_SQLITE_PATH = file;
  sqlite._resetOperationalDbForTest();
  sqlite.sqliteOperationalTableNames();
  await releaseStoreHandles(file);
  const expected = process.platform === "win32" ? null : file;
  ok(sqlite._openedOperationalDbPathForTest() === expected, `releaseStoreHandles on the store's own file leaves the handle at ${String(expected)} on ${process.platform}`);
  await removeTempDir(dir);
}

sqlite._resetOperationalDbForTest();
delete process.env.OE_SQLITE_PATH;
console.log(`✓ temp-dir: ${n} assertions passed (${process.platform})`);
