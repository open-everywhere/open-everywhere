import { allLedgers, spendRoot } from "../spend/store.js";
import { windowTokens } from "../spend/spend.js";
import { resolveCaps } from "../spend/caps.js";
import { listAllRoutines, routinesRoot } from "../routines/store.js";
import { isDue } from "../routines/schedule.js";
import { describeTrigger } from "../routines/routine.js";
import { readAudit, auditRoot, type AuditFilter, type AuditEntry } from "../audit/audit.js";
import { loadBindings, loadBundles } from "../access/bundles.js";
import { domainsForSurface } from "../memory/domains.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "../access/resolver.js";

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

export interface AccessQuery {
  readonly platform?: string;
  readonly workspace?: string;
  readonly channel?: string;
  readonly mode?: SessionMode;
  readonly principalId?: string;
}

export async function accessView(q: AccessQuery = {}) {
  const platform = q.platform ?? "local";
  const workspace = q.workspace ?? "dev";
  const channel = q.channel ?? "default";
  const req: ResolveRequest = {
    mode: q.mode ?? "channel",
    platform,
    workspace,
    channel,
    domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
    principalId: q.principalId,
  };
  const access = resolveAccess(req, loadBundles(), loadBindings());
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
