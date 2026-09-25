import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { usageSummary } from "../spend/usage-events.js";
import { spendRollup } from "../spend/store.js";
import { periodOf, type Caps } from "../spend/spend.js";
import { resolveCaps, applyCapOverrides, activeSpendLimitsForOrg, domainNameForScope, userCapInventory } from "../spend/caps.js";
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
  summariseCostDrift,
  costDriftNote,
  tokenAttribution,
  tokenAttributionNote,
} from "../spend/reporting.js";
import { maskDmSurfaceKey, maskSurfaceKey } from "../spend/dm-mask.js";
import { bridgeFetchUserDisplayName, bridgeFetchChannelDisplayName } from "../channels/slack-bridge.js";
import { fulfilPaneRead } from "../access/pane-venue.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function renderSpendReportForDm(r: {
  org: string;
  sinceDays: number;
  totals: { inputTokens: number; outputTokens: number; costUsd?: number };
  bySurfaceAndKind: readonly { surfaceKey: string; channel?: string; kind: string; inputTokens: number; outputTokens: number; costUsd?: number }[];
  ledger: { period: string; totalTokens: number; totalUsd: number; surfaces: readonly { surfaceKey: string; channel?: string; over: boolean }[] };
  userCaps?: readonly { principal: string; source: string; monthlyTokens: number | null; monthlyUsd: number | null }[];
}): string {
  const usd = (n: number | undefined) => (n === undefined ? "—" : `$${n.toFixed(2)}`);
  const over = r.ledger.surfaces.filter((s) => s.over);
  const userCapLine =
    r.userCaps === undefined || r.userCaps.length === 0
      ? "No per-person allowances declared."
      : `Per-person allowances: ${r.userCaps.length} declared (${r.userCaps.filter((c) => c.source === "override").length} live override(s)) — see the full report for who.`;
  return [
    `Spend — org "${r.org}", last ${r.sinceDays} days`,
    `tokens in ${r.totals.inputTokens} / out ${r.totals.outputTokens} · estimated ${usd(r.totals.costUsd)}`,
    `ledger ${r.ledger.period}: ${r.ledger.totalTokens} tokens · ${usd(r.ledger.totalUsd)}`,
    "",
    "Top surfaces in window:",
    ...(r.bySurfaceAndKind.length
      ? r.bySurfaceAndKind.slice(0, 5).map((s) => `  • ${s.channel ?? s.surfaceKey} (${s.kind}) — ${s.inputTokens + s.outputTokens} tokens, ${usd(s.costUsd)}`)
      : ["  (none in window)"]),
    "",
    over.length ? `Over cap: ${over.map((s) => s.channel ?? s.surfaceKey).join(", ")}` : "Nothing over its cap.",
    userCapLine,
    "",
    "Top rows only, $ figures are estimates. Ask again in a governance channel (or use the control plane) for the full breakdown.",
  ].join("\n");
}

