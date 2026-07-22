import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SurfaceLedger, Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import { assertSpendLimitAmount, assertDomainModelPick, type AuditEntry, type AuditFilter, type CapLevel, type OperationalStore, type OrgSurfaceLedger, type SlackAttachmentRow, type UsageEventEntry } from "./store.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";

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
      level         TEXT NOT NULL,            -- "surface" | "workspace" | "domain" (free-text, no CHECK)
      monthly_tokens INTEGER NOT NULL,        -- -1 = no token component (legacy NOT NULL; see setSpendLimit)
      monthly_usd   REAL,                     -- NULL = no USD component
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
      org_id        TEXT    NOT NULL,
      surface_key   TEXT    NOT NULL,          -- platform/workspace/surface (the channel)
      thread_ts     TEXT    NOT NULL,
      engaged_at    TEXT    NOT NULL,          -- ISO-8601, set once
      last_turn_at  TEXT    NOT NULL,          -- ISO-8601, refreshed each engaged turn
      participating INTEGER NOT NULL DEFAULT 0, -- 1 = invited participant (replied/@mentioned); 0 = warm watcher
      silent_streak INTEGER NOT NULL DEFAULT 0, -- consecutive silent woken turns since last engage/participation
      stopped       INTEGER NOT NULL DEFAULT 0, -- 1 = an explicit stop landed (window path); suppress non-mention wakes until re-invited
      PRIMARY KEY (org_id, surface_key, thread_ts)
    );
    CREATE TABLE IF NOT EXISTS channel_session (
      org_id             TEXT    NOT NULL,
      surface_key        TEXT    NOT NULL,          -- the channel (platform/workspace/surface)
      token              TEXT    NOT NULL,          -- caller-minted continuation token for the CURRENT generation
      generation         INTEGER NOT NULL,          -- 1 on first mint, +1 on every rotation
      created_at         TEXT    NOT NULL,          -- ISO-8601, reset on rotation
      last_wake_at       TEXT    NOT NULL,          -- ISO-8601, bumped by touchChannelSession, reset on rotation
      turn_count         INTEGER NOT NULL DEFAULT 0, -- bumped by touchChannelSession, reset to 0 on rotation (BACKSTOP trigger)
      input_tokens_total INTEGER,                    -- measured cumulative input+cacheRead this generation (§2 #551); NULL = unknown ⇒ rotate
      first_wake_at      TEXT,                        -- ISO-8601 of the first delivered wake (H7c); NULL = none yet ⇒ still fresh
      handoff_note       TEXT,                        -- rolling distilled channel state for the next generation (§5); NULL = none
      PRIMARY KEY (org_id, surface_key)
    );
    CREATE TABLE IF NOT EXISTS event_dedupe (
      org_id  TEXT NOT NULL,
      key     TEXT NOT NULL,                  -- Slack event_id (or channel:ts fallback)
      seen_at TEXT NOT NULL,                  -- ISO-8601 (lexicographic = chronological)
      PRIMARY KEY (org_id, key)
    );
    CREATE TABLE IF NOT EXISTS unified_wake_target (
      org_id      TEXT NOT NULL,
      wake_id     TEXT NOT NULL,              -- host-minted per-wake id (rides the wake envelope)
      target_json TEXT NOT NULL,              -- serialized UnifiedWakeOrigin (opaque to the store)
      created_at  TEXT NOT NULL,              -- ISO-8601 (lexicographic = chronological; TTL prune key)
      PRIMARY KEY (org_id, wake_id)
    );
    CREATE TABLE IF NOT EXISTS thread_ownership (
      org_id      TEXT NOT NULL,
      channel_key TEXT NOT NULL,              -- the container (unifiedThreadRef.channelKey)
      thread_key  TEXT NOT NULL,              -- the thread within it (unifiedThreadRef.threadKey)
      task_token  TEXT NOT NULL,              -- the owning task window token (embeds its generation)
      created_at  TEXT NOT NULL,              -- ISO-8601 (lexicographic = chronological; TTL prune key)
      PRIMARY KEY (org_id, channel_key, thread_key)
    );
    CREATE TABLE IF NOT EXISTS task_result (
      org_id       TEXT NOT NULL,
      task_id      TEXT NOT NULL,             -- the unique one-shot task window token (per-call nonce)
      result_json  TEXT NOT NULL,             -- {summary, artifacts?, error?} (opaque to the store)
      created_at   TEXT NOT NULL,             -- ISO-8601 (lexicographic = chronological; TTL prune key)
      caller_token TEXT,                      -- the delegating seat's standing window token (F1 reader key); NULL = unaddressable (degrade flag / pre-migration)
      delivered_at TEXT,                      -- ISO-8601 when the result reached the caller; NULL = undelivered (reader recovers)
      PRIMARY KEY (org_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS slack_attachment (
      org_id      TEXT NOT NULL,
      file_id     TEXT NOT NULL,              -- Slack file id (the model-named ref; trusted-provenance key)
      url_private TEXT NOT NULL,              -- event-supplied url_private (opaque; never a model string)
      mime_type   TEXT,                       -- IANA media type from the event, when known
      name        TEXT,                       -- original filename, when known (extension fallback for the read path)
      team_id     TEXT,                       -- Slack team id, when known
      created_at  TEXT NOT NULL,              -- ISO-8601 (lexicographic = chronological; TTL prune key)
      PRIMARY KEY (org_id, file_id)
    );
    -- stored_credential: ciphertext store behind the "db" credential broker. NEVER
    -- plaintext — ciphertext is an AES-256-GCM envelope, opaque here. Mutable (re-store replaces).
    CREATE TABLE IF NOT EXISTS stored_credential (
      org_id     TEXT NOT NULL,
      ref        TEXT NOT NULL,               -- unique lookup key, e.g. "db:notion-<domain>-key"
      ciphertext TEXT NOT NULL,               -- AES-256-GCM envelope (iv‖tag‖ct, base64); NEVER logged
      provider   TEXT,                        -- label only (audit/admin views), never the value
      domain     TEXT,                        -- label only
      created_by TEXT NOT NULL,               -- storing principal (the intake requester)
      created_at TEXT NOT NULL,               -- ISO-8601
      PRIMARY KEY (org_id, ref)
    );
    -- credential_intake: the single-use, TTL'd binding a "Set API key" button carries.
    -- Mutable; the ONE unused→used transition is CAS-guarded (WHERE used_at IS NULL). NEVER holds
    -- the secret value — only where it goes (ref), who may store it (requested_by), and labels.
    CREATE TABLE IF NOT EXISTS credential_intake (
      org_id       TEXT NOT NULL,
      id           TEXT NOT NULL,             -- opaque intake id (embedded in the button action_id)
      ref          TEXT NOT NULL,             -- the stored_credential ref the value is written under
      provider     TEXT NOT NULL,             -- label shown in the modal
      domain       TEXT,                      -- label shown in the modal
      requested_by TEXT NOT NULL,             -- the ONLY principal permitted to open + submit
      channel_id   TEXT NOT NULL,             -- where the button lives (wrong-clicker notice + confirm)
      thread_ts    TEXT,
      created_at   TEXT NOT NULL,             -- ISO-8601
      expires_at   TEXT NOT NULL,             -- ISO-8601 TTL bound (~15 min)
      used_at      TEXT,                      -- ISO-8601 when consumed; NULL = still open (single-use)
      PRIMARY KEY (org_id, id)
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
      posted_to    TEXT,                      -- proposing surfaceKey frozen at mint; NULL = no sweep feedback
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
    CREATE TABLE IF NOT EXISTS domain_model (
      org_id     TEXT NOT NULL,
      domain     TEXT NOT NULL,
      model_id   TEXT,                     -- NULL = no modelId component (reasoning-only pick)
      reasoning  TEXT,                     -- NULL = no reasoning component (modelId-only pick)
      set_by     TEXT,
      updated_at TEXT NOT NULL,            -- ISO-8601
      PRIMARY KEY (org_id, domain)
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
    CREATE TABLE IF NOT EXISTS instance_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  for (const ddl of [
    "ALTER TABLE spend_limit ADD COLUMN expires_at INTEGER",
    "ALTER TABLE spend_limit ADD COLUMN reason TEXT",
    "ALTER TABLE spend_limit ADD COLUMN set_by TEXT",
    "ALTER TABLE spend_limit ADD COLUMN monthly_usd REAL",

    "ALTER TABLE connector_override ADD COLUMN reason TEXT",
    "ALTER TABLE connector_override ADD COLUMN set_by TEXT",

    "ALTER TABLE thread_engagement ADD COLUMN participating INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE thread_engagement ADD COLUMN silent_streak INTEGER NOT NULL DEFAULT 0",

    "ALTER TABLE thread_engagement ADD COLUMN owner_token TEXT",
    "ALTER TABLE thread_engagement ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'",

    "ALTER TABLE thread_engagement ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0",

    "ALTER TABLE channel_session ADD COLUMN input_tokens_total INTEGER",
    "ALTER TABLE channel_session ADD COLUMN first_wake_at TEXT",
    "ALTER TABLE channel_session ADD COLUMN handoff_note TEXT",

    "ALTER TABLE task_result ADD COLUMN caller_token TEXT",
    "ALTER TABLE task_result ADD COLUMN delivered_at TEXT",

    "ALTER TABLE pending_actions ADD COLUMN posted_to TEXT",

    "ALTER TABLE stored_credential ADD COLUMN claim_id TEXT",
    "ALTER TABLE stored_credential ADD COLUMN claimed_at TEXT",
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
  posted_to: string | null;
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
    postedTo: r.posted_to,
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

  async setSpendLimit(org, scopeKey, level, limit, meta) {
    assertSpendLimitAmount(limit);
    getDb()
      .prepare(
        `INSERT INTO spend_limit (org_id, scope_key, level, monthly_tokens, monthly_usd, expires_at, reason, set_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, scope_key, level) DO UPDATE SET
           monthly_tokens = excluded.monthly_tokens,
           monthly_usd    = excluded.monthly_usd,
           expires_at     = excluded.expires_at,
           reason         = excluded.reason,
           set_by         = excluded.set_by`,
      )
      .run(org, scopeKey, level, limit.monthlyTokens ?? -1, limit.monthlyUsd ?? null, meta?.expiresAt ?? null, meta?.reason ?? null, meta?.setBy ?? null);
  },

  async clearSpendLimit(org, scopeKey, level) {
    return getDb().prepare("DELETE FROM spend_limit WHERE org_id = ? AND scope_key = ? AND level = ?").run(org, scopeKey, level).changes > 0;
  },

  async spendLimits(org) {
    const rows = getDb()
      .prepare("SELECT scope_key, level, monthly_tokens, monthly_usd, expires_at, reason, set_by FROM spend_limit WHERE org_id = ?")
      .all(org) as { scope_key: string; level: string; monthly_tokens: number; monthly_usd: number | null; expires_at: number | null; reason: string | null; set_by: string | null }[];
    return rows.map((r) => ({
      org,
      scopeKey: r.scope_key,
      level: r.level as CapLevel,
      ...(r.monthly_tokens >= 0 ? { monthlyTokens: r.monthly_tokens } : {}),
      ...(r.monthly_usd != null ? { monthlyUsd: r.monthly_usd } : {}),
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

  async setDomainModel(org, domain, pick, setBy) {
    assertDomainModelPick(pick);
    getDb()
      .prepare(
        `INSERT INTO domain_model (org_id, domain, model_id, reasoning, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, domain) DO UPDATE SET
           model_id   = excluded.model_id,
           reasoning  = excluded.reasoning,
           set_by     = excluded.set_by,
           updated_at = excluded.updated_at`,
      )
      .run(org, domain, pick.modelId ?? null, pick.reasoning ?? null, setBy ?? null, new Date().toISOString());
  },

  async clearDomainModel(org, domain) {
    return getDb().prepare("DELETE FROM domain_model WHERE org_id = ? AND domain = ?").run(org, domain).changes > 0;
  },

  async getDomainModel(org, domain) {
    const row = getDb()
      .prepare("SELECT model_id, reasoning, set_by, updated_at FROM domain_model WHERE org_id = ? AND domain = ?")
      .get(org, domain) as { model_id: string | null; reasoning: string | null; set_by: string | null; updated_at: string } | undefined;
    if (!row) return null;
    return {
      org,
      domain,
      ...(row.model_id ? { modelId: row.model_id } : {}),
      ...(row.reasoning ? { reasoning: row.reasoning as ModelReasoning } : {}),
      ...(row.set_by ? { setBy: row.set_by } : {}),
      updatedAt: row.updated_at,
    };
  },

  async domainModels(org) {
    const rows = getDb()
      .prepare("SELECT domain, model_id, reasoning, set_by, updated_at FROM domain_model WHERE org_id = ? ORDER BY domain")
      .all(org) as { domain: string; model_id: string | null; reasoning: string | null; set_by: string | null; updated_at: string }[];
    return rows.map((r) => ({
      org,
      domain: r.domain,
      ...(r.model_id ? { modelId: r.model_id } : {}),
      ...(r.reasoning ? { reasoning: r.reasoning as ModelReasoning } : {}),
      ...(r.set_by ? { setBy: r.set_by } : {}),
      updatedAt: r.updated_at,
    }));
  },

  async markEngaged(org, surfaceKey, threadTs, at, opts) {
    const participating = opts?.participating ? 1 : 0;
    const ownerToken = opts?.ownerToken ?? null;
    const kind = opts?.kind ?? "thread";
    getDb()
      .prepare(
        `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
         ON CONFLICT(org_id, surface_key, thread_ts) DO UPDATE SET
           last_turn_at  = excluded.last_turn_at,
           participating = MAX(participating, excluded.participating),
           silent_streak = CASE WHEN excluded.participating = 1 THEN 0 ELSE silent_streak END,
           owner_token   = COALESCE(excluded.owner_token, owner_token),
           stopped       = CASE WHEN excluded.participating = 1 THEN 0 ELSE stopped END`,
      )
      .run(org, surfaceKey, threadTs, at, at, participating, ownerToken, kind);
  },

  async markStopped(org, surfaceKey, threadTs) {
    return getDb().prepare("UPDATE thread_engagement SET stopped = 1 WHERE org_id = ? AND surface_key = ? AND thread_ts = ?").run(org, surfaceKey, threadTs).changes > 0;
  },

  async bumpSilentStreak(org, surfaceKey, threadTs) {
    const row = getDb()
      .prepare(
        `UPDATE thread_engagement SET silent_streak = silent_streak + 1
         WHERE org_id = ? AND surface_key = ? AND thread_ts = ? RETURNING silent_streak`,
      )
      .get(org, surfaceKey, threadTs) as { silent_streak: number } | undefined;
    return row ? row.silent_streak : 0;
  },

  async getEngagement(org, surfaceKey, threadTs) {
    const row = getDb()
      .prepare("SELECT engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?")
      .get(org, surfaceKey, threadTs) as
      | { engaged_at: string; last_turn_at: string; participating: number; silent_streak: number; owner_token: string | null; kind: string | null; stopped: number }
      | undefined;
    return row
      ? {
          org,
          surfaceKey,
          threadTs,
          engagedAt: row.engaged_at,
          lastTurnAt: row.last_turn_at,
          participating: row.participating === 1,
          silentStreak: row.silent_streak,
          ...(row.owner_token ? { ownerToken: row.owner_token } : {}),
          kind: (row.kind as "thread" | "spawned" | null) ?? "thread",
          stopped: row.stopped === 1,
        }
      : null;
  },

  async disengage(org, surfaceKey, threadTs) {
    return getDb().prepare("DELETE FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?").run(org, surfaceKey, threadTs).changes > 0;
  },

  async listEngagements(org) {
    const rows = getDb()
      .prepare("SELECT surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped FROM thread_engagement WHERE org_id = ?")
      .all(org) as {
      surface_key: string;
      thread_ts: string;
      engaged_at: string;
      last_turn_at: string;
      participating: number;
      silent_streak: number;
      owner_token: string | null;
      kind: string | null;
      stopped: number;
    }[];
    return rows.map((r) => ({
      org,
      surfaceKey: r.surface_key,
      threadTs: r.thread_ts,
      engagedAt: r.engaged_at,
      lastTurnAt: r.last_turn_at,
      participating: r.participating === 1,
      silentStreak: r.silent_streak,
      ...(r.owner_token ? { ownerToken: r.owner_token } : {}),
      kind: (r.kind as "thread" | "spawned" | null) ?? "thread",
      stopped: r.stopped === 1,
    }));
  },

  async getChannelSession(org, surfaceKey) {
    const row = getDb()
      .prepare("SELECT token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, handoff_note FROM channel_session WHERE org_id = ? AND surface_key = ?")
      .get(org, surfaceKey) as
      | { token: string; generation: number; created_at: string; last_wake_at: string; turn_count: number; input_tokens_total: number | null; first_wake_at: string | null; handoff_note: string | null }
      | undefined;
    return row
      ? {
          org, surfaceKey, token: row.token, generation: row.generation, createdAt: row.created_at,
          lastWakeAt: row.last_wake_at, turnCount: row.turn_count,
          inputTokensTotal: row.input_tokens_total == null ? null : Number(row.input_tokens_total),
          firstWakeAt: row.first_wake_at ?? null,
          handoffNote: row.handoff_note ?? null,
        }
      : null;
  },

  async rotateChannelSession(org, surfaceKey, newToken, at, handoffNote) {
    const handle = getDb();
    const existing = handle.prepare("SELECT generation FROM channel_session WHERE org_id = ? AND surface_key = ?").get(org, surfaceKey) as
      | { generation: number }
      | undefined;
    const generation = (existing?.generation ?? 0) + 1;
    const note = handoffNote ?? null;
    handle
      .prepare(
        `INSERT INTO channel_session (org_id, surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, handoff_note)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?)
         ON CONFLICT(org_id, surface_key) DO UPDATE SET
           token              = excluded.token,
           generation         = excluded.generation,
           created_at         = excluded.created_at,
           last_wake_at       = excluded.last_wake_at,
           turn_count         = 0,
           input_tokens_total = 0,
           first_wake_at      = NULL,
           handoff_note       = excluded.handoff_note`,
      )
      .run(org, surfaceKey, newToken, generation, at, at, note);
    return { org, surfaceKey, token: newToken, generation, createdAt: at, lastWakeAt: at, turnCount: 0, inputTokensTotal: 0, firstWakeAt: null, handoffNote: note };
  },

  async touchChannelSession(org, surfaceKey, at) {
    getDb()
      .prepare("UPDATE channel_session SET last_wake_at = ?, turn_count = turn_count + 1, first_wake_at = COALESCE(first_wake_at, ?) WHERE org_id = ? AND surface_key = ?")
      .run(at, at, org, surfaceKey);
  },

  async bumpChannelSessionUsage(org, surfaceKey, token, delta) {
    getDb()
      .prepare("UPDATE channel_session SET input_tokens_total = COALESCE(input_tokens_total, 0) + ? WHERE org_id = ? AND surface_key = ? AND token = ?")
      .run(delta, org, surfaceKey, token);
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

  async putUnifiedWakeTarget(org, wakeId, targetJson, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM unified_wake_target WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO unified_wake_target (org_id, wake_id, target_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (org_id, wake_id) DO UPDATE SET target_json = excluded.target_json, created_at = excluded.created_at`,
      )
      .run(org, wakeId, targetJson, at);
  },

  async getUnifiedWakeTarget(org, wakeId) {
    const row = getDb().prepare("SELECT target_json FROM unified_wake_target WHERE org_id = ? AND wake_id = ?").get(org, wakeId) as
      | { target_json: string }
      | undefined;
    return row?.target_json ?? null;
  },

  async putThreadOwner(org, channelKey, threadKey, taskToken, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM thread_ownership WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO thread_ownership (org_id, channel_key, thread_key, task_token, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, channel_key, thread_key) DO UPDATE SET task_token = excluded.task_token, created_at = excluded.created_at`,
      )
      .run(org, channelKey, threadKey, taskToken, at);
  },

  async getThreadOwner(org, channelKey, threadKey) {
    const row = getDb().prepare("SELECT task_token FROM thread_ownership WHERE org_id = ? AND channel_key = ? AND thread_key = ?").get(org, channelKey, threadKey) as
      | { task_token: string }
      | undefined;
    return row?.task_token ?? null;
  },

  async clearThreadOwner(org, channelKey, threadKey) {
    return getDb().prepare("DELETE FROM thread_ownership WHERE org_id = ? AND channel_key = ? AND thread_key = ?").run(org, channelKey, threadKey).changes > 0;
  },

  async putTaskResult(org, taskId, resultJson, at, ttlMs, callerToken) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM task_result WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO task_result (org_id, task_id, result_json, created_at, caller_token) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, task_id) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at, caller_token = excluded.caller_token`,
      )
      .run(org, taskId, resultJson, at, callerToken ?? null);
  },

  async putTaskResultIfAbsent(org, taskId, resultJson, at, ttlMs, callerToken) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM task_result WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    const info = handle
      .prepare(
        `INSERT INTO task_result (org_id, task_id, result_json, created_at, caller_token) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, task_id) DO NOTHING`,
      )
      .run(org, taskId, resultJson, at, callerToken ?? null);
    return info.changes > 0;
  },

  async getTaskResult(org, taskId) {
    const row = getDb().prepare("SELECT result_json FROM task_result WHERE org_id = ? AND task_id = ?").get(org, taskId) as
      | { result_json: string }
      | undefined;
    return row?.result_json ?? null;
  },

  async deleteTaskResult(org, taskId) {
    return getDb().prepare("DELETE FROM task_result WHERE org_id = ? AND task_id = ?").run(org, taskId).changes > 0;
  },

  async listUndeliveredTaskResults(org, callerToken, limit) {
    const rows = getDb()
      .prepare(
        `SELECT task_id, result_json, created_at FROM task_result
         WHERE org_id = ? AND caller_token = ? AND delivered_at IS NULL
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(org, callerToken, limit) as { task_id: string; result_json: string; created_at: string }[];
    return rows.map((r) => ({ taskId: r.task_id, resultJson: r.result_json, createdAt: r.created_at }));
  },

  async markTaskResultDelivered(org, taskId, at) {
    getDb()
      .prepare("UPDATE task_result SET delivered_at = ? WHERE org_id = ? AND task_id = ? AND delivered_at IS NULL")
      .run(at, org, taskId);
  },

  async putSlackAttachment(org, fileId, rec, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM slack_attachment WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO slack_attachment (org_id, file_id, url_private, mime_type, name, team_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, file_id) DO UPDATE SET
           url_private = excluded.url_private, mime_type = excluded.mime_type,
           name = excluded.name, team_id = excluded.team_id, created_at = excluded.created_at`,
      )
      .run(org, fileId, rec.urlPrivate, rec.mimeType ?? null, rec.name ?? null, rec.teamId ?? null, at);
  },

  async getSlackAttachment(org, fileId) {
    const row = getDb()
      .prepare("SELECT url_private, mime_type, name, team_id FROM slack_attachment WHERE org_id = ? AND file_id = ?")
      .get(org, fileId) as { url_private: string; mime_type: string | null; name: string | null; team_id: string | null } | undefined;
    if (!row) return null;
    const rec: SlackAttachmentRow = {
      urlPrivate: row.url_private,
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.team_id ? { teamId: row.team_id } : {}),
    };
    return rec;
  },

  async putStoredCredential(org, rec) {
    getDb()
      .prepare(
        `INSERT INTO stored_credential (org_id, ref, ciphertext, provider, domain, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, ref) DO UPDATE SET
           ciphertext = excluded.ciphertext, provider = excluded.provider,
           domain = excluded.domain, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(org, rec.ref, rec.ciphertext, rec.provider ?? null, rec.domain ?? null, rec.createdBy, rec.createdAt);
  },

  async getStoredCredential(org, ref) {
    const row = getDb()
      .prepare("SELECT ref, ciphertext, provider, domain, created_by, created_at FROM stored_credential WHERE org_id = ? AND ref = ?")
      .get(org, ref) as { ref: string; ciphertext: string; provider: string | null; domain: string | null; created_by: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      ref: row.ref,
      ciphertext: row.ciphertext,
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  },

  async claimStoredCredential(org, ref, claimId, claimedAtIso, staleBeforeIso) {
    const info = getDb()
      .prepare(
        `UPDATE stored_credential SET claim_id = ?, claimed_at = ?
         WHERE org_id = ? AND ref = ? AND (claim_id IS NULL OR claimed_at <= ?)`,
      )
      .run(claimId, claimedAtIso, org, ref, staleBeforeIso);
    return info.changes > 0;
  },

  async releaseStoredCredential(org, ref, claimId) {
    const info = getDb()
      .prepare("UPDATE stored_credential SET claim_id = NULL, claimed_at = NULL WHERE org_id = ? AND ref = ? AND claim_id = ?")
      .run(org, ref, claimId);
    return info.changes > 0;
  },

  async addCredentialIntake(row) {
    getDb()
      .prepare(
        `INSERT INTO credential_intake (org_id, id, ref, provider, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.org, row.id, row.ref, row.provider, row.domain ?? null, row.requestedBy, row.channelId, row.threadTs ?? null, row.createdAt, row.expiresAt, row.usedAt ?? null);
  },

  async getCredentialIntake(org, id) {
    const row = getDb()
      .prepare(
        "SELECT id, ref, provider, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at FROM credential_intake WHERE org_id = ? AND id = ?",
      )
      .get(org, id) as
      | { id: string; ref: string; provider: string; domain: string | null; requested_by: string; channel_id: string; thread_ts: string | null; created_at: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      org,
      id: row.id,
      ref: row.ref,
      provider: row.provider,
      ...(row.domain ? { domain: row.domain } : {}),
      requestedBy: row.requested_by,
      channelId: row.channel_id,
      ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.used_at ? { usedAt: row.used_at } : {}),
    };
  },

  async consumeCredentialIntake(org, id, usedAt) {
    const info = getDb()
      .prepare("UPDATE credential_intake SET used_at = ? WHERE org_id = ? AND id = ? AND used_at IS NULL")
      .run(usedAt, org, id);
    return info.changes > 0;
  },

  async addPendingAction(row) {
    getDb()
      .prepare(
        `INSERT INTO pending_actions
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.postedTo,
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
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND id = ?`,
      )
      .get(org, id) as PendingActionSqlRow | undefined;
    return row ? pendingActionFromRow(org, row) : null;
  },

  async listPendingActions(org) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(org) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
  },

  async listExpiredPendingActions(org, nowIso) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND status = 'pending' AND expires_at <= ? ORDER BY created_at ASC`,
      )
      .all(org, nowIso) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
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

  async getMeta(key) {
    const row = getDb().prepare("SELECT value FROM instance_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  },

  async setMeta(key, value) {
    getDb()
      .prepare(
        `INSERT INTO instance_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  },
};
