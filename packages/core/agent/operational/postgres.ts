import type { Routine } from "../routines/routine.js";
import type { PgClient } from "../memory/postgres.js";
import { assertSpendLimitAmount, assertDomainModelPick, routinePromptRevisionWrites, spendLedgerConjuncts, CAPTURE_MAX_RETENTION_MS, EVENT_DEDUPE_MAX_RETENTION_MS, type AuditChainRow, type AuditEntry, type AuditFilter, type CapLevel, type CredentialIntakeRow, type LinkChallengeRow, type LinkChallengeStatus, type LinkSetRow, type LinkSetStatus, type LinkedIdRow, type LinkedIdStatus, type OperationalStore, type SlackAttachmentRow, type SpendLedgerFilter, type SpendLedgerRow, type SpendLedgerWrite, type SpendTotals, type StoredCredentialRow, type UsageEventEntry, type UsageSummaryFilter } from "./store.js";
import type { PendingActionRow, PendingStatus } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";
import { auditRowSha } from "../audit/chain.js";
import { assembleAnalyticsSql } from "../analytics/compile.js";

export type { PgClient } from "../memory/postgres.js";
export { setOrgContext } from "../memory/postgres.js";

const ORG_GUC =
  `(org_id = current_setting('app.current_org', true)
     OR NULLIF(current_setting('app.current_org', true), '') IS NULL)`;

