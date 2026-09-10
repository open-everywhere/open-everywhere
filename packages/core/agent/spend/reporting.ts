import { resolvePartition } from "../memory/partition.js";
import { requireOrgAdmin } from "../access/roles.js";
import { domainForChannel, criteriaDomain, type Domain } from "../memory/domain.js";
import { resolveSkillDomainDetailed, skillDomainFor, type SkillDomainRefusal, type SkillDomainResult } from "../skills/domain-skills.js";
import { getOperationalStore } from "../operational/provider.js";
import { getConfig } from "../access/config.js";
import type { UsageSummaryRow } from "../operational/store.js";
import { parseCron, cronMatches, DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import type { RoutineTrigger } from "../routines/routine.js";
import { modelPricing, estimateCostUsd, soleConfiguredModel, type ModelPricing, type UsageTokens } from "./pricing.js";
import { UNKNOWN_MODEL, periodOf } from "./spend.js";
import { spendRollup, type SurfacePeriodSpend } from "./store.js";
import type { BindableContext, SurfaceBinding } from "../identity/binding.js";

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

export function periodsCoveringDays(nowISO: string, days: number): string[] {
  const now = new Date(nowISO);
  if (Number.isNaN(now.getTime())) throw new Error(`periodsCoveringDays: not an ISO instant: ${JSON.stringify(nowISO)}`);
  if (!Number.isFinite(days) || days < 0) throw new Error(`periodsCoveringDays: days must be a non-negative finite number, got ${days}`);
  const start = new Date(now.getTime() - days * 86_400_000);
  const span = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  const periods: string[] = [];
  for (let i = 0; i <= span; i++) periods.push(periodOf(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString()));
  return periods;
}

export function reportDomainForBinding(binding: SurfaceBinding, domains: readonly Domain[]): SkillDomainResult {
  const workspaceKey = `${binding.platform}/${binding.workspace}`;
  return skillDomainFor(
    binding,
    { surfaceKey: `${workspaceKey}/${binding.surface}`, domainKey: `${workspaceKey}/${binding.domainSurface ?? binding.surface}` },
    domains,
  );
}

export interface DomainSpendWindow {
  readonly domain: string;
  readonly periods: readonly string[];
  readonly tokens: number;
  readonly usd: number;
  readonly calls: number;
}

export interface DomainSpendWindowDeps {
  readonly spendRollup?: typeof spendRollup;
  readonly domains?: readonly Domain[];
}

export async function domainSpendWindow(org: string, domainName: string, nowISO: string, days: number, deps: DomainSpendWindowDeps = {}): Promise<DomainSpendWindow> {
  const periods = periodsCoveringDays(nowISO, days);
  const domains = deps.domains ?? getConfig().loadDomains();
  const rows = await (deps.spendRollup ?? spendRollup)(org, { periodFrom: periods[0], periodTo: periods[periods.length - 1] });
  const mine = rows.filter((l) => l.org === org && periods.includes(l.period) && domainOfUsageRow(l.surfaceKey, undefined, domains) === domainName);
  return {
    domain: domainName,
    periods,
    tokens: mine.reduce((sum, l) => sum + l.tokens, 0),
    usd: mine.reduce((sum, l) => sum + l.usd, 0),
    calls: mine.reduce((sum, l) => sum + l.calls, 0),
  };
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
      note: "token $ omitted — hook-written usage rows carry no model id, and this deployment has no single default model to assume (pass assumedModelId, or ship exactly one entry in the built-in pricing table).",
    };
  }
  const pricing = modelPricing(model);
  if (!pricing) {
    return { model, note: `token $ omitted — "${model}" has no configured pricing (checked the deployer pricing table and the built-in table).` };
  }
  return {
    model,
    pricing,
    note: explicit
      ? `token $ estimated at "${model}" rates (you supplied this model id — hook-written usage rows don't carry one).`
      : `token $ estimated at "${model}" rates (this deployment's only priced model — hook-written usage rows carry no model id).`,
  };
}

export type PriceableRow = UsageTokens & { readonly model?: string };

export function rowCostUsd(row: PriceableRow, assumed: AssumedModelPricing): number | undefined {
  if (row.model) {
    const exact = modelPricing(row.model);
    return exact ? estimateCostUsd(row, exact) : undefined;
  }
  return assumed.pricing ? estimateCostUsd(row, assumed.pricing) : undefined;
}

export interface PricingMix {
  readonly exact: number;
  readonly assumed: number;
  readonly unpriced: number;
  readonly unattributed: number;
}

export function pricingMix(rows: readonly PriceableRow[], assumed: AssumedModelPricing): PricingMix {
  let exact = 0;
  let assumedCount = 0;
  let unpriced = 0;
  let unattributed = 0;
  for (const r of rows) {
    if (r.model) {
      if (modelPricing(r.model)) exact++;
      else unpriced++;
      if (r.model === UNKNOWN_MODEL) unattributed++;
    } else if (assumed.pricing) {
      assumedCount++;
    } else {
      unpriced++;
    }
  }
  return { exact, assumed: assumedCount, unpriced, unattributed };
}

