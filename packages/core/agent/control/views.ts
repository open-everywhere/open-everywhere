import { allLedgers, spendRoot } from "../spend/store.js";
import { windowTokens } from "../spend/spend.js";
import { resolveCaps } from "../spend/caps.js";
import { getOperationalStore } from "../operational/provider.js";
import { listAllRoutines, routinesRoot } from "../routines/store.js";
import { isDue } from "../routines/schedule.js";
import { describeTrigger } from "../routines/routine.js";
import { readAudit, auditRoot, type AuditFilter, type AuditEntry } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "../access/resolver.js";
import { usageSummary } from "../spend/usage-events.js";
import type { UsageSummaryRow } from "../operational/store.js";
import { estimateCostUsd } from "../spend/pricing.js";
import { resolveAssumedModel, filterToDomain, buildRoutinePredictions, type RoutinePredictionRow } from "../spend/reporting.js";
import { listDomainSkills } from "../skills/domain-skills.js";
import type { DomainSkillRow } from "../operational/store.js";
import { providerById } from "../memory/provider.js";
import { siloTier } from "../memory/store.js";
import { controlPartition } from "../memory/partition.js";
import { sourceLabel } from "../memory/listing.js";
import { siloCoveringDomains } from "./auth.js";
import type { MemorySilo } from "../memory/silo.js";

const currentPeriod = (): string => new Date().toISOString().slice(0, 7);

export interface SpendSurfaceRow {
  readonly org: string;
  readonly surfaceKey: string;
  readonly tokens: number;
  readonly cap: number | null;
  readonly over: boolean;
}
export interface SpendWorkspaceRow {
  readonly key: string;
  readonly tokens: number;
  readonly cap: number | null;
  readonly over: boolean;
}
export interface SpendView {
  readonly root: string;
  readonly period: string;
  readonly surfaces: readonly SpendSurfaceRow[];
  readonly workspaces: readonly SpendWorkspaceRow[];
}

export async function spendView(period: string = currentPeriod()): Promise<SpendView> {
  const ledgers = await allLedgers();
  const surfaces: SpendSurfaceRow[] = [];
  const byWorkspace = new Map<string, number>();
  for (const { org, surfaceKey, ledger } of ledgers) {
    const tokens = windowTokens(ledger.windows[period]);
    const cap = resolveCaps(surfaceKey.split("/").slice(0, 2).join("/"), surfaceKey).surfaceMonthlyTokens ?? null;
    surfaces.push({ org, surfaceKey, tokens, cap, over: cap != null && tokens >= cap });
    const wk = `${org}/${surfaceKey.split("/").slice(0, 2).join("/")}`;
    byWorkspace.set(wk, (byWorkspace.get(wk) ?? 0) + tokens);
  }
  const workspaces: SpendWorkspaceRow[] = [...byWorkspace].map(([key, tokens]) => {
    const cap = resolveCaps(key.split("/").slice(1).join("/"), "").workspaceMonthlyTokens ?? null;
    return { key, tokens, cap, over: cap != null && tokens >= cap };
  });
  return { root: spendRoot(), period, surfaces, workspaces };
}

export interface RoutineRow {
  readonly id: string;
  readonly org: string;
  readonly surfaceKey: string;
  readonly status: string;
  readonly trigger: string;
  readonly nextRunAt: string | null;
  readonly prompt: string;
  readonly lastOutcome?: string;
  readonly consecutiveFailures?: number;
  readonly disabledReason?: string;
}
export interface RoutinesView {
  readonly root: string;
  readonly total: number;
  readonly dueCount?: number;
  readonly routines: readonly RoutineRow[];
}

export async function routinesView(opts: { onlyDue?: boolean } = {}): Promise<RoutinesView> {
  const now = new Date();
  const all = await listAllRoutines();
  const dueCount = all.filter((r) => r.status === "active" && isDue(r.nextRunAt, now)).length;
  const rows = opts.onlyDue ? all.filter((r) => r.status === "active" && isDue(r.nextRunAt, now)) : all;
  return {
    root: routinesRoot(),
    total: all.length,
    ...(opts.onlyDue ? { dueCount } : {}),
    routines: rows.map((r) => ({
      id: r.id,
      org: r.org,
      surfaceKey: r.surfaceKey,
      status: r.status,
      trigger: describeTrigger(r.trigger),
      nextRunAt: r.nextRunAt ?? null,
      prompt: r.prompt,
      ...(r.lastOutcome ? { lastOutcome: r.lastOutcome } : {}),
      ...(r.consecutiveFailures ? { consecutiveFailures: r.consecutiveFailures } : {}),
      ...(r.disabledReason ? { disabledReason: r.disabledReason } : {}),
    })),
  };
}

export interface AuditView {
  readonly root: string;
  readonly filter: AuditFilter;
  readonly capped: boolean;
  readonly entries: readonly AuditEntry[];
}