const SCHEMA_STATEMENTS: readonly string[] = [
  `DO $$ BEGIN
     IF to_regclass('public.spend_ledger') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'spend_ledger' AND column_name = 'usd_micros'
     ) THEN
       EXECUTE 'DROP TABLE spend_ledger';
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS spend_ledger (
     org_id             text   NOT NULL,
     surface_key        text   NOT NULL,
     principal_id       text   NOT NULL DEFAULT '',  -- '' = unattributed (PK columns can't be NULL)
     routine_id         text   NOT NULL DEFAULT '',  -- '' = not a routine turn
     model              text   NOT NULL DEFAULT '',  -- '' = no model (unstamped call; sandbox runtime)
     period             text   NOT NULL,
     input_tokens       bigint NOT NULL DEFAULT 0,
     output_tokens      bigint NOT NULL DEFAULT 0,
     cache_read_tokens  bigint NOT NULL DEFAULT 0,
     cache_write_tokens bigint NOT NULL DEFAULT 0,
     usd_micros         bigint NOT NULL DEFAULT 0,   -- millionths of a dollar, priced at write
     calls              bigint NOT NULL DEFAULT 0,
     PRIMARY KEY (org_id, surface_key, principal_id, routine_id, model, period)
   )`,
  `CREATE TABLE IF NOT EXISTS routine (
     org_id      text NOT NULL,
     id          text NOT NULL,
     surface_key text NOT NULL,
     data        text NOT NULL,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS routine_prompt_revisions (
     seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id      text NOT NULL,
     surface_key text NOT NULL,
     routine_id  text NOT NULL,
     prompt      text NOT NULL,
     generation  integer,
     authored_by text,
     armed_by    text,
     approval_id text,
     recorded_at text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS routine_prompt_revisions_org_surface_routine ON routine_prompt_revisions (org_id, surface_key, routine_id, seq)`,
  `CREATE TABLE IF NOT EXISTS audit_entry (
     seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     ts           text NOT NULL,
     org_id       text NOT NULL,
     platform     text NOT NULL,
     workspace    text NOT NULL,
     surface      text,
     principal_id text,
     action       text NOT NULL,
     detail       text,
     prev_sha     text                        -- sha256 of the org's previous row (OPE-52 hash chain); NULL = genesis
   )`,
  `CREATE INDEX IF NOT EXISTS audit_org_ts ON audit_entry (org_id, ts)`,
  `CREATE TABLE IF NOT EXISTS spend_limit (
     org_id         text   NOT NULL,
     scope_key      text   NOT NULL,
     level          text   NOT NULL,          -- "surface" | "workspace" | "domain" (free-text, no CHECK)
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
     org_id        text    NOT NULL,
     surface_key   text    NOT NULL,
     thread_ts     text    NOT NULL,
     engaged_at    text    NOT NULL,
     last_turn_at  text    NOT NULL,
     participating boolean NOT NULL DEFAULT false, -- true = invited participant; false = warm watcher
     silent_streak integer NOT NULL DEFAULT 0,     -- consecutive silent woken turns since last engage/participation
     stopped       boolean NOT NULL DEFAULT false, -- true = an explicit stop landed (window path); suppress non-mention wakes until re-invited
     PRIMARY KEY (org_id, surface_key, thread_ts)
   )`,
  `CREATE TABLE IF NOT EXISTS channel_session (
     org_id             text    NOT NULL,
     surface_key        text    NOT NULL,
     token              text    NOT NULL,
     generation         integer NOT NULL,
     created_at         text    NOT NULL,
     last_wake_at       text    NOT NULL,
     turn_count         integer NOT NULL DEFAULT 0,
     input_tokens_total bigint,               -- measured cumulative input+cacheRead for this generation (§2 #551); NULL = unknown ⇒ rotate
     first_wake_at      text,                 -- ISO-8601 of the first delivered wake (H7c); NULL = none yet ⇒ still fresh
     handoff_note       text,                 -- rolling distilled channel state for the next generation (§5); NULL = none
     PRIMARY KEY (org_id, surface_key)
   )`,
  `CREATE TABLE IF NOT EXISTS event_dedupe (
     org_id  text NOT NULL,
     key     text NOT NULL,
     seen_at text NOT NULL,
     PRIMARY KEY (org_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_capture (
     org_id      text   NOT NULL,
     source      text   NOT NULL,
     seq         integer NOT NULL,
     captured_at text   NOT NULL,
     document    text   NOT NULL,
     PRIMARY KEY (org_id, source, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS unified_wake_target (
     org_id           text NOT NULL,
     wake_id          text NOT NULL,
     target_json      text NOT NULL,
     created_at       text NOT NULL,
     window_token     text,
     answered_at      text,
     answered_turn_id text,
     PRIMARY KEY (org_id, wake_id)
   )`,
  `CREATE TABLE IF NOT EXISTS thread_ownership (
     org_id      text NOT NULL,
     channel_key text NOT NULL,
     thread_key  text NOT NULL,
     task_token  text NOT NULL,
     created_at  text NOT NULL,
     PRIMARY KEY (org_id, channel_key, thread_key)
   )`,
  `CREATE TABLE IF NOT EXISTS task_result (
     org_id       text NOT NULL,
     task_id      text NOT NULL,
     result_json  text NOT NULL,
     created_at   text NOT NULL,
     caller_token text,
     delivered_at text,
     PRIMARY KEY (org_id, task_id)
   )`,
  `CREATE TABLE IF NOT EXISTS slack_attachment (
     org_id      text NOT NULL,
     file_id     text NOT NULL,
     url_private text NOT NULL,
     mime_type   text,
     name        text,
     team_id     text,
     created_at  text NOT NULL,
     PRIMARY KEY (org_id, file_id)
   )`,
  `CREATE TABLE IF NOT EXISTS stored_credential (
     org_id     text NOT NULL,
     ref        text NOT NULL,
     ciphertext text NOT NULL,
     provider   text,
     domain     text,
     created_by text NOT NULL,
     created_at text NOT NULL,
     PRIMARY KEY (org_id, ref)
   )`,
  `CREATE TABLE IF NOT EXISTS credential_intake (
     org_id       text NOT NULL,
     id           text NOT NULL,
     ref          text NOT NULL,
     provider     text NOT NULL,
     domain       text,
     requested_by text NOT NULL,
     channel_id   text NOT NULL,
     thread_ts    text,
     created_at   text NOT NULL,
     expires_at   text NOT NULL,
     used_at      text,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_capture_window (
     org_id        text NOT NULL,
     hook_id       text NOT NULL,
     capture_until text NOT NULL,
     armed_by      text NOT NULL,
     armed_at      text NOT NULL,
     PRIMARY KEY (org_id, hook_id)
   )`,
  `CREATE TABLE IF NOT EXISTS github_installation (
     org_id               text NOT NULL,
     owner                text NOT NULL,
     installation_id      text NOT NULL,
     account_type         text,
     repository_selection text,
     updated_at           text NOT NULL,
     PRIMARY KEY (org_id, owner)
   )`,
  `CREATE TABLE IF NOT EXISTS pr_session_approval (
     org_id     text NOT NULL,
     session_id text NOT NULL,
     kind       text NOT NULL,
     granted_by text NOT NULL,
     created_at text NOT NULL,
     expires_at text NOT NULL,
     PRIMARY KEY (org_id, session_id, kind)
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
     posted_to    text,
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
  `CREATE TABLE IF NOT EXISTS domain_skill_revisions (
     seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id      text NOT NULL,
     domain      text NOT NULL,
     name        text NOT NULL,
     content     text NOT NULL,
     authored_by text,
     armed_by    text,
     approval_id text,
     recorded_at text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS domain_skill_revisions_org_domain_name ON domain_skill_revisions (org_id, domain, name, seq)`,
  `CREATE TABLE IF NOT EXISTS domain_model (
     org_id     text NOT NULL,
     domain     text NOT NULL,
     model_id   text,
     reasoning  text,
     set_by     text,
     updated_at text NOT NULL,
     PRIMARY KEY (org_id, domain)
   )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
     seq                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id             text   NOT NULL,
     surface_key        text   NOT NULL,
     session_id         text   NOT NULL,
     principal_id       text,
     ts                 text   NOT NULL,
     kind               text,
     routine_id         text,
     input_tokens       bigint NOT NULL DEFAULT 0,
     output_tokens      bigint NOT NULL DEFAULT 0,
     cache_read_tokens  bigint NOT NULL DEFAULT 0,
     cache_write_tokens bigint NOT NULL DEFAULT 0,
     model              text,
     detail             text
   )`,
  `CREATE INDEX IF NOT EXISTS usage_events_org_session ON usage_events (org_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS usage_events_org_surface_ts ON usage_events (org_id, surface_key, ts)`,
  `CREATE TABLE IF NOT EXISTS identity_link_sets (
     org_id     text NOT NULL,
     id         text NOT NULL,
     handle     text NOT NULL,          -- DISPLAY ONLY: admin lists + audit rows, never a lookup key
     status     text NOT NULL,          -- "active" | "suspended" | "revoked" ("revoked" is terminal)
     created_at text NOT NULL,
     updated_at text NOT NULL,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS identity_linked_ids (
     org_id         text NOT NULL,
     platform       text NOT NULL,
     native_id      text NOT NULL,
     link_set_id    text NOT NULL,
     status         text NOT NULL,      -- "suggested" | "confirmed" | "revoked" ("revoked" is terminal)
     established_by text NOT NULL,      -- "challenge:<id>" | "config-import" | "directory-sync:<provider>"
     evidence       text,               -- the structured evidence record as JSON; opaque here
     created_at     text NOT NULL,
     updated_at     text NOT NULL,
     PRIMARY KEY (org_id, platform, native_id)
   )`,
  `CREATE INDEX IF NOT EXISTS identity_linked_ids_org_set ON identity_linked_ids (org_id, link_set_id)`,
  `CREATE TABLE IF NOT EXISTS identity_link_challenges (
     org_id                 text NOT NULL,
     id                     text NOT NULL,
     nonce_hash             text NOT NULL,   -- sha-256 hex of the uppercased code; NEVER the code
     initiating_platform    text NOT NULL,
     initiating_native_id   text NOT NULL,
     initiating_surface_key text NOT NULL,   -- the DM the ratification must come back to
     claimed_platform       text,            -- stamped from the WAKE's own captured author
     claimed_native_id      text,
     claimed_at             text,
     status                 text NOT NULL,   -- pending | claimed | ratified | denied | expired
     created_at             text NOT NULL,
     expires_at             text NOT NULL,
     decided_at             text,
     PRIMARY KEY (org_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS identity_link_challenges_org_nonce ON identity_link_challenges (org_id, nonce_hash)`,
  `CREATE TABLE IF NOT EXISTS identity_oauth_vault_grants (
     org_id         text NOT NULL,
     link_set_id    text NOT NULL,
     connector      text NOT NULL,
     platform       text NOT NULL,
     native_id      text NOT NULL,
     established_at text NOT NULL,
     PRIMARY KEY (org_id, link_set_id, connector, platform, native_id)
   )`,
  `CREATE INDEX IF NOT EXISTS identity_oauth_vault_grants_org_account ON identity_oauth_vault_grants (org_id, platform, native_id)`,
  `CREATE TABLE IF NOT EXISTS instance_meta (
     key   text PRIMARY KEY,
     value text NOT NULL
   )`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS expires_at bigint`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS reason text`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS set_by text`,
  `ALTER TABLE spend_limit ADD COLUMN IF NOT EXISTS monthly_usd double precision`,
  `ALTER TABLE connector_override ADD COLUMN IF NOT EXISTS reason text`,
  `ALTER TABLE connector_override ADD COLUMN IF NOT EXISTS set_by text`,
  `ALTER TABLE thread_engagement ADD COLUMN IF NOT EXISTS participating boolean NOT NULL DEFAULT false`,
  `ALTER TABLE thread_engagement ADD COLUMN IF NOT EXISTS silent_streak integer NOT NULL DEFAULT 0`,
  `ALTER TABLE thread_engagement ADD COLUMN IF NOT EXISTS owner_token text`,
  `ALTER TABLE thread_engagement ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'thread'`,
  `ALTER TABLE thread_engagement ADD COLUMN IF NOT EXISTS stopped boolean NOT NULL DEFAULT false`,
  `ALTER TABLE channel_session ADD COLUMN IF NOT EXISTS input_tokens_total bigint`,
  `ALTER TABLE channel_session ADD COLUMN IF NOT EXISTS first_wake_at text`,
  `ALTER TABLE channel_session ADD COLUMN IF NOT EXISTS handoff_note text`,
  `ALTER TABLE task_result ADD COLUMN IF NOT EXISTS caller_token text`,
  `ALTER TABLE task_result ADD COLUMN IF NOT EXISTS delivered_at text`,
  `ALTER TABLE unified_wake_target ADD COLUMN IF NOT EXISTS window_token text`,
  `ALTER TABLE unified_wake_target ADD COLUMN IF NOT EXISTS answered_at text`,
  `ALTER TABLE unified_wake_target ADD COLUMN IF NOT EXISTS answered_turn_id text`,
  `ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS posted_to text`,
  `ALTER TABLE stored_credential ADD COLUMN IF NOT EXISTS claim_id text`,
  `ALTER TABLE stored_credential ADD COLUMN IF NOT EXISTS claimed_at text`,
  `ALTER TABLE audit_entry ADD COLUMN IF NOT EXISTS prev_sha text`,
  `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS routine_id text`,
  `ALTER TABLE spend_ledger ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE routine ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE spend_limit ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE connector_override ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE thread_engagement ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE channel_session ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE event_dedupe ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE webhook_capture ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE unified_wake_target ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE thread_ownership ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE task_result ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE slack_attachment ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE stored_credential ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE credential_intake ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE webhook_capture_window ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE github_installation ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE domain_skill ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE domain_skill_revisions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE routine_prompt_revisions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE domain_model ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pr_session_approval ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE identity_link_sets ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE identity_linked_ids ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE identity_link_challenges ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE identity_oauth_vault_grants ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE audit_entry FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE usage_events FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE domain_skill_revisions FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE routine_prompt_revisions FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS spend_org_isolation ON spend_ledger`,
  `DROP POLICY IF EXISTS routine_org_isolation ON routine`,
  `DROP POLICY IF EXISTS audit_select ON audit_entry`,
  `DROP POLICY IF EXISTS audit_insert ON audit_entry`,
  `DROP POLICY IF EXISTS spend_limit_org_isolation ON spend_limit`,
  `DROP POLICY IF EXISTS connector_override_org_isolation ON connector_override`,
  `DROP POLICY IF EXISTS thread_engagement_org_isolation ON thread_engagement`,
  `DROP POLICY IF EXISTS channel_session_org_isolation ON channel_session`,
  `DROP POLICY IF EXISTS event_dedupe_org_isolation ON event_dedupe`,
  `DROP POLICY IF EXISTS webhook_capture_org_isolation ON webhook_capture`,
  `DROP POLICY IF EXISTS unified_wake_target_org_isolation ON unified_wake_target`,
  `DROP POLICY IF EXISTS thread_ownership_org_isolation ON thread_ownership`,
  `DROP POLICY IF EXISTS task_result_org_isolation ON task_result`,
  `DROP POLICY IF EXISTS slack_attachment_org_isolation ON slack_attachment`,
  `DROP POLICY IF EXISTS stored_credential_org_isolation ON stored_credential`,
  `DROP POLICY IF EXISTS credential_intake_org_isolation ON credential_intake`,
  `DROP POLICY IF EXISTS webhook_capture_window_org_isolation ON webhook_capture_window`,
  `DROP POLICY IF EXISTS github_installation_org_isolation ON github_installation`,
  `DROP POLICY IF EXISTS domain_skill_org_isolation ON domain_skill`,
  `DROP POLICY IF EXISTS domain_skill_revisions_select ON domain_skill_revisions`,
  `DROP POLICY IF EXISTS domain_skill_revisions_insert ON domain_skill_revisions`,
  `DROP POLICY IF EXISTS routine_prompt_revisions_select ON routine_prompt_revisions`,
  `DROP POLICY IF EXISTS routine_prompt_revisions_insert ON routine_prompt_revisions`,
  `DROP POLICY IF EXISTS domain_model_org_isolation ON domain_model`,
  `DROP POLICY IF EXISTS usage_events_select ON usage_events`,
  `DROP POLICY IF EXISTS usage_events_insert ON usage_events`,
  `DROP POLICY IF EXISTS pending_actions_org_isolation ON pending_actions`,
  `DROP POLICY IF EXISTS pr_session_approval_org_isolation ON pr_session_approval`,
  `DROP POLICY IF EXISTS identity_link_sets_org_isolation ON identity_link_sets`,
  `DROP POLICY IF EXISTS identity_linked_ids_org_isolation ON identity_linked_ids`,
  `DROP POLICY IF EXISTS identity_link_challenges_org_isolation ON identity_link_challenges`,
  `DROP POLICY IF EXISTS identity_oauth_vault_grants_org_isolation ON identity_oauth_vault_grants`,
  `CREATE POLICY spend_org_isolation ON spend_ledger
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY routine_org_isolation ON routine
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY audit_select ON audit_entry FOR SELECT USING (true)`,
  `CREATE POLICY audit_insert ON audit_entry FOR INSERT WITH CHECK (true)`,
  `CREATE POLICY spend_limit_org_isolation ON spend_limit
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY connector_override_org_isolation ON connector_override
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY thread_engagement_org_isolation ON thread_engagement
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY channel_session_org_isolation ON channel_session
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY event_dedupe_org_isolation ON event_dedupe
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY webhook_capture_org_isolation ON webhook_capture
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY unified_wake_target_org_isolation ON unified_wake_target
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY thread_ownership_org_isolation ON thread_ownership
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY task_result_org_isolation ON task_result
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY slack_attachment_org_isolation ON slack_attachment
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY stored_credential_org_isolation ON stored_credential
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY credential_intake_org_isolation ON credential_intake
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY webhook_capture_window_org_isolation ON webhook_capture_window
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY github_installation_org_isolation ON github_installation
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY domain_skill_org_isolation ON domain_skill
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY domain_skill_revisions_select ON domain_skill_revisions FOR SELECT USING (true)`,
  `CREATE POLICY domain_skill_revisions_insert ON domain_skill_revisions FOR INSERT WITH CHECK (true)`,
  `CREATE POLICY routine_prompt_revisions_select ON routine_prompt_revisions FOR SELECT USING (true)`,
  `CREATE POLICY routine_prompt_revisions_insert ON routine_prompt_revisions FOR INSERT WITH CHECK (true)`,
  `CREATE POLICY domain_model_org_isolation ON domain_model
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY usage_events_select ON usage_events FOR SELECT USING (true)`,
  `CREATE POLICY usage_events_insert ON usage_events FOR INSERT WITH CHECK (true)`,
  `CREATE POLICY pending_actions_org_isolation ON pending_actions
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY pr_session_approval_org_isolation ON pr_session_approval
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY identity_link_sets_org_isolation ON identity_link_sets
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY identity_linked_ids_org_isolation ON identity_linked_ids
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY identity_link_challenges_org_isolation ON identity_link_challenges
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY identity_oauth_vault_grants_org_isolation ON identity_oauth_vault_grants
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
];

const APPEND_ONLY_TABLES = ["audit_entry", "usage_events", "domain_skill_revisions", "routine_prompt_revisions"] as const;

interface ExpectedPolicy {
  readonly name: string;
  readonly permissive: boolean;
  readonly cmd: string;
  readonly qual: string | null;
  readonly withCheck: string | null;
}
const EXPECTED_POLICIES: Readonly<Record<string, readonly ExpectedPolicy[]>> = {
  audit_entry: [
    { name: "audit_select", permissive: true, cmd: "r", qual: "true", withCheck: null },
    { name: "audit_insert", permissive: true, cmd: "a", qual: null, withCheck: "true" },
  ],
  usage_events: [
    { name: "usage_events_select", permissive: true, cmd: "r", qual: "true", withCheck: null },
    { name: "usage_events_insert", permissive: true, cmd: "a", qual: null, withCheck: "true" },
  ],
  domain_skill_revisions: [
    { name: "domain_skill_revisions_select", permissive: true, cmd: "r", qual: "true", withCheck: null },
    { name: "domain_skill_revisions_insert", permissive: true, cmd: "a", qual: null, withCheck: "true" },
  ],
  routine_prompt_revisions: [
    { name: "routine_prompt_revisions_select", permissive: true, cmd: "r", qual: "true", withCheck: null },
    { name: "routine_prompt_revisions_insert", permissive: true, cmd: "a", qual: null, withCheck: "true" },
  ],
};

interface FoundPolicy {
  readonly name: string;
  readonly permissive: boolean;
  readonly cmd: string;
  readonly qual: string | null;
  readonly withcheck: string | null;
}

function policyMatchesExpected(p: FoundPolicy, e: ExpectedPolicy): boolean {
  return p.name === e.name && p.permissive === e.permissive && p.cmd === e.cmd && p.qual === e.qual && p.withcheck === e.withCheck;
}

async function policiesOn(client: PgClient, table: string): Promise<FoundPolicy[]> {
  const { rows } = await client.query(
    `SELECT p.polname AS name, p.polpermissive AS permissive, p.polcmd AS cmd,
            pg_get_expr(p.polqual, p.polrelid) AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
     FROM pg_policy p WHERE p.polrelid = to_regclass($1)`,
    [table],
  );
  return (rows as { name: string; permissive: boolean; cmd: string; qual: string | null; withcheck: string | null }[]).map((r) => ({
    name: r.name,
    permissive: r.permissive,
    cmd: r.cmd,
    qual: r.qual,
    withcheck: r.withcheck,
  }));
}

function triggerEvents(tgtype: number): string[] {
  const ev: string[] = [];
  if (tgtype & 4) ev.push("INSERT");
  if (tgtype & 8) ev.push("DELETE");
  if (tgtype & 16) ev.push("UPDATE");
  if (tgtype & 32) ev.push("TRUNCATE");
  return ev;
}

async function nonInternalTriggers(client: PgClient, table: string): Promise<{ name: string; tgtype: number }[]> {
  const { rows } = await client.query(
    `SELECT t.tgname AS name, t.tgtype AS tgtype
     FROM pg_trigger t WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal`,
    [table],
  );
  return (rows as { name: string; tgtype: number | string }[]).map((r) => ({ name: r.name, tgtype: Number(r.tgtype) }));
}

async function badMutationGrants(client: PgClient, table: string): Promise<{ token: string; label: string; privilege: string }[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS token,
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END          AS label,
        g.privilege_type AS privilege
     FROM (
       SELECT ae.grantee AS grantee, ae.privilege_type AS privilege_type, c.relowner AS relowner
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) ae
       WHERE c.oid = to_regclass($1)
     ) g
     LEFT JOIN pg_roles r ON r.oid = g.grantee
     WHERE g.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND g.grantee <> g.relowner`,
    [table],
  );
  return rows as { token: string; label: string; privilege: string }[];
}

async function ownsAuditTable(client: PgClient): Promise<boolean | null> {
  const { rows } = await client.query(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS is_owner
     FROM pg_class c WHERE c.oid = to_regclass('audit_entry')`,
  );
  const r = rows[0] as { is_owner: boolean } | undefined;
  return r ? r.is_owner === true : null;
}

export async function verifyAppendOnlyAudit(client: PgClient): Promise<string[]> {
  const violations: string[] = [];
  for (const table of APPEND_ONLY_TABLES) {
    const { rows } = await client.query(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [table],
    );
    const t = rows[0] as { rls: boolean; force: boolean } | undefined;
    if (!t) {
      violations.push(`${table}: table missing`);
      continue;
    }
    if (t.rls !== true) violations.push(`${table}: ROW LEVEL SECURITY is disabled`);
    if (t.force !== true) violations.push(`${table}: FORCE ROW LEVEL SECURITY is off (owner would bypass policies)`);

    const pols = await policiesOn(client, table);
    const expected = EXPECTED_POLICIES[table] ?? [];
    for (const p of pols) {
      if (p.cmd === "w" || p.cmd === "d" || p.cmd === "*") {
        violations.push(`${table}: policy "${p.name}" permits ${p.cmd === "w" ? "UPDATE" : p.cmd === "d" ? "DELETE" : "ALL"} — append-only defeated`);
      }
      if (!expected.some((e) => policyMatchesExpected(p, e))) {
        violations.push(`${table}: unexpected ${p.permissive ? "permissive" : "RESTRICTIVE"} policy "${p.name}" (cmd ${p.cmd}) — not in the append-only allowlist`);
      }
    }
    if (!pols.some((p) => p.cmd === "a")) violations.push(`${table}: no INSERT policy — appends would be denied under FORCE`);
    if (!pols.some((p) => p.cmd === "r")) violations.push(`${table}: no SELECT policy — reads would be denied under FORCE`);

    for (const tr of await nonInternalTriggers(client, table)) {
      const ev = triggerEvents(tr.tgtype);
      if (ev.some((e) => e === "INSERT" || e === "UPDATE" || e === "DELETE")) {
        violations.push(`${table}: hostile trigger "${tr.name}" (${ev.join("/")}) — could suppress or alter audit writes`);
      }
    }

    for (const g of await badMutationGrants(client, table)) {
      violations.push(`${table}: role "${g.label}" holds a ${g.privilege} grant — a non-owner could mutate the append-only log`);
    }
  }
  return violations;
}

interface HealActions {
  readonly droppedPolicies: string[];
  readonly droppedTriggers: string[];
  readonly revokedGrants: string[];
}

async function healUnexpectedArtifacts(client: PgClient): Promise<HealActions> {
  const droppedPolicies: string[] = [];
  const droppedTriggers: string[] = [];
  const revokedGrants: string[] = [];
  for (const table of APPEND_ONLY_TABLES) {
    const expected = EXPECTED_POLICIES[table] ?? [];
    for (const p of await policiesOn(client, table)) {
      if (!expected.some((e) => policyMatchesExpected(p, e))) {
        await client.query(`DROP POLICY IF EXISTS ${quoteIdent(p.name)} ON ${table}`);
        droppedPolicies.push(`${table}.${p.name}`);
      }
    }
    for (const tr of await nonInternalTriggers(client, table)) {
      await client.query(`DROP TRIGGER IF EXISTS ${quoteIdent(tr.name)} ON ${table}`);
      droppedTriggers.push(`${table}.${tr.name}`);
    }
    for (const g of await badMutationGrants(client, table)) {
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${g.token}`);
      revokedGrants.push(`${table}:${g.label}:${g.privilege}`);
    }
  }
  return { droppedPolicies, droppedTriggers, revokedGrants };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function recordAuditIntegrity(
  client: PgClient,
  violations: readonly string[],
  healed: boolean,
  heal?: HealActions,
): Promise<void> {
  const detail: Record<string, unknown> = { violations, healed };
  if (heal && (heal.droppedPolicies.length || heal.droppedTriggers.length || heal.revokedGrants.length)) {
    detail.healed_artifacts = heal;
  }
  const org = process.env.OE_ORG?.trim() || "default";
  const ts = new Date().toISOString();
  try {
    let prevSha: string | null = null;
    try {
      prevSha = await nextAuditPrevSha(client, org);
    } catch {
    }
    await client.query(
      `INSERT INTO audit_entry (ts, org_id, platform, workspace, action, detail, prev_sha)
       VALUES ($1, $2, 'db', 'postgres', 'audit.integrity', $3, $4)`,
      [ts, org, JSON.stringify(detail), prevSha],
    );
  } catch (err) {
    console.error(`[open-everywhere:operational] could not record audit.integrity row: ${String(err)}`);
  }
}

async function nextAuditPrevSha(client: PgClient, org: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha
     FROM audit_entry WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`,
    [org],
  );
  const last = rows[0] as
    | { ts: string; org_id: string; platform: string; workspace: string; surface: string | null; principal_id: string | null; action: string; detail: string | null; prev_sha: string | null }
    | undefined;
  if (!last) return null;
  return auditRowSha(
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
  );
}

export async function initOperationalSchema(client: PgClient): Promise<void> {
  const owner = await ownsAuditTable(client);

  if (owner === false) {
    const violations = await verifyAppendOnlyAudit(client);
    if (violations.length > 0) {
      await recordAuditIntegrity(client, violations, false);
      throw new Error(
        `operational schema: append-only audit posture FAILED verification under the non-owner runtime role — ${violations.join("; ")}. ` +
          "Re-run the schema init as the owner/migration role to repair it, then reboot (docs/extending/database.md, two-role split).",
      );
    }
    return;
  }

  const preViolations = owner === true ? await verifyAppendOnlyAudit(client) : [];

  const heal = owner === true ? await healUnexpectedArtifacts(client) : { droppedPolicies: [], droppedTriggers: [], revokedGrants: [] };

  try {
    for (const stmt of SCHEMA_STATEMENTS) await client.query(stmt);
  } catch (err) {
    if (owner === null) {
      throw new Error(
        `operational schema: could not create the schema (fresh database, and this role may lack CREATE) — ${String(err)}. ` +
          "Run the first boot / migration as the owner role, then point the app at the runtime role (docs/extending/database.md).",
      );
    }
    throw err;
  }

  if (preViolations.length > 0) {
    console.error(`[open-everywhere:operational] append-only audit posture was broken and has been re-applied: ${preViolations.join("; ")}`);
    await recordAuditIntegrity(client, preViolations, true, heal);
  }

  const post = await verifyAppendOnlyAudit(client);
  if (post.length > 0) {
    throw new Error(`operational schema: append-only audit posture STILL failing after apply — ${post.join("; ")}`);
  }
}

export function runtimeRoleGrantsSql(role: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`runtimeRoleGrantsSql: "${role}" is not a plain lowercase identifier`);
  }
  return [
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `REVOKE CREATE ON SCHEMA public FROM ${role}`,
    `GRANT SELECT, INSERT ON audit_entry, usage_events, domain_skill_revisions, routine_prompt_revisions TO ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_entry, usage_events, domain_skill_revisions, routine_prompt_revisions FROM ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    ...mutableTableGrantsSql(role),
    `GRANT SELECT, INSERT, DELETE ON webhook_capture TO ${role}`,
    `REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON webhook_capture FROM ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON memory_file, memory_tier TO ${role}`,
    `REVOKE TRUNCATE, REFERENCES, TRIGGER ON memory_file, memory_tier FROM ${role}`,
  ];
}

const DML_VERBS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type DmlVerb = (typeof DML_VERBS)[number];

const MUTABLE_TABLE_VERBS: Readonly<Record<string, readonly DmlVerb[]>> = {
  spend_ledger: ["SELECT", "INSERT", "UPDATE"],
  routine: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  spend_limit: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  connector_override: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  thread_engagement: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  channel_session: ["SELECT", "INSERT", "UPDATE"],
  event_dedupe: ["SELECT", "INSERT", "DELETE"],
  pending_actions: ["SELECT", "INSERT", "UPDATE"],
  domain_skill: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  domain_model: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  instance_meta: ["SELECT", "INSERT", "UPDATE"],
  thread_ownership: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  task_result: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  slack_attachment: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  stored_credential: ["SELECT", "INSERT", "UPDATE"],
  credential_intake: ["SELECT", "INSERT", "UPDATE"],
  webhook_capture_window: ["SELECT", "INSERT", "UPDATE"],
  unified_wake_target: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  github_installation: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  pr_session_approval: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  identity_link_sets: ["SELECT", "INSERT", "UPDATE"],
  identity_linked_ids: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  identity_link_challenges: ["SELECT", "INSERT", "UPDATE"],
  identity_oauth_vault_grants: ["SELECT", "INSERT", "DELETE"],
};

function mutableTableGrantsSql(role: string): string[] {
  const groups = new Map<string, { verbs: readonly DmlVerb[]; tables: string[] }>();
  for (const [table, verbs] of Object.entries(MUTABLE_TABLE_VERBS)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`runtimeRoleGrantsSql: "${table}" is not a plain lowercase identifier`);
    }
    if (!verbs.includes("SELECT")) {
      throw new Error(`runtimeRoleGrantsSql: ${table} must grant SELECT (every read, and every WHERE/RETURNING, needs it)`);
    }
    const canonical = DML_VERBS.filter((v) => verbs.includes(v));
    const key = canonical.join(", ");
    const group = groups.get(key);
    if (group) group.tables.push(table);
    else groups.set(key, { verbs: canonical, tables: [table] });
  }
  const out: string[] = [];
  for (const [key, { verbs, tables }] of groups) {
    const list = tables.join(", ");
    out.push(`GRANT ${key} ON ${list} TO ${role}`);
    const revoked = [...DML_VERBS.filter((v) => !verbs.includes(v)), "TRUNCATE", "REFERENCES", "TRIGGER"];
    out.push(`REVOKE ${revoked.join(", ")} ON ${list} FROM ${role}`);
  }
  return out;
}

