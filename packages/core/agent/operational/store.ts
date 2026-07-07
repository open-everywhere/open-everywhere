import type { SurfaceLedger, Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";
import type { PendingActionRow } from "../approvals/types.js";

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

export type CapLevel = "surface" | "workspace";
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

  markEngaged(org: string, surfaceKey: string, threadTs: string, at: string): Promise<void>;
  getEngagement(org: string, surfaceKey: string, threadTs: string): Promise<EngagementRow | null>;
  disengage(org: string, surfaceKey: string, threadTs: string): Promise<boolean>;
  listEngagements(org: string): Promise<EngagementRow[]>;

  listDomainSkills(org: string, domain: string): Promise<DomainSkillRow[]>;
  putDomainSkill(org: string, domain: string, name: string, content: string, updatedBy: string | undefined, updatedAt: string): Promise<void>;
  deleteDomainSkill(org: string, domain: string, name: string): Promise<boolean>;

  appendUsageEvent(entry: UsageEventEntry): Promise<void>;
  usageForSession(org: string, sessionId: string): Promise<UsageEventEntry[]>;
  usageSummary(org: string, filter?: UsageSummaryFilter): Promise<UsageSummaryRow[]>;
  pruneUsageEvents(org: string, olderThanTs: string): Promise<number>;

  markEventSeen(org: string, key: string, at: string, ttlMs: number): Promise<boolean>;

  addPendingAction(row: PendingActionRow): Promise<void>;
  getPendingAction(org: string, id: string): Promise<PendingActionRow | null>;
  setPendingActionMessage(org: string, id: string, messageTs: string): Promise<void>;
  decidePendingAction(org: string, id: string, status: "approved" | "rejected" | "expired", decidedBy: string, decidedAt: string): Promise<boolean>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
