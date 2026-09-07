import { spendRollup, spendRoot } from "../spend/store.js";
import { type Caps } from "../spend/spend.js";
import { resolveCaps, applyCapOverrides, activeSpendLimitsForOrg, domainNameForScope, resolveUserCaps, userCapInventory, type UserCapRow } from "../spend/caps.js";
import { parseScopeKey } from "../access/scope-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { listAllRoutines, routinesRoot } from "../routines/store.js";
import { isDue } from "../routines/schedule.js";
import { describeTrigger } from "../routines/routine.js";
import { describeBound } from "../routines/bound.js";
import { describeStall } from "../routines/stall.js";
import { readAudit, auditRoot, type AuditFilter, type AuditEntry } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { windowedSupervisorEnabled, windowIdFor, windowModeFor, resolveDomainForChannel } from "../memory/domain.js";
import { principalSurfaces } from "../identity/principals.js";
import { unionPrincipals } from "../identity/link-resolve.js";
import { confirmedLinkSetPrincipals } from "../identity/link-store.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "../access/resolver.js";
import { usageSummary } from "../spend/usage-events.js";
import type { CapLevel, UsageSummaryRow } from "../operational/store.js";
import { resolveAssumedModel, rowCostUsd, pricingMix, pricingNote, filterToDomain, buildRoutinePredictions, type RoutinePredictionRow } from "../spend/reporting.js";
import { modelPricing, estimateCostUsd } from "../spend/pricing.js";
import { deploymentOrg } from "../identity/binding.js";
import { listDomainSkills, listDomainSkillRevisions } from "../skills/domain-skills.js";
import type { DomainSkillRow, DomainSkillRevisionRow } from "../operational/store.js";
import { providerById, type MemoryAccess } from "../memory/provider.js";
import { siloAccess } from "../memory/resolve.js";
import { siloTier } from "../memory/store.js";
import { controlPartition } from "../memory/partition.js";
import { sourceLabel } from "../memory/listing.js";
import { siloCoveringDomains, roleCoversScope } from "./auth.js";
import type { MemorySilo } from "../memory/silo.js";
import { actionKind, summarizeFrozenRow } from "../approvals/actions.js";
import type { ApproverPolicy } from "../approvals/types.js";

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
  readonly userCaps: Readonly<Record<string, readonly UserCapRow[]>>;
}

export async function spendView(period: string = currentPeriod()): Promise<SpendView> {
  const org = deploymentOrg();
  const rollup = (await spendRollup(org)).filter((r) => r.period === period);

  const limits = await activeSpendLimitsForOrg(org);
  const effCapsFor = (workspaceKey: string, surfaceKey: string): Caps => {
    const config = resolveCaps(workspaceKey, surfaceKey, domainNameForScope(surfaceKey));
    return limits.length ? applyCapOverrides(config, limits, workspaceKey, surfaceKey) : config;
  };

  const surfaces: SpendSurfaceRow[] = [];
  const byWorkspace = new Map<string, { tokens: number; usd: number }>();
  for (const { org: rowOrg, surfaceKey, tokens, usd } of rollup) {
    const workspaceKey = surfaceKey.split("/").slice(0, 2).join("/");
    const caps = effCapsFor(workspaceKey, surfaceKey);
    const tokenCap = caps.surfaceMonthlyTokens ?? null;
    const tokenOver = tokenCap != null && tokens >= tokenCap;
    const usdCap = caps.surfaceMonthlyUsd ?? null;
    const usdOver = usdCap != null && usd >= usdCap;
    surfaces.push({ org: rowOrg, surfaceKey, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver });
    const wk = `${rowOrg}/${workspaceKey}`;
    const acc = byWorkspace.get(wk) ?? { tokens: 0, usd: 0 };
    byWorkspace.set(wk, { tokens: acc.tokens + tokens, usd: acc.usd + usd });
  }
  const workspaces: SpendWorkspaceRow[] = [...byWorkspace].map(([key, { tokens, usd }]) => {
    const workspaceKey = key.slice(key.indexOf("/") + 1);
    const caps = effCapsFor(workspaceKey, "");
    const tokenCap = caps.workspaceMonthlyTokens ?? null;
    const tokenOver = tokenCap != null && tokens >= tokenCap;
    const usdCap = caps.workspaceMonthlyUsd ?? null;
    const usdOver = usdCap != null && usd >= usdCap;
    return { key, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver };
  });
  const userCaps = { [org]: userCapInventory(limits) };
  return { root: spendRoot(), period, surfaces, workspaces, userCaps };
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
  readonly firstMatchAt?: string;
  readonly lastMatchAt?: string;
  readonly ceiling?: string;
  readonly stalled?: string;
}
export interface RoutinesView {
  readonly root: string;
  readonly total: number;
  readonly dueCount?: number;
  readonly routines: readonly RoutineRow[];
}

