import type { Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import type { PgClient } from "../memory/postgres.js";
import type { AuditEntry, AuditFilter, OperationalStore, OrgSurfaceLedger } from "./store.js";

export type { PgClient } from "../memory/postgres.js";
export { setOrgContext } from "../memory/postgres.js";

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS spend_ledger (
     org_id        text   NOT NULL,
     surface_key   text   NOT NULL,
     period        text   NOT NULL,
     input_tokens  bigint NOT NULL DEFAULT 0,
     output_tokens bigint NOT NULL DEFAULT 0,
     calls         bigint NOT NULL DEFAULT 0,
     PRIMARY KEY (org_id, surface_key, period)
   )`,
  `CREATE TABLE IF NOT EXISTS routine (
     org_id      text NOT NULL,
     id          text NOT NULL,
     surface_key text NOT NULL,
     data        text NOT NULL,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS audit_entry (
     seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     ts           text NOT NULL,
     org_id       text NOT NULL,
     platform     text NOT NULL,
     workspace    text NOT NULL,
     surface      text,
     principal_id text,
     action       text NOT NULL,
     detail       text
   )`,
  `CREATE INDEX IF NOT EXISTS audit_org_ts ON audit_entry (org_id, ts)`,
  `ALTER TABLE spend_ledger ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE routine ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS spend_org_isolation ON spend_ledger`,
  `DROP POLICY IF EXISTS routine_org_isolation ON routine`,
  `DROP POLICY IF EXISTS audit_select ON audit_entry`,
  `DROP POLICY IF EXISTS audit_insert ON audit_entry`,
  `CREATE POLICY spend_org_isolation ON spend_ledger
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY routine_org_isolation ON routine
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY audit_select ON audit_entry FOR SELECT
     USING (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY audit_insert ON audit_entry FOR INSERT
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
];

export async function initOperationalSchema(client: PgClient): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) await client.query(stmt);
}

const UPSERT_SPEND =
  `INSERT INTO spend_ledger (org_id, surface_key, period, input_tokens, output_tokens, calls)
   VALUES ($1, $2, $3, $4, $5, 1)
   ON CONFLICT (org_id, surface_key, period) DO UPDATE SET
     input_tokens  = spend_ledger.input_tokens  + excluded.input_tokens,
     output_tokens = spend_ledger.output_tokens + excluded.output_tokens,
     calls         = spend_ledger.calls + 1`;

function ledgerFrom(rows: { period: string; input_tokens: number; output_tokens: number; calls: number }[]) {
  const windows: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
  for (const r of rows) windows[r.period] = { inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), calls: Number(r.calls) };
  return { windows };
}