const UPSERT_SPEND =
  `INSERT INTO spend_ledger
     (org_id, surface_key, principal_id, routine_id, model, period,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_micros, calls)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
   ON CONFLICT (org_id, surface_key, principal_id, routine_id, model, period) DO UPDATE SET
     input_tokens       = spend_ledger.input_tokens       + excluded.input_tokens,
     output_tokens      = spend_ledger.output_tokens      + excluded.output_tokens,
     cache_read_tokens  = spend_ledger.cache_read_tokens  + excluded.cache_read_tokens,
     cache_write_tokens = spend_ledger.cache_write_tokens + excluded.cache_write_tokens,
     usd_micros         = spend_ledger.usd_micros         + excluded.usd_micros,
     calls              = spend_ledger.calls + 1`;

function renderSpendConjuncts(conjuncts: string[], offset: number): string[] {
  let n = offset;
  return conjuncts.map((c) => c.replace("?", () => `$${++n}`));
}

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
  posted_to: string | null;
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
    postedTo: r.posted_to,
    status: r.status as PendingStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

type LinkSetPgRow = { id: string; handle: string; status: string; created_at: string; updated_at: string };

function linkSetFromPgRow(org: string, r: LinkSetPgRow): LinkSetRow {
  return { org, id: r.id, handle: r.handle, status: r.status as LinkSetStatus, createdAt: r.created_at, updatedAt: r.updated_at };
}

