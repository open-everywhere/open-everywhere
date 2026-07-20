import type { SurfaceLedger, Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import type { PendingActionRow } from "../approvals/types.js";
import type { ModelReasoning } from "../memory/domain.js";

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

export interface OrgSurfaceLedger {
  readonly org: string;
  readonly surfaceKey: string;
  readonly ledger: SurfaceLedger;
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

export interface UsageEventEntry {
  readonly org: string;
  readonly surfaceKey: string;
  readonly sessionId: string;
  readonly principalId?: string;
  readonly ts: string;
  readonly kind?: string;
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
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly events: number;
  readonly sessions: number;
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

export interface OperationalStore {
  readonly id: string;
  root(): string;

  recordUsage(org: string, surfaceKey: string, period: string, usage: Usage): Promise<void>;
  surfaceLedger(org: string, surfaceKey: string): Promise<SurfaceLedger>;
  allLedgers(): Promise<OrgSurfaceLedger[]>;

  listRoutines(org: string, surfaceKey: string): Promise<Routine[]>;
  getRoutine(org: string, surfaceKey: string, id: string): Promise<Routine | null>;
  addRoutine(routine: Routine): Promise<Routine>;
  updateRoutine(org: string, surfaceKey: string, id: string, patch: Partial<Routine>): Promise<Routine | null>;
  removeRoutine(org: string, surfaceKey: string, id: string): Promise<boolean>;
  listAllRoutines(): Promise<Routine[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  readAudit(filter: AuditFilter): Promise<AuditEntry[]>;

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
  bumpChannelSessionUsage(org: string, surfaceKey: string, token: string, delta: number): Promise<void>;

  listDomainSkills(org: string, domain: string): Promise<DomainSkillRow[]>;
  putDomainSkill(org: string, domain: string, name: string, content: string, updatedBy: string | undefined, updatedAt: string): Promise<void>;
  deleteDomainSkill(org: string, domain: string, name: string): Promise<boolean>;

  appendUsageEvent(entry: UsageEventEntry): Promise<void>;
  usageForSession(org: string, sessionId: string): Promise<UsageEventEntry[]>;
  usageSummary(org: string, filter?: UsageSummaryFilter): Promise<UsageSummaryRow[]>;
  pruneUsageEvents(org: string, olderThanTs: string): Promise<number>;

  markEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;

  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;

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

  putStoredCredential(org: string, rec: StoredCredentialRow): Promise<void>;
  getStoredCredential(org: string, ref: string): Promise<StoredCredentialRow | null>;

  addCredentialIntake(row: CredentialIntakeRow): Promise<void>;
  getCredentialIntake(org: string, id: string): Promise<CredentialIntakeRow | null>;
  consumeCredentialIntake(org: string, id: string, usedAt: string): Promise<boolean>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
