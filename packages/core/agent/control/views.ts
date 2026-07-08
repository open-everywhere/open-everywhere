import { allLedgers, spendRoot } from "../spend/store.js";
import { windowTokens, periodOf, type Caps } from "../spend/spend.js";
import { resolveCaps, applyCapOverrides, activeSpendLimitsForOrg, domainNameForScope } from "../spend/caps.js";
import { workspaceUsdSpendForCurrentMonth, workspaceUsdSpendForPeriod, type WorkspaceUsdSpend } from "../spend/check.js";
import { getOperationalStore } from "../operational/provider.js";
import { listAllRoutines, routinesRoot } from "../routines/store.js";
import { isDue } from "../routines/schedule.js";
import { describeTrigger } from "../routines/routine.js";
import { readAudit, auditRoot, type AuditFilter, type AuditEntry } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "../access/resolver.js";
import { usageSummary } from "../spend/usage-events.js";
import type { CapLevel, UsageSummaryRow } from "../operational/store.js";
import { resolveAssumedModel, rowCostUsd, pricingMix, pricingNote, filterToDomain, buildRoutinePredictions, type RoutinePredictionRow } from "../spend/reporting.js";
import { modelPricing, estimateCostUsd, ensurePricingFor } from "../spend/pricing.js";
import { deploymentOrg } from "../identity/binding.js";
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
  readonly tokenCap: number | null;
  readonly tokenOver: boolean;
  readonly usd: number;
  readonly usdCap: number | null;
  readonly usdOver: boolean;
  readonly over: boolean;
}
export interface SpendWorkspaceRow {
  readonly key: string;
  readonly tokens: number;
  readonly tokenCap: number | null;
  readonly tokenOver: boolean;
  readonly usd: number;
  readonly usdCap: number | null;
  readonly usdOver: boolean;
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
  const nowISO = new Date().toISOString();
  const isCurrentPeriod = period === periodOf(nowISO);

  const orgs = [...new Set(ledgers.map((l) => l.org))];
  const limitsByOrg = new Map(await Promise.all(orgs.map(async (org) => [org, await activeSpendLimitsForOrg(org)] as const)));
  const effCapsFor = (org: string, workspaceKey: string, surfaceKey: string): Caps => {
    const config = resolveCaps(workspaceKey, surfaceKey, domainNameForScope(surfaceKey));
    const limits = limitsByOrg.get(org) ?? [];
    return limits.length ? applyCapOverrides(config, limits, workspaceKey, surfaceKey) : config;
  };

  const SEP = "\u0000";
  const orgWorkspaceKeys = [...new Set(ledgers.map((l) => `${l.org}${SEP}${l.surfaceKey.split("/").slice(0, 2).join("/")}`))];
  const usdByOrgWorkspace = new Map<string, WorkspaceUsdSpend>(
    await Promise.all(
      orgWorkspaceKeys.map(async (combo) => {
        const sepAt = combo.indexOf(SEP);
        const org = combo.slice(0, sepAt);
        const workspaceKey = combo.slice(sepAt + 1);
        const usd = isCurrentPeriod ? await workspaceUsdSpendForCurrentMonth(org, workspaceKey, nowISO) : await workspaceUsdSpendForPeriod(org, workspaceKey, period);
        return [combo, usd] as const;
      }),
    ),
  );