export function pricingNote(mix: PricingMix, assumed: AssumedModelPricing): string {
  if (mix.exact === 0) return assumed.note;
  const parts: string[] = [
    mix.assumed === 0 && mix.unpriced === 0
      ? "$ figures are exact — every priced row carries its own recorded model id."
      : `${mix.exact} row(s) priced exactly by their own recorded model id.`,
  ];
  if (mix.assumed > 0) parts.push(`${mix.assumed} row(s) with no recorded model: ${assumed.note}`);
  const unpricedButAttributed = mix.unpriced - mix.unattributed;
  if (unpricedButAttributed > 0) {
    parts.push(`${unpricedButAttributed} row(s) omitted — a recorded model this deployment hasn't configured a rate for (see agent/spend/model-pricing.ts), never priced at another model's rate.`);
  }
  if (mix.unattributed > 0) {
    parts.push(
      `${mix.unattributed} row(s) omitted as "${UNKNOWN_MODEL}" — a real model call the host could not attribute to any model (the per-call model stamp was missing), so no rate was applied to it. ` +
        `Its tokens are recorded in full, and where the gateway measured the call its exact $ is stored too; only the rate-derived $ is withheld. This is an instrumentation gap, not a pricing one.`,
    );
  }
  return parts.join(" ");
}

export interface TokenAttribution {
  readonly calls: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReportedCalls: number;
  readonly reasoningReportedCalls: number;
}

export function tokenAttribution(
  rows: readonly Pick<UsageSummaryRow, "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "cacheReportedCalls" | "reasoningReportedCalls" | "events">[],
): TokenAttribution {
  const acc = { calls: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheReportedCalls: 0, reasoningReportedCalls: 0 };
  for (const r of rows) {
    acc.calls += r.events;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.cacheWriteTokens += r.cacheWriteTokens;
    acc.reasoningTokens += r.reasoningTokens;
    acc.cacheReportedCalls += r.cacheReportedCalls;
    acc.reasoningReportedCalls += r.reasoningReportedCalls;
  }
  return acc;
}

export function tokenAttributionNote(a: TokenAttribution): string {
  if (a.calls === 0) return "No model calls in scope — nothing to attribute.";
  const parts: string[] = [];
  const cacheTokens = a.cacheReadTokens + a.cacheWriteTokens;
  parts.push(
    cacheTokens === 0
      ? a.cacheReportedCalls === 0
        ? `Cache: UNATTRIBUTED across all ${a.calls} call(s) — no call published a cache field at all, ` +
          `so nothing here says whether caching happened.`
        : `Cache: UNATTRIBUTED across all ${a.calls} call(s) — no cache tokens were reported at all ` +
          `(${a.cacheReportedCalls} call(s) published a cache field, every one of them zero). A zero is NOT a measurement that caching did not happen: ` +
          `on the Vercel AI Gateway backend a cached call is billed at the discount while the cached-token count reads 0 ` +
          `(docs/security/spend-and-cost.md), so on that backend the saving shows in the cost and never in the split.`
      : `Cache: ${a.cacheReadTokens} read / ${a.cacheWriteTokens} write token(s)` +
        (a.cacheReportedCalls < a.calls
          ? `; ${a.calls - a.cacheReportedCalls} of ${a.calls} call(s) published no cache field at all, so nothing is claimed about those.`
          : ` across ${a.calls} call(s), all of which published a cache field.`),
  );
  parts.push(
    a.reasoningReportedCalls === 0
      ? `Reasoning tokens: UNREPORTED on all ${a.calls} call(s).`
      : `Reasoning: ${a.reasoningTokens} token(s) across ${a.reasoningReportedCalls} of ${a.calls} call(s) that reported the dimension.`,
  );
  parts.push("These are ATTRIBUTION counts only — no dollar figure is derived from them, and the billed cost above stands unchanged.");
  return parts.join(" ");
}

export interface CostDrift {
  readonly measuredUsd: number;
  readonly derivedUsd: number;
  readonly divergenceUsd: number;
  readonly divergencePct?: number;
  readonly measuredCalls: number;
  readonly totalCalls: number;
}

export function summariseCostDrift(rows: readonly SurfacePeriodSpend[]): CostDrift {
  let measuredUsd = 0;
  let derivedUsd = 0;
  let measuredCalls = 0;
  let totalCalls = 0;
  for (const r of rows) {
    measuredUsd += r.usdMeasured;
    derivedUsd += r.usdDerivedOnMeasured;
    measuredCalls += r.measuredCalls;
    totalCalls += r.calls;
  }
  const divergenceUsd = derivedUsd - measuredUsd;
  return {
    measuredUsd,
    derivedUsd,
    divergenceUsd,
    ...(measuredCalls > 0 && measuredUsd > 0 ? { divergencePct: (divergenceUsd / measuredUsd) * 100 } : {}),
    measuredCalls,
    totalCalls,
  };
}

