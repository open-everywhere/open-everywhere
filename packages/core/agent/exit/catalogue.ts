import { OPERATIONAL_TABLES } from "../operational/store.js";

export type OperationalTableName = (typeof OPERATIONAL_TABLES)[number];

export interface ExitTableSpec {
  readonly table: OperationalTableName;
  readonly platformColumn?: string;
  readonly orgColumn: "org_id" | null;
  readonly orderBy: readonly string[];
  readonly holds: string;
  readonly secretColumns?: readonly string[];
  readonly appendOnly?: true;
  readonly personColumns?: readonly string[];
  readonly keptOnErase?: string;
  readonly surfaceColumn?: string;
  readonly sessionColumn?: string;
  readonly ageColumn?: string;
}

export const EXPORT_SECRET_MARKER = "[secret — not exported]";

export const EXIT_TABLES: readonly ExitTableSpec[] = [
  {
    table: "spend_ledger",
    orgColumn: "org_id",
    orderBy: ["org_id", "surface_key", "principal_id", "routine_id", "model", "period", "cost_source"],
    holds: "token and cost counters per room, person and month — counts only, no message text",
  },
  { table: "routine", orgColumn: "org_id", orderBy: ["org_id", "id"], holds: "routines and watches, with their prompts and the last event an event routine matched", surfaceColumn: "surface_key" },
  { table: "routine_prompt_revisions", orgColumn: "org_id", orderBy: ["seq"], holds: "the edit history of routine prompts", appendOnly: true },
  { table: "audit_entry", orgColumn: "org_id", orderBy: ["seq"], holds: "the hash-chained audit log", appendOnly: true },
  { table: "spend_limit", orgColumn: "org_id", orderBy: ["org_id", "scope_key", "level"], holds: "spend limits an admin set" },
  { table: "halt", orgColumn: "org_id", orderBy: ["org_id", "level", "scope_key", "org_wide"], holds: "halts an admin set and cleared" },
  { table: "connector_override", orgColumn: "org_id", orderBy: ["org_id", "scope_key", "connector"], holds: "connector grants an admin set per room" },
  { table: "thread_engagement", orgColumn: "org_id", orderBy: ["org_id", "surface_key", "thread_ts"], holds: "which threads the agent takes part in", surfaceColumn: "surface_key" },
  { table: "channel_session", orgColumn: "org_id", orderBy: ["org_id", "surface_key"], holds: "the live conversation seat per room — tokens and counts" },
  {
    table: "session_tail",
    orgColumn: "org_id",
    orderBy: ["org_id", "surface_key", "token", "seq"],
    holds: "recent conversation lines carried into a fresh seat, and the DM conversation summary",
    surfaceColumn: "surface_key",
    ageColumn: "at",
  },
  { table: "event_dedupe", orgColumn: "org_id", orderBy: ["org_id", "key"], holds: "event dedupe keys — no content, self-pruning" },
  {
    table: "unified_wake_target",
    orgColumn: "org_id",
    orderBy: ["org_id", "wake_id"],
    holds: "where each delivered message is answered — routing ids, self-pruning",
  },
  { table: "thread_ownership", orgColumn: "org_id", orderBy: ["org_id", "channel_key", "thread_key"], holds: "which seat owns a thread — routing ids, self-pruning" },
  { table: "thread_seat_state", orgColumn: "org_id", orderBy: ["org_id", "channel_key", "thread_key"], holds: "the state of each delegated thread seat" },
  { table: "turn_anchor", orgColumn: "org_id", orderBy: ["org_id", "window_key"], holds: "which turn answers which message — routing ids", surfaceColumn: "surface_key", sessionColumn: "session_id" },
  { table: "task_result", orgColumn: "org_id", orderBy: ["org_id", "task_id"], holds: "the results of finished jobs", ageColumn: "created_at" },
  { table: "slack_attachment", orgColumn: "org_id", orderBy: ["org_id", "file_id"], holds: "Slack file names, types and private links", ageColumn: "created_at" },
  {
    table: "stored_credential",
    orgColumn: "org_id",
    orderBy: ["org_id", "ref"],
    holds: "encrypted secrets — names and labels are exported, the values are not",
    secretColumns: ["ciphertext"],
  },
  {
    table: "credential_intake",
    orgColumn: "org_id",
    orderBy: ["org_id", "id"],
    holds: "short-lived “set a key” requests — never the value",
    personColumns: ["requested_by"],
    keptOnErase: "a spent “set a key” request is a single-use token, and it holds no content",
  },
  { table: "webhook_capture_window", orgColumn: "org_id", orderBy: ["org_id", "hook_id"], holds: "webhook capture windows an operator armed" },
  { table: "github_installation", orgColumn: "org_id", orderBy: ["org_id", "owner"], holds: "GitHub App installations" },
  { table: "pr_session_approval", orgColumn: "org_id", orderBy: ["org_id", "session_id", "kind"], holds: "session-scoped approvals" },
  {
    table: "pending_actions",
    orgColumn: "org_id",
    orderBy: ["org_id", "id"],
    holds: "approval cards and their frozen arguments",
    personColumns: ["requested_by"],
    keptOnErase: "a decided card is the approval record the audit story relies on; a decided connector card's stored input is already dropped (OPE-2390)",
  },
  { table: "domain_skill", orgColumn: "org_id", orderBy: ["org_id", "domain", "name"], holds: "skills the agent wrote at runtime" },
  { table: "domain_skill_revisions", orgColumn: "org_id", orderBy: ["seq"], holds: "the edit history of runtime skills", appendOnly: true },
  { table: "domain_model", orgColumn: "org_id", orderBy: ["org_id", "domain"], holds: "model picks per domain" },
  {
    table: "usage_events",
    orgColumn: "org_id",
    orderBy: ["seq"],
    holds: "one row per model call — token counts, model and session",
    appendOnly: true,
    personColumns: ["principal_id"],
    sessionColumn: "session_id",
  },
  {
    table: "tool_usage",
    orgColumn: "org_id",
    orderBy: ["seq"],
    holds: "one row per tool call — tool name and outcome, no arguments",
    appendOnly: true,
    personColumns: ["principal_id"],
    sessionColumn: "session_id",
  },
  { table: "instance_meta", orgColumn: null, orderBy: ["key"], holds: "per-instance facts, such as the schema version" },
  { table: "webhook_capture", orgColumn: "org_id", orderBy: ["org_id", "source", "seq"], holds: "captured webhook bodies", ageColumn: "captured_at" },
  { table: "identity_link_sets", orgColumn: "org_id", orderBy: ["org_id", "id"], holds: "identity link sets — one per linked person" },
  {
    table: "identity_linked_ids",
    orgColumn: "org_id",
    orderBy: ["org_id", "platform", "tenant", "native_id"],
    holds: "which platform accounts belong to one link set",
    personColumns: ["native_id"],
    platformColumn: "platform",
    keptOnErase: "when the person's account is confirmed on a link-set, `oe erase` revokes the set first and reads these rows to end their stored credentials, browser profile and grants; the tombstoned rows stay as the revoke's record, and they stop the accounts being linked again; a suggested row, or one whose set is gone, stays as the record of an unproven claim and grants nothing",
  },
  {
    table: "identity_link_challenges",
    orgColumn: "org_id",
    orderBy: ["org_id", "id"],
    holds: "account-link challenges — nonces are stored as hashes",
    secretColumns: ["nonce_hash", "back_nonce_hash"],
    personColumns: ["initiating_native_id", "claimed_native_id", "target_native_id"],
    keptOnErase: "a spent challenge is what stops a used link code from being claimed again",
  },
  { table: "notice_claim", orgColumn: "org_id", orderBy: ["org_id", "key"], holds: "once-only notice claims — no content" },
  {
    table: "model_call_capture",
    orgColumn: "org_id",
    orderBy: ["seq"],
    holds: "soak-suite captures of whole model requests — written only while `soak.capture` is on",
    surfaceColumn: "surface_key",
    sessionColumn: "session_id",
    ageColumn: "ts",
  },
  {
    table: "proactive_address",
    orgColumn: "org_id",
    orderBy: ["org_id", "platform", "kind", "ref_key"],
    holds: "where the agent may reach a person or room with no live turn",
    personColumns: ["ref_key"],
  },
  {
    table: "memory_proposal",
    orgColumn: "org_id",
    orderBy: ["id"],
    holds: "memory changes the dream cycle proposed, with before and after text",
    personColumns: ["principal_id"],
  },
  {
    table: "credential_grant_ask",
    orgColumn: "org_id",
    orderBy: ["org_id", "id"],
    holds: "asks to use another person's connector account",
    personColumns: ["requester_principal_id", "owner_principal_id"],
    keptOnErase: "a decided ask is the record its grant was minted from; `oe erase` revokes the person's live grants first",
  },
  {
    table: "credential_grant",
    orgColumn: "org_id",
    orderBy: ["org_id", "id"],
    holds: "grants to use another person's connector account — metadata, never a credential",
    personColumns: ["requester_principal_id", "owner_principal_id"],
    keptOnErase: "`oe erase` revokes every live grant the person lends first; a revoked or spent row is what keeps a once-only grant single-use",
  },
  {
    table: "dm_audience",
    orgColumn: "org_id",
    orderBy: ["org_id", "address"],
    holds: "who the agent may start a DM with, and who stopped it",
    personColumns: ["address"],
    keptOnErase: "it holds the person's stop of proactive DMs; deleting it would let the agent start a DM with them again",
  },
  {
    table: "person_opt_out",
    orgColumn: "org_id",
    orderBy: ["org_id", "principal_key"],
    holds: "people who opted out",
    personColumns: ["principal_key"],
    keptOnErase: "it is the person's own opt-out; deleting it would let the agent act on their content again",
  },
  {
    table: "personal_browser",
    orgColumn: "org_id",
    orderBy: ["org_id", "principal_key"],
    holds: "a person's browser record",
    personColumns: ["principal_key"],
    keptOnErase: "`oe erase` forgets the browser first, which deletes this row with the saved profile; the row stays only when the forget failed, because it is the only record of where the profile is",
  },
  { table: "personal_watch", orgColumn: "org_id", orderBy: ["org_id", "principal_key"], holds: "a person's watch settings and ledger", personColumns: ["principal_key"] },
  { table: "personal_cover", orgColumn: "org_id", orderBy: ["org_id", "principal_key"], holds: "a person's out-of-office cover", personColumns: ["principal_key"] },
  {
    table: "question_ledger",
    orgColumn: "org_id",
    orderBy: ["seq"],
    holds: "the words of repeated questions, for workflow discovery",
    personColumns: ["principal_id"],
    surfaceColumn: "surface_key",
    ageColumn: "ts",
  },
  { table: "room_watch", orgColumn: "org_id", orderBy: ["org_id", "surface_key"], holds: "a room's discovery settings — no person id" },
  { table: "ingress_delivery", orgColumn: "org_id", orderBy: ["org_id", "source", "authority_id", "delivery_id"], holds: "accepted inbound deliveries — pending work is never aged out" },
  {
    table: "attention_state",
    orgColumn: "org_id",
    orderBy: ["org_id", "session_id"],
    holds: "what each session waits on, with a short status line",
    personColumns: ["person_id"],
    platformColumn: "person_platform",
    surfaceColumn: "surface_key",
    sessionColumn: "session_id",
    ageColumn: "updated_at",
  },
  {
    table: "dm_rule",
    orgColumn: "org_id",
    orderBy: ["org_id", "surface_key", "rule_id"],
    holds: "rules a person confirmed in their own DM",
    personColumns: ["owner_id"],
    surfaceColumn: "surface_key",
  },
  { table: "meeting_data", orgColumn: "org_id", orderBy: ["org_id", "data_key"], holds: "meeting notes, recaps and their provenance marks" },
  {
    table: "routine_report_thread",
    orgColumn: "org_id",
    orderBy: ["org_id", "channel_key", "thread_key"],
    holds: "which routine a report thread belongs to — ids only, each row with its own expiry",
    surfaceColumn: "routine_surface",
  },
];

const BY_NAME: ReadonlyMap<string, ExitTableSpec> = new Map(EXIT_TABLES.map((t) => [t.table, t]));

export function exitTableSpec(table: string): ExitTableSpec | undefined {
  return BY_NAME.get(table);
}

export function catalogueColumns(spec: ExitTableSpec): ReadonlySet<string> {
  return new Set([
    ...(spec.orgColumn ? [spec.orgColumn] : []),
    ...spec.orderBy,
    ...(spec.secretColumns ?? []),
    ...(spec.personColumns ?? []),
    ...(spec.surfaceColumn ? [spec.surfaceColumn] : []),
    ...(spec.platformColumn ? [spec.platformColumn] : []),
    ...(spec.sessionColumn ? [spec.sessionColumn] : []),
    ...(spec.ageColumn ? [spec.ageColumn] : []),
  ]);
}
