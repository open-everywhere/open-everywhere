import { resolvePartition } from "../memory/partition.js";
import { requireOrgAdmin } from "../access/roles.js";
import { domainForChannel, criteriaDomain, type Domain } from "../memory/domain.js";
import { resolveSkillDomainDetailed, type SkillDomainRefusal } from "../skills/domain-skills.js";
import { getOperationalStore } from "../operational/provider.js";
import type { UsageSummaryRow } from "../operational/store.js";
import { parseCron, cronMatches } from "../routines/schedule.js";
import type { RoutineTrigger } from "../routines/routine.js";
import { modelPricing, estimateCostUsd, soleConfiguredModel, type ModelPricing } from "./pricing.js";
import type { BindableContext } from "../identity/binding.js";

export type ReportScope = "domain" | "org";

export interface ResolvedReportScope {
  readonly org: string;
  readonly domain?: string;
}

export function reportDomainRefusalMessage(reason: SkillDomainRefusal): string {
  switch (reason) {
    case "dm":
      return 'Domain-scoped reporting isn\'t available from a DM (a DM has no memory domain) — ask from a channel in the domain, or pass scope:"org" if you\'re an org admin.';
    case "mpim":
      return "Domain-scoped reporting isn't available from a group chat (execution-only, no memory domain) — ask from a channel in the domain instead.";
    case "external":
      return "Domain-scoped reporting isn't available from an externally-shared or unconfirmed channel.";
    case "unassigned":
      return 'This channel isn\'t in any memory domain and no org-wide default domain is configured — there\'s no domain to report on. Try scope:"org" if you\'re an org admin.';
  }
}

export function resolveReportScope(ctx: BindableContext, scope: ReportScope): ResolvedReportScope {
  const org = resolvePartition(ctx).org;
  if (scope === "org") {
    requireOrgAdmin(ctx);
    return { org };
  }
  const resolved = resolveSkillDomainDetailed(ctx);
  if (resolved.domain === null) throw new Error(reportDomainRefusalMessage(resolved.reason));
  return { org, domain: resolved.domain };
}

export function domainOfUsageRow(surfaceKey: string, kind: string | undefined, domains: readonly Domain[]): string | undefined {
  if (kind === "dm") return undefined;
  return domainForChannel(surfaceKey, domains)?.name ?? criteriaDomain("org", domains)?.name;
}

export function filterToDomain<T extends { readonly surfaceKey: string; readonly kind?: string }>(
  rows: readonly T[],
  domainName: string,
  domains: readonly Domain[],
): T[] {
  return rows.filter((r) => domainOfUsageRow(r.surfaceKey, r.kind, domains) === domainName);
}

export interface AssumedModelPricing {
  readonly model?: string;
  readonly pricing?: ModelPricing;
  readonly note: string;
}

export function resolveAssumedModel(explicit?: string): AssumedModelPricing {
  const model = explicit ?? soleConfiguredModel();
  if (!model) {
    return {
      note: "token $ omitted — hook-written usage rows carry no model id, and this deployment has no single default model to assume (pass assumedModelId, or configure OE_MODEL_PRICING with exactly one entry).",
    };
  }
  const pricing = modelPricing(model);
  if (!pricing) {
    return { model, note: `token $ omitted — "${model}" has no configured pricing (see OE_MODEL_PRICING).` };
  }
  return {
    model,
    pricing,
    note: explicit
      ? `token $ estimated at "${model}" rates (you supplied this model id — hook-written usage rows don't carry one).`
      : `token $ estimated at "${model}" rates (this deployment's only priced model — hook-written usage rows carry no model id).`,
  };
}

function cronFiresPerDay(expr: string): number | undefined {
  try {
    const parsed = parseCron(expr);
    const start = new Date();
    start.setUTCSeconds(0, 0);
    let count = 0;
    for (let i = 0; i < 1440; i++) {
      if (cronMatches(parsed, new Date(start.getTime() + i * 60_000))) count++;
    }
    return count;
  } catch {
    return undefined;
  }
}

export function firesPerDay(trigger: RoutineTrigger): number | undefined {
  switch (trigger.kind) {
    case "interval":
      return 1440 / Math.max(1, trigger.everyMinutes);
    case "cron":
      return cronFiresPerDay(trigger.expr);
    case "watch":
    case "event":
      return undefined;
  }
}

