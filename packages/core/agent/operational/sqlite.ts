import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SurfaceLedger, Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import type { AuditEntry, AuditFilter, OperationalStore, OrgSurfaceLedger, UsageEventEntry } from "./store.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";

function dbPath(): string {
  if (process.env.OE_SQLITE_PATH) return process.env.OE_SQLITE_PATH;
  const root = process.env.OE_MEMORY_DIR ?? join(process.cwd(), ".open-everywhere-memory");
  return join(root, "open-everywhere.sqlite3");
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;

function getDb(): DatabaseSync {
  const path = dbPath();
  if (db && openedPath !== path) {
    db.close();
    db = null;
  }
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS spend_ledger (
      org_id        TEXT NOT NULL,
      surface_key   TEXT NOT NULL,
      period        TEXT NOT NULL,            -- "YYYY-MM"
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      calls         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, surface_key, period)
    );
    CREATE TABLE IF NOT EXISTS routine (
      org_id      TEXT NOT NULL,
      id          TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      data        TEXT NOT NULL,              -- JSON of the full Routine
      PRIMARY KEY (org_id, id)
    );
    CREATE TABLE IF NOT EXISTS audit_entry (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      workspace    TEXT NOT NULL,
      surface      TEXT,
      principal_id TEXT,
      action       TEXT NOT NULL,
      detail       TEXT                       -- JSON
    );
    CREATE INDEX IF NOT EXISTS audit_org_ts ON audit_entry (org_id, ts);
    CREATE TABLE IF NOT EXISTS spend_limit (
      org_id        TEXT NOT NULL,
      scope_key     TEXT NOT NULL,
      level         TEXT NOT NULL,            -- "surface" | "workspace"
      monthly_tokens INTEGER NOT NULL,
      expires_at    INTEGER,                  -- epoch ms; NULL = no auto-expiry
      reason        TEXT,
      set_by        TEXT,
      PRIMARY KEY (org_id, scope_key, level)
    );
    CREATE TABLE IF NOT EXISTS connector_override (
      org_id    TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      connector TEXT NOT NULL,
      granted   INTEGER NOT NULL,             -- 1 = grant, 0 = revoke
      reason    TEXT,                         -- no expires_at: auto-expiry would re-open access
      set_by    TEXT,
      PRIMARY KEY (org_id, scope_key, connector)
    );
    CREATE TABLE IF NOT EXISTS thread_engagement (
      org_id       TEXT NOT NULL,
      surface_key  TEXT NOT NULL,             -- platform/workspace/surface (the channel)
      thread_ts    TEXT NOT NULL,
      engaged_at   TEXT NOT NULL,             -- ISO-8601, set once
      last_turn_at TEXT NOT NULL,             -- ISO-8601, refreshed each engaged turn
      PRIMARY KEY (org_id, surface_key, thread_ts)
    );
    CREATE TABLE IF NOT EXISTS event_dedupe (
      org_id  TEXT NOT NULL,
      key     TEXT NOT NULL,                  -- Slack event_id (or channel:ts fallback)
      seen_at TEXT NOT NULL,                  -- ISO-8601 (lexicographic = chronological)
      PRIMARY KEY (org_id, key)
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      org_id       TEXT NOT NULL,
      id           TEXT NOT NULL,
      kind         TEXT NOT NULL,             -- e.g. "spend.set" (agent/approvals/actions.ts registry key)
      args_json    TEXT NOT NULL,             -- FROZEN mutation args, JSON
      scope_key    TEXT NOT NULL,             -- the scope the mutation targets
      domain       TEXT,                      -- memory domain resolved at propose time (NULL if none)
      requested_by TEXT NOT NULL,             -- proposing session's verified principal id
      channel_id   TEXT NOT NULL,             -- where the card is posted
      thread_ts    TEXT,
      message_ts   TEXT,                      -- the card's ts, set after post
      status       TEXT NOT NULL,             -- pending|approved|rejected|expired
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      decided_by   TEXT,
      decided_at   TEXT,
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS pending_actions_org_status ON pending_actions (org_id, status);
    CREATE TABLE IF NOT EXISTS domain_skill (
      org_id     TEXT NOT NULL,
      domain     TEXT NOT NULL,
      name       TEXT NOT NULL,               -- bare (no repo-style namespace)
      content    TEXT NOT NULL,               -- model-facing markdown, verbatim
      updated_by TEXT,                        -- authoring principalId, when known
      updated_at TEXT NOT NULL,               -- ISO-8601
      PRIMARY KEY (org_id, domain, name)
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      seq                INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id             TEXT NOT NULL,
      surface_key        TEXT NOT NULL,
      session_id         TEXT NOT NULL,
      principal_id       TEXT,
      ts                 TEXT NOT NULL,        -- ISO-8601
      kind               TEXT,                 -- "dm" | "channel" | "routine" | "sandbox" | ...
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      model              TEXT,
      detail             TEXT                  -- JSON
    );
    CREATE INDEX IF NOT EXISTS usage_events_org_session ON usage_events (org_id, session_id);
    CREATE INDEX IF NOT EXISTS usage_events_org_surface_ts ON usage_events (org_id, surface_key, ts);
  `);
  for (const ddl of [
    "ALTER TABLE spend_limit ADD COLUMN expires_at INTEGER",
    "ALTER TABLE spend_limit ADD COLUMN reason TEXT",
    "ALTER TABLE spend_limit ADD COLUMN set_by TEXT",
    "ALTER TABLE connector_override ADD COLUMN reason TEXT",
    "ALTER TABLE connector_override ADD COLUMN set_by TEXT",
  ]) {
    try {
      handle.exec(ddl);
    } catch {
    }
  }
  db = handle;
  openedPath = path;
  return handle;
}

export function _resetOperationalDbForTest(): void {
  if (db) db.close();
  db = null;
  openedPath = null;
}

function rowsToLedger(rows: { period: string; input_tokens: number; output_tokens: number; calls: number }[]): SurfaceLedger {
  const ledger: SurfaceLedger = { windows: {} };
  for (const r of rows) {
    ledger.windows[r.period] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, calls: r.calls };
  }
  return ledger;
}

type UsageEventRow = {
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
};

function usageEventFromRow(org: string, r: UsageEventRow): UsageEventEntry {
  return {
    org,
    surfaceKey: r.surface_key,
    sessionId: r.session_id,
    ...(r.principal_id ? { principalId: r.principal_id } : {}),
    ts: r.ts,
    ...(r.kind ? { kind: r.kind } : {}),
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    ...(r.model ? { model: r.model } : {}),
    ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
  };
}

type PendingActionSqlRow = {
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

function pendingActionFromRow(org: string, r: PendingActionSqlRow): PendingActionRow {
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

export const sqliteOperationalStore: OperationalStore = {
  id: "sqlite",
  root: dbPath,

  async recordUsage(org, surfaceKey, period, usage: Usage) {
    getDb()
      .prepare(
        `INSERT INTO spend_ledger (org_id, surface_key, period, input_tokens, output_tokens, calls)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(org_id, surface_key, period) DO UPDATE SET
           input_tokens  = input_tokens  + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           calls         = calls + 1`,
      )
      .run(org, surfaceKey, period, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
  },

  async surfaceLedger(org, surfaceKey) {
    const rows = getDb()
      .prepare("SELECT period, input_tokens, output_tokens, calls FROM spend_ledger WHERE org_id = ? AND surface_key = ?")
      .all(org, surfaceKey) as { period: string; input_tokens: number; output_tokens: number; calls: number }[];
    return rowsToLedger(rows);
  },

  async allLedgers() {
    const rows = getDb()
      .prepare("SELECT org_id, surface_key, period, input_tokens, output_tokens, calls FROM spend_ledger")
      .all() as { org_id: string; surface_key: string; period: string; input_tokens: number; output_tokens: number; calls: number }[];
    const byKey = new Map<string, OrgSurfaceLedger>();
    for (const r of rows) {
      const k = `${r.org_id} ${r.surface_key}`;
      let entry = byKey.get(k);
      if (!entry) {
        entry = { org: r.org_id, surfaceKey: r.surface_key, ledger: { windows: {} } };
        byKey.set(k, entry);
      }
      entry.ledger.windows[r.period] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, calls: r.calls };
    }
    return [...byKey.values()];
  },

  async listRoutines(org, surfaceKey) {
    const rows = getDb()
      .prepare("SELECT data FROM routine WHERE org_id = ? AND surface_key = ?")
      .all(org, surfaceKey) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Routine);
  },

  async getRoutine(org, surfaceKey, id) {
    const row = getDb()
      .prepare("SELECT data FROM routine WHERE org_id = ? AND id = ? AND surface_key = ?")
      .get(org, id, surfaceKey) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Routine) : null;
  },

  async addRoutine(routine) {
    getDb()
      .prepare("INSERT INTO routine (org_id, id, surface_key, data) VALUES (?, ?, ?, ?)")
      .run(routine.org, routine.id, routine.surfaceKey, JSON.stringify(routine));
    return routine;
  },

  async updateRoutine(org, surfaceKey, id, patch) {
    const handle = getDb();
    const row = handle.prepare("SELECT data FROM routine WHERE org_id = ? AND id = ? AND surface_key = ?").get(org, id, surfaceKey) as
      | { data: string }
      | undefined;
    if (!row) return null;
    const existing = JSON.parse(row.data) as Routine;
    const updated: Routine = { ...existing, ...patch, id: existing.id, org: existing.org, surfaceKey: existing.surfaceKey };
    handle.prepare("UPDATE routine SET data = ? WHERE org_id = ? AND id = ?").run(JSON.stringify(updated), org, id);
    return updated;
  },

  async removeRoutine(org, surfaceKey, id) {
    const info = getDb().prepare("DELETE FROM routine WHERE org_id = ? AND id = ? AND surface_key = ?").run(org, id, surfaceKey);
    return info.changes > 0;
  },

  async listAllRoutines() {
    const rows = getDb().prepare("SELECT data FROM routine").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Routine);
  },

  async appendAudit(entry: AuditEntry) {
    getDb()
      .prepare(
        `INSERT INTO audit_entry (ts, org_id, platform, workspace, surface, principal_id, action, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.org,
        entry.platform,
        entry.workspace,
        entry.surface ?? null,
        entry.principalId ?? null,
        entry.action,
        entry.detail ? JSON.stringify(entry.detail) : null,
      );
  },

  async readAudit(filter: AuditFilter) {
    const where: string[] = [];
    const params: string[] = [];
    const eq = (col: string, val: string | undefined) => {
      if (val !== undefined) {
        where.push(`${col} = ?`);
        params.push(val);
      }
    };
    eq("org_id", filter.org);
    eq("platform", filter.platform);
    eq("workspace", filter.workspace);
    eq("surface", filter.surface);
    eq("action", filter.action);
    eq("principal_id", filter.principalId);
    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit && filter.limit > 0 ? filter.limit : -1;
    const rows = getDb()
      .prepare(
        `SELECT ts, org_id, platform, workspace, surface, principal_id, action, detail
         FROM audit_entry ${clause} ORDER BY ts DESC, seq DESC LIMIT ?`,
      )
      .all(...params, limit) as {
      ts: string;
      org_id: string;
      platform: string;
      workspace: string;
      surface: string | null;
      principal_id: string | null;
      action: string;
      detail: string | null;
    }[];
    return rows.map((r) => ({
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

  async setSpendLimit(org, scopeKey, level, monthlyTokens, meta) {
    getDb()
      .prepare(
        `INSERT INTO spend_limit (org_id, scope_key, level, monthly_tokens, expires_at, reason, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, scope_key, level) DO UPDATE SET
           monthly_tokens = excluded.monthly_tokens,
           expires_at     = excluded.expires_at,
           reason         = excluded.reason,
           set_by         = excluded.set_by`,
      )
      .run(org, scopeKey, level, monthlyTokens, meta?.expiresAt ?? null, meta?.reason ?? null, meta?.setBy ?? null);
  },

  async clearSpendLimit(org, scopeKey, level) {
    return getDb().prepare("DELETE FROM spend_limit WHERE org_id = ? AND scope_key = ? AND level = ?").run(org, scopeKey, level).changes > 0;
  },

  async spendLimits(org) {
    const rows = getDb()
      .prepare("SELECT scope_key, level, monthly_tokens, expires_at, reason, set_by FROM spend_limit WHERE org_id = ?")
      .all(org) as { scope_key: string; level: string; monthly_tokens: number; expires_at: number | null; reason: string | null; set_by: string | null }[];
    return rows.map((r) => ({
      org,
      scopeKey: r.scope_key,
      level: r.level as "surface" | "workspace",
      monthlyTokens: r.monthly_tokens,
      ...(r.expires_at != null ? { expiresAt: r.expires_at } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.set_by ? { setBy: r.set_by } : {}),
    }));
  },

  async setConnectorOverride(org, scopeKey, connector, granted, meta) {
    getDb()
      .prepare(
        `INSERT INTO connector_override (org_id, scope_key, connector, granted, reason, set_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, scope_key, connector) DO UPDATE SET
           granted = excluded.granted,
           reason  = excluded.reason,
           set_by  = excluded.set_by`,
      )
      .run(org, scopeKey, connector, granted ? 1 : 0, meta?.reason ?? null, meta?.setBy ?? null);
  },

  async clearConnectorOverride(org, scopeKey, connector) {
    return getDb().prepare("DELETE FROM connector_override WHERE org_id = ? AND scope_key = ? AND connector = ?").run(org, scopeKey, connector).changes > 0;
  },

  async connectorOverrides(org, scopeKey) {
    const rows = getDb()
      .prepare("SELECT connector, granted FROM connector_override WHERE org_id = ? AND scope_key = ?")
      .all(org, scopeKey) as { connector: string; granted: number }[];
    return rows.map((r) => ({ connector: r.connector, granted: r.granted === 1 }));
  },

  async allConnectorOverrides(org) {
    const rows = getDb()
      .prepare("SELECT scope_key, connector, granted, reason, set_by FROM connector_override WHERE org_id = ?")
      .all(org) as { scope_key: string; connector: string; granted: number; reason: string | null; set_by: string | null }[];
    return rows.map((r) => ({ scopeKey: r.scope_key, connector: r.connector, granted: r.granted === 1, ...(r.reason ? { reason: r.reason } : {}), ...(r.set_by ? { setBy: r.set_by } : {}) }));
  },

  async markEngaged(org, surfaceKey, threadTs, at) {
    getDb()
      .prepare(
        `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, surface_key, thread_ts) DO UPDATE SET last_turn_at = excluded.last_turn_at`,
      )
      .run(org, surfaceKey, threadTs, at, at);
  },

  async getEngagement(org, surfaceKey, threadTs) {
    const row = getDb()
      .prepare("SELECT engaged_at, last_turn_at FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?")
      .get(org, surfaceKey, threadTs) as { engaged_at: string; last_turn_at: string } | undefined;
    return row ? { org, surfaceKey, threadTs, engagedAt: row.engaged_at, lastTurnAt: row.last_turn_at } : null;
  },

  async disengage(org, surfaceKey, threadTs) {
    return getDb().prepare("DELETE FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?").run(org, surfaceKey, threadTs).changes > 0;
  },

  async listEngagements(org) {
    const rows = getDb()
      .prepare("SELECT surface_key, thread_ts, engaged_at, last_turn_at FROM thread_engagement WHERE org_id = ?")
      .all(org) as { surface_key: string; thread_ts: string; engaged_at: string; last_turn_at: string }[];
    return rows.map((r) => ({ org, surfaceKey: r.surface_key, threadTs: r.thread_ts, engagedAt: r.engaged_at, lastTurnAt: r.last_turn_at }));
  },

  async listDomainSkills(org, domain) {
    const rows = getDb()
      .prepare("SELECT name, content, updated_by, updated_at FROM domain_skill WHERE org_id = ? AND domain = ? ORDER BY name")
      .all(org, domain) as { name: string; content: string; updated_by: string | null; updated_at: string }[];
    return rows.map((r) => ({
      org,
      domain,
      name: r.name,
      content: r.content,
      ...(r.updated_by ? { updatedBy: r.updated_by } : {}),
      updatedAt: r.updated_at,
    }));
  },

  async putDomainSkill(org, domain, name, content, updatedBy, updatedAt) {
    getDb()
      .prepare(
        `INSERT INTO domain_skill (org_id, domain, name, content, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, domain, name) DO UPDATE SET
           content    = excluded.content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(org, domain, name, content, updatedBy ?? null, updatedAt);
  },

  async deleteDomainSkill(org, domain, name) {
    return getDb().prepare("DELETE FROM domain_skill WHERE org_id = ? AND domain = ? AND name = ?").run(org, domain, name).changes > 0;
  },

  async appendUsageEvent(entry) {
    getDb()
      .prepare(
        `INSERT INTO usage_events
           (org_id, surface_key, session_id, principal_id, ts, kind,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  },

  async usageForSession(org, sessionId) {
    const rows = getDb()
      .prepare(
        `SELECT surface_key, session_id, principal_id, ts, kind,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail
         FROM usage_events WHERE org_id = ? AND session_id = ? ORDER BY seq ASC`,
      )
      .all(org, sessionId) as UsageEventRow[];
    return rows.map((r) => usageEventFromRow(org, r));
  },

  async usageSummary(org, filter = {}) {
    const where: string[] = ["org_id = ?"];
    const params: string[] = [org];
    if (filter.surfaceKeyPrefix !== undefined) {
      where.push("surface_key LIKE ?");
      params.push(`${filter.surfaceKeyPrefix}%`);
    }
    if (filter.sinceTs !== undefined) {
      where.push("ts >= ?");
      params.push(filter.sinceTs);
    }
    if (filter.untilTs !== undefined) {
      where.push("ts <= ?");
      params.push(filter.untilTs);
    }
    const rows = getDb()
      .prepare(
        `SELECT surface_key, principal_id, kind, model,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM usage_events WHERE ${where.join(" AND ")}
         GROUP BY surface_key, principal_id, kind, model`,
      )
      .all(...params) as {
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
    }[];
    return rows.map((r) => ({
      surfaceKey: r.surface_key,
      ...(r.principal_id ? { principalId: r.principal_id } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.model ? { model: r.model } : {}),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      events: r.events,
      sessions: r.sessions,
    }));
  },

  async pruneUsageEvents(org, olderThanTs) {
    return Number(getDb().prepare("DELETE FROM usage_events WHERE org_id = ? AND ts < ?").run(org, olderThanTs).changes);
  },

  async markEventSeen(org, key, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM event_dedupe WHERE seen_at < ?").run(cutoff);
    const info = handle.prepare("INSERT OR IGNORE INTO event_dedupe (org_id, key, seen_at) VALUES (?, ?, ?)").run(org, key, at);
    return info.changes > 0;
  },

  async addPendingAction(row) {
    getDb()
      .prepare(
        `INSERT INTO pending_actions
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, status, created_at, expires_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  },

  async getPendingAction(org, id) {
    const row = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND id = ?`,
      )
      .get(org, id) as PendingActionSqlRow | undefined;
    return row ? pendingActionFromRow(org, row) : null;
  },

  async setPendingActionMessage(org, id, messageTs) {
    getDb().prepare("UPDATE pending_actions SET message_ts = ? WHERE org_id = ? AND id = ?").run(messageTs, org, id);
  },

  async decidePendingAction(org, id, status, decidedBy, decidedAt) {
    const info = getDb()
      .prepare("UPDATE pending_actions SET status = ?, decided_by = ?, decided_at = ? WHERE org_id = ? AND id = ? AND status = 'pending'")
      .run(status, decidedBy, decidedAt, org, id);
    return info.changes > 0;
  },
};
