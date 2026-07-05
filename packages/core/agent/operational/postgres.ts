import type { Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import type { PgClient } from "../memory/postgres.js";
import { assertSpendLimitAmount, type AuditEntry, type AuditFilter, type OperationalStore, type OrgSurfaceLedger, type UsageEventEntry, type UsageSummaryFilter } from "./store.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";

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
  `CREATE TABLE IF NOT EXISTS spend_limit (
     org_id         text   NOT NULL,
     scope_key      text   NOT NULL,
     level          text   NOT NULL,
     monthly_tokens bigint NOT NULL,          -- -1 = no token component (matches the SQLite encoding)
     monthly_usd    double precision,         -- NULL = no USD component
     expires_at     bigint,                  -- epoch ms; NULL = no auto-expiry
     reason         text,
     set_by         text,
     PRIMARY KEY (org_id, scope_key, level)
   )`,
  `CREATE TABLE IF NOT EXISTS connector_override (
     org_id    text    NOT NULL,
     scope_key text    NOT NULL,
     connector text    NOT NULL,
     granted   boolean NOT NULL,
     reason    text,                         -- no expires_at: auto-expiry would re-open access
     set_by    text,
     PRIMARY KEY (org_id, scope_key, connector)
   )`,
  `CREATE TABLE IF NOT EXISTS thread_engagement (
     org_id       text NOT NULL,
     surface_key  text NOT NULL,
     thread_ts    text NOT NULL,
     engaged_at   text NOT NULL,
     last_turn_at text NOT NULL,
     PRIMARY KEY (org_id, surface_key, thread_ts)
   )`,
  `CREATE TABLE IF NOT EXISTS event_dedupe (
     org_id  text NOT NULL,
     key     text NOT NULL,
     seen_at text NOT NULL,
     PRIMARY KEY (org_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS pending_actions (
     org_id       text NOT NULL,
     id           text NOT NULL,
     kind         text NOT NULL,
     args_json    text NOT NULL,
     scope_key    text NOT NULL,
     domain       text,
     requested_by text NOT NULL,
     channel_id   text NOT NULL,
     thread_ts    text,
     message_ts   text,
     status       text NOT NULL,
     created_at   text NOT NULL,
     expires_at   text NOT NULL,
     decided_by   text,
     decided_at   text,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS pending_actions_org_status ON pending_actions (org_id, status)`,
  `CREATE TABLE IF NOT EXISTS domain_skill (
     org_id     text NOT NULL,
     domain     text NOT NULL,
     name       text NOT NULL,
     content    text NOT NULL,
     updated_by text,
     updated_at text NOT NULL,
     PRIMARY KEY (org_id, domain, name)
   )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
     seq                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id             text   NOT NULL,
     surface_key        text   NOT NULL,
     session_id         text   NOT NULL,
     principal_id       text,
     ts                 text   NOT NULL,
     kind               text,
     input_tokens       bigint NOT NULL DEFAULT 0,
     output_tokens      bigint NOT NULL DEFAULT 0,
     cache_read_tokens  bigint NOT NULL DEFAULT 0,
     cache_write_tokens bigint NOT NULL DEFAULT 0,
     model              text,
     detail             text
   )`,
  `CREATE INDEX IF NOT EXISTS usage_events_org_session ON usage_events (org_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS usage_events_org_surface_ts ON usage_events (org_id, surface_key, ts)`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS expires_at bigint`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS reason text`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS set_by text`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS monthly_usd double precision`,
  `ALTER TABLE connector_override ADD COLUMN IF NOT EXISTS reason text`,
  `ALTER TABLE connector_override ADD COLUMN IF NOT EXISTS set_by text`,
  `ALTER TABLE spend_ledger ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE routine ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE spend_limit ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE connector_override ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE thread_engagement ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE event_dedupe ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE domain_skill ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS spend_org_isolation ON spend_ledger`,
  `DROP POLICY IF EXISTS routine_org_isolation ON routine`,
  `DROP POLICY IF EXISTS audit_select ON audit_entry`,
  `DROP POLICY IF EXISTS audit_insert ON audit_entry`,
  `DROP POLICY IF EXISTS spend_limit_org_isolation ON spend_limit`,
  `DROP POLICY IF EXISTS connector_override_org_isolation ON connector_override`,
  `DROP POLICY IF EXISTS thread_engagement_org_isolation ON thread_engagement`,
  `DROP POLICY IF EXISTS event_dedupe_org_isolation ON event_dedupe`,
  `DROP POLICY IF EXISTS domain_skill_org_isolation ON domain_skill`,
  `DROP POLICY IF EXISTS usage_events_select ON usage_events`,
  `DROP POLICY IF EXISTS usage_events_insert ON usage_events`,
  `DROP POLICY IF EXISTS pending_actions_org_isolation ON pending_actions`,
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
  `CREATE POLICY spend_limit_org_isolation ON spend_limit
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY connector_override_org_isolation ON connector_override
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY thread_engagement_org_isolation ON thread_engagement
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY event_dedupe_org_isolation ON event_dedupe
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY domain_skill_org_isolation ON domain_skill
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY usage_events_select ON usage_events FOR SELECT
     USING (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY usage_events_insert ON usage_events FOR INSERT
     WITH CHECK (org_id = current_setting('app.current_org', true))`,
  `CREATE POLICY pending_actions_org_isolation ON pending_actions
     USING (org_id = current_setting('app.current_org', true))
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

type PendingActionPgRow = {
  id: string;
  kind: string;
  args_json: string;
  scope_key: string;
  domain: string | null;
  requested_by: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

function pendingActionFromPgRow(org: string, r: PendingActionPgRow): PendingActionRow {
  return {
    id: r.id,
    org,
    kind: r.kind,
    argsJson: r.args_json,
    scopeKey: r.scope_key,
    domain: r.domain,
    requestedBy: r.requested_by,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    messageTs: r.message_ts,
    status: r.status as PendingStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

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

    async setSpendLimit(org, scopeKey, level, limit, meta) {
      assertSpendLimitAmount(limit);
      await client.query(
        `INSERT INTO spend_limit (org_id, scope_key, level, monthly_tokens, monthly_usd, expires_at, reason, set_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, scope_key, level) DO UPDATE SET
           monthly_tokens = excluded.monthly_tokens,
           monthly_usd    = excluded.monthly_usd,
           expires_at     = excluded.expires_at,
           reason         = excluded.reason,
           set_by         = excluded.set_by`,
        [org, scopeKey, level, limit.monthlyTokens ?? -1, limit.monthlyUsd ?? null, meta?.expiresAt ?? null, meta?.reason ?? null, meta?.setBy ?? null],
      );
    },

    async clearSpendLimit(org, scopeKey, level) {
      const { rows } = await client.query("DELETE FROM spend_limit WHERE org_id = $1 AND scope_key = $2 AND level = $3 RETURNING scope_key", [org, scopeKey, level]);
      return rows.length > 0;
    },

    async spendLimits(org) {
      const { rows } = await client.query("SELECT scope_key, level, monthly_tokens, monthly_usd, expires_at, reason, set_by FROM spend_limit WHERE org_id = $1", [org]);
      return (rows as { scope_key: string; level: string; monthly_tokens: number; monthly_usd: number | null; expires_at: number | null; reason: string | null; set_by: string | null }[]).map((r) => ({
        org,
        scopeKey: r.scope_key,
        level: r.level as "surface" | "workspace",
        ...(Number(r.monthly_tokens) >= 0 ? { monthlyTokens: Number(r.monthly_tokens) } : {}),
        ...(r.monthly_usd != null ? { monthlyUsd: Number(r.monthly_usd) } : {}),
        ...(r.expires_at != null ? { expiresAt: Number(r.expires_at) } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.set_by ? { setBy: r.set_by } : {}),
      }));
    },

    async setConnectorOverride(org, scopeKey, connector, granted, meta) {
      await client.query(
        `INSERT INTO connector_override (org_id, scope_key, connector, granted, reason, set_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, scope_key, connector) DO UPDATE SET
           granted = excluded.granted,
           reason  = excluded.reason,
           set_by  = excluded.set_by`,
        [org, scopeKey, connector, granted, meta?.reason ?? null, meta?.setBy ?? null],
      );
    },

    async clearConnectorOverride(org, scopeKey, connector) {
      const { rows } = await client.query("DELETE FROM connector_override WHERE org_id = $1 AND scope_key = $2 AND connector = $3 RETURNING connector", [org, scopeKey, connector]);
      return rows.length > 0;
    },

    async connectorOverrides(org, scopeKey) {
      const { rows } = await client.query("SELECT connector, granted FROM connector_override WHERE org_id = $1 AND scope_key = $2", [org, scopeKey]);
      return (rows as { connector: string; granted: boolean }[]).map((r) => ({ connector: r.connector, granted: r.granted }));
    },

    async allConnectorOverrides(org) {
      const { rows } = await client.query("SELECT scope_key, connector, granted, reason, set_by FROM connector_override WHERE org_id = $1", [org]);
      return (rows as { scope_key: string; connector: string; granted: boolean; reason: string | null; set_by: string | null }[]).map((r) => ({ scopeKey: r.scope_key, connector: r.connector, granted: r.granted, ...(r.reason ? { reason: r.reason } : {}), ...(r.set_by ? { setBy: r.set_by } : {}) }));
    },

    async markEngaged(org, surfaceKey, threadTs, at) {
      await client.query(
        `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, surface_key, thread_ts) DO UPDATE SET last_turn_at = excluded.last_turn_at`,
        [org, surfaceKey, threadTs, at, at],
      );
    },

    async getEngagement(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        "SELECT engaged_at, last_turn_at FROM thread_engagement WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3",
        [org, surfaceKey, threadTs],
      );
      const r = (rows as { engaged_at: string; last_turn_at: string }[])[0];
      return r ? { org, surfaceKey, threadTs, engagedAt: r.engaged_at, lastTurnAt: r.last_turn_at } : null;
    },

    async disengage(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        "DELETE FROM thread_engagement WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3 RETURNING thread_ts",
        [org, surfaceKey, threadTs],
      );
      return rows.length > 0;
    },

    async listEngagements(org) {
      const { rows } = await client.query("SELECT surface_key, thread_ts, engaged_at, last_turn_at FROM thread_engagement WHERE org_id = $1", [org]);
      return (rows as { surface_key: string; thread_ts: string; engaged_at: string; last_turn_at: string }[]).map((r) => ({
        org,
        surfaceKey: r.surface_key,
        threadTs: r.thread_ts,
        engagedAt: r.engaged_at,
        lastTurnAt: r.last_turn_at,
      }));
    },

    async listDomainSkills(org, domain) {
      const { rows } = await client.query(
        "SELECT name, content, updated_by, updated_at FROM domain_skill WHERE org_id = $1 AND domain = $2 ORDER BY name",
        [org, domain],
      );
      return (rows as { name: string; content: string; updated_by: string | null; updated_at: string }[]).map((r) => ({
        org,
        domain,
        name: r.name,
        content: r.content,
        ...(r.updated_by ? { updatedBy: r.updated_by } : {}),
        updatedAt: r.updated_at,
      }));
    },

    async putDomainSkill(org, domain, name, content, updatedBy, updatedAt) {
      await client.query(
        `INSERT INTO domain_skill (org_id, domain, name, content, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, domain, name) DO UPDATE SET
           content    = excluded.content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        [org, domain, name, content, updatedBy ?? null, updatedAt],
      );
    },

    async deleteDomainSkill(org, domain, name) {
      const { rows } = await client.query(
        "DELETE FROM domain_skill WHERE org_id = $1 AND domain = $2 AND name = $3 RETURNING name",
        [org, domain, name],
      );
      return rows.length > 0;
    },

    async appendUsageEvent(entry: UsageEventEntry) {
      await client.query(
        `INSERT INTO usage_events
           (org_id, surface_key, session_id, principal_id, ts, kind,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          entry.org,
          entry.surfaceKey,
          entry.sessionId,
          entry.principalId ?? null,
          entry.ts,
          entry.kind ?? null,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheReadTokens,
          entry.cacheWriteTokens,
          entry.model ?? null,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      );
    },

    async usageForSession(org, sessionId) {
      const { rows } = await client.query(
        `SELECT surface_key, session_id, principal_id, ts, kind,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail
         FROM usage_events WHERE org_id = $1 AND session_id = $2 ORDER BY seq ASC`,
        [org, sessionId],
      );
      return (rows as {
        surface_key: string;
        session_id: string;
        principal_id: string | null;
        ts: string;
        kind: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        model: string | null;
        detail: string | null;
      }[]).map((r) => ({
        org,
        surfaceKey: r.surface_key,
        sessionId: r.session_id,
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        ts: r.ts,
        ...(r.kind ? { kind: r.kind } : {}),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        ...(r.model ? { model: r.model } : {}),
        ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
      }));
    },

    async usageSummary(org, filter: UsageSummaryFilter = {}) {
      const where: string[] = ["org_id = $1"];
      const params: unknown[] = [org];
      if (filter.surfaceKeyPrefix !== undefined) {
        params.push(`${filter.surfaceKeyPrefix}%`);
        where.push(`surface_key LIKE $${params.length}`);
      }
      if (filter.sinceTs !== undefined) {
        params.push(filter.sinceTs);
        where.push(`ts >= $${params.length}`);
      }
      if (filter.untilTs !== undefined) {
        params.push(filter.untilTs);
        where.push(`ts <= $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT surface_key, principal_id, kind, model,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM usage_events WHERE ${where.join(" AND ")}
         GROUP BY surface_key, principal_id, kind, model`,
        params,
      );
      return (rows as {
        surface_key: string;
        principal_id: string | null;
        kind: string | null;
        model: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        events: number;
        sessions: number;
      }[]).map((r) => ({
        surfaceKey: r.surface_key,
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.model ? { model: r.model } : {}),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        events: Number(r.events),
        sessions: Number(r.sessions),
      }));
    },

    async pruneUsageEvents() {
      return 0;
    },

    async markEventSeen(org, key, at, ttlMs) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM event_dedupe WHERE seen_at < $1", [cutoff]);
      const { rows } = await client.query(
        "INSERT INTO event_dedupe (org_id, key, seen_at) VALUES ($1, $2, $3) ON CONFLICT (org_id, key) DO NOTHING RETURNING key",
        [org, key, at],
      );
      return rows.length > 0;
    },

    async addPendingAction(row: PendingActionRow) {
      await client.query(
        `INSERT INTO pending_actions
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, status, created_at, expires_at, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.org,
          row.id,
          row.kind,
          row.argsJson,
          row.scopeKey,
          row.domain,
          row.requestedBy,
          row.channelId,
          row.threadTs,
          row.messageTs,
          row.status,
          row.createdAt,
          row.expiresAt,
          row.decidedBy,
          row.decidedAt,
        ],
      );
    },

    async getPendingAction(org, id) {
      const { rows } = await client.query(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = $1 AND id = $2`,
        [org, id],
      );
      const r = (rows as PendingActionPgRow[])[0];
      return r ? pendingActionFromPgRow(org, r) : null;
    },

    async setPendingActionMessage(org, id, messageTs) {
      await client.query("UPDATE pending_actions SET message_ts = $1 WHERE org_id = $2 AND id = $3", [messageTs, org, id]);
    },

    async decidePendingAction(org, id, status, decidedBy, decidedAt) {
      const { rows } = await client.query(
        `UPDATE pending_actions SET status = $1, decided_by = $2, decided_at = $3
         WHERE org_id = $4 AND id = $5 AND status = 'pending' RETURNING id`,
        [status, decidedBy, decidedAt, org, id],
      );
      return rows.length > 0;
    },
  };
}
