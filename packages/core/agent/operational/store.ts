import { routinePermissionGeneration, type Routine } from "../routines/routine.js";
import type { PendingActionRow } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";
import type { PendingUnifiedWake, UnifiedWakeRecord } from "../channels/unified-window.js";
import type { SessionTailEntry } from "../channels/session-tail.js";
import type { CredentialGrantAskRow, CredentialGrantAskState, CredentialGrantMode, CredentialGrantRow } from "./credential-grant-rows.js";
import type { AuditEpochSeal } from "../audit/chain.js";

export const OPERATIONAL_TABLES = [
  "spend_ledger",
  "routine",
  "routine_prompt_revisions",
  "audit_entry",
  "spend_limit",
  "halt",
  "connector_override",
  "thread_engagement",
  "channel_session",
  "session_tail",
  "event_dedupe",
  "unified_wake_target",
  "thread_ownership",
  "thread_seat_state",
  "turn_anchor",
  "task_result",
  "slack_attachment",
  "stored_credential",
  "credential_intake",
  "webhook_capture_window",
  "github_installation",
  "pr_session_approval",
  "pending_actions",
  "domain_skill",
  "domain_skill_revisions",
  "domain_model",
  "usage_events",
  "instance_meta",
  "webhook_capture",
  "identity_link_sets",
  "identity_linked_ids",
  "identity_link_challenges",
  "notice_claim",
  "model_call_capture",
  "proactive_address",
  "memory_proposal",
  "credential_grant_ask",
  "credential_grant",
  "dm_audience",
] as const;

export const EVENT_DEDUPE_MAX_RETENTION_MS = 24 * 60 * 60_000;

export interface NoticeClaimPrune {
  readonly sweepPrefix: string;
  readonly keepPrefix: string;
  readonly olderThanMs: number;
}

export const CAPTURE_MAX_DELIVERIES = 50;

export const CAPTURE_MAX_WINDOW_MS = 60 * 60_000;

export const CAPTURE_MAX_RETENTION_MS = 24 * 60 * 60_000;

export interface WebhookCaptureWindowRow {
  readonly hookId: string;
  readonly captureUntil: string;
  readonly armedBy: string;
  readonly armedAt: string;
}

export interface CapturedDeliveryRow {
  readonly seq: number;
  readonly capturedAt: string;
  readonly documentJson: string;
}

export interface AuditEntry {
  readonly ts: string;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type AuditInput = Omit<AuditEntry, "ts"> & { readonly ts?: string };

export interface AuditChainRow {
  readonly seq: number;
  readonly ts: string;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly prevSha: string | null;
}

export interface AuditChainEpochWritten {
  readonly seal: AuditEpochSeal;
  readonly markerSeq: number;
}

export interface AuditFilter {
  readonly org?: string;
  readonly platform?: string;
  readonly workspace?: string;
  readonly surface?: string;
  readonly action?: string;
  readonly principalId?: string;
  readonly since?: string;
  readonly limit?: number;
}

export type CostSource = "measured" | "derived";

export interface SpendLedgerKey {
  readonly surfaceKey: string;
  readonly principalId: string;
  readonly routineId: string;
  readonly model: string;
  readonly period: string;
  readonly costSource: CostSource;
}

export interface SpendLedgerRow extends SpendLedgerKey {
  readonly org: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly usdMicros: number;
  readonly usdMicrosMeasured: number;
  readonly calls: number;
}

export interface SpendLedgerWrite {
  readonly surfaceKey: string;
  readonly principalId?: string;
  readonly routineId?: string;
  readonly model?: string;
  readonly period: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly usdMicros?: number;
  readonly usdMicrosMeasured?: number;
  readonly costSource?: CostSource;
}

export interface SpendLedgerFilter {
  readonly surfaceKey?: string;
  readonly surfaceKeyPrefix?: string;
  readonly principalId?: string;
  readonly routineId?: string;
  readonly period?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly costSource?: CostSource;
}

export interface SpendTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly usdMicros: number;
  readonly usdMicrosMeasured: number;
  readonly calls: number;
}