export async function auditView(filter: AuditFilter = {}): Promise<AuditView> {
  const limit = filter.limit ?? 200;
  const f: AuditFilter = { ...filter, limit };
  const entries = await readAudit(f);
  return { root: auditRoot(), filter: f, capped: entries.length === limit, entries };
}

export interface SpendOverrideDriftRow {
  readonly scopeKey: string;
  readonly level: "surface" | "workspace";
  readonly monthlyTokens: number;
  readonly configCap: number | null;
  readonly divergesFromConfig: boolean;
  readonly expiresAt?: number;
  readonly expired: boolean;
  readonly reason?: string;
  readonly setBy?: string;
}
export interface ConnectorOverrideDriftRow {
  readonly scopeKey: string;
  readonly connector: string;
  readonly granted: boolean;
  readonly sticky: true;
  readonly reason?: string;
  readonly setBy?: string;
}
export interface OverridesView {
  readonly org: string;
  readonly now: number;
  readonly spend: readonly SpendOverrideDriftRow[];
  readonly connectors: readonly ConnectorOverrideDriftRow[];
  readonly note: string;
}

export async function overridesView(org: string, now: number = Date.now()): Promise<OverridesView> {
  const store = getOperationalStore();
  const [limits, connectors] = await Promise.all([store.spendLimits(org), store.allConnectorOverrides(org)]);
  const spend: SpendOverrideDriftRow[] = limits.map((l) => {
    const configCap =
      l.level === "surface"
        ? resolveCaps(l.scopeKey.split("/").slice(0, 2).join("/"), l.scopeKey).surfaceMonthlyTokens ?? null
        : resolveCaps(l.scopeKey, "").workspaceMonthlyTokens ?? null;
    return {
      scopeKey: l.scopeKey,
      level: l.level,
      monthlyTokens: l.monthlyTokens,
      configCap,
      divergesFromConfig: configCap !== l.monthlyTokens,
      ...(l.expiresAt != null ? { expiresAt: l.expiresAt } : {}),
      expired: l.expiresAt != null && l.expiresAt <= now,
      ...(l.reason ? { reason: l.reason } : {}),
      ...(l.setBy ? { setBy: l.setBy } : {}),
    };
  });
  const connectorRows: ConnectorOverrideDriftRow[] = connectors.map((c) => ({
    scopeKey: c.scopeKey,
    connector: c.connector,
    granted: c.granted,
    sticky: true,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.setBy ? { setBy: c.setBy } : {}),
  }));
  return {
    org,
    now,
    spend,
    connectors: connectorRows,
    note: "Overrides are temporary bridges — reconcile each into config (PR) or clear it. Spend rows with divergesFromConfig=true need a caps.ts PR (or clear_spend_limit); expired=true rows are no longer applied and should be cleared. Connector revokes are sticky (no auto-expiry — clearing re-opens access); clear deliberately or remove the grant from bundles.ts.",
  };
}

export interface UsageSummaryQuery {
  readonly org: string;
  readonly domain?: string;
  readonly surfaceKey?: string;
  readonly sinceDays?: number;
  readonly assumedModelId?: string;
}
export interface UsageSummaryViewRow extends UsageSummaryRow {
  readonly costUsd?: number;
}
export interface UsageSummaryViewResult {
  readonly org: string;
  readonly domain?: string;
  readonly surfaceKey?: string;
  readonly sinceDays: number;
  readonly since: string;
  readonly rows: readonly UsageSummaryViewRow[];
  readonly pricedModel?: string;
  readonly routinePredictions: readonly RoutinePredictionRow[];
  readonly note: string;
}

export async function usageSummaryView(q: UsageSummaryQuery): Promise<UsageSummaryViewResult> {
  const sinceDays = q.sinceDays ?? 30;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const all = await usageSummary(q.org, { sinceTs: since, ...(q.surfaceKey && !q.domain ? { surfaceKeyPrefix: q.surfaceKey } : {}) });
  const rows = q.domain ? filterToDomain(all, q.domain, getConfig().loadDomains()) : all;
  const assumed = resolveAssumedModel(q.assumedModelId);
  const priced: UsageSummaryViewRow[] = rows.map((r) => ({ ...r, ...(assumed.pricing ? { costUsd: estimateCostUsd(r, assumed.pricing) } : {}) }));
  const routineRows = rows.filter((r) => r.kind === "routine");
  const routinePredictions = await buildRoutinePredictions(q.org, routineRows, assumed.pricing);
  return {
    org: q.org,
    ...(q.domain ? { domain: q.domain } : {}),
    ...(q.surfaceKey ? { surfaceKey: q.surfaceKey } : {}),
    sinceDays,
    since,
    rows: priced,
    ...(assumed.model ? { pricedModel: assumed.model } : {}),
    routinePredictions,
    note: assumed.note,
  };
}

