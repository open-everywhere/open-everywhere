import { routineGrantGeneration, type Routine } from "../routines/routine.js";
import type { PendingActionRow } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";
import type { UnifiedWakeRecord } from "../channels/unified-window.js";

export const OPERATIONAL_TABLES = [
  "spend_ledger",
  "routine",
  "routine_prompt_revisions",
  "audit_entry",
  "spend_limit",
  "connector_override",
  "thread_engagement",
  "channel_session",
  "event_dedupe",
  "unified_wake_target",
  "thread_ownership",
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
] as const;

export const EVENT_DEDUPE_MAX_RETENTION_MS = 24 * 60 * 60_000;

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

export interface SpendLedgerKey {
  readonly surfaceKey: string;
  readonly principalId: string;
  readonly routineId: string;
  readonly model: string;
  readonly period: string;
}

export interface SpendLedgerRow extends SpendLedgerKey {
  readonly org: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly usdMicros: number;
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
  readonly usdMicros?: number;
}

export interface SpendLedgerFilter {
  readonly surfaceKey?: string;
  readonly surfaceKeyPrefix?: string;
  readonly principalId?: string;
  readonly routineId?: string;
  readonly period?: string;
}

export interface SpendTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly usdMicros: number;
  readonly calls: number;
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
    params.push(`${filter.surfaceKeyPrefix.replace(/([\\%_])/g, "\\$1")}%`);
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
  return { conjuncts, params };
}

export interface OverrideMeta {
  readonly expiresAt?: number;
  readonly reason?: string;
  readonly setBy?: string;
}

export type CapLevel = "surface" | "workspace" | "domain";
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
          generation: routineGrantGeneration(existing),
          ...(existing.createdBy ? { authoredBy: existing.createdBy } : {}),
          recordedAt: existing.createdAt,
        },
      ];
  return [
    ...genesis,
    {
      prompt: updated.prompt,
      generation: routineGrantGeneration(updated),
      ...(provenance?.authoredBy ? { authoredBy: provenance.authoredBy } : {}),
      ...(provenance?.armedBy ? { armedBy: provenance.armedBy } : {}),
      ...(provenance?.approvalId ? { approvalId: provenance.approvalId } : {}),
      recordedAt: nowIso,
    },
  ];
}

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
  readonly model?: string;
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
  readonly handoffNote: string | null;
}

export interface TaskResultRow {
  readonly taskId: string;
  readonly resultJson: string;
  readonly createdAt: string;
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
  readonly provider?: string;
  readonly domain?: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CredentialIntakeRow {
  readonly org: string;
  readonly id: string;
  readonly ref: string;
  readonly provider: string;
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
  readonly initiatingPlatform: string;
  readonly initiatingNativeId: string;
  readonly initiatingSurfaceKey: string;
  readonly claimedPlatform?: string;
  readonly claimedNativeId?: string;
  readonly claimedAt?: string;
  readonly status: LinkChallengeStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
}

export interface LinkChallengeFilter {
  readonly initiatingPlatform?: string;
  readonly initiatingNativeId?: string;
  readonly status?: LinkChallengeStatus;
}

export interface OperationalStore {
  readonly id: string;
  root(): string;

  recordSpend(org: string, write: SpendLedgerWrite): Promise<void>;
  spendTotals(org: string, filter?: SpendLedgerFilter): Promise<SpendTotals>;
  listSpendLedger(org?: string): Promise<SpendLedgerRow[]>;

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

  setSpendLimit(org: string, scopeKey: string, level: CapLevel, limit: SpendLimitAmount, meta?: OverrideMeta): Promise<void>;
  clearSpendLimit(org: string, scopeKey: string, level: CapLevel): Promise<boolean>;
  spendLimits(org: string): Promise<SpendLimitRow[]>;

  setConnectorOverride(org: string, scopeKey: string, connector: string, granted: boolean, meta?: Omit<OverrideMeta, "expiresAt">): Promise<void>;
  clearConnectorOverride(org: string, scopeKey: string, connector: string): Promise<boolean>;
  connectorOverrides(org: string, scopeKey: string): Promise<ConnectorOverrideRow[]>;
  allConnectorOverrides(org: string): Promise<ScopedConnectorOverrideRow[]>;

  setDomainModel(org: string, domain: string, pick: { readonly modelId?: string; readonly reasoning?: ModelReasoning }, setBy?: string): Promise<void>;
  clearDomainModel(org: string, domain: string): Promise<boolean>;
  getDomainModel(org: string, domain: string): Promise<DomainModelRow | null>;
  domainModels(org: string): Promise<DomainModelRow[]>;

