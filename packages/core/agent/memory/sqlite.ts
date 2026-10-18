import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedFor, tierRelDir } from "./layout.js";
import type { Partition } from "./partition.js";
import type { MemoryProvider } from "./provider.js";
import type { MemoryFiles, Tier } from "./store.js";

function dbPath(): { readonly path: string; readonly fromEnv: boolean } {
  if (process.env.OE_SQLITE_PATH) return { path: process.env.OE_SQLITE_PATH, fromEnv: true };
  const root = process.env.OE_MEMORY_DIR ?? join(process.cwd(), ".open-everywhere-memory");
  return { path: join(root, "open-everywhere.sqlite3"), fromEnv: false };
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;

function getDb(): DatabaseSync {
  const resolved = dbPath();
  if (db && !resolved.fromEnv) return db;
  const path = resolved.path;
  if (db && openedPath !== path) {
    db.close();
    db = null;
  }
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS memory_file (
      org_id     TEXT NOT NULL,
      tier_path  TEXT NOT NULL,   -- canonical scope key (layout.tierRelDir)
      rel_path   TEXT NOT NULL,   -- posix file path within the tier
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, tier_path, rel_path)
    );
    CREATE TABLE IF NOT EXISTS memory_tier (
      org_id     TEXT NOT NULL,
      tier_path  TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, tier_path)
    );
  `);
  db = handle;
  openedPath = path;
  return handle;
}

export function _openedMemoryDbPathForTest(): string | null {
  return openedPath;
}

export function _resetDbForTest(): void {
  if (db) db.close();
  db = null;
  openedPath = null;
}

function readRows(p: Partition, tier: Tier): MemoryFiles {
  const path = tierRelDir(p, tier);
  const rows = getDb()
    .prepare("SELECT rel_path, content FROM memory_file WHERE org_id = ? AND tier_path = ?")
    .all(p.org, path) as { rel_path: string; content: string }[];
  const out: MemoryFiles = {};
  for (const r of rows) out[r.rel_path] = r.content;
  return out;
}

function bumpVersion(org: string, path: string): string {
  const row = getDb()
    .prepare(
      `INSERT INTO memory_tier (org_id, tier_path, version) VALUES (?, ?, 1)
       ON CONFLICT(org_id, tier_path) DO UPDATE SET version = version + 1
       RETURNING version`,
    )
    .get(org, path) as { version: number };
  return String(row.version);
}

export const sqliteProvider: MemoryProvider = {
  id: "sqlite",

  async readTier(p, tier) {
    return readRows(p, tier);
  },

  async ensureTier(p, tier) {
    const existing = readRows(p, tier);
    if (Object.keys(existing).length > 0) return existing;

    const path = tierRelDir(p, tier);
    const seed = seedFor(p, tier);
    const now = Date.now();
    const handle = getDb();
    const insert = handle.prepare(
      `INSERT INTO memory_file (org_id, tier_path, rel_path, content, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, tier_path, rel_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    );
    handle.exec("BEGIN");
    try {
      for (const [rel, content] of Object.entries(seed)) insert.run(p.org, path, rel, content, now);
      bumpVersion(p.org, path);
      handle.exec("COMMIT");
    } catch (e) {
      handle.exec("ROLLBACK");
      throw e;
    }
    return seed;
  },

  async tierVersion(p, tier) {
    const path = tierRelDir(p, tier);
    const row = getDb()
      .prepare("SELECT version FROM memory_tier WHERE org_id = ? AND tier_path = ?")
      .get(p.org, path) as { version: number } | undefined;
    return row ? String(row.version) : null;
  },

  async writeTier(p, tier, files, _message) {
    const path = tierRelDir(p, tier);
    const existing = readRows(p, tier);
    const changed = Object.entries(files).filter(([rel, content]) => existing[rel] !== content);
    if (changed.length === 0) return null;

    const now = Date.now();
    const handle = getDb();
    const insert = handle.prepare(
      `INSERT INTO memory_file (org_id, tier_path, rel_path, content, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, tier_path, rel_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    );
    handle.exec("BEGIN");
    try {
      for (const [rel, content] of changed) insert.run(p.org, path, rel, content, now);
      const version = bumpVersion(p.org, path);
      handle.exec("COMMIT");
      return version;
    } catch (e) {
      handle.exec("ROLLBACK");
      throw e;
    }
  },

  async deleteTier(p, tier) {
    const path = tierRelDir(p, tier);
    const handle = getDb();
    handle.exec("BEGIN");
    try {
      handle.prepare("DELETE FROM memory_file WHERE org_id = ? AND tier_path = ?").run(p.org, path);
      handle.prepare("DELETE FROM memory_tier WHERE org_id = ? AND tier_path = ?").run(p.org, path);
      handle.exec("COMMIT");
    } catch (e) {
      handle.exec("ROLLBACK");
      throw e;
    }
  },

  async deleteFile(p, tier, relPath) {
    const path = tierRelDir(p, tier);
    const handle = getDb();
    const existing = handle.prepare("SELECT 1 FROM memory_file WHERE org_id = ? AND tier_path = ? AND rel_path = ?").get(p.org, path, relPath);
    if (!existing) return null;
    handle.exec("BEGIN");
    try {
      handle.prepare("DELETE FROM memory_file WHERE org_id = ? AND tier_path = ? AND rel_path = ?").run(p.org, path, relPath);
      const version = bumpVersion(p.org, path);
      handle.exec("COMMIT");
      return version;
    } catch (e) {
      handle.exec("ROLLBACK");
      throw e;
    }
  },

  async exportFiles(org) {
    const out: { tierPath: string; relPath: string; content: string }[] = [];
    const first = getDb().prepare("SELECT tier_path, rel_path, content FROM memory_file WHERE org_id = ? ORDER BY tier_path, rel_path LIMIT 1000");
    const next = getDb().prepare("SELECT tier_path, rel_path, content FROM memory_file WHERE org_id = ? AND (tier_path, rel_path) > (?, ?) ORDER BY tier_path, rel_path LIMIT 1000");
    for (let after: { tier_path: string; rel_path: string } | undefined; ; ) {
      const page = (after === undefined ? first.all(org) : next.all(org, after.tier_path, after.rel_path)) as { tier_path: string; rel_path: string; content: string }[];
      for (const row of page) out.push({ tierPath: row.tier_path, relPath: row.rel_path, content: row.content });
      after = page.at(-1);
      if (after === undefined) return out;
    }
  },

  root() {
    return openedPath ?? dbPath().path;
  },
};