export async function routinesView(opts: { onlyDue?: boolean; org?: string; surfaceKey?: string } = {}): Promise<RoutinesView> {
  const now = new Date();
  const org = opts.org ?? deploymentOrg();
  const all = (await listAllRoutines()).filter((r) => r.org === org && (opts.surfaceKey === undefined || r.surfaceKey === opts.surfaceKey));
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
      trigger: describeTrigger(r.trigger, r.report),
      nextRunAt: r.nextRunAt ?? null,
      prompt: r.prompt,
      ...(r.lastOutcome ? { lastOutcome: r.lastOutcome } : {}),
      ...(r.consecutiveFailures ? { consecutiveFailures: r.consecutiveFailures } : {}),
      ...(r.disabledReason ? { disabledReason: r.disabledReason } : {}),
      ...(r.firstMatchAt ? { firstMatchAt: r.firstMatchAt } : {}),
      ...(r.lastMatchAt ? { lastMatchAt: r.lastMatchAt } : {}),
      ...(describeBound(r) !== null ? { ceiling: describeBound(r)! } : {}),
      ...(describeStall(r) !== null ? { stalled: describeStall(r)! } : {}),
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
    const parsedUser = l.level === "user" ? parseScopeKey(l.scopeKey) : undefined;
    const config: Caps =
      l.level === "user"
        ? parsedUser?.kind === "principal"
          ? resolveUserCaps(parsedUser.id, parsedUser.platform, parsedUser.tenant)
          : {}
        : l.level === "workspace"
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
    note: 'Overrides are temporary bridges — reconcile each into config (PR) or clear it. Spend rows with divergesFromConfig=true need a spend-budgets PR (agent/spend/budgets.ts, or clear_spend_limit); expired=true rows are no longer applied and should be cleared. A level:"user" row reconciles into perUser.overrides keyed on the same person — drop the "user:" marker ("user:slack/U1" -> "slack/U1"). Connector revokes are sticky (no auto-expiry — clearing re-opens access); clear deliberately or remove the grant from bundles.ts.',
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
  readonly sessionStartedAfter?: string;
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
  readonly sessionStartedAfter?: string;
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
  let sessionStartedAfter: string | undefined;
  if (q.sessionStartedAfter !== undefined) {
    const parsedSessionStartedAfter = Date.parse(q.sessionStartedAfter);
    if (Number.isNaN(parsedSessionStartedAfter)) {
      throw new Error(`sessionStartedAfter "${q.sessionStartedAfter}" is not a parseable ISO-8601 timestamp (e.g. "2026-07-11T12:00:00Z").`);
    }
    sessionStartedAfter = new Date(parsedSessionStartedAfter).toISOString();
  }
  const org = q.org ?? deploymentOrg();
  const keys = [...new Set(q.workspaceKeys)];
  const grouped = await Promise.all(
    keys.map((wk) => usageSummary(org, { sinceTs: since, surfaceKeyPrefix: `${wk}/`, ...(sessionStartedAfter !== undefined ? { sessionStartedAfter } : {}) })),
  );

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

  return { org, since, workspaceKeys: keys, rows, totalUsd, unpricedModels: [...unpriced].sort(), ...(sessionStartedAfter !== undefined ? { sessionStartedAfter } : {}) };
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

export const DEFAULT_SKILL_REVISIONS_LIMIT = 20;
export const MAX_SKILL_REVISIONS_LIMIT = 100;

export interface SkillRevisionsQuery {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly limit?: number;
}
export interface SkillRevisionsResult {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly revisions: readonly DomainSkillRevisionRow[];
  readonly capped: boolean;
}

export async function skillRevisionsView(q: SkillRevisionsQuery): Promise<SkillRevisionsResult> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_SKILL_REVISIONS_LIMIT)), MAX_SKILL_REVISIONS_LIMIT);
  const oldestFirst = await listDomainSkillRevisions(q.org, q.domain, q.name);
  const newestFirst = [...oldestFirst].reverse();
  return {
    org: q.org,
    domain: q.domain,
    name: q.name,
    revisions: newestFirst.slice(0, limit),
    capped: oldestFirst.length > limit,
  };
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