export function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function spendLedgerConjuncts(filter: SpendLedgerFilter): { conjuncts: string[]; params: (string | number)[] } {
  const conjuncts: string[] = [];
  const params: (string | number)[] = [];
  if (filter.surfaceKey !== undefined) {
    conjuncts.push("surface_key = ?");
    params.push(filter.surfaceKey);
  }
  if (filter.surfaceKeyPrefix !== undefined) {
    conjuncts.push("surface_key LIKE ? ESCAPE '\\'");
    params.push(likePrefixPattern(filter.surfaceKeyPrefix));
  }
  if (filter.principalId !== undefined) {
    conjuncts.push("principal_id = ?");
    params.push(filter.principalId);
  }
  if (filter.routineId !== undefined) {
    conjuncts.push("routine_id = ?");
    params.push(filter.routineId);
  }
  if (filter.period !== undefined) {
    conjuncts.push("period = ?");
    params.push(filter.period);
  }
  if (filter.periodFrom !== undefined) {
    conjuncts.push("period >= ?");
    params.push(filter.periodFrom);
  }
  if (filter.periodTo !== undefined) {
    conjuncts.push("period <= ?");
    params.push(filter.periodTo);
  }
  if (filter.costSource !== undefined) {
    conjuncts.push("cost_source = ?");
    params.push(filter.costSource);
  }
  return { conjuncts, params };
}

export interface OverrideMeta {
  readonly expiresAt?: number;
  readonly reason?: string;
  readonly setBy?: string;
}

export const CAP_LEVELS = ["surface", "workspace", "domain", "user"] as const;
export type CapLevel = (typeof CAP_LEVELS)[number];
export interface SpendLimitRow extends OverrideMeta {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
}

export interface SpendLimitAmount {
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
}

export function assertSpendLimitAmount(limit: SpendLimitAmount): void {
  if (limit.monthlyTokens == null && limit.monthlyUsd == null) {
    throw new Error("spend limit must set monthlyTokens and/or monthlyUsd");
  }
  if (limit.monthlyTokens != null && (!Number.isInteger(limit.monthlyTokens) || limit.monthlyTokens <= 0)) {
    throw new Error(`spend limit monthlyTokens must be a positive integer, got ${JSON.stringify(limit.monthlyTokens)}`);
  }
  if (limit.monthlyUsd != null && (!Number.isFinite(limit.monthlyUsd) || limit.monthlyUsd <= 0)) {
    throw new Error(`spend limit monthlyUsd must be a finite number > 0, got ${JSON.stringify(limit.monthlyUsd)}`);
  }
}

export type HaltAddress =
  | { readonly orgWide: true }
  | { readonly orgWide: false; readonly level: CapLevel; readonly scopeKey: string };

export interface HaltRow {
  readonly org: string;
  readonly address: HaltAddress;
  readonly active: boolean;
  readonly setAt: string;
  readonly setBy?: string;
  readonly clearedAt?: string;
  readonly clearedBy?: string;
}

export function haltAddressColumns(address: HaltAddress): { level: string; scopeKey: string; orgWide: boolean } {
  return address.orgWide ? { level: "", scopeKey: "", orgWide: true } : { level: address.level, scopeKey: address.scopeKey, orgWide: false };
}

export function haltAddressFromColumns(level: string, scopeKey: string, orgWide: boolean): HaltAddress {
  return orgWide ? { orgWide: true } : { orgWide: false, level: level as CapLevel, scopeKey };
}

export function assertHaltAddress(address: HaltAddress): void {
  if (address.orgWide) return;
  if (!CAP_LEVELS.includes(address.level)) {
    throw new Error(`halt level must be one of ${CAP_LEVELS.join(", ")}, got ${JSON.stringify(address.level)}`);
  }
  if (address.scopeKey.trim().length === 0) {
    throw new Error('halt scopeKey must be non-blank — an org-wide halt is addressed with { orgWide: true }, never with a blank scope key');
  }
}

export interface ConnectorOverrideRow {
  readonly connector: string;
  readonly granted: boolean;
  readonly reason?: string;
  readonly setBy?: string;
}

export interface ScopedConnectorOverrideRow extends ConnectorOverrideRow {
  readonly scopeKey: string;
}

export interface DomainModelRow {
  readonly org: string;
  readonly domain: string;
  readonly modelId?: string;
  readonly reasoning?: ModelReasoning;
  readonly setBy?: string;
  readonly updatedAt: string;
}

export function assertDomainModelPick(pick: { readonly modelId?: string; readonly reasoning?: ModelReasoning }): void {
  if (pick.modelId == null && pick.reasoning == null) {
    throw new Error("a domain model pick must set modelId and/or reasoning");
  }
  if (pick.modelId != null && pick.modelId.trim().length === 0) {
    throw new Error("a domain model pick's modelId must be non-blank");
  }
}

export interface DomainSkillRow {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly content: string;
  readonly updatedBy?: string;
  readonly updatedAt: string;
}