export default defineTool({
  description:
    "Token spend rollup for your memory domain, or (org admins only) the whole org: tokens + estimated $ by surface and turn-origin kind, the existing monthly ledger totals (tokens AND $) against EFFECTIVE caps (config-as-code overlaid with any active admin override — the same numbers the spend gate enforces), per surface and per workspace, and a routine-fired cost PROJECTION (7d/30d) where a surface has enough history. At org scope it also lists PER-PERSON monthly allowances (`userCaps` — the perUser budget axis, config-declared and live-override alike, with which layer each came from); that roster is org-admin business and is omitted at domain scope. scope=\"domain\" works for anyone in a memory domain (reports that domain only); scope=\"org\" requires an org admin. $ figures are estimates, always labelled with the assumption behind them.",
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
    tokenAttribution: z
      .object({
        calls: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number(),
        reasoningTokens: z.number(),
        cacheReportedCalls: z.number().describe("Calls whose source PUBLISHED a cache field at all — NOT a claim that the figure is informative, since a published value may be zero."),
        reasoningReportedCalls: z.number().describe("Calls that reported a reasoning-token count at all."),
      })
      .describe(
        "WHERE the tokens went, beside what they cost (OPE-1611) — cache-read, cache-write and reasoning counts over the same usage window, each with the number of calls that published the dimension at all. Deliberately carries NO dollar figure: the billed cost is costDrift.measuredUsd / totals.costUsd and nothing here re-derives it, because a saving inferred from a token count nothing billed against would be a guess. 🔴 A ZERO TOKEN COUNT MEANS UNKNOWN, NOT UNCACHED, whatever cacheReportedCalls says: on the Vercel AI Gateway backend a cached call is billed at the discount while the cached-token count reads 0, so on that backend the saving lands in the cost and never in the split. ModelBackend is swappable, so that sentence is about that backend and not about every deployment; where cacheReportedCalls is 0 no source published the dimension at all and nothing is claimed about caching. The `note` field states which of the two silences this window carries — quote it rather than reading the numbers alone.",
      ),
    pricedModel: z.string().optional(),
    costDrift: z
      .object({
        measuredUsd: z.number().describe("What the gateway actually billed, over the calls it measured."),
        derivedUsd: z.number().describe("What this deployment's rate table derived for those SAME calls."),
        divergenceUsd: z.number().describe("derived - measured. Positive = the rate table over-states the bill."),
        divergencePct: z.number().optional(),
        measuredCalls: z.number(),
        totalCalls: z.number().describe("Calls in scope overall — the denominator the divergence must be read against."),
      })
      .describe(
        "Measured-vs-derived cost divergence for the ledger period (OPE-369). Gateway-measured cost is stored alongside the rate-derived figure on every row that had one, so this compares the two over exactly the same calls. The caps enforce the DERIVED figure, always — a divergence here is a signal that the price table needs re-measuring, never that enforcement is off.",
      ),
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
    userCaps: z
      .array(
        z.object({
          principal: z.string().describe('Who: "user:<platform>/<id>" for an override, the config key for a perUser.overrides entry, "*" for the blanket perUser.default.'),
          source: z.enum(["config:default", "config:overrides", "override"]),
          monthlyTokens: z.number().nullable(),
          monthlyUsd: z.number().nullable(),
          expiresAt: z.number().optional().describe("Overrides only — epoch ms when the temporary bridge reverts to config."),
          reason: z.string().optional(),
          setBy: z.string().optional(),
        }),
      )
      .optional()
      .describe('scope="org" only — every PER-PERSON monthly allowance, config-declared and runtime-override alike. Omitted for scope="domain" (see note).'),
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
    const build = async () => {
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
        const cost = rowCostUsd(r, assumed, "aggregate");
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
      const attribution = tokenAttribution(nonSandbox);

      const nowISO = new Date().toISOString();
      const currentPeriod = periodOf(nowISO);
      const period = input.period ?? currentPeriod;
      const orgLedgers = (await spendRollup(resolved.org, { period }))
        .filter((l) => l.org === resolved.org && l.period === period)
        .filter((l) => !resolved.domain || domainOfUsageRow(l.surfaceKey, undefined, domains) === resolved.domain);

      const costDrift = summariseCostDrift(orgLedgers);

      const overrideLimits = await activeSpendLimitsForOrg(resolved.org);
      const effCapsForScope = (workspaceKey: string, surfaceKey: string): Caps => {
        const domainName = domainNameForScope(surfaceKey);
        const config = resolveCaps(workspaceKey, surfaceKey, domainName);
        return overrideLimits.length ? applyCapOverrides(config, overrideLimits, workspaceKey, surfaceKey, domainName) : config;
      };

      const workspaceKeysInScope = [...new Set(orgLedgers.map((l) => l.surfaceKey.split("/").slice(0, 2).join("/")))];

      const rawLedgerSurfaces = orgLedgers.map((l) => {
        const workspaceKey = l.surfaceKey.split("/").slice(0, 2).join("/");
        const caps = effCapsForScope(workspaceKey, l.surfaceKey);
        const tokenCap = caps.surfaceMonthlyTokens ?? null;
        const tokenOver = tokenCap != null && l.tokens >= tokenCap;
        const usdCap = caps.surfaceMonthlyUsd ?? null;
        const usdOver = usdCap != null && l.usd >= usdCap;
        return { surfaceKey: l.surfaceKey, disclosure: l.disclosure, tokens: l.tokens, tokenCap, tokenOver, usd: l.usd, usdCap, usdOver, over: tokenOver || usdOver };
      });
      const maskedLedger = new Map<string, (typeof rawLedgerSurfaces)[number]>();
      const ledgerSurfaces: typeof rawLedgerSurfaces = [];
      for (const s of rawLedgerSurfaces) {
        const key = maskSurfaceKey(s.surfaceKey, s.disclosure);
        if (key === s.surfaceKey) {
          ledgerSurfaces.push(s);
          continue;
        }
        const acc = maskedLedger.get(key) ?? { surfaceKey: key, disclosure: s.disclosure, tokens: 0, tokenCap: null, tokenOver: false, usd: 0, usdCap: null, usdOver: false, over: false };
        maskedLedger.set(key, {
          surfaceKey: key,
          disclosure: s.disclosure,
          tokens: acc.tokens + s.tokens,
          tokenCap: null,
          tokenOver: acc.tokenOver || s.tokenOver,
          usd: acc.usd + s.usd,
          usdCap: null,
          usdOver: acc.usdOver || s.usdOver,
          over: acc.over || s.over,
        });
      }
      ledgerSurfaces.push(...maskedLedger.values());
      const ledgerTotalTokens = ledgerSurfaces.reduce((sum, s) => sum + s.tokens, 0);
      const ledgerTotalUsd = ledgerSurfaces.reduce((sum, s) => sum + s.usd, 0);

      const ledgerWorkspaces = workspaceKeysInScope.map((workspaceKey) => {
        const inWorkspace = orgLedgers.filter((l) => l.surfaceKey.split("/").slice(0, 2).join("/") === workspaceKey);
        const tokens = inWorkspace.reduce((sum, l) => sum + l.tokens, 0);
        const usd = inWorkspace.reduce((sum, l) => sum + l.usd, 0);
        const caps = effCapsForScope(workspaceKey, "");
        const tokenCap = caps.workspaceMonthlyTokens ?? null;
        const tokenOver = tokenCap != null && tokens >= tokenCap;
        const usdCap = caps.workspaceMonthlyUsd ?? null;
        const usdOver = usdCap != null && usd >= usdCap;
        return { workspaceKey, tokens, tokenCap, tokenOver, usd, usdCap, usdOver, over: tokenOver || usdOver };
      });

      const routineRows = scopedRows.filter((r) => r.kind === "routine");
      const routinePredictions = (await buildRoutinePredictions(resolved.org, routineRows, assumed.pricing)).map((p) => {
        const key = maskSurfaceKey(p.surfaceKey, p.disclosure);
        return key === p.surfaceKey ? p : { ...p, surfaceKey: key };
      });

      const labels = await resolveSlackLabels(
        [],
        [...bySurfaceAndKind.map((r) => r.surfaceKey), ...ledgerSurfaces.map((s) => s.surfaceKey), ...routinePredictions.map((p) => p.surfaceKey)],
        { userName: bridgeFetchUserDisplayName, channelName: bridgeFetchChannelDisplayName },
      );
      const labelled = <T extends { surfaceKey: string }>(row: T): T & { channel?: string } => ({
        ...row,
        ...(labels.channels.has(row.surfaceKey) ? { channel: labels.channels.get(row.surfaceKey)! } : {}),
      });

      const userCaps = resolved.domain ? undefined : userCapInventory(overrideLimits);

      const notes = [
        pricingNote(mix, assumed),
        costDriftNote(costDrift),
        tokenAttributionNote(attribution),
        "the bySurfaceAndKind usage-window figures exclude sandbox runtime (see session_cost for a conversation's sandbox seconds/$); the monthly ledger.*.usd figures DO include sandbox runtime (OPE-266) — an estimate priced at stop time from the platform rate, assuming the configured/default sandbox memory size.",
        "routinePredictions project future spend from this window's history and each surface's CURRENT active cron/interval routines — always an estimate, not a bill.",
        "ledger.surfaces/ledger.workspaces use the existing monthly spend ledger (the caps engine), which may cover a different window than sinceDays (it's keyed by calendar month).",
        "ledger caps are EFFECTIVE caps — config-as-code overlaid with any currently-active admin override (set_spend_limit) — the same numbers the spend gate enforces; an expired override has already reverted to config here, same as at the gate.",
        "ledger.*.usd is the spend ledger's own stored figure — priced evidence-only at WRITE time (a call's stamped model's rate, the sole-priced-model fallback for a stampless call, $0 for an unpriced model, never a guessed rate) — the EXACT sum the gate enforces for the same period; it is independent of any assumedModelId you passed above (that only re-prices the usage-window figures).",
        "channel labels are best-effort Slack lookups — prefer them when presenting; the surfaceKey stays the ground truth.",
        'DM spend is aggregated into a single "(dms)" bucket per workspace — individual DM surfaces are deliberately never listed in reports (the stored rows keep full resolution); tokenCap/usdCap are hidden as null for that bucket (a shared bucket has no single cap) but over/tokenOver/usdOver are never masked.' +
          'A row written before the conversation-mode stamp existed cannot be classified, so it reports under a separate "(unclassified)" bucket per workspace: masked rather than named, and kept apart from "(dms)" so a channel\'s spend is never reported as DM spend.',
      ];
      if (userCaps) {
        notes.push(
          'userCaps lists PER-PERSON monthly allowances (the perUser budget axis), not spend: source "config:default"/"config:overrides" come from the spend-budgets registry and change by PR; source "override" is a temporary runtime bridge set through set_spend_limit level:"user" and expires back to config (expiresAt). A person\'s allowance is checked INDEPENDENTLY of the surface and workspace caps above — it never replaces them, so somebody can be within their own allowance and still declined by the room\'s cap. It applies to their DM usage.',
        );
      }
      if (resolved.domain) {
        notes.push(
          "domain scoping is approximate for the ledger continuity figures above (they aren't kind-tagged, so a DM surface with no explicit domain can appear under the org-domain bucket) — the bySurfaceAndKind/totals figures above don't have this issue (dm-kind rows are excluded from domain buckets).",
          'userCaps (the per-person allowance roster) is omitted at domain scope on purpose: scope="domain" is "anyone in the domain", and a roster of named individuals and what the org decided about each is org-admin business. Ask with scope="org" (it renders in a governance channel or your DM).',
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
        tokenAttribution: attribution,
        ...(assumed.model ? { pricedModel: assumed.model } : {}),
        costDrift,
        ledger: {
          period,
          totalTokens: ledgerTotalTokens,
          totalUsd: ledgerTotalUsd,
          surfaces: ledgerSurfaces.map(({ disclosure: _disclosure, ...row }) => labelled(row)),
          workspaces: ledgerWorkspaces,
        },
        ...(userCaps ? { userCaps } : {}),
        routinePredictions: routinePredictions.map(({ disclosure: _disclosure, ...row }) => labelled(row)),
        note: notes.join(" "),
      };
    };
    if (input.scope !== "org") return await build();
    return await fulfilPaneRead(ctx, { kind: "spend.report.org", render: renderSpendReportForDm }, build);
  },
});
