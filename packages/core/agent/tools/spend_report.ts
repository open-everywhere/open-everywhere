import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { usageSummary } from "../spend/usage-events.js";
import { allLedgers } from "../spend/store.js";
import { windowTokens, periodOf, type Caps } from "../spend/spend.js";
import { resolveCaps, applyCapOverrides, activeSpendLimitsForOrg, domainNameForScope } from "../spend/caps.js";
import { workspaceUsdSpendForCurrentMonth, workspaceUsdSpendForPeriod, type WorkspaceUsdSpend } from "../spend/check.js";
import { getConfig } from "../access/config.js";
import {
  resolveReportScope,
  filterToDomain,
  domainOfUsageRow,
  resolveAssumedModel,
  rowCostUsd,
  pricingMix,
  pricingNote,
  buildRoutinePredictions,
  resolveSlackLabels,
  maskDmSurfaceKey,
  isDmSurface,
  dmBucketKey,
} from "../spend/reporting.js";
import { fetchUserDisplayName, fetchChannelDisplayName } from "../channels/slack-events.js";
import { requirePaneVenue } from "../access/pane-venue.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default defineTool({
  description:
    "Token spend rollup for your memory domain, or (org admins only) the whole org: tokens + estimated $ by surface and turn-origin kind, the existing monthly ledger totals (tokens AND $) against EFFECTIVE caps (config-as-code overlaid with any active admin override — the same numbers the spend gate enforces), per surface and per workspace, and a routine-fired cost PROJECTION (7d/30d) where a surface has enough history. scope=\"domain\" works for anyone in a memory domain (reports that domain only); scope=\"org\" requires an org admin. $ figures are estimates, always labelled with the assumption behind them.",
  inputSchema: z.object({
    scope: z.enum(["domain", "org"]).describe('"domain" = your own resolved memory domain (anyone in it); "org" = the whole org (org-admin only).'),
    sinceDays: z.number().int().positive().max(365).optional().describe("Usage window in days, default 30."),
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional()
      .describe('Calendar month ("YYYY-MM") for the ledger-continuity totals, default the current month.'),
    assumedModelId: z.string().optional().describe("Price token usage as if it were this model id (hook-written usage rows carry no model field). Omit to let the deploy's sole configured model price it, if there is exactly one."),
  }),
  outputSchema: z.object({
    scope: z.enum(["domain", "org"]),
    org: z.string(),
    domain: z.string().optional(),
    sinceDays: z.number(),
    since: z.string(),
    bySurfaceAndKind: z.array(
      z.object({
        surfaceKey: z.string(),
        channel: z.string().optional(),
        kind: z.string(),
        events: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number(),
        costUsd: z.number().optional(),
      }),
    ),
    totals: z.object({
      events: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      costUsd: z.number().optional(),
    }),
    pricedModel: z.string().optional(),
    ledger: z.object({
      period: z.string(),
      totalTokens: z.number(),
      totalUsd: z.number(),
      surfaces: z.array(
        z.object({
          surfaceKey: z.string(),
          channel: z.string().optional(),
          tokens: z.number(),
          tokenCap: z.number().nullable(),
          tokenOver: z.boolean(),
          usd: z.number(),
          usdCap: z.number().nullable(),
          usdOver: z.boolean(),
          over: z.boolean(),
        }),
      ),
      workspaces: z.array(
        z.object({
          workspaceKey: z.string(),
          tokens: z.number(),
          tokenCap: z.number().nullable(),
          tokenOver: z.boolean(),
          usd: z.number(),
          usdCap: z.number().nullable(),
          usdOver: z.boolean(),
          over: z.boolean(),
        }),
      ),
    }),
    routinePredictions: z.array(
      z.object({
        surfaceKey: z.string(),
        channel: z.string().optional(),
        observedFires: z.number(),
        avgTokensPerFire: z.number(),
        cadencePerDay: z.number().optional(),
        projected: z
          .object({
            tokens7d: z.number(),
            tokens30d: z.number(),
            costUsd7d: z.number().optional(),
            costUsd30d: z.number().optional(),
          })
          .nullable(),
        skippedReason: z.string().optional(),
      }),
    ),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const resolved = resolveReportScope(ctx, input.scope);
    if (input.scope === "org") await requirePaneVenue(ctx, { kind: "spend.report.org" });
    const domains = getConfig().loadDomains();
    const sinceDays = input.sinceDays ?? 30;
    const since = isoDaysAgo(sinceDays);

    const allRows = await usageSummary(resolved.org, { sinceTs: since });
    const scopedRows = resolved.domain ? filterToDomain(allRows, resolved.domain, domains) : allRows;
    const nonSandbox = scopedRows.filter((r) => r.kind !== "sandbox").map(maskDmSurfaceKey);

    const assumed = resolveAssumedModel(input.assumedModelId);

    const grouped = new Map<
      string,
      { surfaceKey: string; kind: string; events: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }
    >();
    for (const r of nonSandbox) {
      const kind = r.kind ?? "unknown";
      const key = `${r.surfaceKey} ${kind}`;
      const acc = grouped.get(key) ?? { surfaceKey: r.surfaceKey, kind, events: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      acc.events += r.events;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cacheReadTokens += r.cacheReadTokens;
      acc.cacheWriteTokens += r.cacheWriteTokens;
      const cost = rowCostUsd(r, assumed);
      if (cost !== undefined) acc.costUsd = (acc.costUsd ?? 0) + cost;
      grouped.set(key, acc);
    }
    const bySurfaceAndKind = [...grouped.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    const totals = bySurfaceAndKind.reduce(
      (acc, r) => ({
        events: acc.events + r.events,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      }),
      { events: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    const pricedGroups = bySurfaceAndKind.filter((r) => r.costUsd !== undefined);
    const totalsWithCost = { ...totals, ...(pricedGroups.length > 0 ? { costUsd: pricedGroups.reduce((sum, r) => sum + r.costUsd!, 0) } : {}) };
    const mix = pricingMix(nonSandbox, assumed);

    const nowISO = new Date().toISOString();
    const currentPeriod = periodOf(nowISO);
    const period = input.period ?? currentPeriod;
    const isCurrentPeriod = period === currentPeriod;
    const ledgers = await allLedgers();
    const orgLedgers = ledgers
      .filter((l) => l.org === resolved.org)
      .filter((l) => !resolved.domain || domainOfUsageRow(l.surfaceKey, undefined, domains) === resolved.domain);

    const overrideLimits = await activeSpendLimitsForOrg(resolved.org);
    const effCapsForScope = (workspaceKey: string, surfaceKey: string): Caps => {
      const config = resolveCaps(workspaceKey, surfaceKey, domainNameForScope(surfaceKey));
      return overrideLimits.length ? applyCapOverrides(config, overrideLimits, workspaceKey, surfaceKey) : config;
    };

    const workspaceKeysInScope = [...new Set(orgLedgers.map((l) => l.surfaceKey.split("/").slice(0, 2).join("/")))];
    const usdByWorkspace = new Map<string, WorkspaceUsdSpend>(
      await Promise.all(
        workspaceKeysInScope.map(
          async (wk) => [wk, isCurrentPeriod ? await workspaceUsdSpendForCurrentMonth(resolved.org, wk, nowISO) : await workspaceUsdSpendForPeriod(resolved.org, wk, period)] as const,
        ),
      ),
    );

    const rawLedgerSurfaces = orgLedgers.map((l) => {
      const workspaceKey = l.surfaceKey.split("/").slice(0, 2).join("/");
      const tokens = windowTokens(l.ledger.windows[period]);
      const caps = effCapsForScope(workspaceKey, l.surfaceKey);
      const tokenCap = caps.surfaceMonthlyTokens ?? null;
      const tokenOver = tokenCap != null && tokens >= tokenCap;
      const usd = usdByWorkspace.get(workspaceKey)?.bySurface.get(l.surfaceKey) ?? 0;
      const usdCap = caps.surfaceMonthlyUsd ?? null;
      const usdOver = usdCap != null && usd >= usdCap;
      return { surfaceKey: l.surfaceKey, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver };
    });
    const dmLedger = new Map<string, (typeof rawLedgerSurfaces)[number]>();
    const ledgerSurfaces: typeof rawLedgerSurfaces = [];
    for (const s of rawLedgerSurfaces) {
      if (!isDmSurface(s.surfaceKey)) {
        ledgerSurfaces.push(s);
        continue;
      }
      const key = dmBucketKey(s.surfaceKey);
      const acc = dmLedger.get(key) ?? { surfaceKey: key, tokens: 0, tokenCap: null, tokenOver: false, usd: 0, usdCap: null, usdOver: false, over: false };
      dmLedger.set(key, {
        surfaceKey: key,
        tokens: acc.tokens + s.tokens,
        tokenCap: null,
        tokenOver: acc.tokenOver || s.tokenOver,
        usd: acc.usd + s.usd,
        usdCap: null,
        usdOver: acc.usdOver || s.usdOver,
        over: acc.over || s.over,
      });
    }
    ledgerSurfaces.push(...dmLedger.values());
    const ledgerTotalTokens = ledgerSurfaces.reduce((sum, s) => sum + s.tokens, 0);
    const ledgerTotalUsd = ledgerSurfaces.reduce((sum, s) => sum + s.usd, 0);

    const ledgerWorkspaces = workspaceKeysInScope.map((workspaceKey) => {
      const tokens = orgLedgers
        .filter((l) => l.surfaceKey.split("/").slice(0, 2).join("/") === workspaceKey)
        .reduce((sum, l) => sum + windowTokens(l.ledger.windows[period]), 0);
      const caps = effCapsForScope(workspaceKey, "");
      const tokenCap = caps.workspaceMonthlyTokens ?? null;
      const tokenOver = tokenCap != null && tokens >= tokenCap;
      const usd = usdByWorkspace.get(workspaceKey)?.workspaceUsd ?? 0;
      const usdCap = caps.workspaceMonthlyUsd ?? null;
      const usdOver = usdCap != null && usd >= usdCap;
      return { workspaceKey, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver };
    });

    const routineRows = scopedRows.filter((r) => r.kind === "routine");
    const routinePredictions = (await buildRoutinePredictions(resolved.org, routineRows, assumed.pricing)).map((p) =>
      isDmSurface(p.surfaceKey) ? { ...p, surfaceKey: dmBucketKey(p.surfaceKey) } : p,
    );

    const labels = await resolveSlackLabels(
      [],
      [...bySurfaceAndKind.map((r) => r.surfaceKey), ...ledgerSurfaces.map((s) => s.surfaceKey), ...routinePredictions.map((p) => p.surfaceKey)],
      { userName: fetchUserDisplayName, channelName: fetchChannelDisplayName },
    );
    const labelled = <T extends { surfaceKey: string }>(row: T): T & { channel?: string } => ({
      ...row,
      ...(labels.channels.has(row.surfaceKey) ? { channel: labels.channels.get(row.surfaceKey)! } : {}),
    });

    const notes = [
      pricingNote(mix, assumed),
      "sandbox runtime isn't included in this rollup — see session_cost for a conversation's sandbox seconds/$.",
      "routinePredictions project future spend from this window's history and each surface's CURRENT active cron/interval routines — always an estimate, not a bill.",
      "ledger.surfaces/ledger.workspaces use the existing monthly spend ledger (the caps engine), which may cover a different window than sinceDays (it's keyed by calendar month).",
      "ledger caps are EFFECTIVE caps — config-as-code overlaid with any currently-active admin override (set_spend_limit) — the same numbers the spend gate enforces; an expired override has already reverted to config here, same as at the gate.",
      "ledger.*.usd is the SAME evidence-only per-row estimate the gate uses (never a guessed rate); an all-unpriced deploy's usd reads $0 and its usd cap never trips. For the current month this figure equals what the gate is enforcing right now; it always uses the deploy's own default assumed-model resolution for this ledger, independent of any assumedModelId you passed above.",
      "channel labels are best-effort Slack lookups — prefer them when presenting; the surfaceKey stays the ground truth.",
      'DM spend is aggregated into a single "(dms)" bucket per workspace — individual DM surfaces are deliberately never listed in reports (the stored rows keep full resolution); tokenCap/usdCap are hidden as null for that bucket (a shared bucket has no single cap) but over/tokenOver/usdOver are never masked.',
    ];
    if (resolved.domain) {
      notes.push(
        "domain scoping is approximate for the ledger continuity figures above (they aren't kind-tagged, so a DM surface with no explicit domain can appear under the org-domain bucket) — the bySurfaceAndKind/totals figures above don't have this issue (dm-kind rows are excluded from domain buckets).",
      );
    }

    return {
      scope: input.scope,
      org: resolved.org,
      ...(resolved.domain ? { domain: resolved.domain } : {}),
      sinceDays,
      since,
      bySurfaceAndKind: bySurfaceAndKind.map(labelled),
      totals: totalsWithCost,
      ...(assumed.model ? { pricedModel: assumed.model } : {}),
      ledger: {
        period,
        totalTokens: ledgerTotalTokens,
        totalUsd: ledgerTotalUsd,
        surfaces: ledgerSurfaces.map(labelled),
        workspaces: ledgerWorkspaces,
      },
      routinePredictions: routinePredictions.map(labelled),
      note: notes.join(" "),
    };
  },
});