async function memoryTierRow(org: string, silo: MemorySilo, domains: string[], access: MemoryAccess): Promise<MemoryTierRow> {
  const provider = providerById(silo.provider);
  const files = await provider.readTier(controlPartition(org), siloTier(silo.name), silo, access);
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
    tiers.push(await memoryTierRow(org, silo, covering, siloAccess(silo.name, domains)));
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
  const files = await provider.readTier(controlPartition(q.org), siloTier(silo.name), silo, siloAccess(silo.name, getConfig().loadDomains()));
  const content = files[q.relPath];
  if (content === undefined) {
    const have = Object.keys(files).sort().join(", ") || "(none)";
    throw new Error(`"${q.relPath}" is not a file in silo "${q.silo}" (have: ${have}).`);
  }
  return { org: q.org, silo: q.silo, relPath: q.relPath, content, bytes: byteSize(content) };
}

export interface PendingActionListRow {
  readonly id: string;
  readonly kind: string;
  readonly policy: ApproverPolicy;
  readonly domain: string | null;
  readonly scopeKey: string;
  readonly summary: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly ageSeconds: number;
  readonly expired: boolean;
}
export interface PendingActionsView {
  readonly org: string;
  readonly now: string;
  readonly pending: readonly PendingActionListRow[];
}

export async function pendingActionsView(org: string, roles: readonly string[], now: number = Date.now()): Promise<PendingActionsView> {
  const rows = await getOperationalStore().listPendingActions(org);
  const domains = getConfig().loadDomains();
  const isAdmin = roles.includes("admin");
  const pending: PendingActionListRow[] = [];
  for (const row of rows) {
    if (!isAdmin && !roleCoversScope(roles, { org, surfaceKey: row.scopeKey, domain: row.domain ?? undefined }, domains)) continue;
    pending.push({
      id: row.id,
      kind: row.kind,
      policy: actionKind(row.kind)?.policy ?? "admin",
      domain: row.domain,
      scopeKey: row.scopeKey,
      summary: summarizeFrozenRow(row),
      requestedBy: row.requestedBy,
      requestedAt: row.createdAt,
      expiresAt: row.expiresAt,
      ageSeconds: Math.max(0, Math.round((now - Date.parse(row.createdAt)) / 1000)),
      expired: Date.parse(row.expiresAt) <= now,
    });
  }
  return { org, now: new Date(now).toISOString(), pending };
}