export function costDriftNote(drift: CostDrift): string {
  if (drift.measuredCalls === 0) {
    return `costDrift: no gateway-measured cost on any ledger row this period (${drift.totalCalls} call(s) in scope), so every $ above is rate-derived from this deployment's own price table. Measured cost is a GATEWAY feature — its absence is expected on a direct-provider deployment and is not a fault.`;
  }
  const pct = drift.divergencePct === undefined ? "n/a" : `${drift.divergencePct >= 0 ? "+" : ""}${drift.divergencePct.toFixed(1)}%`;
  const direction = drift.divergenceUsd === 0 ? "agrees with" : drift.divergenceUsd > 0 ? "OVER-states" : "UNDER-states";
  return (
    `costDrift: over the ${drift.measuredCalls} of ${drift.totalCalls} call(s) the gateway measured, it billed $${drift.measuredUsd.toFixed(4)} where this deployment's rate table derived $${drift.derivedUsd.toFixed(4)} ` +
    `— the rate table ${direction} the bill by $${Math.abs(drift.divergenceUsd).toFixed(4)} (${pct}). The caps enforce the DERIVED figure, so a persistent divergence means the price table needs re-measuring (spend/pricing.ts), not that the caps are broken.`
  );
}

const MAX_FIRES_PER_DAY = 1440 / DISPATCH_TICK_MINUTES;

function cronFiresPerDay(expr: string): number | undefined {
  try {
    const parsed = parseCron(expr);
    const start = new Date();
    start.setUTCSeconds(0, 0);
    const ticks = new Set<number>();
    for (let i = 0; i < 1440; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (cronMatches(parsed, t)) ticks.add(Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / DISPATCH_TICK_MINUTES));
    }
    return ticks.size;
  } catch {
    return undefined;
  }
}

export function firesPerDay(trigger: RoutineTrigger): number | undefined {
  switch (trigger.kind) {
    case "interval":
      return Math.min(MAX_FIRES_PER_DAY, 1440 / Math.max(1, trigger.everyMinutes));
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

export interface SlackLabelDeps {
  readonly userName: (userId: string) => Promise<string | undefined>;
  readonly channelName: (channelId: string) => Promise<string | undefined>;
}

export function slackUserIdIn(principalId: string): string | undefined {
  const candidate = principalId.includes(":") ? principalId.slice(principalId.lastIndexOf(":") + 1) : principalId;
  return /^[UW][A-Z0-9]{5,}$/.test(candidate) ? candidate : undefined;
}

export function slackChannelIdIn(surfaceKey: string): string | undefined {
  const parts = surfaceKey.split("/");
  if (parts[0] !== "slack" || parts.length < 3) return undefined;
  const id = parts[2];
  return /^[CGD][A-Z0-9]{5,}$/.test(id) ? id : undefined;
}

export interface SlackLabels {
  readonly users: ReadonlyMap<string, string>;
  readonly channels: ReadonlyMap<string, string>;
}

export async function resolveSlackLabels(
  principalIds: readonly string[],
  surfaceKeys: readonly string[],
  deps: SlackLabelDeps,
): Promise<SlackLabels> {
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  const lookups: Promise<void>[] = [];
  for (const pid of new Set(principalIds)) {
    const userId = slackUserIdIn(pid);
    if (!userId) continue;
    lookups.push(
      deps
        .userName(userId)
        .then((name) => {
          if (name) users.set(pid, name);
        })
        .catch(() => {}),
    );
  }
  for (const key of new Set(surfaceKeys)) {
    const channelId = slackChannelIdIn(key);
    if (!channelId || channelId.startsWith("D")) continue;
    lookups.push(
      deps
        .channelName(channelId)
        .then((name) => {
          if (name) channels.set(key, `#${name}`);
        })
        .catch(() => {}),
    );
  }
  await Promise.all(lookups);
  return { users, channels };
}

export function isDmSurface(surfaceKey: string, kind?: string): boolean {
  if (kind === "dm") return true;
  const parts = surfaceKey.split("/");
  return parts.length >= 3 && /^D[A-Z0-9]{5,}$/.test(parts[2]);
}

export function dmBucketKey(surfaceKey: string): string {
  const parts = surfaceKey.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}/(dms)` : "(dms)";
}

export function maskDmSurfaceKey<T extends { readonly surfaceKey: string; readonly kind?: string }>(row: T): T {
  return isDmSurface(row.surfaceKey, row.kind) ? { ...row, surfaceKey: dmBucketKey(row.surfaceKey) } : row;
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