export interface RoutinePredictionRow {
  readonly surfaceKey: string;
  readonly observedFires: number;
  readonly avgTokensPerFire: number;
  readonly cadencePerDay?: number;
  readonly projected: {
    readonly tokens7d: number;
    readonly tokens30d: number;
    readonly costUsd7d?: number;
    readonly costUsd30d?: number;
  } | null;
  readonly skippedReason?: string;
}

const MIN_FIRES_FOR_PREDICTION = 3;

export async function buildRoutinePredictions(
  org: string,
  routineRows: readonly UsageSummaryRow[],
  pricing: ModelPricing | undefined,
): Promise<RoutinePredictionRow[]> {
  const bySurface = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; sessions: number }>();
  for (const r of routineRows) {
    const acc = bySurface.get(r.surfaceKey) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: 0 };
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.sessions += r.sessions;
    bySurface.set(r.surfaceKey, acc);
  }

  const store = getOperationalStore();
  const out: RoutinePredictionRow[] = [];
  for (const [surfaceKey, acc] of bySurface) {
    if (acc.sessions < MIN_FIRES_FOR_PREDICTION) {
      out.push({
        surfaceKey,
        observedFires: acc.sessions,
        avgTokensPerFire: acc.sessions > 0 ? (acc.inputTokens + acc.outputTokens) / acc.sessions : 0,
        projected: null,
        skippedReason: `fewer than ${MIN_FIRES_FOR_PREDICTION} observed fires in this window — not enough signal to predict`,
      });
      continue;
    }

    const avgTokensPerFire = (acc.inputTokens + acc.outputTokens) / acc.sessions;

    const routines = await store.listRoutines(org, surfaceKey);
    let cadence = 0;
    let sawClockScheduled = false;
    for (const routine of routines) {
      if (routine.status !== "active") continue;
      const fpd = firesPerDay(routine.trigger);
      if (fpd !== undefined) {
        cadence += fpd;
        sawClockScheduled = true;
      }
    }
    if (!sawClockScheduled) {
      out.push({
        surfaceKey,
        observedFires: acc.sessions,
        avgTokensPerFire,
        projected: null,
        skippedReason: "no active cron/interval routine found for this surface — cadence unknowable (watch/event routines don't have a predictable fire rate)",
      });
      continue;
    }

    const avgInput = acc.inputTokens / acc.sessions;
    const avgOutput = acc.outputTokens / acc.sessions;
    const avgCacheRead = acc.cacheReadTokens / acc.sessions;
    const costPerFire = pricing ? estimateCostUsd({ inputTokens: avgInput, outputTokens: avgOutput, cacheReadTokens: avgCacheRead }, pricing) : undefined;

    out.push({
      surfaceKey,
      observedFires: acc.sessions,
      avgTokensPerFire,
      cadencePerDay: cadence,
      projected: {
        tokens7d: avgTokensPerFire * cadence * 7,
        tokens30d: avgTokensPerFire * cadence * 30,
        ...(costPerFire !== undefined ? { costUsd7d: costPerFire * cadence * 7, costUsd30d: costPerFire * cadence * 30 } : {}),
      },
    });
  }
  return out;
}

export function approxConversationCount(rows: readonly UsageSummaryRow[]): number {
  let total = 0;
  for (const r of rows) {
    if (r.kind === "sandbox") continue;
    total += r.sessions;
  }
  return total;
}

export interface UserActivity {
  readonly principalId: string;
  readonly events: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function aggregateByUser(rows: readonly UsageSummaryRow[]): UserActivity[] {
  const byUser = new Map<string, UserActivity>();
  for (const r of rows) {
    if (r.kind === "sandbox" || !r.principalId) continue;
    const acc = byUser.get(r.principalId) ?? { principalId: r.principalId, events: 0, inputTokens: 0, outputTokens: 0 };
    byUser.set(r.principalId, {
      principalId: r.principalId,
      events: acc.events + r.events,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    });
  }
  return [...byUser.values()].sort((a, b) => b.events - a.events);
}

export interface SurfaceActivity {
  readonly surfaceKey: string;
  readonly events: number;
  readonly sessions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function aggregateBySurface(rows: readonly UsageSummaryRow[]): SurfaceActivity[] {
  const bySurface = new Map<string, SurfaceActivity>();
  for (const r of rows) {
    if (r.kind === "sandbox") continue;
    const acc = bySurface.get(r.surfaceKey) ?? { surfaceKey: r.surfaceKey, events: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
    bySurface.set(r.surfaceKey, {
      surfaceKey: r.surfaceKey,
      events: acc.events + r.events,
      sessions: acc.sessions + r.sessions,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    });
  }
  return [...bySurface.values()].sort((a, b) => b.events - a.events);
}