export interface UnifiedContainerRow {
  readonly surfaceKey: string;
  readonly platform: string;
  readonly reachableHosts: readonly string[];
  readonly connectors: readonly string[];
  readonly repos: readonly string[];
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
  readonly widens: readonly string[];
  readonly warnings: readonly string[];
}
export interface UnifiedHumanRow {
  readonly name: string;
  readonly handle?: string;
  readonly surfacesInDomain: readonly string[];
  readonly surfacesNotIn: readonly string[];
}
export interface UnifiedWindowRow {
  readonly windowId: string;
  readonly kind: "group" | "domain" | "solo";
  readonly members: readonly string[];
  readonly platforms: readonly string[];
}
export interface UnifiedDomainAuditResult {
  readonly org: string;
  readonly domain: string;
  readonly unified: boolean;
  readonly singleWindow: boolean;
  readonly windows: readonly UnifiedWindowRow[];
  readonly platforms: readonly string[];
  readonly containers: readonly UnifiedContainerRow[];
  readonly agentReach: {
    readonly reachableHosts: readonly string[];
    readonly connectors: readonly string[];
    readonly repos: readonly string[];
    readonly skills: readonly string[];
    readonly subagents: readonly string[];
  };
  readonly humans: readonly UnifiedHumanRow[];
  readonly controllers: readonly string[];
  readonly behaviour: AuditView;
  readonly notes: readonly string[];
}

export interface UnifiedDomainAuditQuery {
  readonly domain: string;
  readonly org?: string;
  readonly sinceDays?: number;
}

function surfaceKeyParts(surfaceKey: string): { platform: string; workspace: string; channel: string } {
  const parts = surfaceKey.split("/");
  return { platform: parts[0] ?? "", workspace: parts[1] ?? "", channel: parts.slice(2).join("/") };
}