type LinkedIdPgRow = {
  platform: string;
  native_id: string;
  link_set_id: string;
  status: string;
  established_by: string;
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

function linkedIdFromPgRow(org: string, r: LinkedIdPgRow): LinkedIdRow {
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

const LINK_CHALLENGE_SELECT =
  `SELECT org_id, id, nonce_hash, initiating_platform, initiating_native_id, initiating_surface_key,
          claimed_platform, claimed_native_id, claimed_at, status, created_at, expires_at, decided_at
   FROM identity_link_challenges`;

type LinkChallengePgRow = {
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

function linkChallengeFromPgRow(org: string, r: LinkChallengePgRow): LinkChallengeRow {
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

type SpendLedgerPgRow = {
  org_id: string;
  surface_key: string;
  principal_id: string;
  routine_id: string;
  model: string;
  period: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  usd_micros: number | string;
  calls: number | string;
};

function spendRowFromPg(r: SpendLedgerPgRow): SpendLedgerRow {
  return {
    org: r.org_id,
    surfaceKey: r.surface_key,
    principalId: r.principal_id,
    routineId: r.routine_id,
    model: r.model,
    period: r.period,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    usdMicros: Number(r.usd_micros),
    calls: Number(r.calls),
  };
}

export function makeOperationalPostgresStore(client: PgClient): OperationalStore {
  return {
    id: "postgres",
    root: () => "postgres",

    async recordSpend(org, write: SpendLedgerWrite) {
      await client.query(UPSERT_SPEND, [
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
      ]);
    },

    async spendTotals(org, filter: SpendLedgerFilter = {}): Promise<SpendTotals> {
      const { conjuncts, params } = spendLedgerConjuncts(filter);
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(usd_micros), 0) AS usd_micros,
                COALESCE(SUM(calls), 0) AS calls
         FROM spend_ledger WHERE ${["org_id = $1", ...renderSpendConjuncts(conjuncts, 1)].join(" AND ")}`,
        [org, ...params],
      );
      const r = rows[0] as { input_tokens: number | string; output_tokens: number | string; cache_read_tokens: number | string; cache_write_tokens: number | string; usd_micros: number | string; calls: number | string };
      return {
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        usdMicros: Number(r.usd_micros),
        calls: Number(r.calls),
      };
    },

    async listSpendLedger(org?: string) {
      const { rows } =
        org !== undefined
          ? await client.query("SELECT * FROM spend_ledger WHERE org_id = $1", [org])
          : await client.query("SELECT * FROM spend_ledger");
      return (rows as SpendLedgerPgRow[]).map(spendRowFromPg);
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

    async updateRoutine(org, surfaceKey, id, patch, provenance) {
      const { rows } = await client.query("SELECT data FROM routine WHERE org_id = $1 AND id = $2 AND surface_key = $3", [org, id, surfaceKey]);
      const row = rows[0] as { data: string } | undefined;
      if (!row) return null;
      const existing = JSON.parse(row.data) as Routine;
      const updated: Routine = { ...existing, ...patch, id: existing.id, org: existing.org, surfaceKey: existing.surfaceKey };
      if (patch.prompt !== undefined && patch.prompt !== existing.prompt) {
        const prior = await client.query(
          "SELECT 1 FROM routine_prompt_revisions WHERE org_id = $1 AND surface_key = $2 AND routine_id = $3 LIMIT 1",
          [org, surfaceKey, id],
        );
        const writes = routinePromptRevisionWrites({
          existing,
          updated,
          ...(provenance ? { provenance } : {}),
          hasPriorRevisions: prior.rows.length > 0,
          nowIso: new Date().toISOString(),
        });
        for (const w of writes) {
          await client.query(
            `INSERT INTO routine_prompt_revisions (org_id, surface_key, routine_id, prompt, generation, authored_by, armed_by, approval_id, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [org, surfaceKey, id, w.prompt, w.generation, w.authoredBy ?? null, w.armedBy ?? null, w.approvalId ?? null, w.recordedAt],
          );
        }
      }
      await client.query("UPDATE routine SET data = $1 WHERE org_id = $2 AND id = $3", [JSON.stringify(updated), org, id]);
      return updated;
    },

    async listRoutinePromptRevisions(org, surfaceKey, routineId) {
      const { rows } = await client.query(
        `SELECT seq, routine_id, prompt, generation, authored_by, armed_by, approval_id, recorded_at
         FROM routine_prompt_revisions
         WHERE org_id = $1 AND surface_key = $2 AND ($3::text IS NULL OR routine_id = $3)
         ORDER BY seq`,
        [org, surfaceKey, routineId ?? null],
      );
      return (
        rows as {
          seq: number | string;
          routine_id: string;
          prompt: string;
          generation: number | string | null;
          authored_by: string | null;
          armed_by: string | null;
          approval_id: string | null;
          recorded_at: string;
        }[]
      ).map((r) => ({
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
      const prevSha = await nextAuditPrevSha(client, entry.org);
      await client.query(
        `INSERT INTO audit_entry (ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.ts,
          entry.org,
          entry.platform,
          entry.workspace,
          entry.surface ?? null,
          entry.principalId ?? null,
          entry.action,
          entry.detail ? JSON.stringify(entry.detail) : null,
          prevSha,
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

    async listAuditOrgs() {
      const { rows } = await client.query("SELECT DISTINCT org_id FROM audit_entry ORDER BY org_id");
      return (rows as { org_id: string }[]).map((r) => r.org_id);
    },

    async readAuditChain(org, opts) {
      const tail = opts?.tailLimit;
      const cols = "seq, ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha";
      const sql =
        tail && tail > 0
          ? `SELECT ${cols} FROM (
               SELECT ${cols} FROM audit_entry WHERE org_id = $1 ORDER BY seq DESC LIMIT $2
             ) sub ORDER BY seq ASC`
          : `SELECT ${cols} FROM audit_entry WHERE org_id = $1 ORDER BY seq ASC`;
      const { rows } = await client.query(sql, tail && tail > 0 ? [org, tail] : [org]);
      return (rows as {
        seq: number | string;
        ts: string;
        org_id: string;
        platform: string;
        workspace: string;
        surface: string | null;
        principal_id: string | null;
        action: string;
        detail: string | null;
        prev_sha: string | null;
      }[]).map(
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
        level: r.level as CapLevel,
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

    async setDomainModel(org, domain, pick, setBy) {
      assertDomainModelPick(pick);
      await client.query(
        `INSERT INTO domain_model (org_id, domain, model_id, reasoning, set_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, domain) DO UPDATE SET
           model_id   = excluded.model_id,
           reasoning  = excluded.reasoning,
           set_by     = excluded.set_by,
           updated_at = excluded.updated_at`,
        [org, domain, pick.modelId ?? null, pick.reasoning ?? null, setBy ?? null, new Date().toISOString()],
      );
    },

    async clearDomainModel(org, domain) {
      const { rows } = await client.query("DELETE FROM domain_model WHERE org_id = $1 AND domain = $2 RETURNING domain", [org, domain]);
      return rows.length > 0;
    },

    async getDomainModel(org, domain) {
      const { rows } = await client.query(
        "SELECT model_id, reasoning, set_by, updated_at FROM domain_model WHERE org_id = $1 AND domain = $2",
        [org, domain],
      );
      const r = rows[0] as { model_id: string | null; reasoning: string | null; set_by: string | null; updated_at: string } | undefined;
      if (!r) return null;
      return {
        org,
        domain,
        ...(r.model_id ? { modelId: r.model_id } : {}),
        ...(r.reasoning ? { reasoning: r.reasoning as ModelReasoning } : {}),
        ...(r.set_by ? { setBy: r.set_by } : {}),
        updatedAt: r.updated_at,
      };
    },

    async domainModels(org) {
      const { rows } = await client.query("SELECT domain, model_id, reasoning, set_by, updated_at FROM domain_model WHERE org_id = $1 ORDER BY domain", [org]);
      return (rows as { domain: string; model_id: string | null; reasoning: string | null; set_by: string | null; updated_at: string }[]).map((r) => ({
        org,
        domain: r.domain,
        ...(r.model_id ? { modelId: r.model_id } : {}),
        ...(r.reasoning ? { reasoning: r.reasoning as ModelReasoning } : {}),
        ...(r.set_by ? { setBy: r.set_by } : {}),
        updatedAt: r.updated_at,
      }));
    },

    async markEngaged(org, surfaceKey, threadTs, at, opts) {
      await client.query(
        `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, false)
         ON CONFLICT (org_id, surface_key, thread_ts) DO UPDATE SET
           last_turn_at  = excluded.last_turn_at,
           participating = thread_engagement.participating OR excluded.participating,
           silent_streak = CASE WHEN excluded.participating THEN 0 ELSE thread_engagement.silent_streak END,
           owner_token   = COALESCE(excluded.owner_token, thread_engagement.owner_token),
           stopped       = CASE WHEN excluded.participating THEN false ELSE thread_engagement.stopped END`,
        [org, surfaceKey, threadTs, at, at, opts?.participating ?? false, opts?.ownerToken ?? null, opts?.kind ?? "thread"],
      );
    },

    async markStopped(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        "UPDATE thread_engagement SET stopped = true WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3 RETURNING thread_ts",
        [org, surfaceKey, threadTs],
      );
      return rows.length > 0;
    },

    async bumpSilentStreak(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        `UPDATE thread_engagement SET silent_streak = silent_streak + 1
         WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3 RETURNING silent_streak`,
        [org, surfaceKey, threadTs],
      );
      const r = (rows as { silent_streak: number }[])[0];
      return r ? Number(r.silent_streak) : 0;
    },

    async getEngagement(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        "SELECT engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped FROM thread_engagement WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3",
        [org, surfaceKey, threadTs],
      );
      const r = (rows as { engaged_at: string; last_turn_at: string; participating: boolean; silent_streak: number; owner_token: string | null; kind: string | null; stopped: boolean }[])[0];
      return r
        ? {
            org,
            surfaceKey,
            threadTs,
            engagedAt: r.engaged_at,
            lastTurnAt: r.last_turn_at,
            participating: r.participating,
            silentStreak: Number(r.silent_streak),
            ...(r.owner_token ? { ownerToken: r.owner_token } : {}),
            kind: (r.kind as "thread" | "spawned" | null) ?? "thread",
            stopped: r.stopped,
          }
        : null;
    },

    async disengage(org, surfaceKey, threadTs) {
      const { rows } = await client.query(
        "DELETE FROM thread_engagement WHERE org_id = $1 AND surface_key = $2 AND thread_ts = $3 RETURNING thread_ts",
        [org, surfaceKey, threadTs],
      );
      return rows.length > 0;
    },

    async listEngagements(org) {
      const { rows } = await client.query(
        "SELECT surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, owner_token, kind, stopped FROM thread_engagement WHERE org_id = $1",
        [org],
      );
      return (rows as {
        surface_key: string;
        thread_ts: string;
        engaged_at: string;
        last_turn_at: string;
        participating: boolean;
        silent_streak: number;
        owner_token: string | null;
        kind: string | null;
        stopped: boolean;
      }[]).map((r) => ({
        org,
        surfaceKey: r.surface_key,
        threadTs: r.thread_ts,
        engagedAt: r.engaged_at,
        lastTurnAt: r.last_turn_at,
        participating: r.participating,
        silentStreak: Number(r.silent_streak),
        ...(r.owner_token ? { ownerToken: r.owner_token } : {}),
        kind: (r.kind as "thread" | "spawned" | null) ?? "thread",
        stopped: r.stopped,
      }));
    },

    async getChannelSession(org, surfaceKey) {
      const { rows } = await client.query(
        "SELECT token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, handoff_note FROM channel_session WHERE org_id = $1 AND surface_key = $2",
        [org, surfaceKey],
      );
      const r = (rows as {
        token: string; generation: number; created_at: string; last_wake_at: string; turn_count: number;
        input_tokens_total: string | number | null; first_wake_at: string | null; handoff_note: string | null;
      }[])[0];
      return r
        ? {
            org, surfaceKey, token: r.token, generation: Number(r.generation), createdAt: r.created_at,
            lastWakeAt: r.last_wake_at, turnCount: Number(r.turn_count),
            inputTokensTotal: r.input_tokens_total == null ? null : Number(r.input_tokens_total),
            firstWakeAt: r.first_wake_at ?? null,
            handoffNote: r.handoff_note ?? null,
          }
        : null;
    },

    async rotateChannelSession(org, surfaceKey, newToken, at, handoffNote) {
      const note = handoffNote ?? null;
      const { rows } = await client.query(
        `INSERT INTO channel_session (org_id, surface_key, token, generation, created_at, last_wake_at, turn_count, input_tokens_total, first_wake_at, handoff_note)
         VALUES ($1, $2, $3, 1, $4, $5, 0, 0, NULL, $6)
         ON CONFLICT (org_id, surface_key) DO UPDATE SET
           token              = excluded.token,
           generation         = channel_session.generation + 1,
           created_at         = excluded.created_at,
           last_wake_at       = excluded.last_wake_at,
           turn_count         = 0,
           input_tokens_total = 0,
           first_wake_at      = NULL,
           handoff_note       = excluded.handoff_note
         RETURNING generation`,
        [org, surfaceKey, newToken, at, at, note],
      );
      const generation = Number((rows as { generation: number | string }[])[0].generation);
      return { org, surfaceKey, token: newToken, generation, createdAt: at, lastWakeAt: at, turnCount: 0, inputTokensTotal: 0, firstWakeAt: null, handoffNote: note };
    },

    async touchChannelSession(org, surfaceKey, at) {
      await client.query(
        "UPDATE channel_session SET last_wake_at = $1, turn_count = turn_count + 1, first_wake_at = COALESCE(first_wake_at, $1) WHERE org_id = $2 AND surface_key = $3",
        [at, org, surfaceKey],
      );
    },

    async bumpChannelSessionUsage(org, surfaceKey, token, delta) {
      const { rows } = await client.query(
        "UPDATE channel_session SET input_tokens_total = COALESCE(input_tokens_total, 0) + $4 WHERE org_id = $1 AND surface_key = $2 AND token = $3 RETURNING surface_key",
        [org, surfaceKey, token, delta],
      );
      return rows.length;
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

    async putDomainSkill(org, domain, name, content, updatedBy, updatedAt, provenance) {
      await client.query(
        `INSERT INTO domain_skill_revisions (org_id, domain, name, content, authored_by, armed_by, approval_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [org, domain, name, content, updatedBy ?? null, provenance?.armedBy ?? null, provenance?.approvalId ?? null, updatedAt],
      );
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

    async listDomainSkillRevisions(org, domain, name) {
      const { rows } = await client.query(
        `SELECT seq, name, content, authored_by, armed_by, approval_id, recorded_at
         FROM domain_skill_revisions
         WHERE org_id = $1 AND domain = $2 AND ($3::text IS NULL OR name = $3)
         ORDER BY seq`,
        [org, domain, name ?? null],
      );
      return (
        rows as { seq: number | string; name: string; content: string; authored_by: string | null; armed_by: string | null; approval_id: string | null; recorded_at: string }[]
      ).map((r) => ({
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

    async appendUsageEvent(entry: UsageEventEntry) {
      await client.query(
        `INSERT INTO usage_events
           (org_id, surface_key, session_id, principal_id, ts, kind, routine_id,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
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
        ],
      );
    },

    async usageForSession(org, sessionId) {
      const { rows } = await client.query(
        `SELECT surface_key, session_id, principal_id, ts, kind, routine_id,
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
        routine_id: string | null;
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
        ...(r.routine_id ? { routineId: r.routine_id } : {}),
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
        `SELECT surface_key, principal_id, kind, routine_id, model,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM usage_events WHERE ${where.join(" AND ")}
         GROUP BY surface_key, principal_id, kind, routine_id, model`,
        params,
      );
      return (rows as {
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
      }[]).map((r) => ({
        surfaceKey: r.surface_key,
        ...(r.principal_id ? { principalId: r.principal_id } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.routine_id ? { routineId: r.routine_id } : {}),
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

    async runAnalyticsQuery(compiled) {
      const { sql, params } = assembleAnalyticsSql(compiled, "dollar");
      const { rows } = await client.query(sql, params as unknown[]);
      return rows as Record<string, unknown>[];
    },

    async markEventSeen(org, key, at, ttlMs) {
      const atMs = Date.parse(at);
      const ttlCutoff = new Date(atMs - ttlMs).toISOString();
      const maxCutoff = new Date(atMs - EVENT_DEDUPE_MAX_RETENTION_MS).toISOString();
      await client.query("DELETE FROM event_dedupe WHERE org_id = $1 AND (seen_at < $2 OR (key = $3 AND seen_at < $4))", [
        org,
        maxCutoff,
        key,
        ttlCutoff,
      ]);
      const { rows } = await client.query(
        "INSERT INTO event_dedupe (org_id, key, seen_at) VALUES ($1, $2, $3) ON CONFLICT (org_id, key) DO NOTHING RETURNING key",
        [org, key, at],
      );
      return rows.length > 0;
    },

    async captureDelivery(org, source, documentJson, at, captureUntil, maxRows) {
      const atMs = Date.parse(at);
      if (!Number.isFinite(atMs)) return false;
      const maxCutoff = new Date(atMs - CAPTURE_MAX_RETENTION_MS).toISOString();
      await client.query("DELETE FROM webhook_capture WHERE org_id = $1 AND captured_at < $2", [org, maxCutoff]);
      const untilMs = Date.parse(captureUntil);
      if (!Number.isFinite(untilMs) || atMs >= untilMs) return false;
      const { rows } = await client.query(
        "SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS max_seq FROM webhook_capture WHERE org_id = $1 AND source = $2",
        [org, source],
      );
      const agg = (rows[0] ?? {}) as { n?: unknown; max_seq?: unknown };
      const n = Number(agg.n ?? 0);
      const maxSeq = Number(agg.max_seq ?? 0);
      if (!Number.isFinite(n) || n >= maxRows) return false;
      await client.query("INSERT INTO webhook_capture (org_id, source, seq, captured_at, document) VALUES ($1, $2, $3, $4, $5)", [
        org,
        source,
        maxSeq + 1,
        at,
        documentJson,
      ]);
      return true;
    },

    async listCapturedDeliveries(org, source, limit) {
      const { rows } = await client.query(
        "SELECT seq, captured_at, document FROM webhook_capture WHERE org_id = $1 AND source = $2 ORDER BY seq ASC LIMIT $3",
        [org, source, limit],
      );
      return (rows as { seq: number | string; captured_at: string; document: string }[]).map((r) => ({
        seq: Number(r.seq),
        capturedAt: r.captured_at,
        documentJson: r.document,
      }));
    },

    async clearCapturedDeliveries(org, source) {
      await client.query("DELETE FROM webhook_capture WHERE org_id = $1 AND source = $2", [org, source]);
    },

    async putUnifiedWakeTarget(org, wakeId, targetJson, at, ttlMs, windowToken) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM unified_wake_target WHERE created_at < $1 AND org_id = $2", [cutoff, org]);
      await client.query(
        `INSERT INTO unified_wake_target (org_id, wake_id, target_json, created_at, window_token) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, wake_id) DO UPDATE SET target_json = EXCLUDED.target_json, created_at = EXCLUDED.created_at, window_token = EXCLUDED.window_token`,
        [org, wakeId, targetJson, at, windowToken ?? null],
      );
    },

    async getUnifiedWakeTarget(org, wakeId) {
      const { rows } = await client.query("SELECT target_json FROM unified_wake_target WHERE org_id = $1 AND wake_id = $2", [org, wakeId]);
      const r = (rows as { target_json: string }[])[0];
      return r ? r.target_json : null;
    },

    async getUnifiedWakeRecord(org, wakeId) {
      const { rows } = await client.query(
        "SELECT target_json, created_at, window_token, answered_at, answered_turn_id FROM unified_wake_target WHERE org_id = $1 AND wake_id = $2",
        [org, wakeId],
      );
      const r = (rows as { target_json: string; created_at: string; window_token: string | null; answered_at: string | null; answered_turn_id: string | null }[])[0];
      if (!r) return null;
      return {
        targetJson: r.target_json,
        createdAt: r.created_at,
        ...(r.window_token !== null ? { windowToken: r.window_token } : {}),
        ...(r.answered_at !== null ? { answeredAt: r.answered_at } : {}),
        ...(r.answered_turn_id !== null ? { answeredTurnId: r.answered_turn_id } : {}),
      };
    },

    async markUnifiedWakeAnswered(org, wakeId, at, turnId) {
      await client.query("UPDATE unified_wake_target SET answered_at = $1, answered_turn_id = $2 WHERE org_id = $3 AND wake_id = $4", [
        at,
        turnId ?? null,
        org,
        wakeId,
      ]);
    },

    async putThreadOwner(org, channelKey, threadKey, taskToken, at, ttlMs) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM thread_ownership WHERE created_at < $1 AND org_id = $2", [cutoff, org]);
      await client.query(
        `INSERT INTO thread_ownership (org_id, channel_key, thread_key, task_token, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, channel_key, thread_key) DO UPDATE SET task_token = EXCLUDED.task_token, created_at = EXCLUDED.created_at`,
        [org, channelKey, threadKey, taskToken, at],
      );
    },

    async getThreadOwner(org, channelKey, threadKey) {
      const { rows } = await client.query("SELECT task_token FROM thread_ownership WHERE org_id = $1 AND channel_key = $2 AND thread_key = $3", [org, channelKey, threadKey]);
      const r = (rows as { task_token: string }[])[0];
      return r ? r.task_token : null;
    },

    async clearThreadOwner(org, channelKey, threadKey) {
      const { rows } = await client.query(
        "DELETE FROM thread_ownership WHERE org_id = $1 AND channel_key = $2 AND thread_key = $3 RETURNING task_token",
        [org, channelKey, threadKey],
      );
      return rows.length > 0;
    },

    async putTaskResult(org, taskId, resultJson, at, ttlMs, callerToken) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM task_result WHERE created_at < $1 AND org_id = $2", [cutoff, org]);
      await client.query(
        `INSERT INTO task_result (org_id, task_id, result_json, created_at, caller_token) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, task_id) DO UPDATE SET result_json = EXCLUDED.result_json, created_at = EXCLUDED.created_at, caller_token = EXCLUDED.caller_token`,
        [org, taskId, resultJson, at, callerToken ?? null],
      );
    },

    async putTaskResultIfAbsent(org, taskId, resultJson, at, ttlMs, callerToken) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM task_result WHERE created_at < $1 AND org_id = $2", [cutoff, org]);
      const { rows } = await client.query(
        `INSERT INTO task_result (org_id, task_id, result_json, created_at, caller_token) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, task_id) DO NOTHING
         RETURNING task_id`,
        [org, taskId, resultJson, at, callerToken ?? null],
      );
      return rows.length > 0;
    },

    async getTaskResult(org, taskId) {
      const { rows } = await client.query("SELECT result_json FROM task_result WHERE org_id = $1 AND task_id = $2", [org, taskId]);
      const r = (rows as { result_json: string }[])[0];
      return r ? r.result_json : null;
    },

    async deleteTaskResult(org, taskId) {
      const { rows } = await client.query("DELETE FROM task_result WHERE org_id = $1 AND task_id = $2 RETURNING task_id", [org, taskId]);
      return rows.length > 0;
    },

    async listUndeliveredTaskResults(org, callerToken, limit) {
      const { rows } = await client.query(
        `SELECT task_id, result_json, created_at FROM task_result
         WHERE org_id = $1 AND caller_token = $2 AND delivered_at IS NULL
         ORDER BY created_at ASC LIMIT $3`,
        [org, callerToken, limit],
      );
      return (rows as { task_id: string; result_json: string; created_at: string }[]).map((r) => ({
        taskId: r.task_id,
        resultJson: r.result_json,
        createdAt: r.created_at,
      }));
    },

    async markTaskResultDelivered(org, taskId, at) {
      await client.query("UPDATE task_result SET delivered_at = $1 WHERE org_id = $2 AND task_id = $3 AND delivered_at IS NULL", [at, org, taskId]);
    },

    async putSlackAttachment(org, fileId, rec, at, ttlMs) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      await client.query("DELETE FROM slack_attachment WHERE created_at < $1 AND org_id = $2", [cutoff, org]);
      await client.query(
        `INSERT INTO slack_attachment (org_id, file_id, url_private, mime_type, name, team_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, file_id) DO UPDATE SET
           url_private = EXCLUDED.url_private, mime_type = EXCLUDED.mime_type,
           name = EXCLUDED.name, team_id = EXCLUDED.team_id, created_at = EXCLUDED.created_at`,
        [org, fileId, rec.urlPrivate, rec.mimeType ?? null, rec.name ?? null, rec.teamId ?? null, at],
      );
    },

    async getSlackAttachment(org, fileId) {
      const { rows } = await client.query(
        "SELECT url_private, mime_type, name, team_id FROM slack_attachment WHERE org_id = $1 AND file_id = $2",
        [org, fileId],
      );
      const r = (rows as { url_private: string; mime_type: string | null; name: string | null; team_id: string | null }[])[0];
      if (!r) return null;
      const rec: SlackAttachmentRow = {
        urlPrivate: r.url_private,
        ...(r.mime_type ? { mimeType: r.mime_type } : {}),
        ...(r.name ? { name: r.name } : {}),
        ...(r.team_id ? { teamId: r.team_id } : {}),
      };
      return rec;
    },

    async putStoredCredential(org, rec: StoredCredentialRow) {
      await client.query(
        `INSERT INTO stored_credential (org_id, ref, ciphertext, provider, domain, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, ref) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext, provider = EXCLUDED.provider,
           domain = EXCLUDED.domain, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
        [org, rec.ref, rec.ciphertext, rec.provider ?? null, rec.domain ?? null, rec.createdBy, rec.createdAt],
      );
    },

    async getStoredCredential(org, ref) {
      const { rows } = await client.query(
        "SELECT ref, ciphertext, provider, domain, created_by, created_at FROM stored_credential WHERE org_id = $1 AND ref = $2",
        [org, ref],
      );
      const r = (rows as { ref: string; ciphertext: string; provider: string | null; domain: string | null; created_by: string; created_at: string }[])[0];
      if (!r) return null;
      return {
        ref: r.ref,
        ciphertext: r.ciphertext,
        ...(r.provider ? { provider: r.provider } : {}),
        ...(r.domain ? { domain: r.domain } : {}),
        createdBy: r.created_by,
        createdAt: r.created_at,
      };
    },

    async putGitHubInstallation(org, rec) {
      await client.query(
        `INSERT INTO github_installation (org_id, owner, installation_id, account_type, repository_selection, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, owner) DO UPDATE SET installation_id = EXCLUDED.installation_id,
           account_type = EXCLUDED.account_type, repository_selection = EXCLUDED.repository_selection,
           updated_at = EXCLUDED.updated_at`,
        [org, rec.owner, rec.installationId, rec.accountType ?? null, rec.repositorySelection ?? null, rec.updatedAt],
      );
    },

    async deleteGitHubInstallation(org, owner) {
      const { rows } = await client.query("DELETE FROM github_installation WHERE org_id = $1 AND owner = $2 RETURNING owner", [org, owner]);
      return rows.length > 0;
    },

    async listGitHubInstallations(org) {
      const { rows } = await client.query(
        "SELECT owner, installation_id, account_type, repository_selection, updated_at FROM github_installation WHERE org_id = $1 ORDER BY owner ASC",
        [org],
      );
      return (rows as { owner: string; installation_id: string; account_type: string | null; repository_selection: string | null; updated_at: string }[]).map((r) => ({
        owner: r.owner,
        installationId: r.installation_id,
        ...(r.account_type ? { accountType: r.account_type } : {}),
        ...(r.repository_selection ? { repositorySelection: r.repository_selection } : {}),
        updatedAt: r.updated_at,
      }));
    },

    async claimStoredCredential(org, ref, claimId, claimedAtIso, staleBeforeIso) {
      const { rows } = await client.query(
        `UPDATE stored_credential SET claim_id = $1, claimed_at = $2
         WHERE org_id = $3 AND ref = $4 AND (claim_id IS NULL OR claimed_at <= $5) RETURNING ref`,
        [claimId, claimedAtIso, org, ref, staleBeforeIso],
      );
      return rows.length > 0;
    },

    async releaseStoredCredential(org, ref, claimId) {
      const { rows } = await client.query(
        "UPDATE stored_credential SET claim_id = NULL, claimed_at = NULL WHERE org_id = $1 AND ref = $2 AND claim_id = $3 RETURNING ref",
        [org, ref, claimId],
      );
      return rows.length > 0;
    },

    async addCredentialIntake(row: CredentialIntakeRow) {
      await client.query(
        `INSERT INTO credential_intake (org_id, id, ref, provider, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.org, row.id, row.ref, row.provider, row.domain ?? null, row.requestedBy, row.channelId, row.threadTs ?? null, row.createdAt, row.expiresAt, row.usedAt ?? null],
      );
    },

    async getCredentialIntake(org, id) {
      const { rows } = await client.query(
        "SELECT id, ref, provider, domain, requested_by, channel_id, thread_ts, created_at, expires_at, used_at FROM credential_intake WHERE org_id = $1 AND id = $2",
        [org, id],
      );
      const r = (rows as { id: string; ref: string; provider: string; domain: string | null; requested_by: string; channel_id: string; thread_ts: string | null; created_at: string; expires_at: string; used_at: string | null }[])[0];
      if (!r) return null;
      return {
        org,
        id: r.id,
        ref: r.ref,
        provider: r.provider,
        ...(r.domain ? { domain: r.domain } : {}),
        requestedBy: r.requested_by,
        channelId: r.channel_id,
        ...(r.thread_ts ? { threadTs: r.thread_ts } : {}),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        ...(r.used_at ? { usedAt: r.used_at } : {}),
      };
    },

    async consumeCredentialIntake(org, id, usedAt) {
      const { rows } = await client.query(
        "UPDATE credential_intake SET used_at = $1 WHERE org_id = $2 AND id = $3 AND used_at IS NULL RETURNING id",
        [usedAt, org, id],
      );
      return rows.length > 0;
    },

    async armWebhookCaptureWindow(org: string, hookId: string, captureUntil: string, armedBy: string, at: string) {
      await client.query(
        `INSERT INTO webhook_capture_window (org_id, hook_id, capture_until, armed_by, armed_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (org_id, hook_id) DO UPDATE SET capture_until = EXCLUDED.capture_until, armed_by = EXCLUDED.armed_by, armed_at = EXCLUDED.armed_at`,
        [org, hookId, captureUntil, armedBy, at],
      );
    },

    async getWebhookCaptureWindow(org: string, hookId: string) {
      const { rows } = await client.query("SELECT hook_id, capture_until, armed_by, armed_at FROM webhook_capture_window WHERE org_id = $1 AND hook_id = $2", [org, hookId]);
      const row = (rows as { hook_id: string; capture_until: string; armed_by: string; armed_at: string }[])[0];
      return row ? { hookId: row.hook_id, captureUntil: row.capture_until, armedBy: row.armed_by, armedAt: row.armed_at } : null;
    },

    async addPendingAction(row: PendingActionRow) {
      await client.query(
        `INSERT INTO pending_actions
           (org_id, id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
          row.postedTo,
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
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = $1 AND id = $2`,
        [org, id],
      );
      const r = (rows as PendingActionPgRow[])[0];
      return r ? pendingActionFromPgRow(org, r) : null;
    },

    async listPendingActions(org) {
      const { rows } = await client.query(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
        [org],
      );
      return (rows as PendingActionPgRow[]).map((r) => pendingActionFromPgRow(org, r));
    },

    async listExpiredPendingActions(org, nowIso) {
      const { rows } = await client.query(
        `SELECT id, kind, args_json, scope_key, domain, requested_by, channel_id, thread_ts, message_ts, posted_to, status, created_at, expires_at, decided_by, decided_at
         FROM pending_actions WHERE org_id = $1 AND status = 'pending' AND expires_at <= $2 ORDER BY created_at ASC`,
        [org, nowIso],
      );
      return (rows as PendingActionPgRow[]).map((r) => pendingActionFromPgRow(org, r));
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

    async setSessionApproval(row) {
      await client.query("DELETE FROM pr_session_approval WHERE org_id = $1 AND expires_at <= $2", [row.org, row.createdAt]);
      await client.query(
        `INSERT INTO pr_session_approval (org_id, session_id, kind, granted_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, session_id, kind) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
        [row.org, row.sessionId, row.kind, row.grantedBy, row.createdAt, row.expiresAt],
      );
    },

    async getSessionApproval(org, sessionId, kind, nowIso) {
      const { rows } = await client.query(
        "SELECT session_id, kind, granted_by, created_at, expires_at FROM pr_session_approval WHERE org_id = $1 AND session_id = $2 AND kind = $3 AND expires_at > $4",
        [org, sessionId, kind, nowIso],
      );
      const r = (rows as { session_id: string; kind: string; granted_by: string; created_at: string; expires_at: string }[])[0];
      return r ? { org, sessionId: r.session_id, kind: r.kind, grantedBy: r.granted_by, createdAt: r.created_at, expiresAt: r.expires_at } : null;
    },

    async listSessionApprovals(org, sessionId, nowIso) {
      const { rows } = await client.query(
        "SELECT session_id, kind, granted_by, created_at, expires_at FROM pr_session_approval WHERE org_id = $1 AND session_id = $2 AND expires_at > $3 ORDER BY kind ASC",
        [org, sessionId, nowIso],
      );
      return (rows as { session_id: string; kind: string; granted_by: string; created_at: string; expires_at: string }[]).map((r) => ({
        org,
        sessionId: r.session_id,
        kind: r.kind,
        grantedBy: r.granted_by,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }));
    },

    async revokeSessionApprovals(org, sessionId) {
      const { rows } = await client.query("DELETE FROM pr_session_approval WHERE org_id = $1 AND session_id = $2 RETURNING kind", [org, sessionId]);
      return (rows as unknown[]).length;
    },

    async putLinkSet(org: string, row: LinkSetRow) {
      await client.query(
        `INSERT INTO identity_link_sets (org_id, id, handle, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, id) DO UPDATE SET handle = EXCLUDED.handle, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
        [org, row.id, row.handle, row.status, row.createdAt, row.updatedAt],
      );
    },

    async getLinkSet(org, id) {
      const { rows } = await client.query("SELECT id, handle, status, created_at, updated_at FROM identity_link_sets WHERE org_id = $1 AND id = $2", [org, id]);
      const r = (rows as LinkSetPgRow[])[0];
      return r ? linkSetFromPgRow(org, r) : null;
    },

    async listLinkSets(org) {
      const { rows } = await client.query("SELECT id, handle, status, created_at, updated_at FROM identity_link_sets WHERE org_id = $1 ORDER BY id ASC", [org]);
      return (rows as LinkSetPgRow[]).map((r) => linkSetFromPgRow(org, r));
    },

    async updateLinkSetStatus(org, id, from, to, at) {
      const { rows } = await client.query(
        `UPDATE identity_link_sets SET status = $1, updated_at = $2
         WHERE org_id = $3 AND id = $4 AND status = ANY($5) RETURNING id`,
        [to, at, org, id, [...from]],
      );
      return (rows as unknown[]).length > 0;
    },

    async insertLinkedId(org: string, row: LinkedIdRow) {
      const { rows } = await client.query(
        `INSERT INTO identity_linked_ids (org_id, platform, native_id, link_set_id, status, established_by, evidence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (org_id, platform, native_id) DO NOTHING RETURNING native_id`,
        [org, row.platform, row.nativeId, row.linkSetId, row.status, row.establishedBy, row.evidenceJson ?? null, row.createdAt, row.updatedAt],
      );
      return (rows as unknown[]).length > 0;
    },

    async getLinkedId(org, platform, nativeId) {
      const { rows } = await client.query(
        `SELECT platform, native_id, link_set_id, status, established_by, evidence, created_at, updated_at
         FROM identity_linked_ids WHERE org_id = $1 AND platform = $2 AND native_id = $3`,
        [org, platform, nativeId],
      );
      const r = (rows as LinkedIdPgRow[])[0];
      return r ? linkedIdFromPgRow(org, r) : null;
    },

    async listLinkedIds(org, linkSetId) {
      const { rows } = await client.query(
        `SELECT platform, native_id, link_set_id, status, established_by, evidence, created_at, updated_at
         FROM identity_linked_ids WHERE org_id = $1${linkSetId === undefined ? "" : " AND link_set_id = $2"}
         ORDER BY platform ASC, native_id ASC`,
        linkSetId === undefined ? [org] : [org, linkSetId],
      );
      return (rows as LinkedIdPgRow[]).map((r) => linkedIdFromPgRow(org, r));
    },

    async updateLinkedIdStatus(org, platform, nativeId, from, to, establishedBy, evidenceJson, at) {
      const { rows } = await client.query(
        `UPDATE identity_linked_ids SET status = $1, established_by = $2, evidence = $3, updated_at = $4
         WHERE org_id = $5 AND platform = $6 AND native_id = $7 AND status = ANY($8) RETURNING native_id`,
        [to, establishedBy, evidenceJson ?? null, at, org, platform, nativeId, [...from]],
      );
      return (rows as unknown[]).length > 0;
    },

    async deleteLinkedId(org, platform, nativeId) {
      const { rows } = await client.query("DELETE FROM identity_linked_ids WHERE org_id = $1 AND platform = $2 AND native_id = $3 RETURNING native_id", [org, platform, nativeId]);
      return (rows as unknown[]).length > 0;
    },

    async revokeLinkedIdsForSet(org, linkSetId, at) {
      const { rows } = await client.query(
        `UPDATE identity_linked_ids SET status = 'revoked', updated_at = $1
         WHERE org_id = $2 AND link_set_id = $3 AND status <> 'revoked' RETURNING native_id`,
        [at, org, linkSetId],
      );
      return (rows as unknown[]).length;
    },

    async addLinkChallenge(org: string, row: LinkChallengeRow) {
      await client.query(
        `INSERT INTO identity_link_challenges
           (org_id, id, nonce_hash, initiating_platform, initiating_native_id, initiating_surface_key,
            claimed_platform, claimed_native_id, claimed_at, status, created_at, expires_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
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
        ],
      );
    },

    async getLinkChallenge(org, id) {
      const { rows } = await client.query(`${LINK_CHALLENGE_SELECT} WHERE org_id = $1 AND id = $2`, [org, id]);
      const r = (rows as LinkChallengePgRow[])[0];
      return r ? linkChallengeFromPgRow(org, r) : null;
    },

    async listLinkChallenges(org, filter) {
      const conjuncts = ["org_id = $1"];
      const params: unknown[] = [org];
      if (filter?.initiatingPlatform !== undefined) {
        params.push(filter.initiatingPlatform);
        conjuncts.push(`initiating_platform = $${params.length}`);
      }
      if (filter?.initiatingNativeId !== undefined) {
        params.push(filter.initiatingNativeId);
        conjuncts.push(`initiating_native_id = $${params.length}`);
      }
      if (filter?.status !== undefined) {
        params.push(filter.status);
        conjuncts.push(`status = $${params.length}`);
      }
      const { rows } = await client.query(`${LINK_CHALLENGE_SELECT} WHERE ${conjuncts.join(" AND ")} ORDER BY created_at DESC`, params);
      return (rows as LinkChallengePgRow[]).map((r) => linkChallengeFromPgRow(org, r));
    },

    async claimLinkChallenge(org, nonceHash, platform, nativeId, at) {
      const { rows } = await client.query(
        `UPDATE identity_link_challenges
           SET claimed_platform = $1, claimed_native_id = $2, claimed_at = $3, status = 'claimed'
         WHERE org_id = $4 AND nonce_hash = $5 AND status = 'pending' AND expires_at > $6
           AND NOT (initiating_platform = $1 AND initiating_native_id = $2)
         RETURNING org_id, id, nonce_hash, initiating_platform, initiating_native_id, initiating_surface_key,
                   claimed_platform, claimed_native_id, claimed_at, status, created_at, expires_at, decided_at`,
        [platform, nativeId, at, org, nonceHash, at],
      );
      const r = (rows as LinkChallengePgRow[])[0];
      return r ? linkChallengeFromPgRow(org, r) : null;
    },

    async decideLinkChallenge(org, id, from, to, at) {
      const ttlConjunct = to === "ratified" ? " AND expires_at > $6" : "";
      const params = to === "ratified" ? [to, at, org, id, [...from], at] : [to, at, org, id, [...from]];
      const { rows } = await client.query(
        `UPDATE identity_link_challenges SET status = $1, decided_at = $2
         WHERE org_id = $3 AND id = $4 AND status = ANY($5)${ttlConjunct} RETURNING id`,
        params,
      );
      return (rows as unknown[]).length > 0;
    },

    async expireLinkChallenges(org, nowIso) {
      const { rows } = await client.query(
        `UPDATE identity_link_challenges SET status = 'expired', decided_at = $1
         WHERE org_id = $2 AND status IN ('pending', 'claimed') AND expires_at <= $1 RETURNING id`,
        [nowIso, org],
      );
      return (rows as unknown[]).length;
    },

    async putOauthVaultGrant(org, row) {
      await client.query(
        `INSERT INTO identity_oauth_vault_grants (org_id, link_set_id, connector, platform, native_id, established_at)
         VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, link_set_id, connector, platform, native_id) DO NOTHING`,
        [org, row.linkSetId, row.connector, row.platform, row.nativeId, row.establishedAt],
      );
    },

    async getOauthVaultGrant(org, linkSetId, connector, platform, nativeId) {
      const { rows } = await client.query(
        `SELECT link_set_id, connector, platform, native_id, established_at FROM identity_oauth_vault_grants
         WHERE org_id = $1 AND link_set_id = $2 AND connector = $3 AND platform = $4 AND native_id = $5`,
        [org, linkSetId, connector, platform, nativeId],
      );
      const r = (rows as { link_set_id: string; connector: string; platform: string; native_id: string; established_at: string }[])[0];
      return r ? { org, linkSetId: r.link_set_id, connector: r.connector, platform: r.platform, nativeId: r.native_id, establishedAt: r.established_at } : null;
    },

    async deleteOauthVaultGrant(org, linkSetId, connector, platform, nativeId) {
      const { rows } = await client.query(
        `DELETE FROM identity_oauth_vault_grants
         WHERE org_id = $1 AND link_set_id = $2 AND connector = $3 AND platform = $4 AND native_id = $5 RETURNING native_id`,
        [org, linkSetId, connector, platform, nativeId],
      );
      return (rows as unknown[]).length > 0;
    },

    async deleteOauthVaultGrantsForAccount(org, platform, nativeId) {
      const { rows } = await client.query(
        "DELETE FROM identity_oauth_vault_grants WHERE org_id = $1 AND platform = $2 AND native_id = $3 RETURNING native_id",
        [org, platform, nativeId],
      );
      return (rows as unknown[]).length;
    },

    async deleteOauthVaultGrantsForSet(org, linkSetId) {
      const { rows } = await client.query(
        "DELETE FROM identity_oauth_vault_grants WHERE org_id = $1 AND link_set_id = $2 RETURNING native_id",
        [org, linkSetId],
      );
      return (rows as unknown[]).length;
    },

    async getMeta(key) {
      const { rows } = await client.query("SELECT value FROM instance_meta WHERE key = $1", [key]);
      const r = (rows as { value: string }[])[0];
      return r ? r.value : null;
    },

    async setMeta(key, value) {
      await client.query(
        `INSERT INTO instance_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
  };
}
