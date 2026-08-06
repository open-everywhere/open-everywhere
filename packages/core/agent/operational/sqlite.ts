import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Routine } from "../routines/routine.js";
import { assertSpendLimitAmount, assertDomainModelPick, routinePromptRevisionWrites, spendLedgerConjuncts, CAPTURE_MAX_RETENTION_MS, EVENT_DEDUPE_MAX_RETENTION_MS, type AuditChainRow, type AuditEntry, type AuditFilter, type CapLevel, type LinkChallengeRow, type LinkChallengeStatus, type LinkSetRow, type LinkSetStatus, type LinkedIdRow, type LinkedIdStatus, type OperationalStore, type SlackAttachmentRow, type SpendLedgerRow, type SpendLedgerWrite, type SpendLedgerFilter, type SpendTotals, type UsageEventEntry } from "./store.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";
import { auditRowSha } from "../audit/chain.js";
import { assembleAnalyticsSql } from "../analytics/compile.js";

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
  const spendCols = handle.prepare("SELECT name FROM pragma_table_info('spend_ledger')").all() as { name: string }[];
  if (spendCols.length > 0 && !spendCols.some((c) => c.name === "usd_micros")) handle.exec("DROP TABLE spend_ledger");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS spend_ledger (
      org_id             TEXT NOT NULL,
      surface_key        TEXT NOT NULL,
      principal_id       TEXT NOT NULL DEFAULT '',  -- '' = unattributed (PK columns can't be NULL)
      routine_id         TEXT NOT NULL DEFAULT '',  -- '' = not a routine turn
      model              TEXT NOT NULL DEFAULT '',  -- '' = no model (unstamped call; sandbox runtime)
      period             TEXT NOT NULL,             -- "YYYY-MM"
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      usd_micros         INTEGER NOT NULL DEFAULT 0, -- millionths of a dollar, priced at write
      calls              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, surface_key, principal_id, routine_id, model, period)
    );
    CREATE TABLE IF NOT EXISTS routine (
      org_id      TEXT NOT NULL,
      id          TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      data        TEXT NOT NULL,              -- JSON of the full Routine
      PRIMARY KEY (org_id, id)
    );
    -- APPEND-ONLY prompt history for the mutable routine row (OPE-242). Written by
    -- updateRoutine on a patch that REPLACES the prompt, never updated, never deleted, never
    -- pruned — see RoutinePromptRevisionRow in store.ts for why a routine's prompt history is an
    -- audit artefact (an edit revokes standing authority), why the log begins at the first EDIT
    -- rather than at creation, and for the retention position. Append-only here is BY CONTRACT
    -- only: sqlite has no RLS, so unlike Postgres (SELECT+INSERT policies under FORCE) nothing at
    -- the engine stops a rewrite. Same caveat audit_entry carries on this deprecated backend,
    -- stated rather than implied.
    CREATE TABLE IF NOT EXISTS routine_prompt_revisions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id      TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      routine_id  TEXT NOT NULL,
      prompt      TEXT NOT NULL,          -- the exact text the routine ran under
      generation  INTEGER,                -- the promptGeneration it ran under (joins routineGrantKey)
      authored_by TEXT,                   -- createdBy on the genesis row, the edit's requestedBy after
      armed_by    TEXT,                   -- the approver whose click armed it (never on genesis)
      approval_id TEXT,                   -- pending_actions.id of the card that armed it
      recorded_at TEXT NOT NULL           -- ISO-8601 (the routine's createdAt on the genesis row)
    );
    CREATE INDEX IF NOT EXISTS routine_prompt_revisions_org_surface_routine ON routine_prompt_revisions (org_id, surface_key, routine_id, seq);
    CREATE TABLE IF NOT EXISTS audit_entry (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      workspace    TEXT NOT NULL,
      surface      TEXT,
      principal_id TEXT,
      action       TEXT NOT NULL,
      detail       TEXT,                      -- JSON
      prev_sha     TEXT                       -- sha256 of the org's previous row (OPE-52 hash chain); NULL = genesis
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
    -- webhook_capture: the BOUNDED CAPTURE WINDOW (OPE-211 + OPE-184 Half 2). The only table here
    -- that holds bytes an outside party authored — see webhooks/capture-window.ts for what the
    -- document column is (the jq filter document, NOT the raw body) and why that is the safety
    -- property rather than a redaction step. Mutable + self-pruning, like event_dedupe: rows are
    -- swept on write and a whole window is cleared on re-arm. Never UPDATEd.
    -- (No backticks in this block: it is inside a template literal and one would close it.)
    CREATE TABLE IF NOT EXISTS webhook_capture (
      org_id      TEXT    NOT NULL,
      source      TEXT    NOT NULL,         -- the hook HANDLE a routine subscribes to (= the declared id)
      seq         INTEGER NOT NULL,         -- 1-based ordinal within the current window; the number a human says
      captured_at TEXT    NOT NULL,         -- ISO-8601 receive time (OUR clock; prune key)
      document    TEXT    NOT NULL,         -- serialized EventFilterDocument (opaque to the store)
      PRIMARY KEY (org_id, source, seq)
    );
    CREATE TABLE IF NOT EXISTS unified_wake_target (
      org_id           TEXT NOT NULL,
      wake_id          TEXT NOT NULL,         -- host-minted per-wake id (rides the wake envelope)
      target_json      TEXT NOT NULL,         -- serialized UnifiedWakeOrigin (opaque to the store)
      created_at       TEXT NOT NULL,         -- ISO-8601 (lexicographic = chronological; TTL prune key)
      window_token     TEXT,                  -- OPE-161: the BARE window token dispatched to; NULL = legacy row (never answerable via the pending arm)
      answered_at      TEXT,                  -- OPE-161: ISO-8601 when a reply answered this wake; NULL = still pending
      answered_turn_id TEXT,                  -- OPE-161: the turn that answered it (the same-turn re-accept key)
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
    -- webhook_capture_window (OPE-211, re-homed by OPE-224): the ONLY mutable state a DECLARED
    -- webhook has -- when its capture window closes and who opened it. Keyed by (org_id, hook_id):
    -- a hook id is unique within an org's config, unlike the deleted chat-created class's ids which
    -- were globally-unique URL segments and therefore keyed on the bare id. Nothing here is secret
    -- and nothing here is authority -- the hook's identity, posture and read grant are re-read from
    -- the config registry at arm and at delivery time. See the postgres twin.
    CREATE TABLE IF NOT EXISTS webhook_capture_window (
      org_id        TEXT NOT NULL,
      hook_id       TEXT NOT NULL,             -- the DECLARED hook's id (= webhook_capture.source)
      capture_until TEXT NOT NULL,             -- ISO-8601, already clamped by the arming path
      armed_by      TEXT NOT NULL,
      armed_at      TEXT NOT NULL,
      PRIMARY KEY (org_id, hook_id)
    );
    -- github_installation (scm/installations.ts): owner → installation id, learned from the App's own
    -- signature-verified "installation" webhook so a new org installing the App self-registers instead
    -- of needing an OE_GITHUB_INSTALLATIONS env edit + redeploy. NOT a secret (an installation id is a
    -- public routing number; the App private key stays in env). The env map is composed OVER these
    -- rows — env stays authoritative, this only augments.
    CREATE TABLE IF NOT EXISTS github_installation (
      org_id               TEXT NOT NULL,
      owner                TEXT NOT NULL,     -- installation.account.login (the SCM map's key)
      installation_id      TEXT NOT NULL,     -- installation.id, stringified
      account_type         TEXT,              -- "Organization" | "User" (diagnostics)
      repository_selection TEXT,              -- "all" | "selected" (refreshed by installation_repositories)
      updated_at           TEXT NOT NULL,     -- ISO-8601 of the delivery that last wrote this row
      PRIMARY KEY (org_id, owner)
    );
    -- pr_session_approval (OPE-53): the "Approve for session" grant on a pr.open card. Keyed by the
    -- bare session/window token (embeds the generation ⇒ the memo dies with the session). Scoped to
    -- kind="pr.open" by the callers. NEVER holds PR content — only who granted the skip + when.
    CREATE TABLE IF NOT EXISTS pr_session_approval (
      org_id     TEXT NOT NULL,
      session_id TEXT NOT NULL,               -- the bare session/window token of the granting turn
      kind       TEXT NOT NULL,               -- always "pr.open" (the only session-skippable kind)
      granted_by TEXT NOT NULL,               -- the member who clicked "Approve for session"
      created_at TEXT NOT NULL,               -- ISO-8601
      expires_at TEXT NOT NULL,               -- ISO-8601 GC bound (prune-on-write); death is via session_id
      PRIMARY KEY (org_id, session_id, kind)
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
    -- APPEND-ONLY content history for domain_skill (OPE-237). Written by putDomainSkill on
    -- every write, never updated, never deleted, never pruned — see DomainSkillRevisionRow in
    -- store.ts for why a domain skill's history is an audit artefact, and for the retention
    -- position. Append-only here is BY CONTRACT only: sqlite has no RLS, so unlike Postgres
    -- (SELECT+INSERT policies under FORCE) nothing at the engine stops a rewrite. That is the
    -- same caveat audit_entry carries on this deprecated backend, stated rather than implied.
    CREATE TABLE IF NOT EXISTS domain_skill_revisions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id      TEXT NOT NULL,
      domain      TEXT NOT NULL,
      name        TEXT NOT NULL,
      content     TEXT NOT NULL,          -- the exact body written to domain_skill
      authored_by TEXT,                   -- authoring principalId, when known
      armed_by    TEXT,                   -- the approver whose click armed it, when known
      approval_id TEXT,                   -- pending_actions.id of the card that armed it
      recorded_at TEXT NOT NULL           -- ISO-8601 (= the live row's updated_at)
    );
    CREATE INDEX IF NOT EXISTS domain_skill_revisions_org_domain_name ON domain_skill_revisions (org_id, domain, name, seq);
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
      routine_id         TEXT,                 -- OPE-145: set iff kind = "routine"
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      model              TEXT,
      detail             TEXT                  -- JSON
    );
    CREATE INDEX IF NOT EXISTS usage_events_org_session ON usage_events (org_id, session_id);
    CREATE INDEX IF NOT EXISTS usage_events_org_surface_ts ON usage_events (org_id, surface_key, ts);
    -- identity link-sets (P1): the three tables behind DB-backed cross-surface identity. See the
    -- LinkSetRow section in store.ts for what they are, and the postgres twin for the RLS half.
    -- Read-write (a person severs an account, an admin suspends a set); the immutable HISTORY is
    -- audit_entry, which identity/link-store.ts appends on every mutation. The handle column is
    -- DISPLAY ONLY -- no index, no uniqueness, no lookup -- because a name/handle join is exactly the
    -- attacker-controllable merge the fail-closed-on-merge doctrine forbids.
    CREATE TABLE IF NOT EXISTS identity_link_sets (
      org_id     TEXT NOT NULL,
      id         TEXT NOT NULL,               -- opaque, host-minted; the ONLY join key for a set
      handle     TEXT NOT NULL,               -- DISPLAY ONLY: admin lists + audit rows
      status     TEXT NOT NULL,               -- active | suspended | revoked ("revoked" is terminal)
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, id)
    );
    -- PRIMARY KEY (org_id, platform, native_id) IS the "an account is exactly one person"
    -- invariant -- assertPrincipalsValid's rule, moved from config load to write time.
    CREATE TABLE IF NOT EXISTS identity_linked_ids (
      org_id         TEXT NOT NULL,
      platform       TEXT NOT NULL,
      native_id      TEXT NOT NULL,
      link_set_id    TEXT NOT NULL,
      status         TEXT NOT NULL,           -- suggested | confirmed | revoked ("revoked" terminal)
      established_by TEXT NOT NULL,           -- "challenge:<id>" | "config-import" | "directory-sync:<p>"
      evidence       TEXT,                    -- structured evidence record as JSON; opaque here
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (org_id, platform, native_id)
    );
    CREATE INDEX IF NOT EXISTS identity_linked_ids_org_set ON identity_linked_ids (org_id, link_set_id);
    -- The proof-of-control nonce ledger. nonce_hash is a sha-256 -- the RAW code is NEVER stored,
    -- so a copy of this file yields no usable codes. Single-use is the pending-only claim CAS.
    CREATE TABLE IF NOT EXISTS identity_link_challenges (
      org_id                 TEXT NOT NULL,
      id                     TEXT NOT NULL,
      nonce_hash             TEXT NOT NULL,   -- sha-256 hex of the uppercased code; NEVER the code
      initiating_platform    TEXT NOT NULL,
      initiating_native_id   TEXT NOT NULL,
      initiating_surface_key TEXT NOT NULL,   -- the DM the ratification must come back to
      claimed_platform       TEXT,            -- stamped from the WAKE's own captured author
      claimed_native_id      TEXT,
      claimed_at             TEXT,
      status                 TEXT NOT NULL,   -- pending | claimed | ratified | denied | expired
      created_at             TEXT NOT NULL,
      expires_at             TEXT NOT NULL,
      decided_at             TEXT,
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS identity_link_challenges_org_nonce ON identity_link_challenges (org_id, nonce_hash);
    -- identity_oauth_vault_grants (C.3): the per-(link-set, connector, account) shared-vault
    -- ratification. A row = this account consented (from its own DM) to reach the link-set's shared
    -- user-OAuth token for this connector. PK is the whole tuple (consent is never blanket); the
    -- sever/revoke cascade DELETEs it so a re-join starts unratified (threat (h)).
    CREATE TABLE IF NOT EXISTS identity_oauth_vault_grants (
      org_id         TEXT NOT NULL,
      link_set_id    TEXT NOT NULL,
      connector      TEXT NOT NULL,
      platform       TEXT NOT NULL,
      native_id      TEXT NOT NULL,
      established_at TEXT NOT NULL,
      PRIMARY KEY (org_id, link_set_id, connector, platform, native_id)
    );
    CREATE INDEX IF NOT EXISTS identity_oauth_vault_grants_org_account ON identity_oauth_vault_grants (org_id, platform, native_id);
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

    "ALTER TABLE unified_wake_target ADD COLUMN window_token TEXT",
    "ALTER TABLE unified_wake_target ADD COLUMN answered_at TEXT",
    "ALTER TABLE unified_wake_target ADD COLUMN answered_turn_id TEXT",

    "ALTER TABLE pending_actions ADD COLUMN posted_to TEXT",

    "ALTER TABLE stored_credential ADD COLUMN claim_id TEXT",
    "ALTER TABLE stored_credential ADD COLUMN claimed_at TEXT",

    "ALTER TABLE audit_entry ADD COLUMN prev_sha TEXT",

    "ALTER TABLE usage_events ADD COLUMN routine_id TEXT",
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

export function sqliteOperationalDbPath(): string {
  return dbPath();
}

export function sqliteOperationalTableNames(): string[] {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('memory_file', 'memory_tier') ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function _resetOperationalDbForTest(): void {
  if (db) db.close();
  db = null;
  openedPath = null;
}

type SpendLedgerDbRow = {
  org_id: string;
  surface_key: string;
  principal_id: string;
  routine_id: string;
  model: string;
  period: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd_micros: number;
  calls: number;
};

function spendRowFrom(r: SpendLedgerDbRow): SpendLedgerRow {
  return {
    org: r.org_id,
    surfaceKey: r.surface_key,
    principalId: r.principal_id,
    routineId: r.routine_id,
    model: r.model,
    period: r.period,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    usdMicros: r.usd_micros,
    calls: r.calls,
  };
}

type UsageEventRow = {
  surface_key: string;
  session_id: string;
  principal_id: string | null;
  ts: string;
  kind: string | null;
  routine_id: string | null;
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
    ...(r.routine_id ? { routineId: r.routine_id } : {}),
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

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

type LinkSetSqliteRow = { id: string; handle: string; status: string; created_at: string; updated_at: string };

function linkSetFromSqliteRow(org: string, r: LinkSetSqliteRow): LinkSetRow {
  return { org, id: r.id, handle: r.handle, status: r.status as LinkSetStatus, createdAt: r.created_at, updatedAt: r.updated_at };
}

const LINKED_ID_SQLITE_SELECT = "SELECT platform, native_id, link_set_id, status, established_by, evidence, created_at, updated_at FROM identity_linked_ids";

type LinkedIdSqliteRow = {
  platform: string;
  native_id: string;
  link_set_id: string;
  status: string;
  established_by: string;
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

function linkedIdFromSqliteRow(org: string, r: LinkedIdSqliteRow): LinkedIdRow {
  return {
    org,
    linkSetId: r.link_set_id,
    platform: r.platform,
    nativeId: r.native_id,
    status: r.status as LinkedIdStatus,
    establishedBy: r.established_by,
    ...(r.evidence === null ? {} : { evidenceJson: r.evidence }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const LINK_CHALLENGE_SQLITE_SELECT =
  `SELECT id, nonce_hash, initiating_platform, initiating_native_id, initiating_surface_key,
          claimed_platform, claimed_native_id, claimed_at, status, created_at, expires_at, decided_at
   FROM identity_link_challenges`;

type LinkChallengeSqliteRow = {
  id: string;
  nonce_hash: string;
  initiating_platform: string;
  initiating_native_id: string;
  initiating_surface_key: string;
  claimed_platform: string | null;
  claimed_native_id: string | null;
  claimed_at: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

function linkChallengeFromSqliteRow(org: string, r: LinkChallengeSqliteRow): LinkChallengeRow {
  return {
    org,
    id: r.id,
    nonceHash: r.nonce_hash,
    initiatingPlatform: r.initiating_platform,
    initiatingNativeId: r.initiating_native_id,
    initiatingSurfaceKey: r.initiating_surface_key,
    ...(r.claimed_platform === null ? {} : { claimedPlatform: r.claimed_platform }),
    ...(r.claimed_native_id === null ? {} : { claimedNativeId: r.claimed_native_id }),
    ...(r.claimed_at === null ? {} : { claimedAt: r.claimed_at }),
    status: r.status as LinkChallengeStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
  };
}

export const sqliteOperationalStore: OperationalStore = {
  id: "sqlite",
  root: dbPath,

  async recordSpend(org, write: SpendLedgerWrite) {
    getDb()
      .prepare(
        `INSERT INTO spend_ledger
           (org_id, surface_key, principal_id, routine_id, model, period,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_micros, calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(org_id, surface_key, principal_id, routine_id, model, period) DO UPDATE SET
           input_tokens       = input_tokens       + excluded.input_tokens,
           output_tokens      = output_tokens      + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           usd_micros         = usd_micros         + excluded.usd_micros,
           calls              = calls + 1`,
      )
      .run(
        org,
        write.surfaceKey,
        write.principalId ?? "",
        write.routineId ?? "",
        write.model ?? "",
        write.period,
        write.inputTokens ?? 0,
        write.outputTokens ?? 0,
        write.cacheReadTokens ?? 0,
        write.cacheWriteTokens ?? 0,
        write.usdMicros ?? 0,
      );
  },

  async spendTotals(org, filter: SpendLedgerFilter = {}): Promise<SpendTotals> {
    const { conjuncts, params } = spendLedgerConjuncts(filter);
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(usd_micros), 0) AS usd_micros,
                COALESCE(SUM(calls), 0) AS calls
         FROM spend_ledger WHERE ${["org_id = ?", ...conjuncts].join(" AND ")}`,
      )
      .get(org, ...params) as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd_micros: number; calls: number };
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      usdMicros: row.usd_micros,
      calls: row.calls,
    };
  },

  async listSpendLedger(org?: string) {
    const rows = (
      org !== undefined
        ? getDb().prepare("SELECT * FROM spend_ledger WHERE org_id = ?").all(org)
        : getDb().prepare("SELECT * FROM spend_ledger").all()
    ) as SpendLedgerDbRow[];
    return rows.map(spendRowFrom);
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

  async updateRoutine(org, surfaceKey, id, patch, provenance) {
    const handle = getDb();
    const row = handle.prepare("SELECT data FROM routine WHERE org_id = ? AND id = ? AND surface_key = ?").get(org, id, surfaceKey) as
      | { data: string }
      | undefined;
    if (!row) return null;
    const existing = JSON.parse(row.data) as Routine;
    const updated: Routine = { ...existing, ...patch, id: existing.id, org: existing.org, surfaceKey: existing.surfaceKey };
    if (patch.prompt !== undefined && patch.prompt !== existing.prompt) {
      const prior = handle
        .prepare("SELECT 1 FROM routine_prompt_revisions WHERE org_id = ? AND surface_key = ? AND routine_id = ? LIMIT 1")
        .get(org, surfaceKey, id);
      const writes = routinePromptRevisionWrites({
        existing,
        updated,
        ...(provenance ? { provenance } : {}),
        hasPriorRevisions: prior !== undefined,
        nowIso: new Date().toISOString(),
      });
      const insert = handle.prepare(
        `INSERT INTO routine_prompt_revisions (org_id, surface_key, routine_id, prompt, generation, authored_by, armed_by, approval_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of writes) {
        insert.run(org, surfaceKey, id, w.prompt, w.generation, w.authoredBy ?? null, w.armedBy ?? null, w.approvalId ?? null, w.recordedAt);
      }
    }
    handle.prepare("UPDATE routine SET data = ? WHERE org_id = ? AND id = ?").run(JSON.stringify(updated), org, id);
    return updated;
  },

  async listRoutinePromptRevisions(org, surfaceKey, routineId) {
    const rows = getDb()
      .prepare(
        `SELECT seq, routine_id, prompt, generation, authored_by, armed_by, approval_id, recorded_at
         FROM routine_prompt_revisions
         WHERE org_id = ? AND surface_key = ? AND (? IS NULL OR routine_id = ?)
         ORDER BY seq`,
      )
      .all(org, surfaceKey, routineId ?? null, routineId ?? null) as {
      seq: number;
      routine_id: string;
      prompt: string;
      generation: number | null;
      authored_by: string | null;
      armed_by: string | null;
      approval_id: string | null;
      recorded_at: string;
    }[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      org,
      surfaceKey,
      routineId: r.routine_id,
      prompt: r.prompt,
      ...(r.generation === null ? {} : { generation: Number(r.generation) }),
      ...(r.authored_by ? { authoredBy: r.authored_by } : {}),
      ...(r.armed_by ? { armedBy: r.armed_by } : {}),
      ...(r.approval_id ? { approvalId: r.approval_id } : {}),
      recordedAt: r.recorded_at,
    }));
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
    const handle = getDb();
    const last = handle
      .prepare(
        `SELECT ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha
         FROM audit_entry WHERE org_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(entry.org) as
      | { ts: string; org_id: string; platform: string; workspace: string; surface: string | null; principal_id: string | null; action: string; detail: string | null; prev_sha: string | null }
      | undefined;
    const prevSha = last
      ? auditRowSha(
          {
            org: last.org_id,
            ts: last.ts,
            platform: last.platform,
            workspace: last.workspace,
            ...(last.surface ? { surface: last.surface } : {}),
            ...(last.principal_id ? { principalId: last.principal_id } : {}),
            action: last.action,
            ...(last.detail ? { detail: JSON.parse(last.detail) as Record<string, unknown> } : {}),
          },
          last.prev_sha,
        )
      : null;
    handle
      .prepare(
        `INSERT INTO audit_entry (ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        prevSha,
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

  async listAuditOrgs() {
    const rows = getDb().prepare("SELECT DISTINCT org_id FROM audit_entry ORDER BY org_id").all() as { org_id: string }[];
    return rows.map((r) => r.org_id);
  },

  async readAuditChain(org, opts) {
    const tail = opts?.tailLimit;
    const sql =
      tail && tail > 0
        ? `SELECT * FROM (
             SELECT seq, ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha
             FROM audit_entry WHERE org_id = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`
        : `SELECT seq, ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha
           FROM audit_entry WHERE org_id = ? ORDER BY seq ASC`;
    const rows = getDb()
      .prepare(sql)
      .all(...(tail && tail > 0 ? [org, tail] : [org])) as {
      seq: number;
      ts: string;
      org_id: string;
      platform: string;
      workspace: string;
      surface: string | null;
      principal_id: string | null;
      action: string;
      detail: string | null;
      prev_sha: string | null;
    }[];
    return rows.map(
      (r): AuditChainRow => ({
        seq: Number(r.seq),
        ts: r.ts,
        org: r.org_id,
        platform: r.platform,
        workspace: r.workspace,
        ...(r.surface ? { surface: r.surface } : {}),
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        action: r.action,
        ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
        prevSha: r.prev_sha,
      }),
    );
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
    const note = handoffNote ?? null;
    const row = handle
      .prepare(
        `INSERT INTO channel_session (org_id, surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, handoff_note)
         VALUES (?, ?, ?, 1, ?, ?, 0, 0, NULL, ?)
         ON CONFLICT(org_id, surface_key) DO UPDATE SET
           token              = excluded.token,
           generation         = generation + 1,
           created_at         = excluded.created_at,
           last_wake_at       = excluded.last_wake_at,
           turn_count         = 0,
           input_tokens_total = 0,
           first_wake_at      = NULL,
           handoff_note       = excluded.handoff_note
         RETURNING generation`,
      )
      .get(org, surfaceKey, newToken, at, at, note) as { generation: number };
    const generation = row.generation;
    return { org, surfaceKey, token: newToken, generation, createdAt: at, lastWakeAt: at, turnCount: 0, inputTokensTotal: 0, firstWakeAt: null, handoffNote: note };
  },

  async touchChannelSession(org, surfaceKey, at) {
    getDb()
      .prepare("UPDATE channel_session SET last_wake_at = ?, turn_count = turn_count + 1, first_wake_at = COALESCE(first_wake_at, ?) WHERE org_id = ? AND surface_key = ?")
      .run(at, at, org, surfaceKey);
  },

  async bumpChannelSessionUsage(org, surfaceKey, token, delta) {
    const res = getDb()
      .prepare("UPDATE channel_session SET input_tokens_total = COALESCE(input_tokens_total, 0) + ? WHERE org_id = ? AND surface_key = ? AND token = ?")
      .run(delta, org, surfaceKey, token);
    return Number(res.changes ?? 0);
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

  async putDomainSkill(org, domain, name, content, updatedBy, updatedAt, provenance) {
    getDb()
      .prepare(
        `INSERT INTO domain_skill_revisions (org_id, domain, name, content, authored_by, armed_by, approval_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(org, domain, name, content, updatedBy ?? null, provenance?.armedBy ?? null, provenance?.approvalId ?? null, updatedAt);
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

  async listDomainSkillRevisions(org, domain, name) {
    const rows = getDb()
      .prepare(
        `SELECT seq, name, content, authored_by, armed_by, approval_id, recorded_at
         FROM domain_skill_revisions
         WHERE org_id = ? AND domain = ? AND (? IS NULL OR name = ?)
         ORDER BY seq`,
      )
      .all(org, domain, name ?? null, name ?? null) as {
      seq: number;
      name: string;
      content: string;
      authored_by: string | null;
      armed_by: string | null;
      approval_id: string | null;
      recorded_at: string;
    }[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      org,
      domain,
      name: r.name,
      content: r.content,
      ...(r.authored_by ? { authoredBy: r.authored_by } : {}),
      ...(r.armed_by ? { armedBy: r.armed_by } : {}),
      ...(r.approval_id ? { approvalId: r.approval_id } : {}),
      recordedAt: r.recorded_at,
    }));
  },

  async appendUsageEvent(entry) {
    getDb()
      .prepare(
        `INSERT INTO usage_events
           (org_id, surface_key, session_id, principal_id, ts, kind, routine_id,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.org,
        entry.surfaceKey,
        entry.sessionId,
        entry.principalId ?? null,
        entry.ts,
        entry.kind ?? null,
        entry.routineId ?? null,
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
        `SELECT surface_key, session_id, principal_id, ts, kind, routine_id,
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
        `SELECT surface_key, principal_id, kind, routine_id, model,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM usage_events WHERE ${where.join(" AND ")}
         GROUP BY surface_key, principal_id, kind, routine_id, model`,
      )
      .all(...params) as {
      surface_key: string;
      principal_id: string | null;
      kind: string | null;
      routine_id: string | null;
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
      ...(r.routine_id ? { routineId: r.routine_id } : {}),
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

  async runAnalyticsQuery(compiled) {
    const { sql, params } = assembleAnalyticsSql(compiled, "qmark");
    return getDb().prepare(sql).all(...(params as (string | number | null)[])) as Record<string, unknown>[];
  },

  async markEventSeen(org, key, at, ttlMs) {
    const handle = getDb();
    const atMs = Date.parse(at);
    const ttlCutoff = new Date(atMs - ttlMs).toISOString();
    const maxCutoff = new Date(atMs - EVENT_DEDUPE_MAX_RETENTION_MS).toISOString();
    handle
      .prepare("DELETE FROM event_dedupe WHERE org_id = ? AND (seen_at < ? OR (key = ? AND seen_at < ?))")
      .run(org, maxCutoff, key, ttlCutoff);
    const info = handle.prepare("INSERT OR IGNORE INTO event_dedupe (org_id, key, seen_at) VALUES (?, ?, ?)").run(org, key, at);
    return info.changes > 0;
  },

  async captureDelivery(org, source, documentJson, at, captureUntil, maxRows) {
    const handle = getDb();
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return false;
    const maxCutoff = new Date(atMs - CAPTURE_MAX_RETENTION_MS).toISOString();
    handle.prepare("DELETE FROM webhook_capture WHERE org_id = ? AND captured_at < ?").run(org, maxCutoff);
    const untilMs = Date.parse(captureUntil);
    if (!Number.isFinite(untilMs) || atMs >= untilMs) return false;
    const row = handle
      .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS maxSeq FROM webhook_capture WHERE org_id = ? AND source = ?")
      .get(org, source) as { n: number; maxSeq: number };
    if (row.n >= maxRows) return false;
    handle
      .prepare("INSERT INTO webhook_capture (org_id, source, seq, captured_at, document) VALUES (?, ?, ?, ?, ?)")
      .run(org, source, row.maxSeq + 1, at, documentJson);
    return true;
  },

  async listCapturedDeliveries(org, source, limit) {
    const rows = getDb()
      .prepare("SELECT seq, captured_at, document FROM webhook_capture WHERE org_id = ? AND source = ? ORDER BY seq ASC LIMIT ?")
      .all(org, source, limit) as { seq: number; captured_at: string; document: string }[];
    return rows.map((r) => ({ seq: r.seq, capturedAt: r.captured_at, documentJson: r.document }));
  },

  async clearCapturedDeliveries(org, source) {
    getDb().prepare("DELETE FROM webhook_capture WHERE org_id = ? AND source = ?").run(org, source);
  },

  async putUnifiedWakeTarget(org, wakeId, targetJson, at, ttlMs, windowToken) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM unified_wake_target WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO unified_wake_target (org_id, wake_id, target_json, created_at, window_token) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, wake_id) DO UPDATE SET target_json = excluded.target_json, created_at = excluded.created_at, window_token = excluded.window_token`,
      )
      .run(org, wakeId, targetJson, at, windowToken ?? null);
  },

  async getUnifiedWakeTarget(org, wakeId) {
    const row = getDb().prepare("SELECT target_json FROM unified_wake_target WHERE org_id = ? AND wake_id = ?").get(org, wakeId) as
      | { target_json: string }
      | undefined;
    return row?.target_json ?? null;
  },

  async getUnifiedWakeRecord(org, wakeId) {
    const row = getDb()
      .prepare("SELECT target_json, created_at, window_token, answered_at, answered_turn_id FROM unified_wake_target WHERE org_id = ? AND wake_id = ?")
      .get(org, wakeId) as
      | { target_json: string; created_at: string; window_token: string | null; answered_at: string | null; answered_turn_id: string | null }
      | undefined;
    if (!row) return null;
    return {
      targetJson: row.target_json,
      createdAt: row.created_at,
      ...(row.window_token !== null ? { windowToken: row.window_token } : {}),
      ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
      ...(row.answered_turn_id !== null ? { answeredTurnId: row.answered_turn_id } : {}),
    };
  },

  async markUnifiedWakeAnswered(org, wakeId, at, turnId) {
    getDb()
      .prepare("UPDATE unified_wake_target SET answered_at = ?, answered_turn_id = ? WHERE org_id = ? AND wake_id = ?")
      .run(at, turnId ?? null, org, wakeId);
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

  async putGitHubInstallation(org, rec) {
    getDb()
      .prepare(
        `INSERT INTO github_installation (org_id, owner, installation_id, account_type, repository_selection, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, owner) DO UPDATE SET installation_id = excluded.installation_id,
           account_type = excluded.account_type, repository_selection = excluded.repository_selection,
           updated_at = excluded.updated_at`,
      )
      .run(org, rec.owner, rec.installationId, rec.accountType ?? null, rec.repositorySelection ?? null, rec.updatedAt);
  },

  async deleteGitHubInstallation(org, owner) {
    return getDb().prepare("DELETE FROM github_installation WHERE org_id = ? AND owner = ?").run(org, owner).changes > 0;
  },

  async listGitHubInstallations(org) {
    const rows = getDb()
      .prepare("SELECT owner, installation_id, account_type, repository_selection, updated_at FROM github_installation WHERE org_id = ? ORDER BY owner ASC")
      .all(org) as { owner: string; installation_id: string; account_type: string | null; repository_selection: string | null; updated_at: string }[];
    return rows.map((r) => ({
      owner: r.owner,
      installationId: r.installation_id,
      ...(r.account_type ? { accountType: r.account_type } : {}),
      ...(r.repository_selection ? { repositorySelection: r.repository_selection } : {}),
      updatedAt: r.updated_at,
    }));
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

  async armWebhookCaptureWindow(org, hookId, captureUntil, armedBy, at) {
    getDb()
      .prepare(
        `INSERT INTO webhook_capture_window (org_id, hook_id, capture_until, armed_by, armed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org_id, hook_id) DO UPDATE SET capture_until = excluded.capture_until, armed_by = excluded.armed_by, armed_at = excluded.armed_at`,
      )
      .run(org, hookId, captureUntil, armedBy, at);
  },

  async getWebhookCaptureWindow(org, hookId) {
    const row = getDb()
      .prepare("SELECT hook_id, capture_until, armed_by, armed_at FROM webhook_capture_window WHERE org_id = ? AND hook_id = ?")
      .get(org, hookId) as { hook_id: string; capture_until: string; armed_by: string; armed_at: string } | undefined;
    return row ? { hookId: row.hook_id, captureUntil: row.capture_until, armedBy: row.armed_by, armedAt: row.armed_at } : null;
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

  async setSessionApproval(row) {
    const db = getDb();
    db.prepare("DELETE FROM pr_session_approval WHERE org_id = ? AND expires_at <= ?").run(row.org, row.createdAt);
    db.prepare(
      `INSERT INTO pr_session_approval (org_id, session_id, kind, granted_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, session_id, kind) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).run(row.org, row.sessionId, row.kind, row.grantedBy, row.createdAt, row.expiresAt);
  },

  async getSessionApproval(org, sessionId, kind, nowIso) {
    const row = getDb()
      .prepare("SELECT session_id, kind, granted_by, created_at, expires_at FROM pr_session_approval WHERE org_id = ? AND session_id = ? AND kind = ? AND expires_at > ?")
      .get(org, sessionId, kind, nowIso) as { session_id: string; kind: string; granted_by: string; created_at: string; expires_at: string } | undefined;
    if (!row) return null;
    return { org, sessionId: row.session_id, kind: row.kind, grantedBy: row.granted_by, createdAt: row.created_at, expiresAt: row.expires_at };
  },

  async listSessionApprovals(org, sessionId, nowIso) {
    const rows = getDb()
      .prepare(
        "SELECT session_id, kind, granted_by, created_at, expires_at FROM pr_session_approval WHERE org_id = ? AND session_id = ? AND expires_at > ? ORDER BY kind ASC",
      )
      .all(org, sessionId, nowIso) as { session_id: string; kind: string; granted_by: string; created_at: string; expires_at: string }[];
    return rows.map((r) => ({ org, sessionId: r.session_id, kind: r.kind, grantedBy: r.granted_by, createdAt: r.created_at, expiresAt: r.expires_at }));
  },

  async revokeSessionApprovals(org, sessionId) {
    return Number(getDb().prepare("DELETE FROM pr_session_approval WHERE org_id = ? AND session_id = ?").run(org, sessionId).changes);
  },

  async putLinkSet(org, row) {
    getDb()
      .prepare(
        `INSERT INTO identity_link_sets (org_id, id, handle, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, id) DO UPDATE SET handle = excluded.handle, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(org, row.id, row.handle, row.status, row.createdAt, row.updatedAt);
  },

  async getLinkSet(org, id) {
    const row = getDb().prepare("SELECT id, handle, status, created_at, updated_at FROM identity_link_sets WHERE org_id = ? AND id = ?").get(org, id) as
      | LinkSetSqliteRow
      | undefined;
    return row ? linkSetFromSqliteRow(org, row) : null;
  },

  async listLinkSets(org) {
    const rows = getDb().prepare("SELECT id, handle, status, created_at, updated_at FROM identity_link_sets WHERE org_id = ? ORDER BY id ASC").all(org) as LinkSetSqliteRow[];
    return rows.map((r) => linkSetFromSqliteRow(org, r));
  },

  async updateLinkSetStatus(org, id, from, to, at) {
    const changes = getDb()
      .prepare(`UPDATE identity_link_sets SET status = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status IN (${placeholders(from.length)})`)
      .run(to, at, org, id, ...from).changes;
    return Number(changes) > 0;
  },

  async insertLinkedId(org, row) {
    const changes = getDb()
      .prepare(
        `INSERT INTO identity_linked_ids (org_id, platform, native_id, link_set_id, status, established_by, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, platform, native_id) DO NOTHING`,
      )
      .run(org, row.platform, row.nativeId, row.linkSetId, row.status, row.establishedBy, row.evidenceJson ?? null, row.createdAt, row.updatedAt).changes;
    return Number(changes) > 0;
  },

  async getLinkedId(org, platform, nativeId) {
    const row = getDb()
      .prepare(`${LINKED_ID_SQLITE_SELECT} WHERE org_id = ? AND platform = ? AND native_id = ?`)
      .get(org, platform, nativeId) as LinkedIdSqliteRow | undefined;
    return row ? linkedIdFromSqliteRow(org, row) : null;
  },

  async listLinkedIds(org, linkSetId) {
    const sql = `${LINKED_ID_SQLITE_SELECT} WHERE org_id = ?${linkSetId === undefined ? "" : " AND link_set_id = ?"} ORDER BY platform ASC, native_id ASC`;
    const rows = (linkSetId === undefined ? getDb().prepare(sql).all(org) : getDb().prepare(sql).all(org, linkSetId)) as LinkedIdSqliteRow[];
    return rows.map((r) => linkedIdFromSqliteRow(org, r));
  },

  async updateLinkedIdStatus(org, platform, nativeId, from, to, establishedBy, evidenceJson, at) {
    const changes = getDb()
      .prepare(
        `UPDATE identity_linked_ids SET status = ?, established_by = ?, evidence = ?, updated_at = ?
         WHERE org_id = ? AND platform = ? AND native_id = ? AND status IN (${placeholders(from.length)})`,
      )
      .run(to, establishedBy, evidenceJson ?? null, at, org, platform, nativeId, ...from).changes;
    return Number(changes) > 0;
  },

  async deleteLinkedId(org, platform, nativeId) {
    return Number(getDb().prepare("DELETE FROM identity_linked_ids WHERE org_id = ? AND platform = ? AND native_id = ?").run(org, platform, nativeId).changes) > 0;
  },

  async revokeLinkedIdsForSet(org, linkSetId, at) {
    return Number(
      getDb().prepare("UPDATE identity_linked_ids SET status = 'revoked', updated_at = ? WHERE org_id = ? AND link_set_id = ? AND status <> 'revoked'").run(at, org, linkSetId).changes,
    );
  },

  async addLinkChallenge(org, row) {
    getDb()
      .prepare(
        `INSERT INTO identity_link_challenges
           (org_id, id, nonce_hash, initiating_platform, initiating_native_id, initiating_surface_key,
            claimed_platform, claimed_native_id, claimed_at, status, created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        org,
        row.id,
        row.nonceHash,
        row.initiatingPlatform,
        row.initiatingNativeId,
        row.initiatingSurfaceKey,
        row.claimedPlatform ?? null,
        row.claimedNativeId ?? null,
        row.claimedAt ?? null,
        row.status,
        row.createdAt,
        row.expiresAt,
        row.decidedAt ?? null,
      );
  },

  async getLinkChallenge(org, id) {
    const row = getDb().prepare(`${LINK_CHALLENGE_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as LinkChallengeSqliteRow | undefined;
    return row ? linkChallengeFromSqliteRow(org, row) : null;
  },

  async listLinkChallenges(org, filter) {
    const conjuncts = ["org_id = ?"];
    const params: string[] = [org];
    if (filter?.initiatingPlatform !== undefined) {
      conjuncts.push("initiating_platform = ?");
      params.push(filter.initiatingPlatform);
    }
    if (filter?.initiatingNativeId !== undefined) {
      conjuncts.push("initiating_native_id = ?");
      params.push(filter.initiatingNativeId);
    }
    if (filter?.status !== undefined) {
      conjuncts.push("status = ?");
      params.push(filter.status);
    }
    const rows = getDb()
      .prepare(`${LINK_CHALLENGE_SQLITE_SELECT} WHERE ${conjuncts.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params) as LinkChallengeSqliteRow[];
    return rows.map((r) => linkChallengeFromSqliteRow(org, r));
  },

  async claimLinkChallenge(org, nonceHash, platform, nativeId, at) {
    const db = getDb();
    const changes = db
      .prepare(
        `UPDATE identity_link_challenges SET claimed_platform = ?, claimed_native_id = ?, claimed_at = ?, status = 'claimed'
         WHERE org_id = ? AND nonce_hash = ? AND status = 'pending' AND expires_at > ?
           AND NOT (initiating_platform = ? AND initiating_native_id = ?)`,
      )
      .run(platform, nativeId, at, org, nonceHash, at, platform, nativeId).changes;
    if (Number(changes) === 0) return null;
    const row = db.prepare(`${LINK_CHALLENGE_SQLITE_SELECT} WHERE org_id = ? AND nonce_hash = ? AND claimed_at = ?`).get(org, nonceHash, at) as LinkChallengeSqliteRow | undefined;
    return row ? linkChallengeFromSqliteRow(org, row) : null;
  },

  async decideLinkChallenge(org, id, from, to, at) {
    const ttlConjunct = to === "ratified" ? " AND expires_at > ?" : "";
    const args = to === "ratified" ? [to, at, org, id, ...from, at] : [to, at, org, id, ...from];
    const changes = getDb()
      .prepare(`UPDATE identity_link_challenges SET status = ?, decided_at = ? WHERE org_id = ? AND id = ? AND status IN (${placeholders(from.length)})${ttlConjunct}`)
      .run(...args).changes;
    return Number(changes) > 0;
  },

  async expireLinkChallenges(org, nowIso) {
    return Number(
      getDb()
        .prepare("UPDATE identity_link_challenges SET status = 'expired', decided_at = ? WHERE org_id = ? AND status IN ('pending', 'claimed') AND expires_at <= ?")
        .run(nowIso, org, nowIso).changes,
    );
  },

  async putOauthVaultGrant(org, row) {
    getDb()
      .prepare(
        `INSERT INTO identity_oauth_vault_grants (org_id, link_set_id, connector, platform, native_id, established_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, link_set_id, connector, platform, native_id) DO NOTHING`,
      )
      .run(org, row.linkSetId, row.connector, row.platform, row.nativeId, row.establishedAt);
  },

  async getOauthVaultGrant(org, linkSetId, connector, platform, nativeId) {
    const r = getDb()
      .prepare(
        `SELECT link_set_id, connector, platform, native_id, established_at FROM identity_oauth_vault_grants
         WHERE org_id = ? AND link_set_id = ? AND connector = ? AND platform = ? AND native_id = ?`,
      )
      .get(org, linkSetId, connector, platform, nativeId) as
      | { link_set_id: string; connector: string; platform: string; native_id: string; established_at: string }
      | undefined;
    return r ? { org, linkSetId: r.link_set_id, connector: r.connector, platform: r.platform, nativeId: r.native_id, establishedAt: r.established_at } : null;
  },

  async deleteOauthVaultGrant(org, linkSetId, connector, platform, nativeId) {
    return (
      Number(
        getDb()
          .prepare("DELETE FROM identity_oauth_vault_grants WHERE org_id = ? AND link_set_id = ? AND connector = ? AND platform = ? AND native_id = ?")
          .run(org, linkSetId, connector, platform, nativeId).changes,
      ) > 0
    );
  },

  async deleteOauthVaultGrantsForAccount(org, platform, nativeId) {
    return Number(
      getDb().prepare("DELETE FROM identity_oauth_vault_grants WHERE org_id = ? AND platform = ? AND native_id = ?").run(org, platform, nativeId).changes,
    );
  },

  async deleteOauthVaultGrantsForSet(org, linkSetId) {
    return Number(getDb().prepare("DELETE FROM identity_oauth_vault_grants WHERE org_id = ? AND link_set_id = ?").run(org, linkSetId).changes);
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