export interface DomainSkillRevisionRow {
  readonly seq: number;
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly content: string;
  readonly authoredBy?: string;
  readonly armedBy?: string;
  readonly approvalId?: string;
  readonly recordedAt: string;
}

export interface DomainSkillProvenance {
  readonly armedBy?: string;
  readonly approvalId?: string;
}

export interface RoutinePromptRevisionRow {
  readonly seq: number;
  readonly org: string;
  readonly surfaceKey: string;
  readonly routineId: string;
  readonly prompt: string;
  readonly generation?: number;
  readonly authoredBy?: string;
  readonly armedBy?: string;
  readonly approvalId?: string;
  readonly recordedAt: string;
}

export interface RoutinePromptProvenance {
  readonly authoredBy?: string;
  readonly armedBy?: string;
  readonly approvalId?: string;
}

export interface RoutinePromptRevisionWrite {
  readonly prompt: string;
  readonly generation: number;
  readonly authoredBy?: string;
  readonly armedBy?: string;
  readonly approvalId?: string;
  readonly recordedAt: string;
}

export function routinePromptRevisionWrites(input: {
  readonly existing: Routine;
  readonly updated: Routine;
  readonly provenance?: RoutinePromptProvenance;
  readonly hasPriorRevisions: boolean;
  readonly nowIso: string;
}): RoutinePromptRevisionWrite[] {
  const { existing, updated, provenance, hasPriorRevisions, nowIso } = input;
  const genesis: RoutinePromptRevisionWrite[] = hasPriorRevisions
    ? []
    : [
        {
          prompt: existing.prompt,
          generation: routinePermissionGeneration(existing),
          ...(existing.createdBy ? { authoredBy: existing.createdBy } : {}),
          recordedAt: existing.createdAt,
        },
      ];
  return [
    ...genesis,
    {
      prompt: updated.prompt,
      generation: routinePermissionGeneration(updated),
      ...(provenance?.authoredBy ? { authoredBy: provenance.authoredBy } : {}),
      ...(provenance?.armedBy ? { armedBy: provenance.armedBy } : {}),
      ...(provenance?.approvalId ? { approvalId: provenance.approvalId } : {}),
      recordedAt: nowIso,
    },
  ];
}

export const MAX_OBSERVABLE_DELEGATION_DEPTH = 2;

