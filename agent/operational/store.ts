import type { SurfaceLedger, Usage } from "../spend/spend.js";
import type { Routine } from "../routines/routine.js";

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

export type CapLevel = "surface" | "workspace";
export interface SpendLimitRow {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly monthlyTokens: number;
}

export interface ConnectorOverrideRow {
  readonly connector: string;
  readonly granted: boolean;
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

  setSpendLimit(org: string, scopeKey: string, level: CapLevel, monthlyTokens: number): Promise<void>;
  clearSpendLimit(org: string, scopeKey: string, level: CapLevel): Promise<boolean>;
  spendLimits(org: string): Promise<SpendLimitRow[]>;

  setConnectorOverride(org: string, scopeKey: string, connector: string, granted: boolean): Promise<void>;
  clearConnectorOverride(org: string, scopeKey: string, connector: string): Promise<boolean>;
  connectorOverrides(org: string, scopeKey: string): Promise<ConnectorOverrideRow[]>;
}
