import { seedFor, tierRelDir } from "./layout.js";
import type { Partition } from "./partition.js";
import type { MemoryProvider } from "./provider.js";
import type { MemoryFiles, Tier } from "./store.js";

export interface PgClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_file (
     org_id     text        NOT NULL,
     tier_path  text        NOT NULL,
     rel_path   text        NOT NULL,
     content    text        NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (org_id, tier_path, rel_path)
   )`,
  `CREATE TABLE IF NOT EXISTS memory_tier (
     org_id     text   NOT NULL,
     tier_path  text   NOT NULL,
     version    bigint NOT NULL DEFAULT 0,
     PRIMARY KEY (org_id, tier_path)
   )`,
  `ALTER TABLE memory_file ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE memory_tier ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file`,
  `DROP POLICY IF EXISTS memory_tier_org_isolation ON memory_tier`,
  `CREATE POLICY memory_file_org_isolation ON memory_file
     USING (org_id = current_setting('app.current_org', true)
       OR NULLIF(current_setting('app.current_org', true), '') IS NULL)
     WITH CHECK (org_id = current_setting('app.current_org', true)
       OR NULLIF(current_setting('app.current_org', true), '') IS NULL)`,
  `CREATE POLICY memory_tier_org_isolation ON memory_tier
     USING (org_id = current_setting('app.current_org', true)
       OR NULLIF(current_setting('app.current_org', true), '') IS NULL)
     WITH CHECK (org_id = current_setting('app.current_org', true)
       OR NULLIF(current_setting('app.current_org', true), '') IS NULL)`,
];

export async function initPostgresSchema(client: PgClient): Promise<void> {
  const { rows } = await client.query(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS is_owner
     FROM pg_class c WHERE c.oid = to_regclass('memory_file')`,
  );
  const r = rows[0] as { is_owner: boolean } | undefined;
  if (r && r.is_owner !== true) return;
  for (const stmt of SCHEMA_STATEMENTS) await client.query(stmt);
}

export async function setOrgContext(client: PgClient, org: string): Promise<void> {
  await client.query("SELECT set_config('app.current_org', $1, false)", [org]);
}

const UPSERT_FILE =
  `INSERT INTO memory_file (org_id, tier_path, rel_path, content, updated_at)
   VALUES ($1, $2, $3, $4, now())
   ON CONFLICT (org_id, tier_path, rel_path)
   DO UPDATE SET content = excluded.content, updated_at = now()`;

const BUMP_VERSION =
  `INSERT INTO memory_tier (org_id, tier_path, version) VALUES ($1, $2, 1)
   ON CONFLICT (org_id, tier_path) DO UPDATE SET version = memory_tier.version + 1
   RETURNING version`;

export function makePostgresProvider(client: PgClient): MemoryProvider {
  async function readRows(p: Partition, tier: Tier): Promise<MemoryFiles> {
    const path = tierRelDir(p, tier);
    const { rows } = await client.query(
      "SELECT rel_path, content FROM memory_file WHERE org_id = $1 AND tier_path = $2",
      [p.org, path],
    );
    const out: MemoryFiles = {};
    for (const r of rows as { rel_path: string; content: string }[]) out[r.rel_path] = r.content;
    return out;
  }

  async function bumpVersion(org: string, path: string): Promise<string> {
    const { rows } = await client.query(BUMP_VERSION, [org, path]);
    return String((rows[0] as { version: number | string }).version);
  }

  return {
    id: "postgres",

    readTier: readRows,

    async ensureTier(p, tier) {
      const existing = await readRows(p, tier);
      if (Object.keys(existing).length > 0) return existing;
      const path = tierRelDir(p, tier);
      const seed = seedFor(p, tier);
      for (const [rel, content] of Object.entries(seed)) {
        await client.query(UPSERT_FILE, [p.org, path, rel, content]);
      }
      await bumpVersion(p.org, path);
      return seed;
    },

    async writeTier(p, tier, files, _message) {
      const path = tierRelDir(p, tier);
      const existing = await readRows(p, tier);
      const changed = Object.entries(files).filter(([rel, content]) => existing[rel] !== content);
      if (changed.length === 0) return null;
      for (const [rel, content] of changed) {
        await client.query(UPSERT_FILE, [p.org, path, rel, content]);
      }
      return bumpVersion(p.org, path);
    },

    async deleteTier(p, tier) {
      const path = tierRelDir(p, tier);
      await client.query("DELETE FROM memory_file WHERE org_id = $1 AND tier_path = $2", [p.org, path]);
      await client.query("DELETE FROM memory_tier WHERE org_id = $1 AND tier_path = $2", [p.org, path]);
    },

    async deleteFile(p, tier, relPath) {
      const path = tierRelDir(p, tier);
      const { rows } = await client.query(
        "SELECT 1 FROM memory_file WHERE org_id = $1 AND tier_path = $2 AND rel_path = $3",
        [p.org, path, relPath],
      );
      if (rows.length === 0) return null;
      await client.query("DELETE FROM memory_file WHERE org_id = $1 AND tier_path = $2 AND rel_path = $3", [p.org, path, relPath]);
      return bumpVersion(p.org, path);
    },
  };
}
