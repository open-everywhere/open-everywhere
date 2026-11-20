import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Routine } from "../routines/routine.js";
import { asSurfaceMode, readThreadSeatStateValue, auditSurfaceMode, auditReadOrg, auditDetailKeys, likePrefixPattern, argKeyNeedle, assertIngressDeliveryRetainUntil, assertSpendLimitAmount, assertDomainModelPick, assertHaltAddress, haltAddressColumns, haltAddressFromColumns, framePromoterId, promoterListField, proactiveAddressRow, routinePromptRevisionWrites, ROUTINE_GUARDED_WRITE_ATTEMPTS, spendLedgerConjuncts, CAPTURE_MAX_RETENTION_MS, EVENT_DEDUPE_MAX_RETENTION_MS, PROMOTER_LIST_MAX, type AuditChainRow, type AuditEntry, type ChannelSessionRuntimeStamp, type AuditFilter, type CapLevel, type ClaimedIngressDelivery, type DueIngressDelivery, type LinkChallengeRow, type LinkChallengeStatus, type LinkSetRow, type LinkSetStatus, type LinkedIdRow, type LinkedIdStatus, type OperationalStore, type RoutinePromptProvenance, type SlackAttachmentRow, type SpendLedgerRow, type SpendLedgerWrite, type SpendLedgerFilter, type SpendTotals, type SurfaceMode, type TurnAnchorRow, type UsageEventEntry, type ModelCallCaptureWrite, type ModelCallCaptureRow, type ModelCallCaptureSessionRow, type MemoryProposalRow, type MemoryProposalWrite, type DmAudienceRow, type PersonOptOutRow, type PersonalBrowserRow, type PersonalWatchRow, type PersonalCoverRow, type QuestionLedgerRow, ATTENTION_COLUMNS, attentionPruneBefore, attentionRowFrom, type AttentionDbRow, DM_RULE_COLUMNS, dmRuleRowFrom, type DmRuleDbRow } from "./store.js";
import { grantBorrowColumnsProblem, grantFrozenArgsDigest, grantJsonColumn, grantJsonFromColumn, grantRefundTurnOrdinal } from "./credential-grant-rows.js";
import type { CredentialGrantAskRow, CredentialGrantAskState, CredentialGrantMode, CredentialGrantRow, CredentialGrantState } from "./credential-grant-rows.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";
import { CONNECTOR_OP_KIND_PREFIX, ROUTINE_PERMISSION_PREFIX } from "../approvals/session-grant.js";
import { CONVERSATION_SUMMARY_PARTITION, parseConversationSummary, SESSION_TAIL_MAX_ENTRIES, type SessionTailEntry } from "../channels/session-tail.js";
import type { ModelReasoning } from "../memory/domain.js";
import { AUDIT_CHAIN_EPOCH_ACTION, auditEpochDetail, auditEpochSealFor, auditRowSha, withOrgAuditLock } from "../audit/chain.js";
import { assembleAnalyticsSql } from "../analytics/compile.js";
import { buildExitDelete, buildExitSelectDistinct, buildExitSelectPage } from "../exit/sql.js";

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
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const spendCols = handle.prepare("SELECT name FROM pragma_table_info('spend_ledger')").all() as { name: string }[];
  if (spendCols.length > 0 && !spendCols.some((c) => c.name === "usd_micros_measured")) handle.exec("DROP TABLE spend_ledger");
  const linkedIdCols = handle.prepare("SELECT name FROM pragma_table_info('identity_linked_ids')").all() as { name: string }[];
  const needsLinkedIdTenantRebuild = linkedIdCols.length > 0 && !linkedIdCols.some((c) => c.name === "tenant");
  if (needsLinkedIdTenantRebuild) {
    handle.exec("DROP INDEX IF EXISTS identity_linked_ids_org_set; ALTER TABLE identity_linked_ids RENAME TO identity_linked_ids__pre_tenant;");
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS spend_ledger (
      org_id             TEXT NOT NULL,
      surface_key        TEXT NOT NULL,
      principal_id       TEXT NOT NULL DEFAULT '',  -- '' = unattributed (PK columns can't be NULL)
      routine_id         TEXT NOT NULL DEFAULT '',  -- '' = not a routine turn
      model              TEXT NOT NULL DEFAULT '',  -- '' = no model (unstamped call; sandbox runtime)
      period             TEXT NOT NULL,             -- "YYYY-MM"
      -- OPE-1862 (mirrored in the ALTER list below): WHICH KIND OF CONVERSATION this row's spend
      -- happened in — 'dm' | 'mpim' | 'channel', or '' when nothing stamped it. The anti-doxxing
      -- mask reads THIS and never the shape of a surface id, so Discord and Teams DMs mask exactly
      -- as Slack's do. Deliberately OUTSIDE the primary key: a surface's mode never changes, so
      -- keying on it would split a month for nothing — and would force the table drop an additive
      -- column avoids.
      surface_mode       TEXT NOT NULL DEFAULT '',
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      -- OPE-1611 (mirrored in the ALTER list below): reasoning tokens, ATTRIBUTION only. No rate
      -- table names a reasoning rate, so this never reaches usd_micros and no cap sees it.
      reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
      usd_micros         INTEGER NOT NULL DEFAULT 0, -- millionths of a dollar, DERIVED at write from the rate table (what caps sum)
      -- OPE-369: the GATEWAY's own billed figure for these same calls, when it published one.
      -- 0 on a cost_source='derived' row. Never read by a cap — see store.ts's CostSource section.
      usd_micros_measured INTEGER NOT NULL DEFAULT 0,
      cost_source        TEXT NOT NULL DEFAULT 'derived', -- 'measured' | 'derived'; in the PK so a row is homogeneous
      calls              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, surface_key, principal_id, routine_id, model, period, cost_source)
    );
    -- OPE-1677: the PERIOD index the primary key cannot be. The bounded spend reads are shaped
    -- "WHERE org_id = ? AND period ..." (spendLedgerConjuncts in store.ts). period is the SIXTH
    -- primary-key column, and a btree bounds its scan only up to the first column the query
    -- leaves unconstrained -- so the automatic primary-key index bounds on org_id, and everything
    -- after it is a per-row test over every row the org ever wrote. This index puts period
    -- second, which makes the range a plan-level narrowing rather than a transfer saving. It
    -- matters most on the "/oe budget raise" domain scan, which answers a Discord interaction
    -- inside 3 seconds. This statement is also the MIGRATION: the CREATE block runs on every
    -- database open, so an existing file builds the index in place, with no drop-and-recreate.
    CREATE INDEX IF NOT EXISTS spend_ledger_org_period ON spend_ledger (org_id, period);
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
      generation  INTEGER,                -- the promptGeneration it ran under (joins routinePermissionKey)
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
      surface_mode TEXT,                      -- OPE-1866: the conversation the surface names; NULL = unclassified, which MASKS
      principal_id TEXT,
      action       TEXT NOT NULL,
      detail       TEXT,                      -- JSON
      prev_sha     TEXT                       -- sha256 of the org's previous row (OPE-52 hash chain); NULL = genesis
    );
    CREATE INDEX IF NOT EXISTS audit_org_ts ON audit_entry (org_id, ts);
    CREATE TABLE IF NOT EXISTS spend_limit (
      org_id        TEXT NOT NULL,
      scope_key     TEXT NOT NULL,
      level         TEXT NOT NULL,            -- "surface" | "workspace" | "domain" | "user" (free-text, no CHECK — see store.ts CapLevel)
      monthly_tokens INTEGER NOT NULL,        -- -1 = no token component (legacy NOT NULL; see setSpendLimit)
      monthly_usd   REAL,                     -- NULL = no USD component
      expires_at    INTEGER,                  -- epoch ms; NULL = no auto-expiry
      reason        TEXT,
      set_by        TEXT,
      PRIMARY KEY (org_id, scope_key, level)
    );
    CREATE TABLE IF NOT EXISTS halt (
      org_id     TEXT    NOT NULL,
      level      TEXT    NOT NULL,            -- "" on an org-wide row: FILLER, never an address (store.ts haltAddressColumns)
      scope_key  TEXT    NOT NULL,            -- "" on an org-wide row, same reason
      org_wide   INTEGER NOT NULL,            -- 1 = the org-wide MARKER; the column every match branches on first
      active     INTEGER NOT NULL,            -- 1 = halted; a cleared row stays for the trail
      set_by     TEXT,
      set_at     TEXT    NOT NULL,            -- ISO-8601
      set_ref    TEXT,                        -- host wake owning a chat-set halt; NULL for operator/legacy rows
      cleared_by TEXT,
      cleared_at TEXT,                        -- ISO-8601; NULL until a resume clears it
      PRIMARY KEY (org_id, level, scope_key, org_wide)
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
      engaged_by    TEXT,                       -- SEPARATOR-FRAMED list of the ids of events that PROMOTED this row, most recent last, bounded; a re-promotion from ANY id the list holds never clears stopped (store.ts PROMOTER_SEP)
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
      input_tokens_total INTEGER,                    -- measured cumulative inputTokens (cache reads included, counted once) this generation; NULL = unknown ⇒ rotate
      first_wake_at      TEXT,                        -- ISO-8601 of the first delivered wake (H7c); NULL = none yet ⇒ still fresh
      last_input_tokens  INTEGER,                     -- OPE-794: measured inputTokens (cache reads included) of the LATEST request (SET, not summed); NULL = none yet ⇒ rung skipped
      rotate_marked_at   TEXT,                        -- OPE-820: ISO-8601 an operator marked this generation for retirement; NULL = unmarked. Set ONLY by the ops sweep; cleared by every rotation
      served_code_fingerprint   TEXT,                  -- OPE-1821: the runtime CODE hash this seat was last served with; NULL = never stamped. Written ONLY by stampChannelSessionRuntime, and deliberately NOT reset by a rotation
      served_domain_fingerprint TEXT,                  -- OPE-1821: the DOMAIN declaration hash this seat was last served with. Same writer, same NULL meaning — the pair moves together
      PRIMARY KEY (org_id, surface_key)
    );
    -- session_tail (OPE-794): the standing-seat TAIL ring. One row per recorded conversational
    -- event on ONE generation — the wake messages the deployment delivered and the posts the seat
    -- made. The rotate leg reads the OUTGOING generation's rows and renders them into the fresh
    -- generation's first wake. Keyed by the generation's live TOKEN, so a straggler write from a
    -- retired generation files under the retired token and is simply never read again.
    -- Bounded on write (channels/session-tail.ts SESSION_TAIL_MAX_ENTRIES) and dropped once carried.
    -- EXCEPT the DM conversation summary (OPE-2431): ONE row per DM seat under the reserved token
    -- 'oe-dm-summary', a JSON array of up to 200 entries, that only the next rotation overwrites.
    -- Nothing deletes it, so it holds DM text for the life of the seat.
    CREATE TABLE IF NOT EXISTS session_tail (
      org_id      TEXT    NOT NULL,
      surface_key TEXT    NOT NULL,        -- the channel_session registry key this generation lives under
      token       TEXT    NOT NULL,        -- the generation's continuation token (the read + prune key)
      seq         INTEGER NOT NULL,        -- insertion ordinal within the token; ties broken by the at column at render
      at          TEXT    NOT NULL,        -- ISO-8601 of the event (the ORDERING key the render sorts on)
      entry_json  TEXT    NOT NULL,        -- serialized SessionTailEntry (opaque to the store)
      PRIMARY KEY (org_id, surface_key, token, seq)
    );
    CREATE TABLE IF NOT EXISTS event_dedupe (
      org_id  TEXT NOT NULL,
      key     TEXT NOT NULL,                  -- Slack event_id (or channel:ts fallback)
      seen_at TEXT NOT NULL,                  -- ISO-8601 (lexicographic = chronological)
      PRIMARY KEY (org_id, key)
    );
    -- Durable provider inbox. The verified signer id is part of the immutable delivery identity;
    -- payload_json contains a versioned provider envelope but never the raw signature or secret.
    -- Pending rows have retain_until NULL and survive arbitrarily long outages. Completion erases
    -- payload_json and starts the bounded tombstone clock in the SAME fenced UPDATE.
    CREATE TABLE IF NOT EXISTS ingress_delivery (
      org_id       TEXT NOT NULL,
      source       TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      delivery_id  TEXT NOT NULL,
      payload_json TEXT,
      received_at  TEXT NOT NULL,
      available_at TEXT NOT NULL,
      claim_id     TEXT,
      claimed_at   TEXT,
      completed_at TEXT,
      retain_until TEXT,
      PRIMARY KEY (org_id, source, authority_id, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS ingress_delivery_due ON ingress_delivery (org_id, source, completed_at, available_at, claimed_at);
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
      inbound          INTEGER,               -- OPE-767: 1 = this wake carries a real message from the room; NULL/0 = a wake the deployment minted for itself
      audited_at       TEXT,                  -- OPE-836: ISO-8601 when the turn-end wake-accounting audit considered this wake; NULL = not yet audited. Read ONLY by listUnauditedUnifiedWakes.
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
    CREATE TABLE IF NOT EXISTS thread_seat_state (
      org_id       TEXT NOT NULL,
      channel_key  TEXT NOT NULL,              -- the container (unifiedThreadRef.channelKey)
      thread_key   TEXT NOT NULL,              -- the thread within it (unifiedThreadRef.threadKey)
      seat_token   TEXT NOT NULL,              -- the thread seat's own window token
      parent_key   TEXT NOT NULL,              -- the PARENT seat's channel_session registry key
      state        TEXT NOT NULL,              -- 'open' | 'completed' | 'expired' | 'closed'
      origin_json  TEXT NOT NULL,              -- the thread's own wake origin (UnifiedWakeOrigin JSON)
      report       TEXT,                       -- the seat's closing report, in its own words
      opened_at    TEXT NOT NULL,              -- ISO-8601 of the spawn
      updated_at   TEXT NOT NULL,              -- ISO-8601 (lexicographic = chronological; TTL prune key)
      PRIMARY KEY (org_id, channel_key, thread_key)
    );
    CREATE TABLE IF NOT EXISTS turn_anchor (
      org_id      TEXT NOT NULL,
      window_key  TEXT NOT NULL,              -- the continuation token / window this turn belongs to
      anchor_key  TEXT,                       -- "<platform>:<channelId>:<messageId>" where the surface knows it
      channel_key TEXT,                       -- "<platform>:<channelId>" — the slash-command arm (NOT unique)
      session_id  TEXT NOT NULL,              -- → attachSession(session_id)
      turn_id     TEXT NOT NULL,              -- → cancel({turnId})
      surface_key TEXT NOT NULL,
      created_at  TEXT NOT NULL,              -- ISO-8601 (lexicographic = chronological; TTL prune key)
      PRIMARY KEY (org_id, window_key)
    );
    -- An org-scoped, TTL-pruned, OPAQUE key-value scratch table. The NAME is historical (see the
    -- store interface's note): minted for the deleted roll-own delegation regime, now shared by the
    -- retired native-subagent marker rows, the question bridge and the task-wake join, each under its own
    -- key prefix.
    CREATE TABLE IF NOT EXISTS task_result (
      org_id       TEXT NOT NULL,
      task_id      TEXT NOT NULL,             -- the consumer's own namespaced key
      result_json  TEXT NOT NULL,             -- opaque to the store; each consumer owns its shape
      created_at   TEXT NOT NULL,             -- ISO-8601 (lexicographic = chronological; TTL prune key)
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
      connector  TEXT,                        -- label only (audit/admin views), never the value
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
      connector    TEXT NOT NULL,             -- label shown in the modal
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
    -- of needing a "github.installations" settings edit + redeploy. NOT a secret (an installation id is a
    -- public routing number; the App private key stays in env). The settings map is composed OVER
    -- these rows — the settings stay authoritative, this only augments.
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
    -- bare session/window token (embeds the generation ⇒ the memo dies with the generation or its TTL). Scoped to
    -- kind="pr.open" by the callers. NEVER holds PR content — only who granted the skip + when.
    CREATE TABLE IF NOT EXISTS pr_session_approval (
      org_id     TEXT NOT NULL,
      session_id TEXT NOT NULL,               -- the bare session/window token of the granting turn
      kind       TEXT NOT NULL,               -- always "pr.open" (the only session-skippable kind)
      granted_by TEXT NOT NULL,               -- the member who clicked "Approve for session"
      created_at TEXT NOT NULL,               -- ISO-8601
      expires_at TEXT NOT NULL,               -- ISO-8601 TTL, a real bound: reads filter expires_at > now (OPE-2161)
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
      group_key    TEXT,                      -- the proposing session (OPE-2434); NULL = never grouped
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
      detail             TEXT,                 -- JSON
      -- OPE-1611 (mirrored in the ALTER list below): the cache/reasoning ATTRIBUTION pair. Both
      -- NULLABLE on purpose — NULL is "the source reported nothing", a different fact from a
      -- reported zero, and keeping the two apart is the whole point of the dimension.
      -- OPE-1862 (mirrored in the ALTER list below): the conversation this event happened in —
      -- 'dm' | 'mpim' | 'channel'; NULL = unstamped. The kind column above cannot answer this: a routine,
      -- supervisor or subagent turn wins that tag before the DM test runs, so a routine fired in a
      -- DM is stamped kind 'routine'. Reports mask an unstamped row rather than guess.
      surface_mode       TEXT,
      cache_tokens_reported INTEGER,           -- 1 = the call reported a cache split; 0 = it did not; NULL = never asked
      reasoning_tokens   INTEGER,              -- NULL = unreported; a number (0 included) = reported
      -- OPE-369 (mirrored in the ALTER list below, which is what an existing DB takes)
      usd_micros_measured INTEGER,             -- the gateway's billed figure for THIS call; NULL = nothing measured it
      cost_source        TEXT,                 -- 'measured' | 'derived'; NULL on pre-migration/non-model rows
      delegation_depth   INTEGER,              -- 0 = root turn, 1 = direct child, 2 = two-or-more hops (a BAND — see store.ts)
      root_session_id    TEXT                  -- top of this call's delegation chain (its own session id on a root turn)
    );
    CREATE INDEX IF NOT EXISTS usage_events_org_session ON usage_events (org_id, session_id);
    CREATE INDEX IF NOT EXISTS usage_events_org_surface_ts ON usage_events (org_id, surface_key, ts);
    -- OPE-2435: the per-tool usage ledger (spend/tool-usage.ts). Append-only like usage_events, and
    -- pruned with it. IDS AND COUNTS ONLY: never a tool's arguments or its output.
    CREATE TABLE IF NOT EXISTS tool_usage (
      seq                INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id             TEXT NOT NULL,
      ts                 TEXT NOT NULL,        -- ISO-8601
      surface_key        TEXT NOT NULL,
      surface_mode       TEXT,                 -- 'dm' | 'mpim' | 'channel'; NULL = unstamped (masked)
      principal_id       TEXT,
      session_id         TEXT NOT NULL,
      event              TEXT NOT NULL,        -- 'call' | 'card'
      tool               TEXT NOT NULL,
      connector          TEXT NOT NULL DEFAULT '',  -- '' = not a connector op
      outcome            TEXT NOT NULL DEFAULT '',  -- 'ok' | 'error' | 'rejected'; '' on a card
      model              TEXT,
      input_tokens       INTEGER NOT NULL DEFAULT 0,  -- an ATTRIBUTED share (see store.ts ToolUsageEntry)
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tool_usage_org_ts ON tool_usage (org_id, ts);
    -- OPE-2550: room discovery reads one room at a time.
    CREATE INDEX IF NOT EXISTS tool_usage_org_surface_ts ON tool_usage (org_id, surface_key, ts);
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
    -- PRIMARY KEY (org_id, platform, tenant, native_id) IS the "an account is exactly one person"
    -- invariant -- assertPrincipalsValid's rule, moved from config load to write time. tenant joined
    -- the key in OPE-309 phase 2: on a tenant-scoped platform a person id is issued PER WORKSPACE, so
    -- the 3-column key made two workspaces' members one row -- i.e. one person. See the postgres twin
    -- and identity/link-tenant.ts. SQLite cannot ALTER a PRIMARY KEY, so an existing table crosses over
    -- by the rename-and-copy rebuild either side of this exec (needsLinkedIdTenantRebuild).
    CREATE TABLE IF NOT EXISTS identity_linked_ids (
      org_id         TEXT NOT NULL,
      platform       TEXT NOT NULL,
      tenant         TEXT NOT NULL DEFAULT '', -- OPE-309: '' = vendor-global platform, or not yet backfilled
      native_id      TEXT NOT NULL,
      link_set_id    TEXT NOT NULL,
      status         TEXT NOT NULL,           -- suggested | confirmed | revoked ("revoked" terminal)
      established_by TEXT NOT NULL,           -- "challenge:<id>" | "config-import" | "directory-sync:<p>"
      evidence       TEXT,                    -- structured evidence record as JSON; opaque here
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (org_id, platform, tenant, native_id)
    );
    CREATE INDEX IF NOT EXISTS identity_linked_ids_org_set ON identity_linked_ids (org_id, link_set_id);
    -- The proof-of-control nonce ledger. nonce_hash is a sha-256 -- the RAW code is NEVER stored,
    -- so a copy of this file yields no usable codes. Single-use is the pending-only claim CAS.
    CREATE TABLE IF NOT EXISTS identity_link_challenges (
      org_id                 TEXT NOT NULL,
      id                     TEXT NOT NULL,
      nonce_hash             TEXT NOT NULL,   -- sha-256 hex of the uppercased code; NEVER the code
      initiating_platform    TEXT NOT NULL,
      initiating_tenant      TEXT NOT NULL DEFAULT '', -- OPE-309; '' off a tenant-scoped platform
      initiating_native_id   TEXT NOT NULL,
      initiating_surface_key TEXT NOT NULL,   -- the DM the ratification must come back to
      claimed_platform       TEXT,            -- stamped from the WAKE's own captured author
      claimed_tenant         TEXT,            -- ...in the same CAS, so a claimed row names a whole account
      claimed_native_id      TEXT,
      claimed_at             TEXT,
      transport              TEXT NOT NULL DEFAULT 'code', -- OPE-617; code | directory
      target_platform        TEXT,            -- the directory transport's NAMED target ...
      target_tenant          TEXT,            -- ...matched inside the consent CAS, so a consent
      target_native_id       TEXT,            -- ...from any other account matches no row
      back_nonce_hash        TEXT,            -- sha-256 of code-2; its PRESENCE forces the code-back
      status                 TEXT NOT NULL,   -- pending | claimed | ratified | denied | expired
      created_at             TEXT NOT NULL,
      expires_at             TEXT NOT NULL,
      decided_at             TEXT,
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS identity_link_challenges_org_nonce ON identity_link_challenges (org_id, nonce_hash);
    -- credential_grant_ask (OPE-1060): one person's REQUEST for another person's credential, pending
    -- the owner's answer in their own DM. The purpose is MODEL-AUTHORED and is stored as data -- every
    -- reader renders it escaped and quoted. Single-answer is the pending-only approve CAS.
    CREATE TABLE IF NOT EXISTS credential_grant_ask (
      org_id                 TEXT NOT NULL,
      id                     TEXT NOT NULL,
      requester_principal_id TEXT NOT NULL,
      owner_principal_id     TEXT NOT NULL,
      owner_slug             TEXT NOT NULL,   -- the eventual tool name's owner segment, PINNED here
      owner_platform         TEXT NOT NULL,   -- where the owner's card is delivered
      owner_native_id        TEXT NOT NULL,   -- the bare platform id the DM arm addresses
      connector              TEXT NOT NULL,
      verb                   TEXT NOT NULL,   -- the vendor tool SLUGIFIED, as a name segment; a label, never the wire name
      resource               TEXT NOT NULL,   -- the host-composed DISPLAY LABEL, holding model-authored text and the frozen VALUES
      mcp_tool               TEXT,            -- OPE-1136: the vendor MCP tool, in the vendor's exact bytes
      frozen_args            TEXT,            -- OPE-1136: canonical JSON; '{}' is "nothing frozen", NULL is "no borrow"
      tool_name              TEXT,            -- OPE-1136: the full mounted name, PINNED here with the ordinal
      scope_key              TEXT NOT NULL,   -- the CHAT this would serve (the session id)
      domain_scope_key       TEXT,            -- OPE-1950: the room's domain-shaped seat key; a STANDING grant binds here instead
      purpose                TEXT NOT NULL,   -- model-authored; untrusted content
      requester_target       TEXT,            -- JSON ReplyTarget: where the owner's answer is reported back
      card_surface_id        TEXT,            -- where the owner's card landed -- the lapse sweep rewrites it
      card_message_id        TEXT,
      requested_mode         TEXT NOT NULL,   -- once | session | standing
      status                 TEXT NOT NULL,   -- pending | approved | declined | expired
      created_at             TEXT NOT NULL,
      expires_at             TEXT NOT NULL,   -- the ASK's own short TTL, NOT the grant's
      decided_at             TEXT,
      grant_id               TEXT,            -- stamped by the approve CAS
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS credential_grant_ask_org_scope ON credential_grant_ask (org_id, scope_key);
    -- credential_grant (OPE-1060): the owner-approved grant a chat spends. The tier is decided ONCE at
    -- mint -- from the verb definition on the registry path, from classifyConnectorOpTier on the
    -- OPE-1136 borrow path -- and is never re-derived from the mounted tool name (a grant__… name
    -- carries a person's handle where a classifier looks for a verb).
    -- Rows are NEVER deleted: the mount projects every row for a scope and the broker refuses on
    -- state, so a removed row would make a tool vanish mid-plan instead of refusing.
    -- 🔴 NO UNIQUE INDEX ON (org_id, scope_key, tool_name), and the reason is stated once here
    -- (OPE-1136). Uniqueness inside one chat is held by the ORDINAL: nextGrantBorrowToolName reads
    -- every row in the scope, dead ones included, and picks the lowest free ordinal. The only hole
    -- that leaves is two asks composing at the same instant, and the mount-side dedupe closes that
    -- one. A unique index would ALSO refuse a write, and it would start doing so before any writer
    -- of tool_name exists to be tested against it -- so the constraint waits for the transport
    -- slice, where a real writer can be proven against it.
    CREATE TABLE IF NOT EXISTS credential_grant (
      org_id                 TEXT NOT NULL,
      id                     TEXT NOT NULL,
      ask_id                 TEXT NOT NULL,
      requester_principal_id TEXT NOT NULL,
      owner_principal_id     TEXT NOT NULL,
      owner_slug             TEXT NOT NULL,   -- the mounted name's owner segment, PINNED at mint
      connector              TEXT NOT NULL,
      verb                   TEXT NOT NULL,
      resource               TEXT NOT NULL,
      mcp_tool               TEXT,            -- OPE-1136: the vendor MCP tool, in the vendor's exact bytes
      frozen_args            TEXT,            -- OPE-1136: canonical JSON; '{}' is "nothing frozen", NULL is "no borrow"
      tool_name              TEXT,            -- OPE-1136: the full mounted name, copied from the ask
      input_schema           TEXT,            -- OPE-1136: the post-bake schema snapshot, taken at approve
      scope_key              TEXT NOT NULL,
      mode                   TEXT NOT NULL,   -- once | session | standing
      tier                   TEXT NOT NULL,   -- read | write | destructive, pinned at mint
      status                 TEXT NOT NULL,   -- active | used | revoked | expired
      purpose                TEXT NOT NULL,   -- model-authored; untrusted content
      created_at             TEXT NOT NULL,
      expires_at             TEXT NOT NULL,
      used_at                TEXT,
      revoked_at             TEXT,
      refund_turn            TEXT,            -- OPE-1264: the turn key the refund count below belongs to
      refund_turn_seq        INTEGER,         -- OPE-1281: that key's eve turn ordinal; only a LATER one rolls the count
      refund_count           INTEGER NOT NULL DEFAULT 0, -- OPE-1264: refunds already claimed on that turn
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS credential_grant_org_scope ON credential_grant (org_id, scope_key);
    -- notice_claim: LIFETIME at-most-once claims (store.ts claimNotice), four key families. NO TTL
    -- and NO DELETE at all, on purpose: the one thing it records is "this already happened", and
    -- dropping that would make an announcement periodic and a recorded reaction repeatable. Every
    -- family is bounded by the thing it records (one room, one grant, one reaction), never by the
    -- number of ships. Two families are traffic-derived; store.ts's own section states what bounds
    -- each. The fifth family, OPE-1751's runtime-rotation claim, was the one entry that grew per
    -- ship per standing seat, and OPE-1821 retired it with the sweep it needed.
    CREATE TABLE IF NOT EXISTS notice_claim (
      org_id     TEXT NOT NULL,
      key        TEXT NOT NULL,
      claimed_at TEXT NOT NULL,                -- ISO-8601
      PRIMARY KEY (org_id, key)
    );
    -- proactive_address (OPE-887): where this deployment may reach somebody with no live turn.
    -- UPSERTED, never appended — one row per (platform, kind, ref_key), re-stamped by every inbound
    -- activity, so a moved serviceUrl region corrects itself. The address column is a provider-shaped
    -- JSON bag core never reads inside. No TTL: see store.ts's PROACTIVE ADDRESSES section.
    CREATE TABLE IF NOT EXISTS proactive_address (
      org_id     TEXT NOT NULL,
      platform   TEXT NOT NULL,
      kind       TEXT NOT NULL,                -- the provider's own record species
      ref_key    TEXT NOT NULL,                -- the provider's own key inside (platform, kind)
      tenant     TEXT NOT NULL,                -- "" when the platform has no tenant
      address    TEXT NOT NULL,                -- provider-shaped JSON
      updated_at TEXT NOT NULL,                -- ISO-8601
      PRIMARY KEY (org_id, platform, kind, ref_key)
    );
    -- model_call_capture (OPE-846): the soak tests' byte-exact model-call recorder. MUTABLE and
    -- deliberately so — retention here is an explicit delete-by-session, not a TTL (store.ts's
    -- MODEL-CALL CAPTURE section carries the whole posture). Written only while soak.capture is
    -- armed; a deployment that never arms it never grows a row. body_gzip_b64 is gzip(body)
    -- base64'd, TRANSCRIPT-GRADE: it holds the composed prompt verbatim. Never logged.
    CREATE TABLE IF NOT EXISTS model_call_capture (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id         TEXT NOT NULL,
      surface_key    TEXT NOT NULL,             -- spend grain (domainKeyOf), joins to usage_events
      session_id     TEXT NOT NULL,             -- eve's durable session id (wrun_…)
      turn_id        TEXT NOT NULL,             -- eve turn id; '' when none was resolvable
      step_index     INTEGER NOT NULL,          -- 0-based, within the turn
      ts             TEXT NOT NULL,             -- ISO-8601
      model          TEXT NOT NULL,             -- the id the router resolved for THIS call
      provider       TEXT NOT NULL,
      schema_version INTEGER NOT NULL,          -- serialised-shape version (replay validates on read)
      sha256         TEXT NOT NULL,             -- sha256 of the UNCOMPRESSED body
      body_bytes     INTEGER NOT NULL,          -- uncompressed length
      body_gzip_b64  TEXT NOT NULL,             -- '' when truncated
      truncated      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS model_call_capture_org_session ON model_call_capture (org_id, session_id, seq);
    -- memory_proposal (OPE-957): the dream cycle's proposal review queue, moved off the audit log
    -- (store.ts's MEMORY PROPOSALS section carries the whole posture). MUTABLE, like
    -- model_call_capture — a store holding member text needs a real erasure path.
    CREATE TABLE IF NOT EXISTS memory_proposal (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      scope        TEXT NOT NULL,
      summary      TEXT NOT NULL,
      before_text  TEXT,
      after_text   TEXT,
      detail_json  TEXT,
      principal_id TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_proposal_org ON memory_proposal (org_id, id);
    -- dm_audience (OPE-1064 tier P2): who this deployment may START a direct message with, and
    -- whether they have stopped it. Two nullable timestamps and no content — store.ts's DM AUDIENCE
    -- section carries the whole posture, including why the key is the grant's own ARN-like address.
    -- attention_state (OPE-2433): one row per session that reported a typed state with update_status —
    -- the "what waits on me" read, and the once-per-episode ping when a session is blocked.
    CREATE TABLE IF NOT EXISTS attention_state (
      org_id          TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      state           TEXT NOT NULL,     -- working|needs_input|blocked|done
      summary         TEXT NOT NULL,     -- the status line, clipped host-side
      surface_key     TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      thread_ts       TEXT,
      person_platform TEXT,              -- the person the session works for; NULL = no principal
      person_id       TEXT,
      since           TEXT NOT NULL,     -- when the CURRENT state began
      updated_at      TEXT NOT NULL,
      pinged_since    TEXT,              -- the since of the blocked episode already pinged
      PRIMARY KEY (org_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS attention_state_person ON attention_state (org_id, person_platform, person_id);
    -- dm_rule (OPE-2456): the rules a person confirmed from an approval card in their own DM. The judge reads them
    -- for that person's own asks in that DM only; the person removes one in the Home tab.
    CREATE TABLE IF NOT EXISTS dm_rule (
      org_id           TEXT NOT NULL,
      surface_key      TEXT NOT NULL,
      rule_id          TEXT NOT NULL,
      owner_id         TEXT NOT NULL,
      rule             TEXT NOT NULL,
      subject_json     TEXT NOT NULL,
      source_action_id TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (org_id, surface_key, rule_id)
    );
    CREATE TABLE IF NOT EXISTS dm_audience (
      org_id      TEXT NOT NULL,
      address     TEXT NOT NULL,          -- the person address, e.g. slack:person/U0123ABC
      first_dm_at TEXT,                   -- ISO-8601 of the FIRST proactive DM; NULL = never delivered
      stopped_at  TEXT,                   -- ISO-8601 the recipient stopped it; NULL = not stopped
      PRIMARY KEY (org_id, address)
    );
    -- person_opt_out (OPE-2436): who has opted out of agent actions on their own content. One
    -- nullable timestamp and no content — store.ts's PersonOptOutRow carries the posture.
    CREATE TABLE IF NOT EXISTS person_opt_out (
      org_id        TEXT NOT NULL,
      principal_key TEXT NOT NULL,        -- the binding's principalId, e.g. a Slack U0456
      opted_out_at  TEXT,                 -- ISO-8601 the person opted out; NULL = not opted out
      PRIMARY KEY (org_id, principal_key)
    );
    -- personal_browser (OPE-2441): one row per person's browser — store.ts's PersonalBrowserRow. Every
    -- write is a compare-and-set on version.
    CREATE TABLE IF NOT EXISTS personal_browser (
      org_id        TEXT NOT NULL,
      principal_key TEXT NOT NULL,        -- the person's qualified principal key, e.g. slack/T01/U0456
      state_json    TEXT NOT NULL,
      version       INTEGER NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (org_id, principal_key)
    );
    -- personal_watch (OPE-2422): one row per person the chief-of-staff watch serves — store.ts's
    -- PersonalWatchRow. Every write is a compare-and-set on version.
    CREATE TABLE IF NOT EXISTS personal_watch (
      org_id        TEXT NOT NULL,
      principal_key TEXT NOT NULL,        -- the person's qualified principal key, e.g. slack/T01/U0456
      state_json    TEXT NOT NULL,
      version       INTEGER NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (org_id, principal_key)
    );
    -- personal_cover (OPE-2513): one row per person who turned out-of-office cover on — store.ts's
    -- PersonalCoverRow. Every write is a compare-and-set on version.
    CREATE TABLE IF NOT EXISTS personal_cover (
      org_id        TEXT NOT NULL,
      principal_key TEXT NOT NULL,        -- the person's qualified principal key, e.g. slack/T01/U0456
      state_json    TEXT NOT NULL,
      version       INTEGER NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (org_id, principal_key)
    );
    -- question_ledger (OPE-2539): the questions people asked in a turn that made no connector call — store.ts's
    -- QuestionLedgerEntry. Normalized words and their hash only; every append deletes the org's rows past the keep.
    CREATE TABLE IF NOT EXISTS question_ledger (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id       TEXT NOT NULL,
      ts           TEXT NOT NULL,        -- ISO-8601
      surface_key  TEXT NOT NULL,
      surface_mode TEXT NOT NULL,        -- 'dm' | 'channel'
      principal_id TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      words        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS question_ledger_org_ts ON question_ledger (org_id, ts);
    CREATE INDEX IF NOT EXISTS question_ledger_org_surface_ts ON question_ledger (org_id, surface_key, ts);
    -- room_watch (OPE-2539): one row per shared room that workflow discovery offered a routine to — store.ts's
    -- RoomWatchRow. Every write is a compare-and-set on version.
    CREATE TABLE IF NOT EXISTS room_watch (
      org_id      TEXT NOT NULL,
      surface_key TEXT NOT NULL,          -- the room's surface key, or 'scan' for the org-wide scan clock
      state_json  TEXT NOT NULL,
      version     INTEGER NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (org_id, surface_key)
    );
    -- memory_canvas (OPE-2587): one row per Slack channel the memory canvas observer made a canvas in —
    -- store.ts's MemoryCanvasRow. An id and no content.
    CREATE TABLE IF NOT EXISTS memory_canvas (
      org_id      TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      canvas_id   TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (org_id, surface_key)
    );
    -- meeting_data (OPE-2461): the meeting rows, each with its OWN expiry — store.ts's meeting_data section.
    -- A read ignores a row past expires_at, a write deletes only such rows, and the meeting sweep deletes
    -- them on a timer. Never task_result: that table's prune runs by the calling writer's TTL, not the row's.
    CREATE TABLE IF NOT EXISTS meeting_data (
      org_id      TEXT NOT NULL,
      data_key    TEXT NOT NULL,          -- the meetings module's own namespaced key
      value_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL,          -- ISO-8601
      expires_at  TEXT NOT NULL,          -- ISO-8601 (lexicographic = chronological); the row is dead at it
      PRIMARY KEY (org_id, data_key)
    );
    CREATE INDEX IF NOT EXISTS meeting_data_expiry ON meeting_data (org_id, expires_at);
    -- routine_report_thread (OPE-2532): the routine a report thread belongs to, so a reply there is a check-in.
    -- Keyed by the thread a reply carries; ids only. Each row has its OWN expiry, as meeting_data does.
    CREATE TABLE IF NOT EXISTS routine_report_thread (
      org_id          TEXT NOT NULL,
      channel_key     TEXT NOT NULL,      -- unifiedThreadRef(origin).channelKey
      thread_key      TEXT NOT NULL,      -- unifiedThreadRef(origin).threadKey
      routine_surface TEXT NOT NULL,      -- the routine's OWNING surface key
      routine_id      TEXT NOT NULL,
      created_at      TEXT NOT NULL,      -- ISO-8601
      expires_at      TEXT NOT NULL,      -- ISO-8601 (lexicographic = chronological); the row is dead at it
      PRIMARY KEY (org_id, channel_key, thread_key)
    );
    CREATE INDEX IF NOT EXISTS routine_report_thread_expiry ON routine_report_thread (org_id, expires_at);
    CREATE TABLE IF NOT EXISTS instance_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  if (needsLinkedIdTenantRebuild) {
    handle.exec(`
      INSERT INTO identity_linked_ids (org_id, platform, tenant, native_id, link_set_id, status, established_by, evidence, created_at, updated_at)
        SELECT org_id, platform, '', native_id, link_set_id, status, established_by, evidence, created_at, updated_at
          FROM identity_linked_ids__pre_tenant;
      DROP TABLE identity_linked_ids__pre_tenant;
    `);
  }
  for (const ddl of [
    "ALTER TABLE spend_limit ADD COLUMN expires_at INTEGER",
    "ALTER TABLE spend_limit ADD COLUMN reason TEXT",
    "ALTER TABLE spend_limit ADD COLUMN set_by TEXT",
    "ALTER TABLE spend_limit ADD COLUMN monthly_usd REAL",
    "ALTER TABLE halt ADD COLUMN set_ref TEXT",

    "ALTER TABLE connector_override ADD COLUMN reason TEXT",
    "ALTER TABLE connector_override ADD COLUMN set_by TEXT",

    "ALTER TABLE thread_engagement ADD COLUMN participating INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE thread_engagement ADD COLUMN silent_streak INTEGER NOT NULL DEFAULT 0",

    "ALTER TABLE thread_engagement ADD COLUMN owner_token TEXT",
    "ALTER TABLE thread_engagement ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'",

    "ALTER TABLE thread_engagement ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0",

    "ALTER TABLE thread_engagement ADD COLUMN engaged_by TEXT",
    "UPDATE thread_engagement SET engaged_by = char(10) || engaged_by || char(10) WHERE engaged_by IS NOT NULL AND engaged_by <> '' AND substr(engaged_by, 1, 1) <> char(10)",

    "ALTER TABLE channel_session ADD COLUMN input_tokens_total INTEGER",
    "ALTER TABLE channel_session ADD COLUMN first_wake_at TEXT",
    "ALTER TABLE channel_session ADD COLUMN last_input_tokens INTEGER",
    "ALTER TABLE channel_session ADD COLUMN rotate_marked_at TEXT",

    "ALTER TABLE channel_session ADD COLUMN served_code_fingerprint TEXT",
    "ALTER TABLE channel_session ADD COLUMN served_domain_fingerprint TEXT",

    "ALTER TABLE unified_wake_target ADD COLUMN window_token TEXT",
    "ALTER TABLE unified_wake_target ADD COLUMN answered_at TEXT",
    "ALTER TABLE unified_wake_target ADD COLUMN answered_turn_id TEXT",
    "ALTER TABLE unified_wake_target ADD COLUMN inbound INTEGER",
    "ALTER TABLE unified_wake_target ADD COLUMN audited_at TEXT",

    "ALTER TABLE pending_actions ADD COLUMN posted_to TEXT",

    "ALTER TABLE pending_actions ADD COLUMN group_key TEXT",

    "ALTER TABLE stored_credential ADD COLUMN claim_id TEXT",
    "ALTER TABLE stored_credential ADD COLUMN claimed_at TEXT",

    "ALTER TABLE stored_credential RENAME COLUMN provider TO connector",
    "ALTER TABLE credential_intake RENAME COLUMN provider TO connector",

    "ALTER TABLE audit_entry ADD COLUMN prev_sha TEXT",

    "ALTER TABLE audit_entry ADD COLUMN surface_mode TEXT",

    "ALTER TABLE usage_events ADD COLUMN routine_id TEXT",

    "ALTER TABLE usage_events ADD COLUMN usd_micros_measured INTEGER",
    "ALTER TABLE usage_events ADD COLUMN cost_source TEXT",
    "ALTER TABLE usage_events ADD COLUMN delegation_depth INTEGER",
    "ALTER TABLE usage_events ADD COLUMN root_session_id TEXT",

    "ALTER TABLE usage_events ADD COLUMN cache_tokens_reported INTEGER",
    "ALTER TABLE usage_events ADD COLUMN reasoning_tokens INTEGER",
    "ALTER TABLE spend_ledger ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0",

    "ALTER TABLE usage_events ADD COLUMN surface_mode TEXT",
    "ALTER TABLE spend_ledger ADD COLUMN surface_mode TEXT NOT NULL DEFAULT ''",

    "ALTER TABLE identity_link_challenges ADD COLUMN initiating_tenant TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE identity_link_challenges ADD COLUMN claimed_tenant TEXT",

    "ALTER TABLE identity_link_challenges ADD COLUMN transport TEXT NOT NULL DEFAULT 'code'",
    "ALTER TABLE identity_link_challenges ADD COLUMN target_platform TEXT",
    "ALTER TABLE identity_link_challenges ADD COLUMN target_tenant TEXT",
    "ALTER TABLE identity_link_challenges ADD COLUMN target_native_id TEXT",
    "ALTER TABLE identity_link_challenges ADD COLUMN back_nonce_hash TEXT",

    "ALTER TABLE credential_grant_ask ADD COLUMN requester_target TEXT",

    "ALTER TABLE credential_grant_ask ADD COLUMN card_surface_id TEXT",
    "ALTER TABLE credential_grant_ask ADD COLUMN card_message_id TEXT",

    "ALTER TABLE credential_grant_ask ADD COLUMN mcp_tool TEXT",
    "ALTER TABLE credential_grant_ask ADD COLUMN frozen_args TEXT",
    "ALTER TABLE credential_grant_ask ADD COLUMN tool_name TEXT",
    "ALTER TABLE credential_grant ADD COLUMN mcp_tool TEXT",
    "ALTER TABLE credential_grant ADD COLUMN frozen_args TEXT",
    "ALTER TABLE credential_grant ADD COLUMN tool_name TEXT",
    "ALTER TABLE credential_grant ADD COLUMN input_schema TEXT",
    "ALTER TABLE credential_grant ADD COLUMN refund_turn TEXT",
    "ALTER TABLE credential_grant ADD COLUMN refund_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE credential_grant ADD COLUMN refund_turn_seq INTEGER",

    "ALTER TABLE credential_grant_ask ADD COLUMN domain_scope_key TEXT",
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
  return dbPath().path;
}

export function _openedOperationalDbPathForTest(): string | null {
  return openedPath;
}

function operationalRoot(): string {
  return openedPath ?? dbPath().path;
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

type ModelCallCaptureDbRow = {
  seq: number;
  surface_key: string;
  session_id: string;
  turn_id: string;
  step_index: number;
  ts: string;
  model: string;
  provider: string;
  schema_version: number;
  sha256: string;
  body_bytes: number;
  body_gzip_b64: string;
  truncated: number;
};

function modelCallCaptureFromRow(org: string, r: ModelCallCaptureDbRow): ModelCallCaptureRow {
  return {
    seq: Number(r.seq),
    org,
    surfaceKey: r.surface_key,
    sessionId: r.session_id,
    turnId: r.turn_id,
    stepIndex: Number(r.step_index),
    ts: r.ts,
    model: r.model,
    provider: r.provider,
    schemaVersion: Number(r.schema_version),
    sha256: r.sha256,
    bodyBytes: Number(r.body_bytes),
    bodyGzipB64: r.body_gzip_b64,
    truncated: Number(r.truncated) === 1,
  };
}

type SpendLedgerDbRow = {
  org_id: string;
  surface_key: string;
  principal_id: string;
  routine_id: string;
  model: string;
  period: string;
  surface_mode: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  usd_micros: number;
  usd_micros_measured: number;
  cost_source: string;
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
    costSource: r.cost_source === "measured" ? "measured" : "derived",
    surfaceMode: r.surface_mode ?? "",
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    usdMicros: r.usd_micros,
    usdMicrosMeasured: r.usd_micros_measured,
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
  usd_micros_measured: number | null;
  cost_source: string | null;
  delegation_depth: number | null;
  root_session_id: string | null;
  cache_tokens_reported: number | null;
  reasoning_tokens: number | null;
  surface_mode: string | null;
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
    ...(r.usd_micros_measured != null ? { usdMicrosMeasured: Number(r.usd_micros_measured) } : {}),
    ...(r.cost_source ? { costSource: r.cost_source === "measured" ? ("measured" as const) : ("derived" as const) } : {}),
    ...(r.delegation_depth != null ? { delegationDepth: Number(r.delegation_depth) } : {}),
    ...(r.root_session_id ? { rootSessionId: r.root_session_id } : {}),
    ...(r.cache_tokens_reported != null ? { cacheTokensReported: r.cache_tokens_reported === 1 } : {}),
    ...(r.reasoning_tokens != null ? { reasoningTokens: Number(r.reasoning_tokens) } : {}),
    ...((): { surfaceMode?: SurfaceMode } => {
      const mode = asSurfaceMode(r.surface_mode);
      return mode ? { surfaceMode: mode } : {};
    })(),
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
  group_key?: string | null;
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
    ...(r.group_key ? { groupKey: r.group_key } : {}),
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

const TURN_ANCHOR_SELECT = "SELECT window_key, anchor_key, channel_key, session_id, turn_id, surface_key, created_at FROM turn_anchor";

type TurnAnchorSqlRow = {
  window_key: string;
  anchor_key: string | null;
  channel_key: string | null;
  session_id: string;
  turn_id: string;
  surface_key: string;
  created_at: string;
};

function readTurnAnchorRow(raw: unknown): TurnAnchorRow | null {
  const r = raw as TurnAnchorSqlRow | undefined;
  if (!r) return null;
  return {
    windowKey: r.window_key,
    ...(r.anchor_key !== null ? { anchorKey: r.anchor_key } : {}),
    ...(r.channel_key !== null ? { channelKey: r.channel_key } : {}),
    sessionId: r.session_id,
    turnId: r.turn_id,
    surfaceKey: r.surface_key,
    createdAt: r.created_at,
  };
}

type LinkSetSqliteRow = { id: string; handle: string; status: string; created_at: string; updated_at: string };

function linkSetFromSqliteRow(org: string, r: LinkSetSqliteRow): LinkSetRow {
  return { org, id: r.id, handle: r.handle, status: r.status as LinkSetStatus, createdAt: r.created_at, updatedAt: r.updated_at };
}

const LINKED_ID_SQLITE_SELECT = "SELECT platform, tenant, native_id, link_set_id, status, established_by, evidence, created_at, updated_at FROM identity_linked_ids";

type LinkedIdSqliteRow = {
  platform: string;
  tenant: string;
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
    tenant: r.tenant,
    nativeId: r.native_id,
    status: r.status as LinkedIdStatus,
    establishedBy: r.established_by,
    ...(r.evidence === null ? {} : { evidenceJson: r.evidence }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const LINK_CHALLENGE_SQLITE_SELECT =
  `SELECT id, nonce_hash, initiating_platform, initiating_tenant, initiating_native_id, initiating_surface_key,
          claimed_platform, claimed_tenant, claimed_native_id, claimed_at,
          transport, target_platform, target_tenant, target_native_id, back_nonce_hash,
          status, created_at, expires_at, decided_at
   FROM identity_link_challenges`;

type LinkChallengeSqliteRow = {
  id: string;
  nonce_hash: string;
  initiating_platform: string;
  initiating_tenant: string;
  initiating_native_id: string;
  initiating_surface_key: string;
  claimed_platform: string | null;
  claimed_tenant: string | null;
  claimed_native_id: string | null;
  claimed_at: string | null;
  transport: string | null;
  target_platform: string | null;
  target_tenant: string | null;
  target_native_id: string | null;
  back_nonce_hash: string | null;
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
    initiatingTenant: r.initiating_tenant,
    initiatingNativeId: r.initiating_native_id,
    initiatingSurfaceKey: r.initiating_surface_key,
    ...(r.claimed_platform === null ? {} : { claimedPlatform: r.claimed_platform }),
    ...(r.claimed_tenant === null ? {} : { claimedTenant: r.claimed_tenant }),
    ...(r.claimed_native_id === null ? {} : { claimedNativeId: r.claimed_native_id }),
    ...(r.claimed_at === null ? {} : { claimedAt: r.claimed_at }),
    transport: r.transport ?? "code",
    ...(r.target_platform === null || r.target_platform === undefined ? {} : { targetPlatform: r.target_platform }),
    ...(r.target_tenant === null || r.target_tenant === undefined ? {} : { targetTenant: r.target_tenant }),
    ...(r.target_native_id === null || r.target_native_id === undefined ? {} : { targetNativeId: r.target_native_id }),
    ...(r.back_nonce_hash === null || r.back_nonce_hash === undefined ? {} : { backNonceHash: r.back_nonce_hash }),
    status: r.status as LinkChallengeStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
  };
}

function refuseHalfBorrow(table: string, row: Parameters<typeof grantBorrowColumnsProblem>[0]): void {
  const problem = grantBorrowColumnsProblem(row);
  if (problem !== undefined) throw new Error(`${table}: ${problem}`);
}

const GRANT_ASK_SQLITE_SELECT =
  `SELECT id, requester_principal_id, owner_principal_id, owner_slug, owner_platform, owner_native_id, connector, verb, resource,
          mcp_tool, frozen_args, tool_name,
          scope_key, domain_scope_key, purpose, requester_target, card_surface_id, card_message_id, requested_mode, status, created_at, expires_at, decided_at, grant_id
   FROM credential_grant_ask`;

type GrantAskSqliteRow = {
  id: string;
  requester_principal_id: string;
  owner_principal_id: string;
  owner_slug: string;
  owner_platform: string;
  owner_native_id: string;
  connector: string;
  verb: string;
  resource: string;
  mcp_tool: string | null;
  frozen_args: string | null;
  tool_name: string | null;
  scope_key: string;
  domain_scope_key: string | null;
  purpose: string;
  requester_target: string | null;
  card_surface_id: string | null;
  card_message_id: string | null;
  requested_mode: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  grant_id: string | null;
};

function grantAskFromSqliteRow(r: GrantAskSqliteRow): CredentialGrantAskRow {
  const frozenArgs = grantJsonFromColumn(r.frozen_args, "credential_grant_ask.frozen_args");
  return {
    id: r.id,
    requesterPrincipalId: r.requester_principal_id,
    ownerPrincipalId: r.owner_principal_id,
    ownerSlug: r.owner_slug,
    ownerPlatform: r.owner_platform,
    ownerNativeId: r.owner_native_id,
    connector: r.connector,
    verb: r.verb,
    resource: r.resource,
    ...(r.mcp_tool === null || r.mcp_tool === undefined ? {} : { mcpTool: r.mcp_tool }),
    ...(frozenArgs === undefined ? {} : { frozenArgs }),
    ...(r.tool_name === null || r.tool_name === undefined ? {} : { toolName: r.tool_name }),
    scopeKey: r.scope_key,
    ...(r.domain_scope_key === null || r.domain_scope_key === undefined ? {} : { domainScopeKey: r.domain_scope_key }),
    purpose: r.purpose,
    ...(r.requester_target === null ? {} : { requesterTarget: r.requester_target }),
    ...(r.card_surface_id === null ? {} : { cardSurfaceId: r.card_surface_id }),
    ...(r.card_message_id === null ? {} : { cardMessageId: r.card_message_id }),
    requestedMode: r.requested_mode as CredentialGrantMode,
    status: r.status as CredentialGrantAskState,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
    ...(r.grant_id === null ? {} : { grantId: r.grant_id }),
  };
}

const GRANT_SQLITE_SELECT =
  `SELECT id, ask_id, requester_principal_id, owner_principal_id, owner_slug, connector, verb, resource,
          mcp_tool, frozen_args, tool_name, input_schema,
          scope_key, mode, tier, status, purpose, created_at, expires_at, used_at, revoked_at
   FROM credential_grant`;

type GrantSqliteRow = {
  id: string;
  ask_id: string;
  requester_principal_id: string;
  owner_principal_id: string;
  owner_slug: string;
  connector: string;
  verb: string;
  resource: string;
  mcp_tool: string | null;
  frozen_args: string | null;
  tool_name: string | null;
  input_schema: string | null;
  scope_key: string;
  mode: string;
  tier: string;
  status: string;
  purpose: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

function grantFromSqliteRow(r: GrantSqliteRow): CredentialGrantRow {
  const frozenArgs = grantJsonFromColumn(r.frozen_args, "credential_grant.frozen_args");
  const inputSchema = grantJsonFromColumn(r.input_schema, "credential_grant.input_schema");
  return {
    id: r.id,
    askId: r.ask_id,
    requesterPrincipalId: r.requester_principal_id,
    ownerPrincipalId: r.owner_principal_id,
    ownerSlug: r.owner_slug,
    connector: r.connector,
    verb: r.verb,
    resource: r.resource,
    ...(r.mcp_tool === null || r.mcp_tool === undefined ? {} : { mcpTool: r.mcp_tool }),
    ...(frozenArgs === undefined ? {} : { frozenArgs }),
    ...(r.tool_name === null || r.tool_name === undefined ? {} : { toolName: r.tool_name }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    scopeKey: r.scope_key,
    mode: r.mode as CredentialGrantMode,
    tier: r.tier as CredentialGrantRow["tier"],
    status: r.status as CredentialGrantState,
    purpose: r.purpose,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.used_at === null ? {} : { usedAt: r.used_at }),
    ...(r.revoked_at === null ? {} : { revokedAt: r.revoked_at }),
  };
}

interface PersonalBrowserSqliteRow {
  readonly principal_key: string;
  readonly state_json: string;
  readonly version: number;
  readonly updated_at: string;
}

function personalBrowserRowFrom(r: PersonalBrowserSqliteRow): PersonalBrowserRow {
  return { principalKey: r.principal_key, stateJson: r.state_json, version: Number(r.version), updatedAt: r.updated_at };
}

function personalWatchRowFrom(r: PersonalBrowserSqliteRow): PersonalWatchRow {
  return { principalKey: r.principal_key, stateJson: r.state_json, version: Number(r.version), updatedAt: r.updated_at };
}

interface QuestionLedgerSqliteRow {
  readonly ts: string;
  readonly surface_key: string;
  readonly principal_id: string;
  readonly fingerprint: string;
  readonly words: string;
}

function questionRowFrom(r: QuestionLedgerSqliteRow): QuestionLedgerRow {
  return { ts: r.ts, surfaceKey: r.surface_key, principalId: r.principal_id, fingerprint: r.fingerprint, words: r.words };
}

function personalCoverRowFrom(r: PersonalBrowserSqliteRow): PersonalCoverRow {
  return { principalKey: r.principal_key, stateJson: r.state_json, version: Number(r.version), updatedAt: r.updated_at };
}

function personOptOutRowFrom(r: { principal_key: string; opted_out_at: string | null }): PersonOptOutRow {
  return { principalKey: r.principal_key, ...(r.opted_out_at === null ? {} : { optedOutAt: r.opted_out_at }) };
}

function dmAudienceRowFrom(r: { address: string; first_dm_at: string | null; stopped_at: string | null }): DmAudienceRow {
  return {
    address: r.address,
    ...(r.first_dm_at === null ? {} : { firstDmAt: r.first_dm_at }),
    ...(r.stopped_at === null ? {} : { stoppedAt: r.stopped_at }),
  };
}

function recordSqliteRoutinePromptRevisions(
  handle: DatabaseSync,
  org: string,
  surfaceKey: string,
  id: string,
  existing: Routine,
  updated: Routine,
  patch: Partial<Routine>,
  provenance: RoutinePromptProvenance | undefined,
): void {
  if (patch.prompt === undefined || patch.prompt === existing.prompt) return;
  const prior = handle.prepare("SELECT 1 FROM routine_prompt_revisions WHERE org_id = ? AND surface_key = ? AND routine_id = ? LIMIT 1").get(org, surfaceKey, id);
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

export const sqliteOperationalStore: OperationalStore = {
  id: "sqlite",
  root: operationalRoot,

  async recordSpend(org, write: SpendLedgerWrite) {
    getDb()
      .prepare(
        `INSERT INTO spend_ledger
           (org_id, surface_key, principal_id, routine_id, model, period, cost_source, surface_mode,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, usd_micros, usd_micros_measured, calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(org_id, surface_key, principal_id, routine_id, model, period, cost_source) DO UPDATE SET
           -- OPE-1862: a stamped mode HEALS a row an older build (or a writer with no binding)
           -- left unstamped, and an unstamped write never erases a mode the row already holds.
           -- A surface cannot change mode, so the two spellings can only ever be '' and the truth.
           surface_mode        = COALESCE(NULLIF(excluded.surface_mode, ''), spend_ledger.surface_mode),
           input_tokens        = input_tokens        + excluded.input_tokens,
           output_tokens       = output_tokens       + excluded.output_tokens,
           cache_read_tokens   = cache_read_tokens   + excluded.cache_read_tokens,
           cache_write_tokens  = cache_write_tokens  + excluded.cache_write_tokens,
           reasoning_tokens    = reasoning_tokens    + excluded.reasoning_tokens,
           usd_micros          = usd_micros          + excluded.usd_micros,
           usd_micros_measured = usd_micros_measured + excluded.usd_micros_measured,
           calls               = calls + 1`,
      )
      .run(
        org,
        write.surfaceKey,
        write.principalId ?? "",
        write.routineId ?? "",
        write.model ?? "",
        write.period,
        write.costSource ?? "derived",
        write.surfaceMode ?? "",
        write.inputTokens ?? 0,
        write.outputTokens ?? 0,
        write.cacheReadTokens ?? 0,
        write.cacheWriteTokens ?? 0,
        write.reasoningTokens ?? 0,
        write.usdMicros ?? 0,
        write.usdMicrosMeasured ?? 0,
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
                COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                COALESCE(SUM(usd_micros), 0) AS usd_micros,
                COALESCE(SUM(usd_micros_measured), 0) AS usd_micros_measured,
                COALESCE(SUM(calls), 0) AS calls
         FROM spend_ledger WHERE ${["org_id = ?", ...conjuncts].join(" AND ")}`,
      )
      .get(org, ...params) as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; usd_micros: number; usd_micros_measured: number; calls: number };
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reasoningTokens: row.reasoning_tokens,
      usdMicros: row.usd_micros,
      usdMicrosMeasured: row.usd_micros_measured,
      calls: row.calls,
    };
  },

  async listSpendLedger(org?: string, filter: SpendLedgerFilter = {}) {
    const { conjuncts, params } = spendLedgerConjuncts(filter);
    const where = [...(org !== undefined ? ["org_id = ?"] : []), ...conjuncts];
    const rows = getDb()
      .prepare(`SELECT * FROM spend_ledger${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`)
      .all(...(org !== undefined ? [org] : []), ...params) as SpendLedgerDbRow[];
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
    recordSqliteRoutinePromptRevisions(handle, org, surfaceKey, id, existing, updated, patch, provenance);
    handle.prepare("UPDATE routine SET data = ? WHERE org_id = ? AND id = ?").run(JSON.stringify(updated), org, id);
    return updated;
  },

  async updateRoutineIf(org, surfaceKey, id, precondition, patch, provenance) {
    const handle = getDb();
    for (let attempt = 0; attempt < ROUTINE_GUARDED_WRITE_ATTEMPTS; attempt++) {
      const row = handle.prepare("SELECT data FROM routine WHERE org_id = ? AND id = ? AND surface_key = ?").get(org, id, surfaceKey) as
        | { data: string }
        | undefined;
      if (!row) return { kind: "gone" };
      const existing = JSON.parse(row.data) as Routine;
      if (!precondition(existing)) return { kind: "refused", routine: existing };
      const p = typeof patch === "function" ? patch(existing) : patch;
      const updated: Routine = { ...existing, ...p, id: existing.id, org: existing.org, surfaceKey: existing.surfaceKey };
      recordSqliteRoutinePromptRevisions(handle, org, surfaceKey, id, existing, updated, p, provenance);
      const info = handle
        .prepare("UPDATE routine SET data = ? WHERE org_id = ? AND id = ? AND surface_key = ? AND data = ?")
        .run(JSON.stringify(updated), org, id, surfaceKey, row.data);
      if (info.changes > 0) return { kind: "written", routine: updated };
    }
    throw new Error(`routine ${id} changed ${ROUTINE_GUARDED_WRITE_ATTEMPTS} times during one guarded write`);
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
    return withOrgAuditLock(entry.org, async () => {
    const handle = getDb();
    const last = handle
      .prepare(
        `SELECT ts, org_id, platform, workspace, surface, surface_mode, principal_id, action, detail, prev_sha
         FROM audit_entry WHERE org_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(entry.org) as
      | { ts: string; org_id: string; platform: string; workspace: string; surface: string | null; surface_mode: string | null; principal_id: string | null; action: string; detail: string | null; prev_sha: string | null }
      | undefined;
    const lastMode = auditSurfaceMode(last?.surface_mode);
    const prevSha = last
      ? auditRowSha(
          {
            org: last.org_id,
            ts: last.ts,
            platform: last.platform,
            workspace: last.workspace,
            ...(last.surface ? { surface: last.surface } : {}),
            ...lastMode,
            ...(last.principal_id ? { principalId: last.principal_id } : {}),
            action: last.action,
            ...(last.detail ? { detail: JSON.parse(last.detail) as Record<string, unknown> } : {}),
          },
          last.prev_sha,
        )
      : null;
    handle
      .prepare(
        `INSERT INTO audit_entry (ts, org_id, platform, workspace, surface, surface_mode, principal_id, action, detail, prev_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.org,
        entry.platform,
        entry.workspace,
        entry.surface ?? null,
        entry.surfaceMode ?? null,
        entry.principalId ?? null,
        entry.action,
        entry.detail ? JSON.stringify(entry.detail) : null,
        prevSha,
      );
    });
  },

  async readAudit(filter: AuditFilter) {
    const org = auditReadOrg(filter);
    const where: string[] = [];
    const params: string[] = [];
    const eq = (col: string, val: string | undefined) => {
      if (val !== undefined) {
        where.push(`${col} = ?`);
        params.push(val);
      }
    };
    eq("org_id", org);
    eq("platform", filter.platform);
    eq("workspace", filter.workspace);
    eq("surface", filter.surface);
    eq("action", filter.action);
    eq("principal_id", filter.principalId);
    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      where.push("ts <= ?");
      params.push(filter.until);
    }
    for (const [key, value] of auditDetailKeys(filter)) {
      where.push("json_type(detail, ?) = 'text' AND json_extract(detail, ?) = ?");
      params.push(`$.${key}`, `$.${key}`, value);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit && filter.limit > 0 ? filter.limit : -1;
    const rows = getDb()
      .prepare(
        `SELECT seq, ts, org_id, platform, workspace, surface, surface_mode, principal_id, action, detail
         FROM audit_entry ${clause} ORDER BY ts DESC, seq DESC LIMIT ?`,
      )
      .all(...params, limit) as {
      seq: number;
      ts: string;
      org_id: string;
      platform: string;
      workspace: string;
      surface: string | null;
      surface_mode: string | null;
      principal_id: string | null;
      action: string;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: r.ts,
      org: r.org_id,
      platform: r.platform,
      workspace: r.workspace,
      ...(r.surface ? { surface: r.surface } : {}),
      ...auditSurfaceMode(r.surface_mode),
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
    const page = !(tail && tail > 0) && opts?.afterSeq !== undefined ? { after: opts.afterSeq, limit: Math.max(1, Math.floor(opts.limit ?? 1)) } : undefined;
    const cols = "seq, ts, org_id, platform, workspace, surface, surface_mode, principal_id, action, detail, prev_sha";
    const sql =
      tail && tail > 0
        ? `SELECT * FROM (
             SELECT ${cols}
             FROM audit_entry WHERE org_id = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`
        : page
          ? `SELECT ${cols} FROM audit_entry WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
          : `SELECT ${cols}
           FROM audit_entry WHERE org_id = ? ORDER BY seq ASC`;
    const rows = getDb()
      .prepare(sql)
      .all(...(tail && tail > 0 ? [org, tail] : page ? [org, page.after, page.limit] : [org])) as {
      seq: number;
      ts: string;
      org_id: string;
      platform: string;
      workspace: string;
      surface: string | null;
      surface_mode: string | null;
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
        ...auditSurfaceMode(r.surface_mode),
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        action: r.action,
        ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
        prevSha: r.prev_sha,
      }),
    );
  },

  async sealAuditChainEpoch(org, sealedBy) {
    return withOrgAuditLock(org, async () => {
      const rows = await sqliteOperationalStore.readAuditChain(org);
      const seal = auditEpochSealFor(rows);
      if (seal === null) return null;
      const written = getDb()
        .prepare(
          `INSERT INTO audit_entry (ts, org_id, platform, workspace, principal_id, action, detail, prev_sha)
           VALUES (?, ?, 'db', 'sqlite', ?, ?, ?, NULL)`,
        )
        .run(new Date().toISOString(), org, sealedBy, AUDIT_CHAIN_EPOCH_ACTION, JSON.stringify(auditEpochDetail(seal)));
      return { seal, markerSeq: Number(written.lastInsertRowid) };
    });
  },

  async setSpendLimit(org, scopeKey, level, limit, meta, condition) {
    assertSpendLimitAmount(limit);
    const conflict = condition?.ifAbsent
      ? "DO NOTHING"
      : `DO UPDATE SET
           monthly_tokens = excluded.monthly_tokens,
           monthly_usd    = excluded.monthly_usd,
           expires_at     = excluded.expires_at,
           reason         = excluded.reason,
           set_by         = excluded.set_by`;
    return (
      getDb()
        .prepare(
          `INSERT INTO spend_limit (org_id, scope_key, level, monthly_tokens, monthly_usd, expires_at, reason, set_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, scope_key, level) ${conflict}`,
        )
        .run(org, scopeKey, level, limit.monthlyTokens ?? -1, limit.monthlyUsd ?? null, meta?.expiresAt ?? null, meta?.reason ?? null, meta?.setBy ?? null).changes > 0
    );
  },

  async clearSpendLimit(org, scopeKey, level, expected) {
    const sql = expected
      ? "DELETE FROM spend_limit WHERE org_id = ? AND scope_key = ? AND level = ? AND monthly_tokens IS ? AND monthly_usd IS ? AND expires_at IS ? AND reason IS ? AND set_by IS ?"
      : "DELETE FROM spend_limit WHERE org_id = ? AND scope_key = ? AND level = ?";
    const params = expected
      ? [org, scopeKey, level, expected.monthlyTokens ?? -1, expected.monthlyUsd ?? null, expected.expiresAt ?? null, expected.reason ?? null, expected.setBy ?? null]
      : [org, scopeKey, level];
    return getDb().prepare(sql).run(...params).changes > 0;
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

  async setHalt(org, address, meta) {
    assertHaltAddress(address);
    const a = haltAddressColumns(address);
    getDb()
      .prepare(
        `INSERT INTO halt (org_id, level, scope_key, org_wide, active, set_by, set_at, set_ref, cleared_by, cleared_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL)
         ON CONFLICT(org_id, level, scope_key, org_wide) DO UPDATE SET
           active     = 1,
           set_by     = excluded.set_by,
           set_at     = excluded.set_at,
           set_ref    = excluded.set_ref,
           cleared_by = NULL,
           cleared_at = NULL`,
      )
      .run(org, a.level, a.scopeKey, a.orgWide ? 1 : 0, meta?.setBy ?? null, meta?.setAt ?? new Date().toISOString(), meta?.setRef ?? null);
  },

  async clearHalt(org, address, meta, expected) {
    assertHaltAddress(address);
    const a = haltAddressColumns(address);
    const expectedSql = expected ? " AND set_at = ? AND set_by IS ? AND set_ref IS ?" : "";
    const expectedParams = expected ? [expected.setAt, expected.setBy ?? null, expected.setRef ?? null] : [];
    return (
      getDb()
        .prepare(`UPDATE halt SET active = 0, cleared_by = ?, cleared_at = ? WHERE org_id = ? AND level = ? AND scope_key = ? AND org_wide = ? AND active = 1${expectedSql}`)
        .run(meta?.clearedBy ?? null, new Date().toISOString(), org, a.level, a.scopeKey, a.orgWide ? 1 : 0, ...expectedParams).changes > 0
    );
  },

  async activeHalts(org) {
    const rows = getDb()
      .prepare("SELECT level, scope_key, org_wide, set_by, set_at, set_ref, cleared_by, cleared_at FROM halt WHERE org_id = ? AND active = 1")
      .all(org) as { level: string; scope_key: string; org_wide: number; set_by: string | null; set_at: string; set_ref: string | null; cleared_by: string | null; cleared_at: string | null }[];
    return rows.map((r) => ({
      org,
      address: haltAddressFromColumns(r.level, r.scope_key, r.org_wide === 1),
      active: true,
      setAt: r.set_at,
      ...(r.set_by ? { setBy: r.set_by } : {}),
      ...(r.set_ref ? { setRef: r.set_ref } : {}),
      ...(r.cleared_by ? { clearedBy: r.cleared_by } : {}),
      ...(r.cleared_at ? { clearedAt: r.cleared_at } : {}),
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
    const framed = participating === 1 && opts?.engagedBy ? framePromoterId(opts.engagedBy) : null;
    getDb()
      .prepare(
        `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped, engaged_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)
         ON CONFLICT(org_id, surface_key, thread_ts) DO UPDATE SET
           last_turn_at  = excluded.last_turn_at,
           participating = MAX(participating, excluded.participating),
           silent_streak = CASE WHEN excluded.participating = 1 THEN 0 ELSE silent_streak END,
           owner_token   = COALESCE(excluded.owner_token, owner_token),
           stopped       = CASE
                             WHEN excluded.participating = 1
                              AND (excluded.engaged_by IS NULL
                                   OR instr(CASE WHEN engaged_by IS NULL OR engaged_by = '' THEN char(10)
                                                 WHEN substr(engaged_by, 1, 1) = char(10) THEN engaged_by
                                                 ELSE char(10) || engaged_by || char(10) END,
                                            excluded.engaged_by) = 0)
                             THEN 0 ELSE stopped END,
           engaged_by    = CASE
                             WHEN excluded.participating = 1 AND excluded.engaged_by IS NOT NULL
                             THEN replace(CASE WHEN engaged_by IS NULL OR engaged_by = '' THEN char(10)
                                               WHEN substr(engaged_by, 1, 1) = char(10) THEN engaged_by
                                               ELSE char(10) || engaged_by || char(10) END,
                                          excluded.engaged_by, char(10)) || substr(excluded.engaged_by, 2)
                             ELSE engaged_by END`,
      )
      .run(org, surfaceKey, threadTs, at, at, participating, ownerToken, kind, framed);
    if (framed === null) return;
    getDb()
      .prepare(
        `UPDATE thread_engagement
            SET engaged_by = substr(engaged_by, instr(substr(engaged_by, 2), char(10)) + 1)
          WHERE org_id = ? AND surface_key = ? AND thread_ts = ?
            AND engaged_by IS NOT NULL
            AND length(engaged_by) - length(replace(engaged_by, char(10), '')) - 1 > ?`,
      )
      .run(org, surfaceKey, threadTs, PROMOTER_LIST_MAX);
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
      .prepare("SELECT engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped, engaged_by FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?")
      .get(org, surfaceKey, threadTs) as
      | { engaged_at: string; last_turn_at: string; participating: number; silent_streak: number; owner_token: string | null; kind: string | null; stopped: number; engaged_by: string | null }
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
          ...promoterListField(row.engaged_by),
        }
      : null;
  },

  async disengage(org, surfaceKey, threadTs) {
    return getDb().prepare("DELETE FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ?").run(org, surfaceKey, threadTs).changes > 0;
  },

  async listEngagements(org) {
    const rows = getDb()
      .prepare("SELECT surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped, engaged_by FROM thread_engagement WHERE org_id = ?")
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
      engaged_by: string | null;
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
      ...promoterListField(r.engaged_by),
    }));
  },

  async getChannelSession(org, surfaceKey) {
    const row = getDb()
      .prepare("SELECT token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, last_input_tokens, rotate_marked_at, served_code_fingerprint, served_domain_fingerprint FROM channel_session WHERE org_id = ? AND surface_key = ?")
      .get(org, surfaceKey) as
      | { token: string; generation: number; created_at: string; last_wake_at: string; turn_count: number; input_tokens_total: number | null; first_wake_at: string | null; last_input_tokens: number | null; rotate_marked_at: string | null; served_code_fingerprint: string | null; served_domain_fingerprint: string | null }
      | undefined;
    return row
      ? {
          org, surfaceKey, token: row.token, generation: row.generation, createdAt: row.created_at,
          lastWakeAt: row.last_wake_at, turnCount: row.turn_count,
          inputTokensTotal: row.input_tokens_total == null ? null : Number(row.input_tokens_total),
          firstWakeAt: row.first_wake_at ?? null,
          lastInputTokens: row.last_input_tokens == null ? null : Number(row.last_input_tokens),
          rotateMarkedAt: row.rotate_marked_at ?? null,
          servedCodeFingerprint: row.served_code_fingerprint ?? null,
          servedDomainFingerprint: row.served_domain_fingerprint ?? null,
        }
      : null;
  },

  async stampChannelSessionRuntime(org, surfaceKey, codeFingerprint, domainFingerprint) {
    const handle = getDb();
    const prev = handle
      .prepare("SELECT served_code_fingerprint, served_domain_fingerprint FROM channel_session WHERE org_id = ? AND surface_key = ?")
      .get(org, surfaceKey) as { served_code_fingerprint: string | null; served_domain_fingerprint: string | null } | undefined;
    if (prev === undefined) return { outcome: "absent", previousCodeFingerprint: null, previousDomainFingerprint: null };
    const previousCodeFingerprint = prev.served_code_fingerprint ?? null;
    const previousDomainFingerprint = prev.served_domain_fingerprint ?? null;
    const info = handle
      .prepare(
        `UPDATE channel_session SET served_code_fingerprint = ?, served_domain_fingerprint = ?
          WHERE org_id = ? AND surface_key = ?
            AND (served_code_fingerprint IS NOT ? OR served_domain_fingerprint IS NOT ?)`,
      )
      .run(codeFingerprint, domainFingerprint, org, surfaceKey, codeFingerprint, domainFingerprint);
    if (Number(info.changes ?? 0) === 0) return { outcome: "current", previousCodeFingerprint, previousDomainFingerprint };
    const outcome: ChannelSessionRuntimeStamp["outcome"] = previousCodeFingerprint === null ? "adopted" : "rotate";
    return { outcome, previousCodeFingerprint, previousDomainFingerprint };
  },

  async rotateChannelSession(org, surfaceKey, newToken, at) {
    const handle = getDb();
    const row = handle
      .prepare(
        `INSERT INTO channel_session (org_id, surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, last_input_tokens, rotate_marked_at)
         VALUES (?, ?, ?, 1, ?, ?, 0, 0, NULL, NULL, NULL)
         ON CONFLICT(org_id, surface_key) DO UPDATE SET
           token              = excluded.token,
           generation         = generation + 1,
           created_at         = excluded.created_at,
           last_wake_at       = excluded.last_wake_at,
           turn_count         = 0,
           input_tokens_total = 0,
           first_wake_at      = NULL,
           last_input_tokens  = NULL,
           rotate_marked_at   = NULL
         RETURNING generation, served_code_fingerprint, served_domain_fingerprint`,
      )
      .get(org, surfaceKey, newToken, at, at) as { generation: number; served_code_fingerprint: string | null; served_domain_fingerprint: string | null };
    const generation = row.generation;
    return {
      org, surfaceKey, token: newToken, generation, createdAt: at, lastWakeAt: at, turnCount: 0, inputTokensTotal: 0, firstWakeAt: null, lastInputTokens: null, rotateMarkedAt: null,
      servedCodeFingerprint: row.served_code_fingerprint ?? null,
      servedDomainFingerprint: row.served_domain_fingerprint ?? null,
    };
  },

  async markChannelSessionRotation(org, surfaceKey, at) {
    const res = getDb()
      .prepare("UPDATE channel_session SET rotate_marked_at = COALESCE(rotate_marked_at, ?) WHERE org_id = ? AND surface_key = ?")
      .run(at, org, surfaceKey);
    return Number(res.changes ?? 0) > 0;
  },

  async touchChannelSession(org, surfaceKey, at) {
    getDb()
      .prepare("UPDATE channel_session SET last_wake_at = ?, turn_count = turn_count + 1, first_wake_at = COALESCE(first_wake_at, ?) WHERE org_id = ? AND surface_key = ?")
      .run(at, at, org, surfaceKey);
  },

  async bumpChannelSessionUsage(org, surfaceKey, token, delta) {
    const res = getDb()
      .prepare("UPDATE channel_session SET input_tokens_total = COALESCE(input_tokens_total, 0) + ?, last_input_tokens = ? WHERE org_id = ? AND surface_key = ? AND token = ?")
      .run(delta, delta, org, surfaceKey, token);
    return Number(res.changes ?? 0);
  },

  async listChannelSessions(org, keyPrefix) {
    const rows = (
      keyPrefix === undefined
        ? getDb()
            .prepare("SELECT surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, last_input_tokens, rotate_marked_at, served_code_fingerprint, served_domain_fingerprint FROM channel_session WHERE org_id = ?")
            .all(org)
        : getDb()
            .prepare("SELECT surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, last_input_tokens, rotate_marked_at, served_code_fingerprint, served_domain_fingerprint FROM channel_session WHERE org_id = ? AND surface_key LIKE ?")
            .all(org, `${keyPrefix}%`)
    ) as {
      surface_key: string; token: string; generation: number; created_at: string; last_wake_at: string; turn_count: number;
      input_tokens_total: number | null; first_wake_at: string | null; last_input_tokens: number | null; rotate_marked_at: string | null;
      served_code_fingerprint: string | null; served_domain_fingerprint: string | null;
    }[];
    return rows.map((r) => ({
      org, surfaceKey: r.surface_key, token: r.token, generation: r.generation, createdAt: r.created_at,
      lastWakeAt: r.last_wake_at, turnCount: r.turn_count,
      inputTokensTotal: r.input_tokens_total == null ? null : Number(r.input_tokens_total),
      firstWakeAt: r.first_wake_at ?? null,
      lastInputTokens: r.last_input_tokens == null ? null : Number(r.last_input_tokens),
      rotateMarkedAt: r.rotate_marked_at ?? null,
      servedCodeFingerprint: r.served_code_fingerprint ?? null,
      servedDomainFingerprint: r.served_domain_fingerprint ?? null,
    }));
  },

  async appendSessionTail(org, surfaceKey, token, entry) {
    const handle = getDb();
    const next = handle
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ?")
      .get(org, surfaceKey, token) as { seq: number };
    handle
      .prepare("INSERT INTO session_tail (org_id, surface_key, token, seq, at, entry_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(org, surfaceKey, token, next.seq, entry.at, JSON.stringify(entry));
    handle
      .prepare(
        `DELETE FROM session_tail
          WHERE org_id = ? AND surface_key = ? AND token = ?
            AND seq <= ?`,
      )
      .run(org, surfaceKey, token, next.seq - SESSION_TAIL_MAX_ENTRIES);
  },

  async readSessionTail(org, surfaceKey, token) {
    const rows = getDb()
      .prepare("SELECT entry_json FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ? ORDER BY seq ASC")
      .all(org, surfaceKey, token) as { entry_json: string }[];
    const out: SessionTailEntry[] = [];
    for (const r of rows) {
      try {
        const parsed: unknown = JSON.parse(r.entry_json);
        if (!Array.isArray(parsed)) out.push(parsed as SessionTailEntry);
      } catch {
      }
    }
    return out;
  },

  async clearSessionTail(org, surfaceKey, token) {
    getDb().prepare("DELETE FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ?").run(org, surfaceKey, token);
  },

  async readConversationSummary(org, surfaceKey) {
    const row = getDb()
      .prepare("SELECT entry_json FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ? AND seq = 1")
      .get(org, surfaceKey, CONVERSATION_SUMMARY_PARTITION) as { entry_json: string } | undefined;
    return parseConversationSummary(row?.entry_json);
  },

  async writeConversationSummary(org, surfaceKey, entries) {
    const at = entries[entries.length - 1]?.at ?? "";
    getDb()
      .prepare(
        `INSERT INTO session_tail (org_id, surface_key, token, seq, at, entry_json) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (org_id, surface_key, token, seq) DO UPDATE SET at = excluded.at, entry_json = excluded.entry_json`,
      )
      .run(org, surfaceKey, CONVERSATION_SUMMARY_PARTITION, at, JSON.stringify(entries));
  },

  async editConversationSummaryPost(org, surfaceKey, messageId, text) {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT entry_json FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ? AND seq = 1")
        .get(org, surfaceKey, CONVERSATION_SUMMARY_PARTITION) as { entry_json: string } | undefined;
      const summary = parseConversationSummary(row?.entry_json);
      const i = summary.findIndex((e) => e.kind === "post" && e.id === messageId);
      if (i >= 0) {
        summary[i] = { ...summary[i], text };
        db.prepare("UPDATE session_tail SET entry_json = ? WHERE org_id = ? AND surface_key = ? AND token = ? AND seq = 1").run(JSON.stringify(summary), org, surfaceKey, CONVERSATION_SUMMARY_PARTITION);
      }
      db.exec("COMMIT");
      return i >= 0;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },

  async editSessionTailPost(org, surfaceKey, token, messageId, text) {
    const rows = getDb()
      .prepare("SELECT seq, entry_json FROM session_tail WHERE org_id = ? AND surface_key = ? AND token = ? ORDER BY seq DESC")
      .all(org, surfaceKey, token) as { seq: number; entry_json: string }[];
    for (const r of rows) {
      let entry: SessionTailEntry;
      try {
        entry = JSON.parse(r.entry_json) as SessionTailEntry;
      } catch {
        continue;
      }
      if (entry.kind !== "post" || entry.id !== messageId) continue;
      const updated: SessionTailEntry = { ...entry, text };
      getDb()
        .prepare("UPDATE session_tail SET entry_json = ? WHERE org_id = ? AND surface_key = ? AND token = ? AND seq = ?")
        .run(JSON.stringify(updated), org, surfaceKey, token, r.seq);
      return true;
    }
    return false;
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
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail,
            usd_micros_measured, cost_source, delegation_depth, root_session_id,
            cache_tokens_reported, reasoning_tokens, surface_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.usdMicrosMeasured ?? null,
        entry.costSource ?? null,
        entry.delegationDepth ?? null,
        entry.rootSessionId ?? null,
        entry.cacheTokensReported === undefined ? null : entry.cacheTokensReported ? 1 : 0,
        entry.reasoningTokens ?? null,
        entry.surfaceMode ?? null,
      );
  },

  async usageForSession(org, sessionId) {
    const rows = getDb()
      .prepare(
        `SELECT surface_key, session_id, principal_id, ts, kind, routine_id,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail,
                usd_micros_measured, cost_source, delegation_depth, root_session_id,
                cache_tokens_reported, reasoning_tokens, surface_mode
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
    if (filter.sessionStartedAfter !== undefined) {
      where.push("session_id IN (SELECT session_id FROM usage_events WHERE org_id = ? GROUP BY session_id HAVING MIN(ts) >= ?)");
      params.push(org, filter.sessionStartedAfter);
    }
    const rows = getDb()
      .prepare(
        `SELECT surface_key, principal_id, kind, routine_id, model, surface_mode,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                -- OPE-1611: the attribution dimension AND its coverage. COALESCE keeps the sum an
                -- integer when every row is NULL; the two counts say how many calls actually
                -- reported, so a reader never mistakes an all-NULL group's 0 for "no caching".
                -- (sqlite has no FILTER clause here, so the flag count is a SUM over 1/0.)
                COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                COALESCE(SUM(CASE WHEN cache_tokens_reported = 1 THEN 1 ELSE 0 END), 0) AS cache_reported_calls,
                COUNT(reasoning_tokens) AS reasoning_reported_calls,
                COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM usage_events WHERE ${where.join(" AND ")}
         -- OPE-1862: surface_mode joins the GRAIN rather than riding along as MAX(). A group must
         -- be homogeneous in every column it reports, and one surface can hold both unstamped
         -- legacy rows and stamped new ones; those two masks differently, so they must not blend.
         GROUP BY surface_key, principal_id, kind, routine_id, model, surface_mode`,
      )
      .all(...params) as {
      surface_key: string;
      principal_id: string | null;
      kind: string | null;
      routine_id: string | null;
      model: string | null;
      surface_mode: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      cache_reported_calls: number;
      reasoning_reported_calls: number;
      events: number;
      sessions: number;
    }[];
    return rows.map((r) => ({
      surfaceKey: r.surface_key,
      ...(r.principal_id ? { principalId: r.principal_id } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.routine_id ? { routineId: r.routine_id } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...((): { surfaceMode?: SurfaceMode } => {
        const mode = asSurfaceMode(r.surface_mode);
        return mode ? { surfaceMode: mode } : {};
      })(),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      reasoningTokens: r.reasoning_tokens,
      cacheReportedCalls: r.cache_reported_calls,
      reasoningReportedCalls: r.reasoning_reported_calls,
      events: r.events,
      sessions: r.sessions,
    }));
  },

  async pruneUsageEvents(org, olderThanTs) {
    getDb().prepare("DELETE FROM tool_usage WHERE org_id = ? AND ts < ?").run(org, olderThanTs);
    return Number(getDb().prepare("DELETE FROM usage_events WHERE org_id = ? AND ts < ?").run(org, olderThanTs).changes);
  },

  async listPersonConnectorCalls(org, principalId, surfacePrefix, since, limit) {
    const rows = getDb()
      .prepare(
        `SELECT ts, connector, tool FROM (
           SELECT seq, ts, connector, tool FROM tool_usage
           WHERE org_id = ?1 AND principal_id = ?2 AND event = 'call' AND outcome = 'ok' AND connector <> ''
             AND substr(surface_key, 1, length(?3)) = ?3 AND ts >= ?4
             AND session_id NOT IN (SELECT session_id FROM usage_events WHERE org_id = ?1 AND kind = 'routine')
           ORDER BY seq DESC LIMIT ?5
         ) recent ORDER BY seq ASC`,
      )
      .all(org, principalId, surfacePrefix, since, Math.max(0, Math.floor(limit))) as { ts: string; connector: string; tool: string }[];
    return rows.map((r) => ({ ts: r.ts, connector: r.connector, tool: r.tool }));
  },

  async listDiscoveryRooms(org, since) {
    const rows = getDb()
      .prepare(
        `SELECT surface_key FROM tool_usage
           WHERE org_id = ?1 AND surface_mode = 'channel' AND event = 'call' AND outcome = 'ok' AND connector <> ''
             AND principal_id IS NOT NULL AND principal_id <> '' AND ts >= ?2
             AND session_id NOT IN (SELECT session_id FROM usage_events WHERE org_id = ?1 AND kind = 'routine')
         UNION
         SELECT surface_key FROM question_ledger WHERE org_id = ?1 AND surface_mode = 'channel' AND ts >= ?2
         ORDER BY surface_key`,
      )
      .all(org, since) as { surface_key: string }[];
    return rows.map((r) => r.surface_key);
  },

  async listRoomConnectorCalls(org, surfaceKey, since, limit) {
    const rows = getDb()
      .prepare(
        `SELECT ts, surface_key, principal_id, connector, tool FROM (
           SELECT seq, ts, surface_key, principal_id, connector, tool FROM tool_usage
           WHERE org_id = ?1 AND surface_key = ?2 AND surface_mode = 'channel' AND event = 'call' AND outcome = 'ok' AND connector <> ''
             AND principal_id IS NOT NULL AND principal_id <> '' AND ts >= ?3
             AND session_id NOT IN (SELECT session_id FROM usage_events WHERE org_id = ?1 AND kind = 'routine')
           ORDER BY seq DESC LIMIT ?4
         ) recent ORDER BY seq ASC`,
      )
      .all(org, surfaceKey, since, Math.max(0, Math.floor(limit))) as { ts: string; surface_key: string; principal_id: string; connector: string; tool: string }[];
    return rows.map((r) => ({ ts: r.ts, surfaceKey: r.surface_key, principalId: r.principal_id, connector: r.connector, tool: r.tool }));
  },

  async appendQuestion(entry, pruneBefore) {
    const db = getDb();
    db.prepare("INSERT INTO question_ledger (org_id, ts, surface_key, surface_mode, principal_id, fingerprint, words) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      entry.org,
      entry.ts,
      entry.surfaceKey,
      entry.surfaceMode,
      entry.principalId,
      entry.fingerprint,
      entry.words,
    );
    db.prepare("DELETE FROM question_ledger WHERE org_id = ? AND ts < ?").run(entry.org, pruneBefore);
  },

  async listPersonQuestions(org, principalId, surfacePrefix, since, limit) {
    const rows = getDb()
      .prepare(
        `SELECT ts, surface_key, principal_id, fingerprint, words FROM (
           SELECT seq, ts, surface_key, principal_id, fingerprint, words FROM question_ledger
           WHERE org_id = ?1 AND principal_id = ?2 AND surface_mode = 'dm' AND substr(surface_key, 1, length(?3)) = ?3 AND ts >= ?4
           ORDER BY seq DESC LIMIT ?5
         ) recent ORDER BY seq ASC`,
      )
      .all(org, principalId, surfacePrefix, since, Math.max(0, Math.floor(limit))) as unknown as QuestionLedgerSqliteRow[];
    return rows.map(questionRowFrom);
  },

  async listRoomQuestions(org, surfaceKey, since, limit) {
    const rows = getDb()
      .prepare(
        `SELECT ts, surface_key, principal_id, fingerprint, words FROM (
           SELECT seq, ts, surface_key, principal_id, fingerprint, words FROM question_ledger
           WHERE org_id = ?1 AND surface_key = ?2 AND surface_mode = 'channel' AND ts >= ?3
           ORDER BY seq DESC LIMIT ?4
         ) recent ORDER BY seq ASC`,
      )
      .all(org, surfaceKey, since, Math.max(0, Math.floor(limit))) as unknown as QuestionLedgerSqliteRow[];
    return rows.map(questionRowFrom);
  },

  async appendToolUsage(entry) {
    getDb()
      .prepare(
        `INSERT INTO tool_usage (org_id, ts, surface_key, surface_mode, principal_id, session_id, event, tool, connector, outcome, model, input_tokens, output_tokens, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.org,
        entry.ts,
        entry.surfaceKey,
        entry.surfaceMode ?? null,
        entry.principalId ?? null,
        entry.sessionId,
        entry.event,
        entry.tool,
        entry.connector,
        entry.outcome,
        entry.model ?? null,
        Math.round(entry.inputTokens),
        Math.round(entry.outputTokens),
        Math.round(entry.cacheReadTokens),
      );
  },

  async appendModelCallCapture(write: ModelCallCaptureWrite) {
    getDb()
      .prepare(
        `INSERT INTO model_call_capture
           (org_id, surface_key, session_id, turn_id, step_index, ts, model, provider,
            schema_version, sha256, body_bytes, body_gzip_b64, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        write.org,
        write.surfaceKey,
        write.sessionId,
        write.turnId,
        write.stepIndex,
        write.ts,
        write.model,
        write.provider,
        write.schemaVersion,
        write.sha256,
        write.bodyBytes,
        write.bodyGzipB64,
        write.truncated ? 1 : 0,
      );
  },

  async modelCallCapturesForSession(org, sessionId, opts = {}) {
    const includeBody = opts.includeBody !== false;
    const bodyCol = includeBody ? "body_gzip_b64" : "'' AS body_gzip_b64";
    const where = ["org_id = ?", "session_id = ?"];
    const params: (string | number)[] = [org, sessionId];
    if (opts.turnId !== undefined) {
      where.push("turn_id = ?");
      params.push(opts.turnId);
    }
    const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : "";
    const rows = getDb()
      .prepare(
        `SELECT seq, surface_key, session_id, turn_id, step_index, ts, model, provider,
                schema_version, sha256, body_bytes, ${bodyCol}, truncated
         FROM model_call_capture WHERE ${where.join(" AND ")} ORDER BY seq ASC${limit}`,
      )
      .all(...params) as ModelCallCaptureDbRow[];
    return rows.map((r) => modelCallCaptureFromRow(org, r));
  },

  async modelCallCaptureSessions(org) {
    const rows = getDb()
      .prepare(
        `SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS row_count, SUM(body_bytes) AS total_bytes
         FROM model_call_capture WHERE org_id = ?
         GROUP BY session_id
         ORDER BY MAX(ts) DESC`,
      )
      .all(org) as { session_id: string; first_ts: string; last_ts: string; row_count: number; total_bytes: number | null }[];
    return rows.map(
      (r): ModelCallCaptureSessionRow => ({
        sessionId: r.session_id,
        firstTs: r.first_ts,
        lastTs: r.last_ts,
        rowCount: Number(r.row_count),
        totalBytes: Number(r.total_bytes ?? 0),
      }),
    );
  },

  async deleteModelCallCapturesForSession(org, sessionId) {
    return Number(getDb().prepare("DELETE FROM model_call_capture WHERE org_id = ? AND session_id = ?").run(org, sessionId).changes);
  },

  async addMemoryProposal(write: MemoryProposalWrite) {
    const result = getDb()
      .prepare(
        `INSERT INTO memory_proposal (org_id, kind, scope, summary, before_text, after_text, detail_json, principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        write.org,
        write.kind,
        write.scope,
        write.summary,
        write.before ?? null,
        write.after ?? null,
        write.detail ? JSON.stringify(write.detail) : null,
        write.principalId,
        write.createdAt,
      );
    return { ...write, id: Number(result.lastInsertRowid) } as MemoryProposalRow;
  },

  async listMemoryProposals(org) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, scope, summary, before_text, after_text, detail_json, principal_id, created_at
         FROM memory_proposal WHERE org_id = ? ORDER BY id DESC`,
      )
      .all(org) as {
      id: number;
      kind: string;
      scope: string;
      summary: string;
      before_text: string | null;
      after_text: string | null;
      detail_json: string | null;
      principal_id: string;
      created_at: string;
    }[];
    return rows.map(
      (r): MemoryProposalRow => ({
        id: r.id,
        org,
        kind: r.kind,
        scope: r.scope,
        summary: r.summary,
        ...(r.before_text !== null ? { before: r.before_text } : {}),
        ...(r.after_text !== null ? { after: r.after_text } : {}),
        ...(r.detail_json ? { detail: JSON.parse(r.detail_json) as Record<string, unknown> } : {}),
        principalId: r.principal_id,
        createdAt: r.created_at,
      }),
    );
  },

  async getDmAudience(org, address) {
    const row = getDb()
      .prepare("SELECT address, first_dm_at, stopped_at FROM dm_audience WHERE org_id = ? AND address = ?")
      .get(org, address) as { address: string; first_dm_at: string | null; stopped_at: string | null } | undefined;
    return row ? dmAudienceRowFrom(row) : null;
  },

  async markDmAudienceDelivered(org, address, at) {
    getDb()
      .prepare(
        `INSERT INTO dm_audience (org_id, address, first_dm_at, stopped_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT (org_id, address) DO UPDATE SET first_dm_at = COALESCE(dm_audience.first_dm_at, excluded.first_dm_at)`,
      )
      .run(org, address, at);
  },

  async setDmAudienceStopped(org, address, at) {
    getDb()
      .prepare(
        `INSERT INTO dm_audience (org_id, address, first_dm_at, stopped_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT (org_id, address) DO UPDATE SET stopped_at = COALESCE(dm_audience.stopped_at, excluded.stopped_at)`,
      )
      .run(org, address, at);
  },

  async clearDmAudienceStopped(org, address) {
    return (
      getDb()
        .prepare("UPDATE dm_audience SET stopped_at = NULL WHERE org_id = ? AND address = ? AND stopped_at IS NOT NULL")
        .run(org, address).changes > 0
    );
  },

  async listDmAudience(org) {
    const rows = getDb()
      .prepare("SELECT address, first_dm_at, stopped_at FROM dm_audience WHERE org_id = ? ORDER BY address")
      .all(org) as { address: string; first_dm_at: string | null; stopped_at: string | null }[];
    return rows.map(dmAudienceRowFrom);
  },

  async getPersonalBrowser(org, principalKey) {
    const row = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_browser WHERE org_id = ? AND principal_key = ?")
      .get(org, principalKey) as PersonalBrowserSqliteRow | undefined;
    return row ? personalBrowserRowFrom(row) : null;
  },

  async casPersonalBrowser(org, principalKey, stateJson, at, expected) {
    const db = getDb();
    if (expected === null) {
      const changes = db
        .prepare("INSERT INTO personal_browser (org_id, principal_key, state_json, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (org_id, principal_key) DO NOTHING")
        .run(org, principalKey, stateJson, at).changes;
      return changes > 0 ? 1 : null;
    }
    const changes = db
      .prepare("UPDATE personal_browser SET state_json = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND principal_key = ? AND version = ?")
      .run(stateJson, at, org, principalKey, expected).changes;
    return changes > 0 ? expected + 1 : null;
  },

  async deletePersonalBrowser(org, principalKey) {
    return getDb().prepare("DELETE FROM personal_browser WHERE org_id = ? AND principal_key = ?").run(org, principalKey).changes > 0;
  },

  async listPersonalBrowsers(org) {
    const rows = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_browser WHERE org_id = ? ORDER BY principal_key")
      .all(org) as unknown as PersonalBrowserSqliteRow[];
    return rows.map(personalBrowserRowFrom);
  },

  async getPersonalWatch(org, principalKey) {
    const row = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_watch WHERE org_id = ? AND principal_key = ?")
      .get(org, principalKey) as PersonalBrowserSqliteRow | undefined;
    return row ? personalWatchRowFrom(row) : null;
  },

  async casPersonalWatch(org, principalKey, stateJson, at, expected) {
    const db = getDb();
    if (expected === null) {
      const changes = db
        .prepare("INSERT INTO personal_watch (org_id, principal_key, state_json, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (org_id, principal_key) DO NOTHING")
        .run(org, principalKey, stateJson, at).changes;
      return changes > 0 ? 1 : null;
    }
    const changes = db
      .prepare("UPDATE personal_watch SET state_json = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND principal_key = ? AND version = ?")
      .run(stateJson, at, org, principalKey, expected).changes;
    return changes > 0 ? expected + 1 : null;
  },

  async listPersonalWatches(org) {
    const rows = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_watch WHERE org_id = ? ORDER BY principal_key")
      .all(org) as unknown as PersonalBrowserSqliteRow[];
    return rows.map(personalWatchRowFrom);
  },

  async getRoomWatch(org, surfaceKey) {
    const row = getDb().prepare("SELECT surface_key, state_json, version, updated_at FROM room_watch WHERE org_id = ? AND surface_key = ?").get(org, surfaceKey) as
      | { surface_key: string; state_json: string; version: number; updated_at: string }
      | undefined;
    return row ? { surfaceKey: row.surface_key, stateJson: row.state_json, version: Number(row.version), updatedAt: row.updated_at } : null;
  },

  async casRoomWatch(org, surfaceKey, stateJson, at, expected) {
    const db = getDb();
    if (expected === null) {
      const changes = db
        .prepare("INSERT INTO room_watch (org_id, surface_key, state_json, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (org_id, surface_key) DO NOTHING")
        .run(org, surfaceKey, stateJson, at).changes;
      return changes > 0 ? 1 : null;
    }
    const changes = db
      .prepare("UPDATE room_watch SET state_json = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND surface_key = ? AND version = ?")
      .run(stateJson, at, org, surfaceKey, expected).changes;
    return changes > 0 ? expected + 1 : null;
  },

  async getMemoryCanvas(org, surfaceKey) {
    const row = getDb().prepare("SELECT surface_key, canvas_id, updated_at FROM memory_canvas WHERE org_id = ? AND surface_key = ?").get(org, surfaceKey) as
      | { surface_key: string; canvas_id: string; updated_at: string }
      | undefined;
    return row ? { surfaceKey: row.surface_key, canvasId: row.canvas_id, updatedAt: row.updated_at } : null;
  },

  async setMemoryCanvas(org, surfaceKey, canvasId, at) {
    getDb()
      .prepare("INSERT INTO memory_canvas (org_id, surface_key, canvas_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, surface_key) DO UPDATE SET canvas_id = excluded.canvas_id, updated_at = excluded.updated_at")
      .run(org, surfaceKey, canvasId, at);
  },

  async getPersonalCover(org, principalKey) {
    const row = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_cover WHERE org_id = ? AND principal_key = ?")
      .get(org, principalKey) as PersonalBrowserSqliteRow | undefined;
    return row ? personalCoverRowFrom(row) : null;
  },

  async casPersonalCover(org, principalKey, stateJson, at, expected) {
    const db = getDb();
    if (expected === null) {
      const changes = db
        .prepare("INSERT INTO personal_cover (org_id, principal_key, state_json, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (org_id, principal_key) DO NOTHING")
        .run(org, principalKey, stateJson, at).changes;
      return changes > 0 ? 1 : null;
    }
    const changes = db
      .prepare("UPDATE personal_cover SET state_json = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND principal_key = ? AND version = ?")
      .run(stateJson, at, org, principalKey, expected).changes;
    return changes > 0 ? expected + 1 : null;
  },

  async listPersonalCovers(org) {
    const rows = getDb()
      .prepare("SELECT principal_key, state_json, version, updated_at FROM personal_cover WHERE org_id = ? ORDER BY principal_key")
      .all(org) as unknown as PersonalBrowserSqliteRow[];
    return rows.map(personalCoverRowFrom);
  },

  async getPersonOptOut(org, principalKey) {
    const row = getDb()
      .prepare("SELECT principal_key, opted_out_at FROM person_opt_out WHERE org_id = ? AND principal_key = ?")
      .get(org, principalKey) as { principal_key: string; opted_out_at: string | null } | undefined;
    return row ? personOptOutRowFrom(row) : null;
  },

  async setPersonOptOut(org, principalKey, at) {
    const db = getDb();
    if (db.prepare("INSERT INTO person_opt_out (org_id, principal_key, opted_out_at) VALUES (?, ?, ?) ON CONFLICT (org_id, principal_key) DO NOTHING").run(org, principalKey, at).changes > 0) {
      return true;
    }
    return (
      db.prepare("UPDATE person_opt_out SET opted_out_at = ? WHERE org_id = ? AND principal_key = ? AND opted_out_at IS NULL").run(at, org, principalKey).changes > 0
    );
  },

  async clearPersonOptOut(org, principalKey) {
    return (
      getDb()
        .prepare("UPDATE person_opt_out SET opted_out_at = NULL WHERE org_id = ? AND principal_key = ? AND opted_out_at IS NOT NULL")
        .run(org, principalKey).changes > 0
    );
  },

  async listDmRules(org, surfaceKey) {
    const rows = getDb()
      .prepare(`SELECT ${DM_RULE_COLUMNS} FROM dm_rule WHERE org_id = ? AND surface_key = ? ORDER BY created_at, rule_id`)
      .all(org, surfaceKey) as DmRuleDbRow[];
    return rows.map((r) => dmRuleRowFrom(org, r));
  },

  async upsertDmRule(row) {
    getDb()
      .prepare(
        `INSERT INTO dm_rule (org_id, surface_key, rule_id, owner_id, rule, subject_json, source_action_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, surface_key, rule_id) DO UPDATE SET
           owner_id = excluded.owner_id, rule = excluded.rule, subject_json = excluded.subject_json,
           source_action_id = excluded.source_action_id, updated_at = excluded.updated_at`,
      )
      .run(row.org, row.surfaceKey, row.ruleId, row.ownerId, row.rule, row.subjectJson, row.sourceActionId, row.createdAt, row.updatedAt);
  },

  async removeDmRule(org, surfaceKey, ruleId) {
    const info = getDb().prepare("DELETE FROM dm_rule WHERE org_id = ? AND surface_key = ? AND rule_id = ?").run(org, surfaceKey, ruleId);
    return info.changes > 0;
  },

  async recordAttentionState(row) {
    const db = getDb();
    db.prepare("DELETE FROM attention_state WHERE org_id = ? AND updated_at < ?").run(row.org, attentionPruneBefore(row.updatedAt));
    db.prepare(
      `INSERT INTO attention_state (org_id, session_id, state, summary, surface_key, channel_id, thread_ts, person_platform, person_id, since, updated_at, pinged_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (org_id, session_id) DO UPDATE SET
         since = CASE WHEN attention_state.state = excluded.state THEN attention_state.since ELSE excluded.since END,
         state = excluded.state, summary = excluded.summary, surface_key = excluded.surface_key, channel_id = excluded.channel_id,
         thread_ts = excluded.thread_ts, person_platform = excluded.person_platform, person_id = excluded.person_id, updated_at = excluded.updated_at`,
    ).run(row.org, row.sessionId, row.state, row.summary, row.surfaceKey, row.channelId, row.threadTs, row.personPlatform, row.personId, row.updatedAt, row.updatedAt);
    const stored = db.prepare(`SELECT ${ATTENTION_COLUMNS} FROM attention_state WHERE org_id = ? AND session_id = ?`).get(row.org, row.sessionId) as AttentionDbRow;
    return attentionRowFrom(row.org, stored);
  },

  async listAttentionWaitingOn(org, personPlatform, personId, sinceIso) {
    const rows = getDb()
      .prepare(
        `SELECT ${ATTENTION_COLUMNS} FROM attention_state
         WHERE org_id = ? AND person_platform = ? AND person_id = ? AND state IN ('needs_input', 'blocked') AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(org, personPlatform, personId, sinceIso) as AttentionDbRow[];
    return rows.map((r) => attentionRowFrom(org, r));
  },

  async claimAttentionPing(org, sessionId, since) {
    const info = getDb()
      .prepare(
        `UPDATE attention_state SET pinged_since = ?
         WHERE org_id = ? AND session_id = ? AND state = 'blocked' AND since = ? AND (pinged_since IS NULL OR pinged_since <> ?)`,
      )
      .run(since, org, sessionId, since, since);
    return info.changes > 0;
  },

  exitTables: {
    async readRows(table, org, offset, limit) {
      const { sql, params } = buildExitSelectPage("qmark", table, org, offset, limit);
      return getDb().prepare(sql).all(...(params as (string | number)[])) as Record<string, unknown>[];
    },
    async selectDistinct(table, org, column, filter, page) {
      const { sql, params } = buildExitSelectDistinct("qmark", table, org, column, filter, page);
      return (getDb().prepare(sql).all(...(params as (string | number)[])) as { v: unknown }[]).map((r) => String(r.v));
    },
    async deleteRows(table, org, filter) {
      const { sql, params } = buildExitDelete("qmark", table, org, filter);
      return getDb().prepare(sql).all(...(params as (string | number)[])).length;
    },
  },

  async runAnalyticsQuery(compiled) {
    const { sql, params } = assembleAnalyticsSql(compiled, "qmark");
    return getDb().prepare(sql).all(...(params as (string | number | null)[])) as Record<string, unknown>[];
  },

  async enqueueIngressDelivery(org, write) {
    const handle = getDb();
    handle
      .prepare("DELETE FROM ingress_delivery WHERE org_id = ? AND source = ? AND completed_at IS NOT NULL AND retain_until IS NOT NULL AND retain_until <= ?")
      .run(org, write.source, write.receivedAt);
    const info = handle
      .prepare(
        `INSERT OR IGNORE INTO ingress_delivery
           (org_id, source, authority_id, delivery_id, payload_json, received_at, available_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(org, write.source, write.authorityId, write.deliveryId, write.payloadJson, write.receivedAt, write.receivedAt);
    return info.changes > 0;
  },

  async listDueIngressDeliveries(org, source, nowIso, staleBeforeIso, limit) {
    const rows = getDb()
      .prepare(
        `SELECT authority_id, delivery_id, received_at, available_at
           FROM ingress_delivery
          WHERE org_id = ? AND source = ? AND completed_at IS NULL AND payload_json IS NOT NULL
            AND available_at <= ?
            AND (claim_id IS NULL OR (claimed_at IS NOT NULL AND claimed_at <= ?))
          ORDER BY received_at ASC, authority_id ASC, delivery_id ASC
          LIMIT ?`,
      )
      .all(org, source, nowIso, staleBeforeIso, Math.max(0, Math.trunc(limit))) as Array<{
        authority_id: string;
        delivery_id: string;
        received_at: string;
        available_at: string;
      }>;
    return rows.map((row): DueIngressDelivery => ({
      source,
      authorityId: row.authority_id,
      deliveryId: row.delivery_id,
      receivedAt: row.received_at,
      availableAt: row.available_at,
    }));
  },

  async claimIngressDelivery(org, key, claimId, claimedAtIso, staleBeforeIso) {
    const row = getDb()
      .prepare(
        `UPDATE ingress_delivery SET claim_id = ?, claimed_at = ?
          WHERE org_id = ? AND source = ? AND authority_id = ? AND delivery_id = ?
            AND completed_at IS NULL AND payload_json IS NOT NULL AND available_at <= ?
            AND (claim_id IS NULL OR (claimed_at IS NOT NULL AND claimed_at <= ?))
        RETURNING payload_json, received_at, available_at`,
      )
      .get(claimId, claimedAtIso, org, key.source, key.authorityId, key.deliveryId, claimedAtIso, staleBeforeIso) as
      | { payload_json: string; received_at: string; available_at: string }
      | undefined;
    return row
      ? ({
          ...key,
          payloadJson: row.payload_json,
          receivedAt: row.received_at,
          availableAt: row.available_at,
          claimId,
          claimedAt: claimedAtIso,
        } satisfies ClaimedIngressDelivery)
      : null;
  },

  async releaseIngressDelivery(org, key, claimId, availableAtIso) {
    const info = getDb()
      .prepare(
        `UPDATE ingress_delivery SET claim_id = NULL, claimed_at = NULL, available_at = ?
          WHERE org_id = ? AND source = ? AND authority_id = ? AND delivery_id = ?
            AND completed_at IS NULL AND claim_id = ?`,
      )
      .run(availableAtIso, org, key.source, key.authorityId, key.deliveryId, claimId);
    return info.changes > 0;
  },

  async completeIngressDelivery(org, key, claimId, completedAtIso, retainUntilIso) {
    assertIngressDeliveryRetainUntil(completedAtIso, retainUntilIso);
    const info = getDb()
      .prepare(
        `UPDATE ingress_delivery
            SET payload_json = NULL, claim_id = NULL, claimed_at = NULL,
                completed_at = ?, retain_until = ?
          WHERE org_id = ? AND source = ? AND authority_id = ? AND delivery_id = ?
            AND completed_at IS NULL AND claim_id = ?`,
      )
      .run(completedAtIso, retainUntilIso, org, key.source, key.authorityId, key.deliveryId, claimId);
    return info.changes > 0;
  },

  async discardIngressDelivery(org, key, claimId) {
    const info = getDb()
      .prepare(
        `DELETE FROM ingress_delivery
          WHERE org_id = ? AND source = ? AND authority_id = ? AND delivery_id = ?
            AND completed_at IS NULL AND claim_id = ?`,
      )
      .run(org, key.source, key.authorityId, key.deliveryId, claimId);
    return info.changes > 0;
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

  async claimNotice(org, key, at) {
    const info = getDb().prepare("INSERT OR IGNORE INTO notice_claim (org_id, key, claimed_at) VALUES (?, ?, ?)").run(org, key, at);
    return info.changes > 0;
  },

  async noticeClaimed(org, key) {
    const row = getDb().prepare("SELECT 1 FROM notice_claim WHERE org_id = ? AND key = ? LIMIT 1").get(org, key);
    return row !== undefined;
  },

  async recordProactiveAddress(org, row) {
    getDb()
      .prepare(
        `INSERT INTO proactive_address (org_id, platform, kind, ref_key, tenant, address, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, platform, kind, ref_key) DO UPDATE SET
           tenant = excluded.tenant, address = excluded.address, updated_at = excluded.updated_at`,
      )
      .run(org, row.platform, row.kind, row.refKey, row.tenant, JSON.stringify(row.address ?? {}), row.updatedAt);
  },

  async proactiveAddress(org, platform, kind, refKey) {
    const row = getDb()
      .prepare("SELECT tenant, address, updated_at FROM proactive_address WHERE org_id = ? AND platform = ? AND kind = ? AND ref_key = ?")
      .get(org, platform, kind, refKey) as { tenant: string; address: string; updated_at: string } | undefined;
    return row ? proactiveAddressRow(platform, kind, refKey, row.tenant, row.address, row.updated_at) : undefined;
  },

  async proactiveAddresses(org, platform, kind, limit) {
    const rows = getDb()
      .prepare(
        `SELECT ref_key, tenant, address, updated_at FROM proactive_address
         WHERE org_id = ? AND platform = ? AND kind = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(org, platform, kind, Math.max(0, Math.trunc(limit))) as { ref_key: string; tenant: string; address: string; updated_at: string }[];
    return rows.map((r) => proactiveAddressRow(platform, kind, r.ref_key, r.tenant, r.address, r.updated_at));
  },

  async hasEventSeen(org, key, at, ttlMs) {
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    const row = getDb()
      .prepare("SELECT 1 FROM event_dedupe WHERE org_id = ? AND key = ? AND seen_at >= ? LIMIT 1")
      .get(org, key, cutoff);
    return row !== undefined;
  },

  async forgetEventSeen(org, key) {
    getDb().prepare("DELETE FROM event_dedupe WHERE org_id = ? AND key = ?").run(org, key);
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

  async putUnifiedWakeTarget(org, wakeId, targetJson, at, ttlMs, windowToken, inbound) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM unified_wake_target WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO unified_wake_target (org_id, wake_id, target_json, created_at, window_token, inbound) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, wake_id) DO UPDATE SET target_json = excluded.target_json, created_at = excluded.created_at, window_token = excluded.window_token,
           inbound = MAX(COALESCE(excluded.inbound, 0), COALESCE(unified_wake_target.inbound, 0))`,
      )
      .run(org, wakeId, targetJson, at, windowToken ?? null, inbound === true ? 1 : 0);
  },

  async getUnifiedWakeTarget(org, wakeId) {
    const row = getDb().prepare("SELECT target_json FROM unified_wake_target WHERE org_id = ? AND wake_id = ?").get(org, wakeId) as
      | { target_json: string }
      | undefined;
    return row?.target_json ?? null;
  },

  async getUnifiedWakeRecord(org, wakeId) {
    const row = getDb()
      .prepare("SELECT target_json, created_at, window_token, answered_at, answered_turn_id, audited_at, inbound FROM unified_wake_target WHERE org_id = ? AND wake_id = ?")
      .get(org, wakeId) as
      | { target_json: string; created_at: string; window_token: string | null; answered_at: string | null; answered_turn_id: string | null; audited_at: string | null; inbound: number | null }
      | undefined;
    if (!row) return null;
    return {
      targetJson: row.target_json,
      createdAt: row.created_at,
      ...(row.window_token !== null ? { windowToken: row.window_token } : {}),
      ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
      ...(row.answered_turn_id !== null ? { answeredTurnId: row.answered_turn_id } : {}),
      ...(row.audited_at !== null ? { auditedAt: row.audited_at } : {}),
      ...(row.inbound !== null ? { inbound: row.inbound === 1 } : {}),
    };
  },

  async listPendingUnifiedWakes(org, windowToken, afterIso, limit) {
    const rows = getDb()
      .prepare(
        `SELECT wake_id, target_json, created_at FROM unified_wake_target
         WHERE org_id = ? AND window_token = ? AND answered_at IS NULL AND inbound = 1 AND created_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(org, windowToken, afterIso, limit) as { wake_id: string; target_json: string; created_at: string }[];
    return rows.map((r) => ({ wakeId: r.wake_id, targetJson: r.target_json, createdAt: r.created_at }));
  },

  async listUnauditedUnifiedWakes(org, windowToken, limit) {
    const rows = getDb()
      .prepare(
        `SELECT wake_id, target_json, created_at FROM unified_wake_target
         WHERE org_id = ? AND window_token = ? AND answered_at IS NULL AND inbound = 1 AND audited_at IS NULL
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(org, windowToken, limit) as { wake_id: string; target_json: string; created_at: string }[];
    return rows.map((r) => ({ wakeId: r.wake_id, targetJson: r.target_json, createdAt: r.created_at }));
  },

  async markUnifiedWakesAudited(org, wakeIds, at) {
    if (wakeIds.length === 0) return;
    const stmt = getDb().prepare("UPDATE unified_wake_target SET audited_at = ? WHERE org_id = ? AND wake_id = ? AND audited_at IS NULL");
    for (const wakeId of wakeIds) stmt.run(at, org, wakeId);
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

  async putThreadSeatState(org, row, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM thread_seat_state WHERE updated_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO thread_seat_state (org_id, channel_key, thread_key, seat_token, parent_key, state, origin_json, report, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, channel_key, thread_key) DO UPDATE SET
           seat_token = excluded.seat_token,
           parent_key = excluded.parent_key,
           state = excluded.state,
           origin_json = excluded.origin_json,
           report = excluded.report,
           opened_at = excluded.opened_at,
           updated_at = excluded.updated_at`,
      )
      .run(org, row.channelKey, row.threadKey, row.seatToken, row.parentRegistryKey, row.state, row.originJson, row.report ?? null, row.openedAt, at);
  },

  async getThreadSeatState(org, channelKey, threadKey) {
    const row = getDb()
      .prepare("SELECT seat_token, parent_key, state, origin_json, report, opened_at, updated_at FROM thread_seat_state WHERE org_id = ? AND channel_key = ? AND thread_key = ?")
      .get(org, channelKey, threadKey) as
      | { seat_token: string; parent_key: string; state: string; origin_json: string; report: string | null; opened_at: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      channelKey,
      threadKey,
      seatToken: row.seat_token,
      parentRegistryKey: row.parent_key,
      state: readThreadSeatStateValue(row.state),
      originJson: row.origin_json,
      ...(row.report !== null ? { report: row.report } : {}),
      openedAt: row.opened_at,
      updatedAt: row.updated_at,
    };
  },

  async touchThreadSeat(org, channelKey, threadKey, at) {
    const handle = getDb();
    handle.prepare("UPDATE thread_ownership SET created_at = ? WHERE org_id = ? AND channel_key = ? AND thread_key = ?").run(at, org, channelKey, threadKey);
    return (
      handle
        .prepare("UPDATE thread_seat_state SET updated_at = ? WHERE org_id = ? AND channel_key = ? AND thread_key = ? AND state = 'open'")
        .run(at, org, channelKey, threadKey).changes > 0
    );
  },

  async closeThreadSeatState(org, channelKey, threadKey, seatToken, state, report, at) {
    return (
      getDb()
        .prepare(
          `UPDATE thread_seat_state SET state = ?, report = COALESCE(?, report), updated_at = ?
           WHERE org_id = ? AND channel_key = ? AND thread_key = ? AND seat_token = ?
             AND (state = 'open' OR (state = 'expired' AND ? = 'completed'))`,
        )
        .run(state, report, at, org, channelKey, threadKey, seatToken, state).changes > 0
    );
  },

  async listIdleThreadSeats(org, before, limit) {
    const rows = getDb()
      .prepare(
        "SELECT channel_key, thread_key, seat_token, parent_key, state, origin_json, report, opened_at, updated_at FROM thread_seat_state WHERE org_id = ? AND state = 'open' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
      )
      .all(org, before, limit) as { channel_key: string; thread_key: string; seat_token: string; parent_key: string; state: string; origin_json: string; report: string | null; opened_at: string; updated_at: string }[];
    return rows.map((row) => ({
      channelKey: row.channel_key,
      threadKey: row.thread_key,
      seatToken: row.seat_token,
      parentRegistryKey: row.parent_key,
      state: readThreadSeatStateValue(row.state),
      originJson: row.origin_json,
      ...(row.report !== null ? { report: row.report } : {}),
      openedAt: row.opened_at,
      updatedAt: row.updated_at,
    }));
  },

  async putTurnAnchor(org, anchor, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM turn_anchor WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO turn_anchor (org_id, window_key, anchor_key, channel_key, session_id, turn_id, surface_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, window_key) DO UPDATE SET
           anchor_key = excluded.anchor_key, channel_key = excluded.channel_key,
           session_id = excluded.session_id, turn_id = excluded.turn_id,
           surface_key = excluded.surface_key, created_at = excluded.created_at`,
      )
      .run(org, anchor.windowKey, anchor.anchorKey ?? null, anchor.channelKey ?? null, anchor.sessionId, anchor.turnId, anchor.surfaceKey, at);
  },

  async getTurnAnchorByWindow(org, windowKey) {
    return readTurnAnchorRow(getDb().prepare(`${TURN_ANCHOR_SELECT} WHERE org_id = ? AND window_key = ?`).get(org, windowKey));
  },

  async getTurnAnchorByAnchor(org, anchorKey) {
    return readTurnAnchorRow(getDb().prepare(`${TURN_ANCHOR_SELECT} WHERE org_id = ? AND anchor_key = ?`).get(org, anchorKey));
  },

  async getLatestTurnAnchorForChannel(org, channelKey) {
    return readTurnAnchorRow(
      getDb().prepare(`${TURN_ANCHOR_SELECT} WHERE org_id = ? AND channel_key = ? ORDER BY created_at DESC, window_key DESC LIMIT 1`).get(org, channelKey),
    );
  },

  async clearTurnAnchor(org, windowKey) {
    return getDb().prepare("DELETE FROM turn_anchor WHERE org_id = ? AND window_key = ?").run(org, windowKey).changes > 0;
  },

  async putTaskResult(org, taskId, resultJson, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM task_result WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    handle
      .prepare(
        `INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (org_id, task_id) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at`,
      )
      .run(org, taskId, resultJson, at);
  },

  async putTaskResultIfAbsent(org, taskId, resultJson, at, ttlMs) {
    const handle = getDb();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    handle.prepare("DELETE FROM task_result WHERE created_at < ? AND org_id = ?").run(cutoff, org);
    const info = handle
      .prepare(`INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, task_id) DO NOTHING`)
      .run(org, taskId, resultJson, at);
    return info.changes > 0;
  },

  async casTaskResult(org, taskId, resultJson, at, ttlMs, expected) {
    const handle = getDb();
    if (expected === null) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      handle.prepare("DELETE FROM task_result WHERE created_at < ? AND org_id = ?").run(cutoff, org);
      return (
        handle.prepare(`INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, task_id) DO NOTHING`).run(org, taskId, resultJson, at)
          .changes > 0
      );
    }
    return (
      handle.prepare("UPDATE task_result SET result_json = ?, created_at = ? WHERE org_id = ? AND task_id = ? AND result_json = ?").run(resultJson, at, org, taskId, expected)
        .changes > 0
    );
  },

  async getTaskResult(org, taskId) {
    const row = getDb().prepare("SELECT result_json FROM task_result WHERE org_id = ? AND task_id = ?").get(org, taskId) as
      | { result_json?: string }
      | undefined;
    return typeof row?.result_json === "string" ? row.result_json : null;
  },

  async deleteTaskResult(org, taskId) {
    return getDb().prepare("DELETE FROM task_result WHERE org_id = ? AND task_id = ?").run(org, taskId).changes > 0;
  },

  async deleteTaskResultIf(org, taskId, expectedJson) {
    return getDb().prepare("DELETE FROM task_result WHERE org_id = ? AND task_id = ? AND result_json = ?").run(org, taskId, expectedJson).changes > 0;
  },

  async deleteTaskResultIfUnstopped(org, taskId, expectedJson, surfaceKey, threadTs) {
    return (
      getDb()
        .prepare(
          `DELETE FROM task_result WHERE org_id = ? AND task_id = ? AND result_json = ?
             AND NOT EXISTS (SELECT 1 FROM thread_engagement WHERE org_id = ? AND surface_key = ? AND thread_ts = ? AND stopped = 1)`,
        )
        .run(org, taskId, expectedJson, org, surfaceKey, threadTs).changes > 0
    );
  },

  async putMeetingData(org, key, valueJson, at, expiresAt) {
    const handle = getDb();
    handle.prepare("DELETE FROM meeting_data WHERE org_id = ? AND expires_at <= ?").run(org, at);
    handle
      .prepare(
        `INSERT INTO meeting_data (org_id, data_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, data_key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(org, key, valueJson, at, expiresAt);
  },

  async putMeetingDataIfAbsent(org, key, valueJson, at, expiresAt) {
    const info = getDb()
      .prepare(
        `INSERT INTO meeting_data (org_id, data_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, data_key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at, expires_at = excluded.expires_at
         WHERE meeting_data.expires_at <= excluded.created_at`,
      )
      .run(org, key, valueJson, at, expiresAt);
    return info.changes > 0;
  },

  async getMeetingData(org, key, now) {
    const row = getDb().prepare("SELECT value_json FROM meeting_data WHERE org_id = ? AND data_key = ? AND expires_at > ?").get(org, key, now) as
      | { value_json?: string }
      | undefined;
    return typeof row?.value_json === "string" ? row.value_json : null;
  },

  async deleteMeetingData(org, key) {
    return getDb().prepare("DELETE FROM meeting_data WHERE org_id = ? AND data_key = ?").run(org, key).changes > 0;
  },

  async sweepMeetingData(org, now) {
    return Number(getDb().prepare("DELETE FROM meeting_data WHERE org_id = ? AND expires_at <= ?").run(org, now).changes);
  },

  async putRoutineReportThread(org, row, at, expiresAt) {
    const handle = getDb();
    handle.prepare("DELETE FROM routine_report_thread WHERE org_id = ? AND expires_at <= ?").run(org, at);
    handle
      .prepare(
        `INSERT INTO routine_report_thread (org_id, channel_key, thread_key, routine_surface, routine_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, channel_key, thread_key) DO UPDATE SET routine_surface = excluded.routine_surface, routine_id = excluded.routine_id, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(org, row.channelKey, row.threadKey, row.routineSurface, row.routineId, at, expiresAt);
  },

  async getRoutineReportThread(org, channelKey, threadKey, now) {
    const row = getDb()
      .prepare("SELECT routine_surface, routine_id FROM routine_report_thread WHERE org_id = ? AND channel_key = ? AND thread_key = ? AND expires_at > ?")
      .get(org, channelKey, threadKey, now) as { routine_surface?: string; routine_id?: string } | undefined;
    return typeof row?.routine_surface === "string" && typeof row.routine_id === "string" ? { channelKey, threadKey, routineSurface: row.routine_surface, routineId: row.routine_id } : null;
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
        `INSERT INTO stored_credential (org_id, ref, ciphertext, connector, domain, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, ref) DO UPDATE SET
           ciphertext = excluded.ciphertext, connector = excluded.connector,
           domain = excluded.domain, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(org, rec.ref, rec.ciphertext, rec.connector ?? null, rec.domain ?? null, rec.createdBy, rec.createdAt);
  },

  async getStoredCredential(org, ref) {
    const row = getDb()
      .prepare("SELECT ref, ciphertext, connector, domain, created_by, created_at FROM stored_credential WHERE org_id = ? AND ref = ?")
      .get(org, ref) as { ref: string; ciphertext: string; connector: string | null; domain: string | null; created_by: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      ref: row.ref,
      ciphertext: row.ciphertext,
      ...(row.connector ? { connector: row.connector } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  },

  async deleteStoredCredential(org, ref) {
    return getDb().prepare("DELETE FROM stored_credential WHERE org_id = ? AND ref = ?").run(org, ref).changes > 0;
  },

  async listStoredCredentialRefs(org, refPrefix) {
    if (refPrefix) {
      const rows = getDb().prepare("SELECT ref FROM stored_credential WHERE org_id = ? AND ref LIKE ? ESCAPE '\\' ORDER BY ref").all(org, likePrefixPattern(refPrefix)) as { ref: string }[];
      return rows.map((r) => r.ref);
    }
    const rows = getDb().prepare("SELECT ref FROM stored_credential WHERE org_id = ? ORDER BY ref").all(org) as { ref: string }[];
    return rows.map((r) => r.ref);
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
        `INSERT INTO credential_intake (org_id, id, ref, connector, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.org, row.id, row.ref, row.connector, row.domain ?? null, row.requestedBy, row.channelId, row.threadTs ?? null, row.createdAt, row.expiresAt, row.usedAt ?? null);
  },

  async getCredentialIntake(org, id) {
    const row = getDb()
      .prepare(
        "SELECT id, ref, connector, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at FROM credential_intake WHERE org_id = ? AND id = ?",
      )
      .get(org, id) as
      | { id: string; ref: string; connector: string; domain: string | null; requested_by: string; channel_id: string; thread_ts: string | null; created_at: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      org,
      id: row.id,
      ref: row.ref,
      connector: row.connector,
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
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.groupKey ?? null,
        row.status,
        row.createdAt,
        row.expiresAt,
        row.decidedBy,
        row.decidedAt,
      );
  },

  async addPendingActionIfAbsent(row) {
    const info = getDb()
      .prepare(
        `INSERT INTO pending_actions
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, id) DO NOTHING`,
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
        row.groupKey ?? null,
        row.status,
        row.createdAt,
        row.expiresAt,
        row.decidedBy,
        row.decidedAt,
      );
    return info.changes > 0;
  },

  async getPendingAction(org, id) {
    const row = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND id = ?`,
      )
      .get(org, id) as PendingActionSqlRow | undefined;
    return row ? pendingActionFromRow(org, row) : null;
  },

  async listPendingActions(org) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(org) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
  },

  async listExpiredPendingActions(org, nowIso) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND status = 'pending' AND expires_at <= ? ORDER BY created_at ASC`,
      )
      .all(org, nowIso) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
  },

  async listRejectedActionsSince(org, sinceIso) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND status = 'rejected' AND decided_at >= ? ORDER BY decided_at DESC`,
      )
      .all(org, sinceIso) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
  },

  async setPendingActionMessage(org, id, messageTs) {
    getDb().prepare("UPDATE pending_actions SET message_ts = ? WHERE org_id = ? AND id = ?").run(messageTs, org, id);
  },

  async listPendingActionsForMessage(org, channelId, messageTs) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND channel_id = ? AND message_ts = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(org, channelId, messageTs) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
  },

  async decidePendingAction(org, id, status, decidedBy, decidedAt) {
    const info = getDb()
      .prepare("UPDATE pending_actions SET status = ?, decided_by = ?, decided_at = ? WHERE org_id = ? AND id = ? AND status = 'pending'")
      .run(status, decidedBy, decidedAt, org, id);
    return info.changes > 0;
  },

  async rewriteDecidedPendingActionArgs(org, id, argsJson) {
    const info = getDb()
      .prepare("UPDATE pending_actions SET args_json = ? WHERE org_id = ? AND id = ? AND status <> 'pending'")
      .run(argsJson, org, id);
    return info.changes > 0;
  },

  async listDecidedPendingActionsWithArg(org, kind, argKey) {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, group_key, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = ? AND kind = ? AND status <> 'pending' AND instr(args_json, ?) > 0 ORDER BY decided_at ASC`,
      )
      .all(org, kind, argKeyNeedle(argKey)) as PendingActionSqlRow[];
    return rows.map((r) => pendingActionFromRow(org, r));
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

  async revokeSessionApprovalsByPrefix(org, prefix) {
    if (prefix.length === 0) throw new Error("revokeSessionApprovalsByPrefix: an empty prefix would revoke every memo of the org");
    return Number(
      getDb().prepare("DELETE FROM pr_session_approval WHERE org_id = ? AND substr(session_id, 1, ?) = ?").run(org, prefix.length, prefix).changes,
    );
  },

  async sweepLegacyConnectorOpRows(org) {
    return Number(
      getDb()
        .prepare("DELETE FROM pr_session_approval WHERE org_id = ? AND session_id LIKE ? AND kind LIKE ?")
        .run(org, `${ROUTINE_PERMISSION_PREFIX}%`, `${CONNECTOR_OP_KIND_PREFIX}%`).changes,
    );
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
        `INSERT INTO identity_linked_ids (org_id, platform, tenant, native_id, link_set_id, status, established_by, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, platform, tenant, native_id) DO NOTHING`,
      )
      .run(org, row.platform, row.tenant, row.nativeId, row.linkSetId, row.status, row.establishedBy, row.evidenceJson ?? null, row.createdAt, row.updatedAt).changes;
    return Number(changes) > 0;
  },

  async getLinkedId(org, platform, tenant, nativeId) {
    const row = getDb()
      .prepare(`${LINKED_ID_SQLITE_SELECT} WHERE org_id = ? AND platform = ? AND tenant = ? AND native_id = ?`)
      .get(org, platform, tenant, nativeId) as LinkedIdSqliteRow | undefined;
    return row ? linkedIdFromSqliteRow(org, row) : null;
  },

  async listLinkedIds(org, linkSetId) {
    const sql = `${LINKED_ID_SQLITE_SELECT} WHERE org_id = ?${linkSetId === undefined ? "" : " AND link_set_id = ?"} ORDER BY platform ASC, tenant ASC, native_id ASC`;
    const rows = (linkSetId === undefined ? getDb().prepare(sql).all(org) : getDb().prepare(sql).all(org, linkSetId)) as LinkedIdSqliteRow[];
    return rows.map((r) => linkedIdFromSqliteRow(org, r));
  },

  async updateLinkedIdStatus(org, platform, tenant, nativeId, from, to, establishedBy, evidenceJson, at) {
    const changes = getDb()
      .prepare(
        `UPDATE identity_linked_ids SET status = ?, established_by = ?, evidence = ?, updated_at = ?
         WHERE org_id = ? AND platform = ? AND tenant = ? AND native_id = ? AND status IN (${placeholders(from.length)})`,
      )
      .run(to, establishedBy, evidenceJson ?? null, at, org, platform, tenant, nativeId, ...from).changes;
    return Number(changes) > 0;
  },

  async deleteLinkedId(org, platform, tenant, nativeId) {
    return Number(getDb().prepare("DELETE FROM identity_linked_ids WHERE org_id = ? AND platform = ? AND tenant = ? AND native_id = ?").run(org, platform, tenant, nativeId).changes) > 0;
  },

  async revokeLinkedIdsForSet(org, linkSetId, at) {
    return Number(
      getDb().prepare("UPDATE identity_linked_ids SET status = 'revoked', updated_at = ? WHERE org_id = ? AND link_set_id = ? AND status <> 'revoked'").run(at, org, linkSetId).changes,
    );
  },

  async unbackfilledLinkedIdPlatforms() {
    const rows = getDb().prepare("SELECT DISTINCT platform FROM identity_linked_ids WHERE tenant = '' ORDER BY platform ASC").all() as { platform: string }[];
    return rows.map((r) => r.platform);
  },

  async backfillLinkedIdTenant(platform, tenant, at) {
    return Number(getDb().prepare("UPDATE identity_linked_ids SET tenant = ?, updated_at = ? WHERE platform = ? AND tenant = ''").run(tenant, at, platform).changes);
  },

  async addLinkChallenge(org, row) {
    getDb()
      .prepare(
        `INSERT INTO identity_link_challenges
           (org_id, id, nonce_hash, initiating_platform, initiating_tenant, initiating_native_id, initiating_surface_key,
            claimed_platform, claimed_tenant, claimed_native_id, claimed_at,
            transport, target_platform, target_tenant, target_native_id, back_nonce_hash,
            status, created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        org,
        row.id,
        row.nonceHash,
        row.initiatingPlatform,
        row.initiatingTenant,
        row.initiatingNativeId,
        row.initiatingSurfaceKey,
        row.claimedPlatform ?? null,
        row.claimedTenant ?? null,
        row.claimedNativeId ?? null,
        row.claimedAt ?? null,
        row.transport,
        row.targetPlatform ?? null,
        row.targetTenant ?? null,
        row.targetNativeId ?? null,
        row.backNonceHash ?? null,
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
    if (filter?.initiatingTenant !== undefined) {
      conjuncts.push("initiating_tenant = ?");
      params.push(filter.initiatingTenant);
    }
    if (filter?.initiatingNativeId !== undefined) {
      conjuncts.push("initiating_native_id = ?");
      params.push(filter.initiatingNativeId);
    }
    if (filter?.targetPlatform !== undefined) {
      conjuncts.push("target_platform = ?");
      params.push(filter.targetPlatform);
    }
    if (filter?.targetTenant !== undefined) {
      conjuncts.push("target_tenant = ?");
      params.push(filter.targetTenant);
    }
    if (filter?.targetNativeId !== undefined) {
      conjuncts.push("target_native_id = ?");
      params.push(filter.targetNativeId);
    }
    if (filter?.claimedPlatform !== undefined) {
      conjuncts.push("claimed_platform = ?");
      params.push(filter.claimedPlatform);
    }
    if (filter?.claimedTenant !== undefined) {
      conjuncts.push("claimed_tenant = ?");
      params.push(filter.claimedTenant);
    }
    if (filter?.claimedNativeId !== undefined) {
      conjuncts.push("claimed_native_id = ?");
      params.push(filter.claimedNativeId);
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

  async claimLinkChallenge(org, nonceHash, platform, tenant, nativeId, at, backNonceHash) {
    const db = getDb();
    const changes = db
      .prepare(
        `UPDATE identity_link_challenges SET claimed_platform = ?, claimed_tenant = ?, claimed_native_id = ?, claimed_at = ?, back_nonce_hash = ?, status = 'claimed'
         WHERE org_id = ? AND nonce_hash = ? AND status = 'pending' AND expires_at > ?
           AND NOT (initiating_platform = ? AND initiating_tenant = ? AND initiating_native_id = ?)`,
      )
      .run(platform, tenant, nativeId, at, backNonceHash ?? null, org, nonceHash, at, platform, tenant, nativeId).changes;
    if (Number(changes) === 0) return null;
    const row = db.prepare(`${LINK_CHALLENGE_SQLITE_SELECT} WHERE org_id = ? AND nonce_hash = ? AND claimed_at = ?`).get(org, nonceHash, at) as LinkChallengeSqliteRow | undefined;
    return row ? linkChallengeFromSqliteRow(org, row) : null;
  },

  async consentLinkChallenge(org, id, consenter, at, backNonceHash) {
    const db = getDb();
    const changes = db
      .prepare(
        `UPDATE identity_link_challenges SET claimed_platform = ?, claimed_tenant = ?, claimed_native_id = ?, claimed_at = ?, back_nonce_hash = ?, status = 'claimed'
         WHERE org_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
           AND target_platform = ? AND target_tenant = ? AND target_native_id = ?`,
      )
      .run(consenter.platform, consenter.tenant, consenter.nativeId, at, backNonceHash ?? null, org, id, at, consenter.platform, consenter.tenant, consenter.nativeId).changes;
    if (Number(changes) === 0) return null;
    const row = db.prepare(`${LINK_CHALLENGE_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as LinkChallengeSqliteRow | undefined;
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

  async addCredentialGrantAsk(org, row) {
    refuseHalfBorrow("credential_grant_ask", row);
    getDb()
      .prepare(
        `INSERT INTO credential_grant_ask
           (org_id, id, requester_principal_id, owner_principal_id, owner_slug, owner_platform, owner_native_id, connector, verb, resource,
            mcp_tool, frozen_args, tool_name,
            scope_key, domain_scope_key, purpose, requester_target, card_surface_id, card_message_id, requested_mode, status, created_at, expires_at, decided_at, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        org,
        row.id,
        row.requesterPrincipalId,
        row.ownerPrincipalId,
        row.ownerSlug,
        row.ownerPlatform,
        row.ownerNativeId,
        row.connector,
        row.verb,
        row.resource,
        row.mcpTool ?? null,
        grantJsonColumn(row.frozenArgs),
        row.toolName ?? null,
        row.scopeKey,
        row.domainScopeKey ?? null,
        row.purpose,
        row.requesterTarget ?? null,
        row.cardSurfaceId ?? null,
        row.cardMessageId ?? null,
        row.requestedMode,
        row.status,
        row.createdAt,
        row.expiresAt,
        row.decidedAt ?? null,
        row.grantId ?? null,
      );
  },

  async setCredentialGrantAskCard(org, id, surfaceId, messageId) {
    getDb().prepare("UPDATE credential_grant_ask SET card_surface_id = ?, card_message_id = ? WHERE org_id = ? AND id = ?").run(surfaceId, messageId, org, id);
  },

  async getCredentialGrantAsk(org, id) {
    const row = getDb().prepare(`${GRANT_ASK_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as GrantAskSqliteRow | undefined;
    return row ? grantAskFromSqliteRow(row) : null;
  },

  async liveCredentialGrantAsk(org, requesterPrincipalId, ownerPrincipalId, verb, resource, nowIso) {
    const row = getDb()
      .prepare(
        `${GRANT_ASK_SQLITE_SELECT}
         WHERE org_id = ? AND requester_principal_id = ? AND owner_principal_id = ? AND verb = ? AND resource = ?
           AND status = 'pending' AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(org, requesterPrincipalId, ownerPrincipalId, verb, resource, nowIso) as GrantAskSqliteRow | undefined;
    return row ? grantAskFromSqliteRow(row) : null;
  },

  async approveCredentialGrantAsk(org, id, mode, grantId, at) {
    const db = getDb();
    const changes = db
      .prepare(
        `UPDATE credential_grant_ask SET status = 'approved', requested_mode = ?, grant_id = ?, decided_at = ?
         WHERE org_id = ? AND id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(mode, grantId, at, org, id, at).changes;
    if (Number(changes) === 0) return null;
    const row = db.prepare(`${GRANT_ASK_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as GrantAskSqliteRow | undefined;
    return row ? grantAskFromSqliteRow(row) : null;
  },

  async decideCredentialGrantAsk(org, id, from, to, at) {
    const changes = getDb()
      .prepare(`UPDATE credential_grant_ask SET status = ?, decided_at = ? WHERE org_id = ? AND id = ? AND status IN (${placeholders(from.length)})`)
      .run(to, at, org, id, ...from).changes;
    return Number(changes) > 0;
  },

  async listExpiredCredentialGrantAsks(org, nowIso) {
    const rows = getDb()
      .prepare(`${GRANT_ASK_SQLITE_SELECT} WHERE org_id = ? AND status = 'pending' AND expires_at <= ? ORDER BY created_at ASC`)
      .all(org, nowIso) as GrantAskSqliteRow[];
    return rows.map(grantAskFromSqliteRow);
  },

  async pendingCredentialGrantAsksForScope(org, scopeKey, nowIso) {
    const rows = getDb()
      .prepare(`${GRANT_ASK_SQLITE_SELECT} WHERE org_id = ? AND scope_key = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC`)
      .all(org, scopeKey, nowIso) as GrantAskSqliteRow[];
    return rows.map(grantAskFromSqliteRow);
  },

  async addCredentialGrant(org, row) {
    refuseHalfBorrow("credential_grant", row);
    getDb()
      .prepare(
        `INSERT INTO credential_grant
           (org_id, id, ask_id, requester_principal_id, owner_principal_id, owner_slug, connector, verb, resource,
            mcp_tool, frozen_args, tool_name, input_schema,
            scope_key, mode, tier, status, purpose, created_at, expires_at, used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        org,
        row.id,
        row.askId,
        row.requesterPrincipalId,
        row.ownerPrincipalId,
        row.ownerSlug,
        row.connector,
        row.verb,
        row.resource,
        row.mcpTool ?? null,
        grantJsonColumn(row.frozenArgs),
        row.toolName ?? null,
        grantJsonColumn(row.inputSchema),
        row.scopeKey,
        row.mode,
        row.tier,
        row.status,
        row.purpose,
        row.createdAt,
        row.expiresAt,
        row.usedAt ?? null,
        row.revokedAt ?? null,
      );
  },

  async getCredentialGrant(org, id) {
    const row = getDb().prepare(`${GRANT_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as GrantSqliteRow | undefined;
    return row ? grantFromSqliteRow(row) : null;
  },

  async credentialGrantsForScope(org, scopeKey) {
    const rows = getDb()
      .prepare(`${GRANT_SQLITE_SELECT} WHERE org_id = ? AND scope_key = ? ORDER BY created_at DESC`)
      .all(org, scopeKey) as GrantSqliteRow[];
    return rows.map(grantFromSqliteRow);
  },

  async liveStandingCredentialGrantsForScope(org, scopeKey, nowIso) {
    const rows = getDb()
      .prepare(
        `${GRANT_SQLITE_SELECT} WHERE org_id = ? AND scope_key = ? AND mode = 'standing' AND status = 'active'
           AND expires_at > ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(org, scopeKey, nowIso) as GrantSqliteRow[];
    return rows.map(grantFromSqliteRow);
  },

  async liveCredentialGrantsForOwner(org, ownerPrincipalId, nowIso) {
    const rows = getDb()
      .prepare(`${GRANT_SQLITE_SELECT} WHERE org_id = ? AND owner_principal_id = ? AND status = 'active' AND expires_at > ? ORDER BY created_at ASC`)
      .all(org, ownerPrincipalId, nowIso) as GrantSqliteRow[];
    return rows.map(grantFromSqliteRow);
  },

  async liveBorrowCredentialGrant(org, ownerPrincipalId, connector, mcpTool, frozenArgsDigest, scopeKey, nowIso) {
    const rows = getDb()
      .prepare(
        `${GRANT_SQLITE_SELECT} WHERE org_id = ? AND owner_principal_id = ? AND connector = ? AND mcp_tool = ? AND scope_key = ?
           AND status = 'active' AND expires_at > ? ORDER BY created_at DESC`,
      )
      .all(org, ownerPrincipalId, connector, mcpTool, scopeKey, nowIso) as GrantSqliteRow[];
    for (const r of rows) {
      const row = grantFromSqliteRow(r);
      if (row.frozenArgs !== undefined && grantFrozenArgsDigest(row.frozenArgs) === frozenArgsDigest) return row;
    }
    return null;
  },

  async burnCredentialGrant(org, id, at) {
    const db = getDb();
    const changes = db
      .prepare(`UPDATE credential_grant SET status = 'used', used_at = ? WHERE org_id = ? AND id = ? AND status = 'active' AND expires_at > ?`)
      .run(at, org, id, at).changes;
    if (Number(changes) === 0) return null;
    const row = db.prepare(`${GRANT_SQLITE_SELECT} WHERE org_id = ? AND id = ?`).get(org, id) as GrantSqliteRow | undefined;
    return row ? grantFromSqliteRow(row) : null;
  },

  async refundCredentialGrant(org, id, burnedAt) {
    const changes = getDb()
      .prepare(
        `UPDATE credential_grant SET status = 'active', used_at = NULL
         WHERE org_id = ? AND id = ? AND status = 'used' AND used_at = ? AND revoked_at IS NULL`,
      )
      .run(org, id, burnedAt).changes;
    return Number(changes) > 0;
  },

  async claimCredentialGrantRefund(org, id, turnKey, cap) {
    const key = turnKey ?? null;
    const seq = grantRefundTurnOrdinal(turnKey) ?? null;
    const rolls = "(? IS NOT NULL AND ((refund_turn IS NULL AND refund_turn_seq IS NULL) OR ? > refund_turn_seq))";
    const changes = getDb()
      .prepare(
        `UPDATE credential_grant
            SET refund_turn = CASE WHEN ${rolls} THEN ? ELSE refund_turn END,
                refund_turn_seq = CASE WHEN ${rolls} THEN ? ELSE refund_turn_seq END,
                refund_count = CASE WHEN ${rolls} THEN 1 ELSE COALESCE(refund_count, 0) + 1 END
          WHERE org_id = ? AND id = ?
            AND (${rolls} OR COALESCE(refund_count, 0) < ?)`,
      )
      .run(seq, seq, key, seq, seq, seq, seq, seq, org, id, seq, seq, cap).changes;
    return Number(changes) > 0;
  },

  async revokeCredentialGrant(org, id, at) {
    const db = getDb();
    const changes = db
      .prepare("UPDATE credential_grant SET status = 'revoked', revoked_at = ? WHERE org_id = ? AND id = ? AND status = 'active'")
      .run(at, org, id).changes;
    if (Number(changes) > 0) return true;
    db.prepare("UPDATE credential_grant SET revoked_at = ? WHERE org_id = ? AND id = ? AND status = 'used' AND revoked_at IS NULL").run(at, org, id);
    return false;
  },

  async expireCredentialGrants(org, nowIso) {
    return Number(
      getDb()
        .prepare("UPDATE credential_grant SET status = 'expired' WHERE org_id = ? AND status = 'active' AND expires_at <= ?")
        .run(org, nowIso).changes,
    );
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