export function makeOperationalPostgresStore(client: PgClient): OperationalStore {
  return {
    id: "postgres",
    root: () => "postgres",

    async recordUsage(org, surfaceKey, period, usage: Usage) {
      await client.query(UPSERT_SPEND, [org, surfaceKey, period, usage.inputTokens ?? 0, usage.outputTokens ?? 0]);
    },

    async surfaceLedger(org, surfaceKey) {
      const { rows } = await client.query(
        "SELECT period, input_tokens, output_tokens, calls FROM spend_ledger WHERE org_id = $1 AND surface_key = $2",
        [org, surfaceKey],
      );
      return ledgerFrom(rows as never[]);
    },

    async allLedgers() {
      const { rows } = await client.query(
        "SELECT org_id, surface_key, period, input_tokens, output_tokens, calls FROM spend_ledger",
      );
      const byKey = new Map<string, OrgSurfaceLedger>();
      for (const r of rows as { org_id: string; surface_key: string; period: string; input_tokens: number; output_tokens: number; calls: number }[]) {
        const k = `${r.org_id} ${r.surface_key}`;
        let entry = byKey.get(k);
        if (!entry) {
          entry = { org: r.org_id, surfaceKey: r.surface_key, ledger: { windows: {} } };
          byKey.set(k, entry);
        }
        entry.ledger.windows[r.period] = { inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), calls: Number(r.calls) };
      }
      return [...byKey.values()];
    },

    async listRoutines(org, surfaceKey) {
      const { rows } = await client.query("SELECT data FROM routine WHERE org_id = $1 AND surface_key = $2", [org, surfaceKey]);
      return (rows as { data: string }[]).map((r) => JSON.parse(r.data) as Routine);
    },

    async getRoutine(org, surfaceKey, id) {
      const { rows } = await client.query("SELECT data FROM routine WHERE org_id = $1 AND id = $2 AND surface_key = $3", [org, id, surfaceKey]);
      const row = rows[0] as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Routine) : null;
    },

    async addRoutine(routine) {
      await client.query("INSERT INTO routine (org_id, id, surface_key, data) VALUES ($1, $2, $3, $4)", [
        routine.org,
        routine.id,
        routine.surfaceKey,
        JSON.stringify(routine),
      ]);
      return routine;
    },

    async updateRoutine(org, surfaceKey, id, patch) {
      const { rows } = await client.query("SELECT data FROM routine WHERE org_id = $1 AND id = $2 AND surface_key = $3", [org, id, surfaceKey]);
      const row = rows[0] as { data: string } | undefined;
      if (!row) return null;
      const existing = JSON.parse(row.data) as Routine;
      const updated: Routine = { ...existing, ...patch, id: existing.id, org: existing.org, surfaceKey: existing.surfaceKey };
      await client.query("UPDATE routine SET data = $1 WHERE org_id = $2 AND id = $3", [JSON.stringify(updated), org, id]);
      return updated;
    },

    async removeRoutine(org, surfaceKey, id) {
      const { rows } = await client.query(
        "DELETE FROM routine WHERE org_id = $1 AND id = $2 AND surface_key = $3 RETURNING id",
        [org, id, surfaceKey],
      );
      return rows.length > 0;
    },

    async listAllRoutines() {
      const { rows } = await client.query("SELECT data FROM routine");
      return (rows as { data: string }[]).map((r) => JSON.parse(r.data) as Routine);
    },

    async appendAudit(entry: AuditEntry) {
      await client.query(
        `INSERT INTO audit_entry (ts, org_id, platform, workspace, surface, principal_id, action, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.ts,
          entry.org,
          entry.platform,
          entry.workspace,
          entry.surface ?? null,
          entry.principalId ?? null,
          entry.action,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      );
    },

    async readAudit(filter: AuditFilter) {
      const where: string[] = [];
      const params: unknown[] = [];
      const eq = (col: string, val: string | undefined) => {
        if (val !== undefined) {
          params.push(val);
          where.push(`${col} = $${params.length}`);
        }
      };
      eq("org_id", filter.org);
      eq("platform", filter.platform);
      eq("workspace", filter.workspace);
      eq("surface", filter.surface);
      eq("action", filter.action);
      eq("principal_id", filter.principalId);
      if (filter.since !== undefined) {
        params.push(filter.since);
        where.push(`ts >= $${params.length}`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      let limitClause = "";
      if (filter.limit && filter.limit > 0) {
        params.push(filter.limit);
        limitClause = `LIMIT $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT ts, org_id, platform, workspace, surface, principal_id, action, detail
         FROM audit_entry ${clause} ORDER BY ts DESC, seq DESC ${limitClause}`,
        params,
      );
      return (rows as {
        ts: string;
        org_id: string;
        platform: string;
        workspace: string;
        surface: string | null;
        principal_id: string | null;
        action: string;
        detail: string | null;
      }[]).map((r) => ({
        ts: r.ts,
        org: r.org_id,
        platform: r.platform,
        workspace: r.workspace,
        ...(r.surface ? { surface: r.surface } : {}),
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        action: r.action,
        ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
      }));
    },
  };
}