export interface SkillsListQuery {
  readonly org: string;
  readonly domain: string;
}
export interface SkillsListResult {
  readonly org: string;
  readonly domain: string;
  readonly skills: readonly DomainSkillRow[];
}

export async function skillsListView(q: SkillsListQuery): Promise<SkillsListResult> {
  const skills = await listDomainSkills(q.org, q.domain);
  return { org: q.org, domain: q.domain, skills };
}

export interface MemoryFileRow {
  readonly path: string;
  readonly bytes: number;
}
export interface MemoryTierRow {
  readonly silo: string;
  readonly domains: readonly string[];
  readonly provider: string;
  readonly backing: string;
  readonly readOnly: boolean;
  readonly files: readonly MemoryFileRow[];
  readonly totalBytes: number;
}
export interface MemoryListResult {
  readonly org: string;
  readonly tiers: readonly MemoryTierRow[];
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf-8");
}

async function memoryTierRow(org: string, silo: MemorySilo, domains: string[]): Promise<MemoryTierRow> {
  const provider = providerById(silo.provider);
  const files = await provider.readTier(controlPartition(org), siloTier(silo.name), silo);
  const rows: MemoryFileRow[] = Object.entries(files)
    .map(([path, content]) => ({ path, bytes: byteSize(content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    silo: silo.name,
    domains,
    provider: silo.provider,
    backing: sourceLabel(silo),
    readOnly: silo.readOnly === true,
    files: rows,
    totalBytes: rows.reduce((sum, f) => sum + f.bytes, 0),
  };
}

export async function memoryListView(org: string, roles: readonly string[]): Promise<MemoryListResult> {
  const cfg = getConfig();
  const domains = cfg.loadDomains();
  const isAdmin = roles.includes("admin");
  const domainRoles = new Set(roles.filter((r) => r.startsWith("domain:")).map((r) => r.slice("domain:".length)));

  const tiers: MemoryTierRow[] = [];
  for (const silo of cfg.loadSilos()) {
    const covering = siloCoveringDomains(silo.name, domains);
    if (!isAdmin && !covering.some((d) => domainRoles.has(d))) continue;
    tiers.push(await memoryTierRow(org, silo, covering));
  }
  return { org, tiers: tiers.sort((a, b) => a.silo.localeCompare(b.silo)) };
}

export function assertSafeRelPath(relPath: string): void {
  if (!relPath || relPath.trim().length === 0) throw new Error("relPath is required");
  if (relPath.startsWith("/") || relPath.includes("\\")) throw new Error(`relPath must be a relative posix path (got "${relPath}")`);
  const segments = relPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`relPath must not contain ".." or empty segments (got "${relPath}")`);
  }
}

export interface MemoryReadQuery {
  readonly org: string;
  readonly silo: string;
  readonly relPath: string;
}
export interface MemoryReadResult {
  readonly org: string;
  readonly silo: string;
  readonly relPath: string;
  readonly content: string;
  readonly bytes: number;
}

export async function memoryReadView(q: MemoryReadQuery): Promise<MemoryReadResult> {
  assertSafeRelPath(q.relPath);
  const silo = getConfig()
    .loadSilos()
    .find((s) => s.name === q.silo);
  if (!silo) throw new Error(`no memory silo named "${q.silo}" (memory_list for the configured silos).`);
  const provider = providerById(silo.provider);
  const files = await provider.readTier(controlPartition(q.org), siloTier(silo.name), silo);
  const content = files[q.relPath];
  if (content === undefined) {
    const have = Object.keys(files).sort().join(", ") || "(none)";
    throw new Error(`"${q.relPath}" is not a file in silo "${q.silo}" (have: ${have}).`);
  }
  return { org: q.org, silo: q.silo, relPath: q.relPath, content, bytes: byteSize(content) };
}

export interface AccessQuery {
  readonly platform?: string;
  readonly workspace?: string;
  readonly channel?: string;
  readonly mode?: SessionMode;
  readonly principalId?: string;
}

export async function accessView(q: AccessQuery = {}) {
  const cfg = getConfig();
  const platform = q.platform ?? "local";
  const workspace = q.workspace ?? "dev";
  const channel = q.channel ?? "default";
  const req: ResolveRequest = {
    mode: q.mode ?? "channel",
    platform,
    workspace,
    channel,
    domains: cfg.domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
    principalId: q.principalId,
  };
  const access = resolveAccess(req, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry);
  return {
    scopeKey: access.scopeKey,
    mode: access.mode,
    reachableHosts: access.reachableHosts,
    connections: access.connections.map((c) => ({
      id: c.id,
      credentialType: c.credentialType,
      secretRef: c.secretRef,
      allowedWebsites: c.allowedWebsites,
    })),
    repos: access.repos,
    plugins: access.plugins,
    skills: access.skills,
    subagents: access.subagents,
    connectors: access.connectors,
    instructionStack: access.instructionStack,
    warnings: access.warnings,
  };
}
