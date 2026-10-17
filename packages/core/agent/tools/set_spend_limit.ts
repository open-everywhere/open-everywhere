import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { PersonFacingError } from "../channels/person-text.js";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { domainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import { effectiveCaps, effectiveUserCaps, domainNameForScope } from "../spend/caps.js";
import { usageSummary } from "../spend/usage-events.js";
import { modelPricing, soleConfiguredModel } from "../spend/pricing.js";
import { UNKNOWN_MODEL } from "../spend/spend.js";
import { userScopeKey, parseScopeKey } from "../access/scope-key.js";
import { CAP_LEVELS, type CapLevel } from "../operational/store.js";
import { requestApproval, autoApprovedNote, cardPosterFor, type RequestApprovalDeps } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import type { SpendCoverage } from "../approvals/actions.js";

export const LEVELS = CAP_LEVELS;
export type Level = CapLevel;

import { approvalPostDeps, hasApprovalCardPath } from "../approvals/flow.js";
import { placeBesideKey } from "../channels/friendly-ids.js";
import { placeWords } from "../channels/friendly-ids.js";
export { approvalPostDeps, hasApprovalCardPath };

export function requireCardPathHere(tool: string, platform: string): void {
  if (hasApprovalCardPath(platform)) return;
  throw new PersonFacingError(`${tool} doesn't work here. Ask me in a message instead.`);
}

export interface SetSpendLimitInput {
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
  readonly reason: string;
  readonly level?: Level;
  readonly scopeKey?: string;
}

export interface CurrentCaps {
  readonly tokens: number | null;
  readonly usd: number | null;
}

export async function currentCapsFor(
  org: string,
  workspaceKey: string,
  level: Level,
  scopeKey: string,
  mode: SurfaceBinding["mode"],
  trust: SurfaceBinding["trust"],
): Promise<CurrentCaps> {
  if (level === "user") {
    const parsed = parseScopeKey(scopeKey);
    const userCaps = parsed.kind === "principal" ? await effectiveUserCaps(org, parsed.platform, parsed.tenant, parsed.id) : {};
    return { tokens: userCaps.surfaceMonthlyTokens ?? null, usd: userCaps.surfaceMonthlyUsd ?? null };
  }
  const capsSurfaceArg = level === "workspace" ? workspaceKey : scopeKey;
  const capsDomainArg = level === "domain" ? scopeKey : domainNameForScope(scopeKey, mode, trust);
  const caps = await effectiveCaps(org, workspaceKey, capsSurfaceArg, capsDomainArg);
  return {
    tokens: (level === "workspace" ? caps.workspaceMonthlyTokens : caps.surfaceMonthlyTokens) ?? null,
    usd: (level === "workspace" ? caps.workspaceMonthlyUsd : caps.surfaceMonthlyUsd) ?? null,
  };
}

const COVERAGE_WINDOW_DAYS = 30;

const UNSTAMPED = "(unstamped)";

const NO_MODEL_OBSERVED: readonly string[] = [UNKNOWN_MODEL, UNSTAMPED];

function contributesZeroUsd(model: string | undefined): boolean {
  if (model !== undefined) return modelPricing(model) === undefined;
  const sole = soleConfiguredModel();
  return sole === undefined || modelPricing(sole) === undefined;
}

export interface CoverageReport {
  readonly models: readonly string[];
  readonly notMeasurable?: string;
  readonly noTraffic?: true;
}

function rowsForScope<T extends { readonly surfaceKey: string; readonly kind?: string; readonly principalId?: string }>(
  all: readonly T[],
  level: Level,
  scopeKey: string,
  domains: readonly Domain[],
): readonly T[] {
  if (level === "surface") return all.filter((r) => r.surfaceKey === scopeKey);
  if (level === "domain") return all.filter((r) => domainForChannel(r.surfaceKey, domains)?.name === scopeKey);
  if (level === "user") {
    const parsed = parseScopeKey(scopeKey);
    return parsed.kind === "principal" ? all.filter((r) => r.principalId === parsed.id && r.surfaceKey.startsWith(`${parsed.platform}/`)) : [];
  }
  return all;
}

export async function unpricedModelsForScope(org: string, level: Level, scopeKey: string): Promise<CoverageReport> {
  const domains = getConfig().loadDomains();
  const criteria = level === "domain" ? domains.find((d) => d.name === scopeKey)?.match : undefined;
  if (criteria !== undefined) {
    return {
      models: [],
      notMeasurable: `"${scopeKey}" is a CRITERIA domain — it matches ${criteria} TURNS rather than named channels — and a usage row records neither the session mode nor the trust that decide membership, so this scope's traffic cannot be identified in the ledger.`,
    };
  }
  const sinceTs = new Date(Date.now() - COVERAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const prefix = level === "workspace" ? `${scopeKey}/` : level === "surface" ? scopeKey : undefined;
  const all = await usageSummary(org, { sinceTs, ...(prefix !== undefined ? { surfaceKeyPrefix: prefix } : {}) });
  const rows = rowsForScope(all, level, scopeKey, domains);
  if (rows.length === 0) return { models: [], noTraffic: true };
  const unpriced = new Set<string>();
  for (const r of rows) {
    if (contributesZeroUsd(r.model)) unpriced.add(r.model ?? UNSTAMPED);
  }
  return { models: [...unpriced].sort() };
}

export function frozenCoverage(report: CoverageReport): SpendCoverage {
  if (report.notMeasurable !== undefined) return { measured: "none", why: report.notMeasurable };
  if (report.noTraffic) return { measured: "no-traffic", windowDays: COVERAGE_WINDOW_DAYS };
  if (report.models.length === 0) return { measured: "full", windowDays: COVERAGE_WINDOW_DAYS };
  return {
    measured: "gap",
    windowDays: COVERAGE_WINDOW_DAYS,
    unratedModels: report.models.filter((m) => !NO_MODEL_OBSERVED.includes(m)),
    unobservedModels: report.models.filter((m) => NO_MODEL_OBSERVED.includes(m)),
  };
}

export async function readSpendCoverage(org: string, level: Level, scopeKey: string, monthlyUsd: number | undefined): Promise<CoverageReport | undefined> {
  if (monthlyUsd == null) return undefined;
  try {
    return await unpricedModelsForScope(org, level, scopeKey);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[open-everywhere:spend] set_spend_limit could not read pricing coverage for "${scopeKey}": ${why}`);
    return { models: [], notMeasurable: "the usage ledger could not be read on this turn, so no coverage was measured." };
  }
}

export function pendingScopeWords(label: string | undefined): string {
  return label !== undefined && label.length > 0 ? label : "this scope";
}

export function unpricedCoverageNote(report: CoverageReport, scopeKey: string): string {
  if (report.notMeasurable !== undefined) {
    return ` ⚠ Pricing coverage NOT MEASURED for "${scopeKey}": ${report.notMeasurable} RELAY THIS: tell the user this cap's coverage is unknown — a USD cap counts only priced rows, and nothing here establishes whether this scope has any.`;
  }
  if (report.models.length === 0) return "";
  const rated = report.models.filter((m) => !NO_MODEL_OBSERVED.includes(m));
  const unobserved = report.models.filter((m) => NO_MODEL_OBSERVED.includes(m));
  const parts = [`⚠ Pricing coverage: this scope's traffic in the last ${COVERAGE_WINDOW_DAYS} days includes calls that a USD cap on "${scopeKey}" does not count — they add $0 to the spend ledger.`];
  if (rated.length > 0) {
    parts.push(`${rated.length} model(s) carry no committed price: ${rated.join(", ")}. Measure the rate (\`npm run probe:models\`) and commit it in agent/spend/model-pricing.ts.`);
  }
  if (unobserved.length > 0) {
    parts.push(`Some rows record no model at all (${unobserved.join(", ")}). That is an instrumentation gap, not a pricing one — no rate can be committed for them, because nothing observed which model ran.`);
  }
  parts.push(`The cap still sums every other priced row in the scope, and a token cap is unaffected. RELAY THIS: the $ figure does not meter all of this scope's traffic.`);
  return ` ${parts.join(" ")}`;
}

export interface SpendSetPlan {
  readonly kind: "spend.set";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly level: Level;
    readonly monthlyTokens?: number;
    readonly monthlyUsd?: number;
    readonly reason: string;
    readonly currentCap: number | null;
    readonly currentUsd: number | null;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function defaultScopeKey(binding: SurfaceBinding, level: Level): string {
  const workspaceKey = `${binding.platform}/${binding.workspace}`;
  if (level === "workspace") return workspaceKey;
  if (level === "user") {
    const me = actingPrincipalId(binding);
    if (!me) {
      throw new Error(
        `defaultScopeKey: level:"user" has no default here — there is no acting sender on this turn to mean "my own allowance" (a triggered routine fire has only the creator it is attributed to). Pass scopeKey explicitly (\`user:<platform>/<id>\`).`,
      );
    }
    return userScopeKey(binding.platform, binding.workspace, me);
  }
  const surfaceKey = `${workspaceKey}/${binding.domainSurface ?? binding.surface}`;
  if (level === "surface") return surfaceKey;
  const domainName = domainNameForScope(surfaceKey, binding.mode, binding.trust);
  if (!domainName) {
    throw new Error(
      `defaultScopeKey: level:"domain" has no default here — this channel isn't an explicit member of any domain, and doesn't classify into a dm/public criteria domain either. Pass scopeKey explicitly (the domain's name).`,
    );
  }
  return domainName;
}

export function assertScopableFromHere(tool: string, binding: SurfaceBinding, level: Level, explicitScopeKey: string | undefined): void {
  if (explicitScopeKey?.trim() || binding.mode === "channel") return;
  if (level === "domain") {
    throw new Error(
      `${tool}: this is a DM, so a domain-level cap defaulted from here would land on the dm/public CRITERIA domain — which spans every DM in the deployment, not just this conversation. That caps everyone. Say scopeKey explicitly (the domain's name) if you mean it, or use level:"surface" to cap just this DM.`,
    );
  }
  if (level === "workspace" && binding.platform === "discord") {
    throw new Error(
      `${tool}: a Discord DM belongs to no server, so level:"workspace" here would target your personal DM bucket ("discord/${binding.workspace}"), not a server. Pass scopeKey "discord/<serverId>" for the server you mean — the ⛔ decline message in an over-budget channel shows it, or ask again from a channel in that server.`,
    );
  }
}

export function assertScopeKeyShapeForLevel(tool: string, level: Level, scopeKey: string): void {
  const isUserKey = parseScopeKey(scopeKey).kind === "principal";
  if (level === "user" && !isUserKey) {
    throw new Error(
      `${tool}: level:"user" needs a principal scope key of the form \`user:<platform>/<id>\` (e.g. "user:slack/U0123ABCD") — got "${scopeKey}", which addresses a place, not a person, and would store an allowance nobody can ever present. The over-budget decline message names the exact key.`,
    );
  }
  if (level !== "user" && isUserKey) {
    throw new Error(
      `${tool}: "${scopeKey}" is a PERSON's scope key, so it only works with level:"user" — a ${level}-level cap on it would gate nothing. Pass level:"user", or a ${level} scope key.`,
    );
  }
}

export function planSetSpendLimit(binding: SurfaceBinding, input: SetSpendLimitInput, current: CurrentCaps, domain: string | null): SpendSetPlan {
  if (!actingPrincipalId(binding)) {
    throw new Error("set_spend_limit needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose a spend-limit change in that person's name. Ask a person in this conversation to propose it.");
  }
  if (input.monthlyTokens == null && input.monthlyUsd == null) {
    throw new Error("set_spend_limit needs monthlyTokens or monthlyUsd — set the one the person asked for (either alone is a complete proposal), or both only if they named both.");
  }
  const level = input.level ?? "surface";
  assertScopableFromHere("set_spend_limit", binding, level, input.scopeKey);
  const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
  assertScopeKeyShapeForLevel("set_spend_limit", level, scopeKey);
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("set_spend_limit needs a non-empty reason — it's shown on the approval card.");
  }
  return {
    kind: "spend.set",
    args: {
      org: binding.org,
      scopeKey,
      level,
      ...(input.monthlyTokens != null ? { monthlyTokens: input.monthlyTokens } : {}),
      ...(input.monthlyUsd != null ? { monthlyUsd: input.monthlyUsd } : {}),
      reason,
      currentCap: current.tokens,
      currentUsd: current.usd,
    },
    scopeKey,
    domain,
  };
}

export default defineTool({
  description:
    'PROPOSE a monthly spend limit — token count and/or USD — for this surface (or, with level:"workspace", the whole workspace: the Slack workspace / Discord server; with level:"domain", every surface in this channel\'s memory domain; or with level:"user", ONE PERSON\'s own allowance) — this does NOT change the cap. It posts a confirmation card in this channel showing the current cap and the proposed one. Approval standing: an org admin can always decide; a domain admin whose domain covers this scope can too for "surface"/"workspace" — but a DOMAIN-LEVEL or USER-LEVEL cap needs an ORG ADMIN specifically (domain admins cannot approve or raise their own domain\'s budget, and a per-person allowance is a change about somebody who is not in the room the card lands in). Propose ONLY the component(s) the person named: monthlyUsd alone is a complete proposal, and so is monthlyTokens alone. A dollar-only request is a dollar-only proposal — never add a token cap (or a $ cap) nobody asked for; a component you leave out stays exactly as it is. A repeat of the same proposal (same level, scope and figures) while its card is still undecided posts no second card: you get the open card\'s pendingId back, so do not call again to "retry". DM turns are spend-capped like any other surface, so from a DM the default level:"surface" caps THIS DM and is accepted; level:"domain" needs an explicit scopeKey there (a DM\'s default domain spans every DM), and so does level:"workspace" on Discord (a Discord DM belongs to no server). level:"user" defaults to the person who just spoke ("my own allowance"); to change somebody ELSE\'s, pass their key explicitly as "user:<platform>/<id>". A person\'s allowance is checked INDEPENDENTLY of the room\'s cap — raising it never switches off the cap on the channel they are in. An over-budget decline message names the exact cap that stopped the turn and its key. Config-as-code (the spend budgets registry, reviewed by PR) is still the permanent way to set budgets — this is the fast runtime bridge for a one-off change an admin can approve on the spot. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says. EXCEPT in two cases, where the `note` carries something the channel cannot see and you MUST relay it: when this surface can\'t host a card (it then goes to a card-capable channel in the same domain, and the `note` names it), and whenever the `note` carries a "Pricing coverage" sentence (the USD cap you proposed does not count some of this scope\'s traffic, or its coverage could not be measured at all — the proposal still stands either way, this is a report, not a refusal). The approval card does NOT show this coverage on its visible lines, so relaying the note is the only way a person in this channel reads it; the person who asked is the one who can go and commit the missing rate.',
  inputSchema: z.object({
    monthlyTokens: z.number().int().positive().optional().describe("Proposed monthly token budget. Set it ONLY when the person asked for a token cap — omit it for a dollar-only request, and the token cap stays unchanged."),
    monthlyUsd: z.number().positive().optional().describe("Proposed monthly USD budget (estimated $, enforced against per-row priced usage). Set it ONLY when the person asked for a $ cap — omit it for a token-only request, and the $ cap stays unchanged."),
    reason: z.string().min(1).describe("Why you're proposing this — shown on the approval card."),
    level: z
      .enum(LEVELS)
      .optional()
      .describe(
        '"surface" (default — this channel/DM only), "workspace" (the whole Slack workspace / Discord server), "domain" (this channel\'s memory domain — ORG ADMIN approval only), or "user" (ONE PERSON\'s own monthly allowance, checked independently of the room\'s cap — ORG ADMIN approval only).',
      ),
    scopeKey: z
      .string()
      .optional()
      .describe(
        'Override the scope key, e.g. "slack/T123/C456" or "discord/G123/C456" for a surface, "slack/T123" for a workspace, a domain\'s own name for level:"domain", or "user:slack/U123" for level:"user". Defaults to this surface\'s own scope — or, for level:"user", to the person who just spoke.',
      ),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
    unpricedModels: z
      .array(z.string())
      .optional()
      .describe(
        'Models this scope ran on in the last 30 days that carry no committed price, so a USD cap does not count their calls ("(unstamped)" = rows with no model id). Present only on a monthlyUsd proposal that found one. 🔴 ITS ABSENCE IS NOT PROOF OF FULL COVERAGE — three different things produce it: every model was priced, the scope ran NO traffic in the window (so nothing was measured either way), or coverage could not be measured at all. `note` names only the last of the three; the approval card states which of them happened, in every case. Never report an absent field as "coverage is fine" — say the tool found no unpriced models, and leave it there. The proposal stands in all three cases.',
      ),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const level = input.level ?? "surface";
    const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
    const domain = level === "user" ? null : level === "domain" ? scopeKey : (domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null);
    const workspaceKey = `${binding.platform}/${binding.workspace}`;
    const current = await currentCapsFor(binding.org, workspaceKey, level, scopeKey, binding.mode, binding.trust);

    const plan = planSetSpendLimit(binding, input, current, domain);

    const venueResult = await checkApprovalVenue(binding, resolvePartition(ctx), () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "set that spend limit"));
    }
    const venue = venueResult.venue;

    const scopeLabel = await friendlyScopeLabel(plan.scopeKey);

    const tainted = untrustedIngestedThisTurn();

    const coverageReport = await readSpendCoverage(plan.args.org, plan.args.level, plan.args.scopeKey, plan.args.monthlyUsd);
    const coverage = coverageReport === undefined ? undefined : frozenCoverage(coverageReport);

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}), ...(coverage ? { coverage } : {}), tainted },
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const coverageNote = unpricedCoverageNote(coverageReport ?? { models: [] }, plan.args.scopeKey);
    const coverageFields = coverageReport !== undefined && coverageReport.models.length > 0 ? { unpricedModels: [...coverageReport.models] } : {};

    const proposed = [
      ...(plan.args.monthlyTokens != null ? [`${plan.args.monthlyTokens.toLocaleString()} tokens/month (current: ${plan.args.currentCap === null ? "uncapped" : plan.args.currentCap.toLocaleString()})`] : []),
      ...(plan.args.monthlyUsd != null ? [`$${plan.args.monthlyUsd.toFixed(2)}/month (current: ${plan.args.currentUsd === null ? "uncapped" : `$${plan.args.currentUsd.toFixed(2)}`})`] : []),
    ].join(" + ");
    if (posted.deduped) {
      return {
        requested: false,
        pendingId: posted.id,
        expiresAt: posted.expiresAt,
        ...coverageFields,
        note:
          `Already pending — the same ${plan.args.level} limit ${proposed} on ${pendingScopeWords(scopeLabel)} is awaiting an admin's Approve/Reject. ` +
          `No new card was posted; tell the user in plain words that the existing card${venue.sameRoom ? "" : ` in ${placeWords({ key: venue.surfaceKey })}`} still needs an admin to tap Approve or Reject.` +
          (venue.sameRoom ? "" : " Name that channel — the card is not in this conversation, so the user cannot see it from here.") +
          coverageNote,
      };
    }
    const subject = `${plan.args.level} limit ${proposed} on ${placeBesideKey(plan.args.scopeKey)}${tainted ? " ⚠ tainted" : ""}`;
    if (posted.autoApproved) {
      return {
        requested: false,
        autoApproved: true,
        pendingId: posted.id,
        ...coverageFields,
        note: autoApprovedNote(subject, posted.autoApproved) + coverageNote,
      };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      ...coverageFields,
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}).` + cardPostedTail(venue, "approve it", posted) + coverageNote,
    };
  },
});