export async function unifiedDomainAudit(q: UnifiedDomainAuditQuery): Promise<UnifiedDomainAuditResult> {
  const org = q.org ?? deploymentOrg();
  const cfg = getConfig();
  const domains = cfg.loadDomains();
  const domain = domains.find((d) => d.name === q.domain);
  if (!domain) {
    const have = domains.map((d) => d.name).join(", ") || "(none)";
    throw new Error(`no domain named "${q.domain}" (configured domains: ${have}).`);
  }
  const channels = [...(domain.channels ?? [])];
  const unified = channels.length > 0 && windowedSupervisorEnabled(channels[0], domains);
  const residueUnified = unified && windowModeFor(channels[0] ?? "", domains) === "unified";
  const byWindow = new Map<string, { kind: UnifiedWindowRow["kind"]; members: string[] }>();
  if (unified) {
    for (const ch of channels) {
      const grouped = windowIdFor(ch, domains);
      const windowId = grouped ?? (residueUnified ? domain.name : ch);
      const kind: UnifiedWindowRow["kind"] = grouped !== undefined ? "group" : residueUnified ? "domain" : "solo";
      const row = byWindow.get(windowId);
      if (row) row.members.push(ch);
      else byWindow.set(windowId, { kind, members: [ch] });
    }
  }
  const windows: UnifiedWindowRow[] = [...byWindow].map(([windowId, row]) => ({
    windowId,
    kind: row.kind,
    members: row.members,
    platforms: [...new Set(row.members.map((ch) => surfaceKeyParts(ch).platform))].sort(),
  }));
  const singleWindow = residueUnified && windows.length === 1;

  const perContainer = await Promise.all(
    channels.map(async (surfaceKey) => {
      const { platform, workspace, channel } = surfaceKeyParts(surfaceKey);
      const a = await accessView({ platform, workspace, channel, mode: "channel" });
      return { surfaceKey, platform, access: a };
    }),
  );

  const reachCount = new Map<string, number>();
  const tag = (kind: string, v: string): string => `${kind}:${v}`;
  const itemsOf = (a: Awaited<ReturnType<typeof accessView>>): string[] => [
    ...a.reachableHosts.map((h) => tag("host", h.host)),
    ...a.connectors.map((c) => tag("connector", c)),
    ...a.repos.map((r) => tag("repo", r)),
    ...a.skills.map((s) => tag("skill", s)),
    ...a.subagents.map((s) => tag("subagent", s)),
  ];
  for (const c of perContainer) for (const it of new Set(itemsOf(c.access))) reachCount.set(it, (reachCount.get(it) ?? 0) + 1);

  const containers: UnifiedContainerRow[] = perContainer.map((c) => {
    const items = new Set(itemsOf(c.access));
    const widens = [...items].filter((it) => reachCount.get(it) === 1).sort();
    return {
      surfaceKey: c.surfaceKey,
      platform: c.platform,
      reachableHosts: c.access.reachableHosts.map((h) => h.host),
      connectors: c.access.connectors,
      repos: c.access.repos,
      skills: c.access.skills,
      subagents: c.access.subagents,
      widens,
      warnings: c.access.warnings,
    };
  });

  const union = (pick: (r: UnifiedContainerRow) => readonly string[]): string[] => [...new Set(containers.flatMap((r) => [...pick(r)]))].sort();
  const platforms = [...new Set(channels.map((ch) => surfaceKeyParts(ch).platform))].sort();

  const principalUnion = unionPrincipals(cfg.loadPrincipals?.() ?? [], await confirmedLinkSetPrincipals(org));
  const principals = principalUnion.principals;
  const humans: UnifiedHumanRow[] = principals
    .map((p) => {
      const surfaces = principalSurfaces(p);
      const inDomain = platforms.filter((pl) => surfaces.includes(pl));
      const notIn = platforms.filter((pl) => !surfaces.includes(pl));
      return { name: p.name, ...(p.handle ? { handle: p.handle } : {}), surfacesInDomain: inDomain, surfacesNotIn: notIn };
    })
    .filter((h) => h.surfacesInDomain.length > 0);

  const since = new Date(Date.now() - (q.sinceDays ?? 30) * 24 * 60 * 60 * 1000).toISOString();
  const surfaceSet = new Set(channels);
  const behaviourAll = await auditView({ org, since, limit: 200 });
  const behaviour: AuditView = {
    ...behaviourAll,
    entries: behaviourAll.entries.filter((e) => {
      const key = `${e.platform}/${e.workspace}/${e.surface ?? ""}`.replace(/\/$/, "");
      if (surfaceSet.has(key)) return true;
      return !e.surface && [...surfaceSet].some((ch) => ch.startsWith(`${e.platform}/${e.workspace}/`));
    }),
  };

  const notes = [
    "Pure-read: this view restricts the agent by nothing — it is only answerable because the domain unifies the surfaces.",
    "Per-container INTERNAL/EXTERNAL trust and per-account membership are confirmed FAIL-CLOSED at delivery time (each surface's confirmInternal); a container that fails is dropped and audited (*.trust_demotion). This read reflects config-declared membership, not a live trust probe.",
    "Unmapped accounts (present in a surface but not in the principals map) stay DISTINCT per-surface identities — never merged on name similarity; enumerate them from the live surface, not here.",
    "Surface-privacy ORDINAL (P5 enforced form) is not yet built — TODO(unified-audit-privacy-ordinal); quote-across-surfaces is advisory (one sentence in the standing prompt) until it lands.",
  ];
  if (!unified) notes.unshift(`NOTE: domain "${q.domain}" is not currently windowed (WINDOW_TOPOLOGY_ENABLED off and/or the domain is not an ambient supervisor) — this shows what unification WOULD expose.`);
  for (const w of principalUnion.warnings) notes.unshift(`⚠ ${w.message}`);

  return {
    org,
    domain: q.domain,
    unified,
    singleWindow,
    windows,
    platforms,
    containers,
    agentReach: {
      reachableHosts: union((r) => r.reachableHosts),
      connectors: union((r) => r.connectors),
      repos: union((r) => r.repos),
      skills: union((r) => r.skills),
      subagents: union((r) => r.subagents),
    },
    humans,
    controllers: [...(domain.admins ?? [])],
    behaviour,
    notes,
  };
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
  const routing = resolveDomainForChannel(`${platform}/${workspace}/${channel}`, cfg.loadDomains());
  return {
    scopeKey: access.scopeKey,
    mode: access.mode,
    routing: { domain: routing.domain?.name ?? null, via: routing.via },
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