  const surfaces: SpendSurfaceRow[] = [];
  const byWorkspaceTokens = new Map<string, number>();
  for (const { org, surfaceKey, ledger } of ledgers) {
    const workspaceKey = surfaceKey.split("/").slice(0, 2).join("/");
    const tokens = windowTokens(ledger.windows[period]);
    const caps = effCapsFor(org, workspaceKey, surfaceKey);
    const tokenCap = caps.surfaceMonthlyTokens ?? null;
    const tokenOver = tokenCap != null && tokens >= tokenCap;
    const usd = usdByOrgWorkspace.get(`${org}${SEP}${workspaceKey}`)?.bySurface.get(surfaceKey) ?? 0;
    const usdCap = caps.surfaceMonthlyUsd ?? null;
    const usdOver = usdCap != null && usd >= usdCap;
    surfaces.push({ org, surfaceKey, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver });
    const wk = `${org}/${workspaceKey}`;
    byWorkspaceTokens.set(wk, (byWorkspaceTokens.get(wk) ?? 0) + tokens);
  }
  const workspaces: SpendWorkspaceRow[] = [...byWorkspaceTokens].map(([key, tokens]) => {
    const org = key.slice(0, key.indexOf("/"));
    const workspaceKey = key.slice(key.indexOf("/") + 1);
    const caps = effCapsFor(org, workspaceKey, "");
    const tokenCap = caps.workspaceMonthlyTokens ?? null;
    const tokenOver = tokenCap != null && tokens >= tokenCap;
    const usd = usdByOrgWorkspace.get(`${org}${SEP}${workspaceKey}`)?.workspaceUsd ?? 0;
    const usdCap = caps.workspaceMonthlyUsd ?? null;
    const usdOver = usdCap != null && usd >= usdCap;
    return { key, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver };
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
  readonly level: CapLevel;
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
  readonly configCap: number | null;
  readonly configCapUsd: number | null;
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
    const config =
      l.level === "workspace"
        ? resolveCaps(l.scopeKey, "")
        : l.level === "domain"
          ? resolveCaps("", "", l.scopeKey)
          : resolveCaps(l.scopeKey.split("/").slice(0, 2).join("/"), l.scopeKey, domainNameForScope(l.scopeKey));
    const configCap = (l.level === "workspace" ? config.workspaceMonthlyTokens : config.surfaceMonthlyTokens) ?? null;
    const configCapUsd = (l.level === "workspace" ? config.workspaceMonthlyUsd : config.surfaceMonthlyUsd) ?? null;
    return {
      scopeKey: l.scopeKey,
      level: l.level,
      ...(l.monthlyTokens != null ? { monthlyTokens: l.monthlyTokens } : {}),
      ...(l.monthlyUsd != null ? { monthlyUsd: l.monthlyUsd } : {}),
      configCap,
      configCapUsd,
      divergesFromConfig: (l.monthlyTokens != null && l.monthlyTokens !== configCap) || (l.monthlyUsd != null && l.monthlyUsd !== configCapUsd),
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
    note: "Overrides are temporary bridges — reconcile each into config (PR) or clear it. Spend rows with divergesFromConfig=true need a spend-budgets PR (agent/spend/budgets.ts, or clear_spend_limit); expired=true rows are no longer applied and should be cleared. Connector revokes are sticky (no auto-expiry — clearing re-opens access); clear deliberately or remove the grant from bundles.ts.",
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
  await ensurePricingFor([...rows.map((r) => r.model), q.assumedModelId]);
  const assumed = resolveAssumedModel(q.assumedModelId);
  const priced: UsageSummaryViewRow[] = rows.map((r) => {
    const costUsd = rowCostUsd(r, assumed);
    return costUsd !== undefined ? { ...r, costUsd } : r;
  });
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
    note: pricingNote(pricingMix(rows, assumed), assumed),
  };
}

export interface UsageWindowQuery {
  readonly sinceIso: string;
  readonly workspaceKeys: readonly string[];
  readonly org?: string;
}
export interface UsageWindowRow {
  readonly surfaceKey: string;
  readonly model?: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd?: number;
}
export interface UsageWindowResult {
  readonly org: string;
  readonly since: string;
  readonly workspaceKeys: readonly string[];
  readonly rows: readonly UsageWindowRow[];
  readonly totalUsd: number;
  readonly unpricedModels: readonly string[];
}

const WORKSPACE_KEY_SHAPE = /^[^/\s]+\/[^/\s]+$/;

export async function usageWindowView(q: UsageWindowQuery): Promise<UsageWindowResult> {
  const parsedSince = Date.parse(q.sinceIso);
  if (Number.isNaN(parsedSince)) {
    throw new Error(`sinceIso "${q.sinceIso}" is not a parseable ISO-8601 timestamp (e.g. "2026-07-11T12:00:00Z").`);
  }
  const since = new Date(parsedSince).toISOString();
  if (!Array.isArray(q.workspaceKeys) || q.workspaceKeys.length === 0) {
    throw new Error('workspaceKeys must be a non-empty array of "platform/workspace" keys.');
  }
  for (const wk of q.workspaceKeys) {
    if (typeof wk !== "string" || !WORKSPACE_KEY_SHAPE.test(wk)) {
      throw new Error(`workspaceKeys entry "${String(wk)}" must be exactly "platform/workspace" (two segments, e.g. "slack/T1") — not a surface key or a bare platform.`);
    }
  }
  const org = q.org ?? deploymentOrg();
  const keys = [...new Set(q.workspaceKeys)];
  const grouped = await Promise.all(keys.map((wk) => usageSummary(org, { sinceTs: since, surfaceKeyPrefix: `${wk}/` })));

  const SEP = "\u0000";
  const acc = new Map<string, { surfaceKey: string; model?: string; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>();
  for (const rows of grouped) {
    for (const r of rows) {
      const key = `${r.surfaceKey}${SEP}${r.model ?? ""}`;
      const a = acc.get(key) ?? { surfaceKey: r.surfaceKey, ...(r.model ? { model: r.model } : {}), calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      a.calls += r.events;
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      acc.set(key, a);
    }
  }

  await ensurePricingFor([...acc.values()].map((r) => r.model));

  const unpriced = new Set<string>();
  let totalUsd = 0;
  const rows: UsageWindowRow[] = [...acc.values()]
    .sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey) || (a.model ?? "").localeCompare(b.model ?? ""))
    .map((r) => {
      const usd = r.model ? estimateCostUsd(r, modelPricing(r.model)) : undefined;
      if (usd === undefined) unpriced.add(r.model ?? "(unstamped)");
      else totalUsd += usd;
      return { ...r, ...(usd !== undefined ? { estimatedUsd: usd } : {}) };
    });

  return { org, since, workspaceKeys: keys, rows, totalUsd, unpricedModels: [...unpriced].sort() };
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