export interface UsageEventEntry {
  readonly org: string;
  readonly surfaceKey: string;
  readonly sessionId: string;
  readonly principalId?: string;
  readonly ts: string;
  readonly kind?: string;
  readonly routineId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheTokensReported?: boolean;
  readonly reasoningTokens?: number;
  readonly model?: string;
  readonly usdMicrosMeasured?: number;
  readonly costSource?: CostSource;
  readonly delegationDepth?: number;
  readonly rootSessionId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type UsageEventInput = Omit<UsageEventEntry, "ts" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> & {
  readonly ts?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
};

export interface UsageSummaryFilter {
  readonly surfaceKeyPrefix?: string;
  readonly sinceTs?: string;
  readonly untilTs?: string;
  readonly sessionStartedAfter?: string;
}

export interface UsageSummaryRow {
  readonly surfaceKey: string;
  readonly principalId?: string;
  readonly kind?: string;
  readonly routineId?: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReportedCalls: number;
  readonly reasoningReportedCalls: number;
  readonly events: number;
  readonly sessions: number;
}

export interface CompiledAnalyticsQuery {
  readonly table: "audit_entry" | "usage_events" | "spend_ledger";
  readonly select: readonly { readonly expr: string; readonly alias: string }[];
  readonly groupBy: readonly string[];
  readonly where: readonly string[];
  readonly params: readonly unknown[];
  readonly orderBy: { readonly expr: string; readonly dir: "ASC" | "DESC" } | null;
  readonly limit: number;
}

export const PROMOTER_SEP = "\n";

export const PROMOTER_LIST_MAX = 32;

export function framePromoterId(raw: string): string {
  return PROMOTER_SEP + raw.split(PROMOTER_SEP).join(" ") + PROMOTER_SEP;
}

export function decodePromoterList(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored.split(PROMOTER_SEP).filter((id) => id.length > 0);
}

export function promoterListField(stored: string | null | undefined): { recentPromoters?: readonly string[] } {
  const ids = decodePromoterList(stored);
  return ids.length > 0 ? { recentPromoters: ids } : {};
}

export interface EngagementRow {
  readonly org: string;
  readonly surfaceKey: string;
  readonly threadTs: string;
  readonly engagedAt: string;
  readonly lastTurnAt: string;
  readonly participating: boolean;
  readonly silentStreak: number;
  readonly ownerToken?: string;
  readonly kind: "thread" | "spawned";
  readonly stopped: boolean;
  readonly recentPromoters?: readonly string[];
}

export interface TurnAnchorWrite {
  readonly windowKey: string;
  readonly anchorKey?: string;
  readonly channelKey?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly surfaceKey: string;
}

export interface TurnAnchorRow extends TurnAnchorWrite {
  readonly createdAt: string;
}

export interface ThreadSeatStateWrite {
  readonly channelKey: string;
  readonly threadKey: string;
  readonly seatToken: string;
  readonly parentRegistryKey: string;
  readonly state: "open" | "completed";
  readonly originJson: string;
  readonly report?: string;
  readonly openedAt: string;
}

export interface ThreadSeatStateRow extends ThreadSeatStateWrite {
  readonly updatedAt: string;
}

export interface ChannelSessionRow {
  readonly org: string;
  readonly surfaceKey: string;
  readonly token: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly lastWakeAt: string;
  readonly turnCount: number;
  readonly inputTokensTotal: number | null;
  readonly firstWakeAt: string | null;
  readonly lastInputTokens: number | null;
  readonly rotateMarkedAt: string | null;
}

export interface SlackAttachmentRow {
  readonly urlPrivate: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly teamId?: string;
}

export interface GitHubInstallationRow {
  readonly owner: string;
  readonly installationId: string;
  readonly accountType?: string;
  readonly repositorySelection?: string;
  readonly updatedAt: string;
}

export interface StoredCredentialRow {
  readonly ref: string;
  readonly ciphertext: string;
  readonly connector?: string;
  readonly domain?: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CredentialIntakeRow {
  readonly org: string;
  readonly id: string;
  readonly ref: string;
  readonly connector: string;
  readonly domain?: string;
  readonly requestedBy: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
}

export interface SessionApprovalRow {
  readonly org: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly grantedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type LinkSetStatus = "active" | "suspended" | "revoked";

export type LinkedIdStatus = "suggested" | "confirmed" | "revoked";

export type LinkChallengeStatus = "pending" | "claimed" | "ratified" | "denied" | "expired";

export interface LinkSetRow {
  readonly org: string;
  readonly id: string;
  readonly handle: string;
  readonly status: LinkSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LinkedIdRow {
  readonly org: string;
  readonly linkSetId: string;
  readonly platform: string;
  readonly tenant: string;
  readonly nativeId: string;
  readonly status: LinkedIdStatus;
  readonly establishedBy: string;
  readonly evidenceJson?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LinkChallengeRow {
  readonly org: string;
  readonly id: string;
  readonly nonceHash: string;
  readonly transport: string;
  readonly targetPlatform?: string;
  readonly targetTenant?: string;
  readonly targetNativeId?: string;
  readonly backNonceHash?: string;
  readonly initiatingPlatform: string;
  readonly initiatingTenant: string;
  readonly initiatingNativeId: string;
  readonly initiatingSurfaceKey: string;
  readonly claimedPlatform?: string;
  readonly claimedTenant?: string;
  readonly claimedNativeId?: string;
  readonly claimedAt?: string;
  readonly status: LinkChallengeStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
}

export interface LinkChallengeFilter {
  readonly initiatingPlatform?: string;
  readonly initiatingTenant?: string;
  readonly initiatingNativeId?: string;
  readonly targetPlatform?: string;
  readonly targetTenant?: string;
  readonly targetNativeId?: string;
  readonly status?: LinkChallengeStatus;
}

export interface ModelCallCaptureWrite {
  readonly org: string;
  readonly surfaceKey: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly model: string;
  readonly provider: string;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly bodyBytes: number;
  readonly bodyGzipB64: string;
  readonly truncated: boolean;
}

export interface ModelCallCaptureRow extends ModelCallCaptureWrite {
  readonly seq: number;
}

export interface ModelCallCaptureSessionRow {
  readonly sessionId: string;
  readonly firstTs: string;
  readonly lastTs: string;
  readonly rowCount: number;
  readonly totalBytes: number;
}

export interface ModelCallCaptureReadOptions {
  readonly includeBody?: boolean;
  readonly turnId?: string;
  readonly limit?: number;
}

export interface MemoryProposalRow {
  readonly id: number;
  readonly org: string;
  readonly kind: string;
  readonly scope: string;
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly principalId: string;
  readonly createdAt: string;
}

export type MemoryProposalWrite = Omit<MemoryProposalRow, "id">;

export interface DmAudienceRow {
  readonly address: string;
  readonly firstDmAt?: string;
  readonly stoppedAt?: string;
}
export interface ProactiveAddress {
  readonly platform: string;
  readonly kind: string;
  readonly refKey: string;
  readonly tenant: string;
  readonly address: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export function proactiveAddressRow(
  platform: string,
  kind: string,
  refKey: string,
  tenant: string,
  addressJson: string,
  updatedAt: string,
): ProactiveAddress {
  let address: Readonly<Record<string, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(addressJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) address = parsed as Record<string, unknown>;
  } catch {
    address = {};
  }
  return { platform, kind, refKey, tenant, address, updatedAt };
}

export interface OperationalStore {
  readonly id: string;
  root(): string;

  recordSpend(org: string, write: SpendLedgerWrite): Promise<void>;
  spendTotals(org: string, filter?: SpendLedgerFilter): Promise<SpendTotals>;
  listSpendLedger(org?: string, filter?: SpendLedgerFilter): Promise<SpendLedgerRow[]>;

  listRoutines(org: string, surfaceKey: string): Promise<Routine[]>;
  getRoutine(org: string, surfaceKey: string, id: string): Promise<Routine | null>;
  addRoutine(routine: Routine): Promise<Routine>;
  updateRoutine(org: string, surfaceKey: string, id: string, patch: Partial<Routine>, provenance?: RoutinePromptProvenance): Promise<Routine | null>;
  removeRoutine(org: string, surfaceKey: string, id: string): Promise<boolean>;
  listAllRoutines(): Promise<Routine[]>;
  listRoutinePromptRevisions(org: string, surfaceKey: string, routineId?: string): Promise<RoutinePromptRevisionRow[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  readAudit(filter: AuditFilter): Promise<AuditEntry[]>;
  listAuditOrgs(): Promise<string[]>;
  readAuditChain(org: string, opts?: { readonly tailLimit?: number }): Promise<AuditChainRow[]>;
  sealAuditChainEpoch(org: string, sealedBy: string): Promise<AuditChainEpochWritten | null>;

  setSpendLimit(org: string, scopeKey: string, level: CapLevel, limit: SpendLimitAmount, meta?: OverrideMeta): Promise<void>;
  clearSpendLimit(org: string, scopeKey: string, level: CapLevel): Promise<boolean>;
  spendLimits(org: string): Promise<SpendLimitRow[]>;

  setHalt(org: string, address: HaltAddress, meta?: { readonly setBy?: string }): Promise<void>;
  clearHalt(org: string, address: HaltAddress, meta?: { readonly clearedBy?: string }): Promise<boolean>;
  activeHalts(org: string): Promise<HaltRow[]>;

  setConnectorOverride(org: string, scopeKey: string, connector: string, granted: boolean, meta?: Omit<OverrideMeta, "expiresAt">): Promise<void>;
  clearConnectorOverride(org: string, scopeKey: string, connector: string): Promise<boolean>;
  connectorOverrides(org: string, scopeKey: string): Promise<ConnectorOverrideRow[]>;
  allConnectorOverrides(org: string): Promise<ScopedConnectorOverrideRow[]>;

  setDomainModel(org: string, domain: string, pick: { readonly modelId?: string; readonly reasoning?: ModelReasoning }, setBy?: string): Promise<void>;
  clearDomainModel(org: string, domain: string): Promise<boolean>;
  getDomainModel(org: string, domain: string): Promise<DomainModelRow | null>;
  domainModels(org: string): Promise<DomainModelRow[]>;

  markEngaged(
    org: string,
    surfaceKey: string,
    threadTs: string,
    at: string,
    opts?: { participating?: boolean; ownerToken?: string; kind?: "thread" | "spawned"; engagedBy?: string },
  ): Promise<void>;
  markStopped(org: string, surfaceKey: string, threadTs: string): Promise<boolean>;
  bumpSilentStreak(org: string, surfaceKey: string, threadTs: string): Promise<number>;
  getEngagement(org: string, surfaceKey: string, threadTs: string): Promise<EngagementRow | null>;
  disengage(org: string, surfaceKey: string, threadTs: string): Promise<boolean>;
  listEngagements(org: string): Promise<EngagementRow[]>;

  getChannelSession(org: string, surfaceKey: string): Promise<ChannelSessionRow | null>;
  rotateChannelSession(org: string, surfaceKey: string, newToken: string, at: string): Promise<ChannelSessionRow>;
  markChannelSessionRotation(org: string, surfaceKey: string, at: string): Promise<boolean>;
  touchChannelSession(org: string, surfaceKey: string, at: string): Promise<void>;
  bumpChannelSessionUsage(org: string, surfaceKey: string, token: string, delta: number): Promise<number>;
  listChannelSessions(org: string, keyPrefix?: string): Promise<ChannelSessionRow[]>;

  appendSessionTail(org: string, surfaceKey: string, token: string, entry: SessionTailEntry): Promise<void>;
  readSessionTail(org: string, surfaceKey: string, token: string): Promise<SessionTailEntry[]>;
  clearSessionTail(org: string, surfaceKey: string, token: string): Promise<void>;
  editSessionTailPost(org: string, surfaceKey: string, token: string, messageId: string, text: string): Promise<boolean>;

  listDomainSkills(org: string, domain: string): Promise<DomainSkillRow[]>;
  putDomainSkill(
    org: string,
    domain: string,
    name: string,
    content: string,
    updatedBy: string | undefined,
    updatedAt: string,
    provenance?: DomainSkillProvenance,
  ): Promise<void>;
  deleteDomainSkill(org: string, domain: string, name: string): Promise<boolean>;
  listDomainSkillRevisions(org: string, domain: string, name?: string): Promise<DomainSkillRevisionRow[]>;

  appendUsageEvent(entry: UsageEventEntry): Promise<void>;
  usageForSession(org: string, sessionId: string): Promise<UsageEventEntry[]>;
  usageSummary(org: string, filter?: UsageSummaryFilter): Promise<UsageSummaryRow[]>;
  pruneUsageEvents(org: string, olderThanTs: string): Promise<number>;

  appendModelCallCapture(write: ModelCallCaptureWrite): Promise<void>;
  modelCallCapturesForSession(org: string, sessionId: string, opts?: ModelCallCaptureReadOptions): Promise<ModelCallCaptureRow[]>;
  modelCallCaptureSessions(org: string): Promise<ModelCallCaptureSessionRow[]>;
  deleteModelCallCapturesForSession(org: string, sessionId: string): Promise<number>;

  addMemoryProposal(write: MemoryProposalWrite): Promise<MemoryProposalRow>;
  listMemoryProposals(org: string): Promise<MemoryProposalRow[]>;

  getDmAudience(org: string, address: string): Promise<DmAudienceRow | null>;
  markDmAudienceDelivered(org: string, address: string, at: string): Promise<void>;
  setDmAudienceStopped(org: string, address: string, at: string): Promise<void>;
  clearDmAudienceStopped(org: string, address: string): Promise<boolean>;
  listDmAudience(org: string): Promise<DmAudienceRow[]>;

  runAnalyticsQuery(compiled: CompiledAnalyticsQuery): Promise<Record<string, unknown>[]>;

  markEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;
  hasEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;
  forgetEventSeen(org: string, key: string): Promise<void>;

  captureDelivery(
    org: string,
    source: string,
    documentJson: string,
    at: string,
    captureUntil: string,
    maxRows: number,
  ): Promise<boolean>;
  listCapturedDeliveries(org: string, source: string, limit: number): Promise<readonly CapturedDeliveryRow[]>;
  clearCapturedDeliveries(org: string, source: string): Promise<void>;

  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number, windowToken?: string, inbound?: boolean): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<UnifiedWakeRecord | null>;
  markUnifiedWakeAnswered(org: string, wakeId: string, at: string, turnId?: string): Promise<void>;
  markUnifiedWakesAudited(org: string, wakeIds: readonly string[], at: string): Promise<void>;
  listUnauditedUnifiedWakes(org: string, windowToken: string, limit: number): Promise<readonly PendingUnifiedWake[]>;
  listPendingUnifiedWakes(org: string, windowToken: string, afterIso: string, limit: number): Promise<readonly PendingUnifiedWake[]>;

  putThreadOwner(org: string, channelKey: string, threadKey: string, taskToken: string, at: string, ttlMs: number): Promise<void>;
  getThreadOwner(org: string, channelKey: string, threadKey: string): Promise<string | null>;
  clearThreadOwner(org: string, channelKey: string, threadKey: string): Promise<boolean>;

  putThreadSeatState(org: string, row: ThreadSeatStateWrite, at: string, ttlMs: number): Promise<void>;
  getThreadSeatState(org: string, channelKey: string, threadKey: string): Promise<ThreadSeatStateRow | null>;

  putTurnAnchor(org: string, anchor: TurnAnchorWrite, at: string, ttlMs: number): Promise<void>;
  getTurnAnchorByWindow(org: string, windowKey: string): Promise<TurnAnchorRow | null>;
  getTurnAnchorByAnchor(org: string, anchorKey: string): Promise<TurnAnchorRow | null>;
  getLatestTurnAnchorForChannel(org: string, channelKey: string): Promise<TurnAnchorRow | null>;
  clearTurnAnchor(org: string, windowKey: string): Promise<boolean>;

  putTaskResult(org: string, taskId: string, resultJson: string, at: string, ttlMs: number): Promise<void>;
  putTaskResultIfAbsent(org: string, taskId: string, resultJson: string, at: string, ttlMs: number): Promise<boolean>;
  getTaskResult(org: string, taskId: string): Promise<string | null>;
  deleteTaskResult(org: string, taskId: string): Promise<boolean>;

  putSlackAttachment(org: string, fileId: string, rec: SlackAttachmentRow, at: string, ttlMs: number): Promise<void>;
  getSlackAttachment(org: string, fileId: string): Promise<SlackAttachmentRow | null>;

  addPendingAction(row: PendingActionRow): Promise<void>;
  addPendingActionIfAbsent(row: PendingActionRow): Promise<boolean>;
  getPendingAction(org: string, id: string): Promise<PendingActionRow | null>;
  listPendingActions(org: string): Promise<readonly PendingActionRow[]>;
  listExpiredPendingActions(org: string, nowIso: string): Promise<readonly PendingActionRow[]>;
  setPendingActionMessage(org: string, id: string, messageTs: string): Promise<void>;
  decidePendingAction(org: string, id: string, status: "approved" | "rejected" | "expired", decidedBy: string, decidedAt: string): Promise<boolean>;

  setSessionApproval(row: SessionApprovalRow): Promise<void>;
  getSessionApproval(org: string, sessionId: string, kind: string, nowIso: string): Promise<SessionApprovalRow | null>;
  listSessionApprovals(org: string, sessionId: string, nowIso: string): Promise<SessionApprovalRow[]>;
  revokeSessionApprovals(org: string, sessionId: string): Promise<number>;
  sweepLegacyConnectorOpRows(org: string): Promise<number>;

  putStoredCredential(org: string, rec: StoredCredentialRow): Promise<void>;
  getStoredCredential(org: string, ref: string): Promise<StoredCredentialRow | null>;
  deleteStoredCredential(org: string, ref: string): Promise<boolean>;
  listStoredCredentialRefs(org: string, refPrefix?: string): Promise<readonly string[]>;

  putGitHubInstallation(org: string, rec: GitHubInstallationRow): Promise<void>;
  deleteGitHubInstallation(org: string, owner: string): Promise<boolean>;
  listGitHubInstallations(org: string): Promise<readonly GitHubInstallationRow[]>;

  claimStoredCredential(org: string, ref: string, claimId: string, claimedAtIso: string, staleBeforeIso: string): Promise<boolean>;
  releaseStoredCredential(org: string, ref: string, claimId: string): Promise<boolean>;

  addCredentialIntake(row: CredentialIntakeRow): Promise<void>;
  getCredentialIntake(org: string, id: string): Promise<CredentialIntakeRow | null>;
  consumeCredentialIntake(org: string, id: string, usedAt: string): Promise<boolean>;

  armWebhookCaptureWindow(org: string, hookId: string, captureUntil: string, armedBy: string, at: string): Promise<void>;
  getWebhookCaptureWindow(org: string, hookId: string): Promise<WebhookCaptureWindowRow | null>;

  putLinkSet(org: string, row: LinkSetRow): Promise<void>;
  getLinkSet(org: string, id: string): Promise<LinkSetRow | null>;
  listLinkSets(org: string): Promise<readonly LinkSetRow[]>;
  updateLinkSetStatus(org: string, id: string, from: readonly LinkSetStatus[], to: LinkSetStatus, at: string): Promise<boolean>;

  insertLinkedId(org: string, row: LinkedIdRow): Promise<boolean>;
  getLinkedId(org: string, platform: string, tenant: string, nativeId: string): Promise<LinkedIdRow | null>;
  listLinkedIds(org: string, linkSetId?: string): Promise<readonly LinkedIdRow[]>;
  updateLinkedIdStatus(
    org: string,
    platform: string,
    tenant: string,
    nativeId: string,
    from: readonly LinkedIdStatus[],
    to: LinkedIdStatus,
    establishedBy: string,
    evidenceJson: string | undefined,
    at: string,
  ): Promise<boolean>;
  deleteLinkedId(org: string, platform: string, tenant: string, nativeId: string): Promise<boolean>;
  revokeLinkedIdsForSet(org: string, linkSetId: string, at: string): Promise<number>;

  unbackfilledLinkedIdPlatforms(): Promise<readonly string[]>;
  backfillLinkedIdTenant(platform: string, tenant: string, at: string): Promise<number>;

  addLinkChallenge(org: string, row: LinkChallengeRow): Promise<void>;
  getLinkChallenge(org: string, id: string): Promise<LinkChallengeRow | null>;
  listLinkChallenges(org: string, filter?: LinkChallengeFilter): Promise<readonly LinkChallengeRow[]>;
  claimLinkChallenge(org: string, nonceHash: string, platform: string, tenant: string, nativeId: string, at: string, backNonceHash?: string): Promise<LinkChallengeRow | null>;
  consentLinkChallenge(
    org: string,
    id: string,
    consenter: { readonly platform: string; readonly tenant: string; readonly nativeId: string },
    at: string,
    backNonceHash?: string,
  ): Promise<LinkChallengeRow | null>;
  decideLinkChallenge(org: string, id: string, from: readonly LinkChallengeStatus[], to: LinkChallengeStatus, at: string): Promise<boolean>;
  expireLinkChallenges(org: string, nowIso: string): Promise<number>;

  addCredentialGrantAsk(org: string, row: CredentialGrantAskRow): Promise<void>;
  getCredentialGrantAsk(org: string, id: string): Promise<CredentialGrantAskRow | null>;
  liveCredentialGrantAsk(
    org: string,
    requesterPrincipalId: string,
    ownerPrincipalId: string,
    verb: string,
    resource: string,
    nowIso: string,
  ): Promise<CredentialGrantAskRow | null>;
  approveCredentialGrantAsk(org: string, id: string, mode: CredentialGrantMode, grantId: string, at: string): Promise<CredentialGrantAskRow | null>;
  decideCredentialGrantAsk(org: string, id: string, from: readonly CredentialGrantAskState[], to: CredentialGrantAskState, at: string): Promise<boolean>;
  setCredentialGrantAskCard(org: string, id: string, surfaceId: string, messageId: string): Promise<void>;
  listExpiredCredentialGrantAsks(org: string, nowIso: string): Promise<readonly CredentialGrantAskRow[]>;
  pendingCredentialGrantAsksForScope(org: string, scopeKey: string, nowIso: string): Promise<readonly CredentialGrantAskRow[]>;
  addCredentialGrant(org: string, row: CredentialGrantRow): Promise<void>;
  getCredentialGrant(org: string, id: string): Promise<CredentialGrantRow | null>;
  credentialGrantsForScope(org: string, scopeKey: string): Promise<readonly CredentialGrantRow[]>;
  liveCredentialGrantsForOwner(org: string, ownerPrincipalId: string, nowIso: string): Promise<readonly CredentialGrantRow[]>;
  liveBorrowCredentialGrant(
    org: string,
    ownerPrincipalId: string,
    connector: string,
    mcpTool: string,
    frozenArgsDigest: string,
    scopeKey: string,
    nowIso: string,
  ): Promise<CredentialGrantRow | null>;
  burnCredentialGrant(org: string, id: string, at: string): Promise<CredentialGrantRow | null>;
  refundCredentialGrant(org: string, id: string, burnedAt: string): Promise<boolean>;
  claimCredentialGrantRefund(org: string, id: string, turnKey: string | undefined, cap: number): Promise<boolean>;
  revokeCredentialGrant(org: string, id: string, at: string): Promise<boolean>;
  expireCredentialGrants(org: string, nowIso: string): Promise<number>;

  claimNotice(org: string, key: string, at: string, prune?: NoticeClaimPrune): Promise<boolean>;
  noticeClaimed(org: string, key: string): Promise<boolean>;

  recordProactiveAddress(org: string, row: ProactiveAddress): Promise<void>;
  proactiveAddress(org: string, platform: string, kind: string, refKey: string): Promise<ProactiveAddress | undefined>;
  proactiveAddresses(org: string, platform: string, kind: string, limit: number): Promise<readonly ProactiveAddress[]>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