  markEngaged(org: string, surfaceKey: string, threadTs: string, at: string, opts?: { participating?: boolean; ownerToken?: string; kind?: "thread" | "spawned" }): Promise<void>;
  markStopped(org: string, surfaceKey: string, threadTs: string): Promise<boolean>;
  bumpSilentStreak(org: string, surfaceKey: string, threadTs: string): Promise<number>;
  getEngagement(org: string, surfaceKey: string, threadTs: string): Promise<EngagementRow | null>;
  disengage(org: string, surfaceKey: string, threadTs: string): Promise<boolean>;
  listEngagements(org: string): Promise<EngagementRow[]>;

  getChannelSession(org: string, surfaceKey: string): Promise<ChannelSessionRow | null>;
  rotateChannelSession(org: string, surfaceKey: string, newToken: string, at: string, handoffNote?: string): Promise<ChannelSessionRow>;
  touchChannelSession(org: string, surfaceKey: string, at: string): Promise<void>;
  bumpChannelSessionUsage(org: string, surfaceKey: string, token: string, delta: number): Promise<number>;

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

  runAnalyticsQuery(compiled: CompiledAnalyticsQuery): Promise<Record<string, unknown>[]>;

  markEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;

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

  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number, windowToken?: string): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<UnifiedWakeRecord | null>;
  markUnifiedWakeAnswered(org: string, wakeId: string, at: string, turnId?: string): Promise<void>;

  putThreadOwner(org: string, channelKey: string, threadKey: string, taskToken: string, at: string, ttlMs: number): Promise<void>;
  getThreadOwner(org: string, channelKey: string, threadKey: string): Promise<string | null>;
  clearThreadOwner(org: string, channelKey: string, threadKey: string): Promise<boolean>;

  putTaskResult(org: string, taskId: string, resultJson: string, at: string, ttlMs: number, callerToken?: string): Promise<void>;
  putTaskResultIfAbsent(org: string, taskId: string, resultJson: string, at: string, ttlMs: number, callerToken?: string): Promise<boolean>;
  getTaskResult(org: string, taskId: string): Promise<string | null>;
  deleteTaskResult(org: string, taskId: string): Promise<boolean>;
  listUndeliveredTaskResults(org: string, callerToken: string, limit: number): Promise<readonly TaskResultRow[]>;
  markTaskResultDelivered(org: string, taskId: string, at: string): Promise<void>;

  putSlackAttachment(org: string, fileId: string, rec: SlackAttachmentRow, at: string, ttlMs: number): Promise<void>;
  getSlackAttachment(org: string, fileId: string): Promise<SlackAttachmentRow | null>;

  addPendingAction(row: PendingActionRow): Promise<void>;
  getPendingAction(org: string, id: string): Promise<PendingActionRow | null>;
  listPendingActions(org: string): Promise<readonly PendingActionRow[]>;
  listExpiredPendingActions(org: string, nowIso: string): Promise<readonly PendingActionRow[]>;
  setPendingActionMessage(org: string, id: string, messageTs: string): Promise<void>;
  decidePendingAction(org: string, id: string, status: "approved" | "rejected" | "expired", decidedBy: string, decidedAt: string): Promise<boolean>;

  setSessionApproval(row: SessionApprovalRow): Promise<void>;
  getSessionApproval(org: string, sessionId: string, kind: string, nowIso: string): Promise<SessionApprovalRow | null>;
  listSessionApprovals(org: string, sessionId: string, nowIso: string): Promise<SessionApprovalRow[]>;
  revokeSessionApprovals(org: string, sessionId: string): Promise<number>;

  putStoredCredential(org: string, rec: StoredCredentialRow): Promise<void>;
  getStoredCredential(org: string, ref: string): Promise<StoredCredentialRow | null>;

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
  getLinkedId(org: string, platform: string, nativeId: string): Promise<LinkedIdRow | null>;
  listLinkedIds(org: string, linkSetId?: string): Promise<readonly LinkedIdRow[]>;
  updateLinkedIdStatus(
    org: string,
    platform: string,
    nativeId: string,
    from: readonly LinkedIdStatus[],
    to: LinkedIdStatus,
    establishedBy: string,
    evidenceJson: string | undefined,
    at: string,
  ): Promise<boolean>;
  deleteLinkedId(org: string, platform: string, nativeId: string): Promise<boolean>;
  revokeLinkedIdsForSet(org: string, linkSetId: string, at: string): Promise<number>;

  addLinkChallenge(org: string, row: LinkChallengeRow): Promise<void>;
  getLinkChallenge(org: string, id: string): Promise<LinkChallengeRow | null>;
  listLinkChallenges(org: string, filter?: LinkChallengeFilter): Promise<readonly LinkChallengeRow[]>;
  claimLinkChallenge(org: string, nonceHash: string, platform: string, nativeId: string, at: string): Promise<LinkChallengeRow | null>;
  decideLinkChallenge(org: string, id: string, from: readonly LinkChallengeStatus[], to: LinkChallengeStatus, at: string): Promise<boolean>;
  expireLinkChallenges(org: string, nowIso: string): Promise<number>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
