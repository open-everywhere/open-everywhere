process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { appendUsageEvent } from "../agent/spend/usage-events.js";
import { periodOf, UNKNOWN_MODEL } from "../agent/spend/spend.js";
import type { SurfacePeriodSpend } from "../agent/spend/store.js";
import type { BindableContext } from "../agent/identity/binding.js";
import {
  soleConfiguredModel,
  _setBuiltInForTest,
  registerModelPricing,
  _resetModelPricingForTest,
  builtInModelIds,
  modelPricing,
} from "../agent/spend/pricing.js";
import { estimateSandboxCostUsd, sandboxMemoryGiB, sandboxGiBHourUsd } from "../agent/spend/sandbox-pricing.js";
import {
  domainOfUsageRow,
  filterToDomain,
  resolveAssumedModel,
  rowCostUsd,
  pricingMix,
  pricingNote,
  firesPerDay,
  buildRoutinePredictions,
  approxConversationCount,
  aggregateByUser,
  aggregateBySurface,
  resolveReportScope,
  reportDomainRefusalMessage,
  slackUserIdIn,
  slackChannelIdIn,
  resolveSlackLabels,
  isDmSurface,
  dmBucketKey,
  maskDmSurfaceKey,
  summariseCostDrift,
  costDriftNote,
} from "../agent/spend/reporting.js";
import sessionCostTool from "../agent/tools/session_cost.js";
import spendReportTool from "../agent/tools/spend_report.js";
import usageReportTool from "../agent/tools/usage_report.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { execTool } from "./_tool-exec.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

const PRICED_MODEL = builtInModelIds()[0];

const FIXTURE_DAY = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
registerSlackFixtureMapper();


let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-tools" })],
  loadBindings: () => [defineBinding({ bundle: "org-tools", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["slack/T1/U_ENG_ADMIN"] }),
    defineDomain({ name: "other", channels: ["slack/T1/C_OTHER"] }),
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG_ADMIN"] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function ctxFor(opts: { channelId: string; channelType?: string; principalId?: string; internal?: boolean; sessionId?: string }): BindableContext {
  const attributes: Record<string, string> = { team_id: "T1", channel_id: opts.channelId };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  if (opts.internal) attributes.trust_checked = "true";
  return {
    channel: { kind: "slack" },
    session: { id: opts.sessionId ?? "sess-ctx", auth: { current: { attributes, principalId: opts.principalId ?? "U1", principalType: "slack-user" } } },
  } as unknown as BindableContext;
}

const ctxEng = (sessionId?: string) => ctxFor({ channelId: "C_ENG", internal: true, sessionId });
const ctxEngAdmin = ctxFor({ channelId: "C_ENG", internal: true, principalId: "U_ENG_ADMIN" });
const ctxOrgAdmin = ctxFor({ channelId: "C_RANDOM", internal: true, principalId: "U_ORG_ADMIN" });
const ctxPlainUnassigned = ctxFor({ channelId: "C_RANDOM", internal: true, principalId: "U_PLAIN" });
const ctxDm = ctxFor({ channelId: "D1", channelType: "im" });
const ctxMpim = ctxFor({ channelId: "G1", channelType: "mpim" });
const ctxExternal = ctxFor({ channelId: "C_EXT" });

{
  _resetModelPricingForTest();
  ok(builtInModelIds().length === 1 && builtInModelIds()[0] === PRICED_MODEL, "builtInModelIds: just the one shipped, verified model by default");
  ok(soleConfiguredModel() === PRICED_MODEL, "soleConfiguredModel: resolves the sole priced model");

  registerModelPricing({ "acme/two": { inPerMtok: 1, outPerMtok: 2 } });
  ok(soleConfiguredModel() === PRICED_MODEL, "soleConfiguredModel: a deployer-table id does NOT become a candidate");
  _resetModelPricingForTest();

  _setBuiltInForTest({ [PRICED_MODEL]: { inPerMtok: 1, outPerMtok: 2 }, "acme/two": { inPerMtok: 1, outPerMtok: 2 } });
  ok(builtInModelIds().length === 2, "builtInModelIds: reports every shipped entry");
  ok(soleConfiguredModel() === undefined, "soleConfiguredModel: two candidates -> undefined, never guesses");
  _setBuiltInForTest({});
  ok(soleConfiguredModel() === undefined, "soleConfiguredModel: zero candidates -> undefined too");
  _setBuiltInForTest(null);
}

{
  overrideSettingsForTest({ spend: { sandboxMemoryGiB: 4 } });
  overrideSettingsForTest({ spend: { sandboxGiBHourUsd: 0.0212 } });
  ok(sandboxMemoryGiB() === 4, "sandboxMemoryGiB: default is Vercel Sandbox's platform default (4 GiB)");
  ok(sandboxGiBHourUsd() === 0.0212, "sandboxGiBHourUsd: default is the verified Vercel rate");
  const oneHour = estimateSandboxCostUsd(3600);
  ok(Math.abs(oneHour - 0.0848) < 1e-9, "estimateSandboxCostUsd: 1hr default-size sandbox matches the verified rate");
  ok(estimateSandboxCostUsd(0) === 0, "estimateSandboxCostUsd: zero seconds -> $0, not undefined");
  ok(estimateSandboxCostUsd(-10) === 0, "estimateSandboxCostUsd: never goes negative on bad input");

  overrideSettingsForTest({ spend: { sandboxMemoryGiB: 8 } });
  overrideSettingsForTest({ spend: { sandboxGiBHourUsd: 0.01 } });
  ok(estimateSandboxCostUsd(3600) === 0.08, "estimateSandboxCostUsd: env overrides both the memory size and the rate");
  overrideSettingsForTest({ spend: { sandboxMemoryGiB: 4 } });
  overrideSettingsForTest({ spend: { sandboxGiBHourUsd: 0.0212 } });
}

{
  const domains = [
    defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"] }),
    defineDomain({ name: "org", match: "org" }),
  ];
  ok(domainOfUsageRow("slack/T1/C_ENG", "channel", domains) === "eng", "domainOfUsageRow: explicit domain wins");
  ok(domainOfUsageRow("slack/T1/C_RANDOM", "channel", domains) === "org", "domainOfUsageRow: unassigned channel-kind row falls to the org pseudo-domain");
  ok(domainOfUsageRow("slack/T1/C_RANDOM", "routine", domains) === "org", "domainOfUsageRow: routine-kind row also falls through to org");
  ok(domainOfUsageRow("slack/T1/D1", "dm", domains) === undefined, "domainOfUsageRow: dm-kind row never attributes to any domain");
  ok(domainOfUsageRow("slack/T1/C_RANDOM", "channel", []) === undefined, "domainOfUsageRow: no org pseudo-domain configured -> undefined for an unassigned surface");

  const rows = [
    { surfaceKey: "slack/T1/C_ENG", kind: "channel" },
    { surfaceKey: "slack/T1/D1", kind: "dm" },
    { surfaceKey: "slack/T1/C_RANDOM", kind: "channel" },
  ];
  ok(filterToDomain(rows, "eng", domains).length === 1, "filterToDomain: keeps only the requested domain's rows");
  ok(filterToDomain(rows, "org", domains).length === 1, "filterToDomain: org bucket excludes the dm row and the eng row");
}

{
  _resetModelPricingForTest();
  const auto = resolveAssumedModel(undefined);
  ok(auto.model === PRICED_MODEL && auto.pricing !== undefined, "resolveAssumedModel: falls back to the sole configured model");
  ok(/only priced model/.test(auto.note), "resolveAssumedModel: note explains the auto-assumption");

  const explicit = resolveAssumedModel(PRICED_MODEL);
  ok(explicit.model === PRICED_MODEL && /you supplied/.test(explicit.note), "resolveAssumedModel: an explicit model id is honoured and labelled as caller-supplied");

  const unpriced = resolveAssumedModel("no/such-model");
  ok(unpriced.model === "no/such-model" && unpriced.pricing === undefined && /no configured pricing/.test(unpriced.note), "resolveAssumedModel: an unpriced explicit model -> no pricing, explained, never a guessed rate");

  _setBuiltInForTest({ [PRICED_MODEL]: { inPerMtok: 0.25, outPerMtok: 1.2, cachedInPerMtok: 0.02 }, "acme/two": { inPerMtok: 1, outPerMtok: 2 } });
  const ambiguous = resolveAssumedModel(undefined);
  ok(ambiguous.model === undefined && ambiguous.pricing === undefined && /no single default/.test(ambiguous.note), "resolveAssumedModel: two candidates and no explicit choice -> omitted, never a guess");
  _setBuiltInForTest(null);
}

{
  _setBuiltInForTest({ [PRICED_MODEL]: { inPerMtok: 0.25, outPerMtok: 1.2, cachedInPerMtok: 0.02 }, "anthropic/claude-sonnet-5": { inPerMtok: 3, outPerMtok: 15 } });

  const explicitAssumed = resolveAssumedModel(PRICED_MODEL);
  const ambiguousAssumed = resolveAssumedModel(undefined);

  const exactRow = { model: "anthropic/claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0 };
  const stamplessRow = { inputTokens: 1_000_000, outputTokens: 0 };
  const stampedUnpricedRow = { model: "no/such-model", inputTokens: 500, outputTokens: 0 };

  ok(rowCostUsd(exactRow, explicitAssumed) === 3, "rowCostUsd: a stamped, priced model prices at ITS OWN rate ($3 = 1M in-tokens @ $3/Mtok)");
  ok(rowCostUsd(exactRow, ambiguousAssumed) === 3, "rowCostUsd: own-model pricing doesn't need the assumed model to resolve at all");
  ok(rowCostUsd(stamplessRow, explicitAssumed) === modelPricing(PRICED_MODEL)!.inPerMtok, "rowCostUsd: a stampless row falls back to the assumed model's rate");
  ok(rowCostUsd(stamplessRow, ambiguousAssumed) === undefined, "rowCostUsd: stampless row + no assumable model -> omitted, not guessed");
  ok(rowCostUsd(stampedUnpricedRow, explicitAssumed) === undefined, "rowCostUsd: a stamped model with NO configured rate is never priced at the assumed model's DIFFERENT rate — omitted, not silently wrong");

  const mix = pricingMix([exactRow, stamplessRow, stampedUnpricedRow], explicitAssumed);
  ok(mix.exact === 1 && mix.assumed === 1 && mix.unpriced === 1, "pricingMix: splits exact / assumed-fallback / unpriced correctly across a mixed set");

  const mixedNote = pricingNote(mix, explicitAssumed);
  ok(/1 row\(s\) priced exactly/.test(mixedNote), "pricingNote: reports the exact-priced count");
  ok(mixedNote.includes(explicitAssumed.note), "pricingNote: folds in the assumed-model note verbatim for the fallback rows");
  ok(/omitted/.test(mixedNote) && /hasn't configured a rate/.test(mixedNote), "pricingNote: explains the unpriced-stamped-model row rather than silently dropping it");

  const allExactMix = pricingMix([exactRow], explicitAssumed);
  ok(/exact — every priced row carries its own recorded model id/.test(pricingNote(allExactMix, explicitAssumed)), "pricingNote: an all-exact mix gets the confident 'every row' phrasing, not a row count");

  const legacyMix = pricingMix([stamplessRow], explicitAssumed);
  ok(pricingNote(legacyMix, explicitAssumed) === explicitAssumed.note, "pricingNote: zero stamped rows -> reproduces resolveAssumedModel's note verbatim (pre-item-17 wording, unchanged)");

  {
    const unattributedRow = { model: UNKNOWN_MODEL, inputTokens: 1_000_000, outputTokens: 0 };
    ok(rowCostUsd(unattributedRow, explicitAssumed) === undefined, "🔴 OPE-369: an unknown-model row is NEVER priced at the assumed model's rate — the read path inherits the same refusal the write path makes");

    const unattributedMix = pricingMix([exactRow, stampedUnpricedRow, unattributedRow], explicitAssumed);
    ok(unattributedMix.unpriced === 2 && unattributedMix.unattributed === 1, "pricingMix: unattributed rows are counted as a SUBSET of unpriced, not a fourth disjoint bucket");

    const note = pricingNote(unattributedMix, explicitAssumed);
    ok(/1 row\(s\) omitted — a recorded model this deployment hasn't configured a rate for/.test(note), "pricingNote: the unattributed row is subtracted out of the 'configure a rate' sentence rather than double-counted into it");
    ok(note.includes(UNKNOWN_MODEL) && /instrumentation gap, not a pricing one/.test(note), "🔴 pricingNote: the unattributed rows get their OWN sentence naming the sentinel and the right remedy");

    const noneUnattributed = pricingNote(pricingMix([exactRow, stampedUnpricedRow], explicitAssumed), explicitAssumed);
    ok(!noneUnattributed.includes(UNKNOWN_MODEL) && /1 row\(s\) omitted/.test(noneUnattributed), "pricingNote: with nothing unattributed the wording is byte-identical to before OPE-369");
  }

  _setBuiltInForTest(null);
}

{
  const row = (over: Partial<SurfacePeriodSpend>): SurfacePeriodSpend => ({
    org: "default",
    surfaceKey: "slack/T1/C1",
    period: "2026-08",
    tokens: 0,
    usd: 0,
    usdMeasured: 0,
    usdDerivedOnMeasured: 0,
    measuredCalls: 0,
    calls: 0,
    ...over,
  });

  const none = summariseCostDrift([row({ usd: 12.5, calls: 40 })]);
  ok(none.measuredCalls === 0 && none.measuredUsd === 0 && none.divergencePct === undefined, "summariseCostDrift: nothing measured -> no divergence AND no percentage (a percentage of zero is not a number a report may print)");
  ok(/no gateway-measured cost/.test(costDriftNote(none)) && /not a fault/.test(costDriftNote(none)), "🔴 costDriftNote: absent measurement is reported as EXPECTED on a direct-provider deployment, never as a defect");

  const over = summariseCostDrift([row({ usd: 3.1, calls: 40, usdMeasured: 1, usdDerivedOnMeasured: 1.1, measuredCalls: 10 })]);
  ok(Math.abs(over.divergenceUsd - 0.1) < 1e-9, "summariseCostDrift: divergence = derived − measured, over EXACTLY the measured rows (never against the unmeasured ones the total also carries)");
  ok(over.divergencePct !== undefined && Math.abs(over.divergencePct - 10) < 1e-9, "summariseCostDrift: divergence as a percentage of the MEASURED figure");
  ok(over.measuredCalls === 10 && over.totalCalls === 40, "summariseCostDrift: the coverage denominator travels with the number — 10 of 40 calls means something different from 40 of 40");
  const overNote = costDriftNote(over);
  ok(/OVER-states/.test(overNote) && /10 of 40 call/.test(overNote), "🔴 costDriftNote: names the DIRECTION and the coverage, so a reader can tell a rate-table error from a sampling artefact");
  ok(/caps enforce the DERIVED figure/.test(overNote), "🔴 costDriftNote: says which figure is enforced, so a divergence never reads as 'the caps are broken'");

  const under = summariseCostDrift([row({ usdMeasured: 2, usdDerivedOnMeasured: 1, measuredCalls: 4, calls: 4 })]);
  ok(under.divergenceUsd === -1 && /UNDER-states/.test(costDriftNote(under)), "costDriftNote: an under-stating rate table reads as UNDER-states (the direction that silently lets a cap run over)");

  const agree = summariseCostDrift([row({ usdMeasured: 5, usdDerivedOnMeasured: 5, measuredCalls: 2, calls: 2 })]);
  ok(agree.divergenceUsd === 0 && /agrees with/.test(costDriftNote(agree)), "costDriftNote: an exact match says so plainly");

  const multi = summariseCostDrift([row({ usdMeasured: 1, usdDerivedOnMeasured: 2, measuredCalls: 1, calls: 3 }), row({ surfaceKey: "slack/T1/C2", usdMeasured: 3, usdDerivedOnMeasured: 4, measuredCalls: 2, calls: 5 })]);
  ok(multi.measuredUsd === 4 && multi.derivedUsd === 6 && multi.measuredCalls === 3 && multi.totalCalls === 8, "summariseCostDrift: sums across every scoped surface, both halves and both denominators");
}

{
  const eng = resolveReportScope(ctxEng(), "domain");
  ok(eng.domain === "eng" && eng.org === "default", "resolveReportScope: domain scope resolves the caller's explicit domain (anyone in it — no admin check)");

  assert.throws(() => resolveReportScope(ctxDm, "domain"), /DM/, "resolveReportScope: domain scope refuses from a DM");
  n++;
  assert.throws(() => resolveReportScope(ctxMpim, "domain"), /group chat/, "resolveReportScope: domain scope refuses from a group chat");
  n++;
  assert.throws(() => resolveReportScope(ctxExternal, "domain"), /externally-shared|unconfirmed/, "resolveReportScope: domain scope refuses from an external/unconfirmed channel");
  n++;

  ok(resolveReportScope(ctxOrgAdmin, "org").org === "default", "resolveReportScope: org scope passes for an org admin");
  assert.throws(() => resolveReportScope(ctxPlainUnassigned, "org"), /org admin/i, "resolveReportScope: org scope throws a clear denial for a non-admin");
  n++;
  assert.throws(() => resolveReportScope(ctxEngAdmin, "org"), /org admin/i, "resolveReportScope: a DOMAIN admin (not org) still can't get org scope");
  n++;

  for (const reason of ["dm", "mpim", "external", "unassigned"] as const) {
    const msg = reportDomainRefusalMessage(reason);
    ok(msg.length > 0 && !msg.includes("undefined") && !/authored/.test(msg), "reportDomainRefusalMessage: a real sentence, and doesn't misleadingly talk about authoring a skill");
  }
}

{
  ok(firesPerDay({ kind: "interval", everyMinutes: 60 }) === 24, "firesPerDay: interval -> 1440/everyMinutes");
  ok(firesPerDay({ kind: "cron", expr: "0 * * * *" }) === 24, "firesPerDay: hourly cron -> 24/day");
  ok(firesPerDay({ kind: "cron", expr: "*/15 * * * *" }) === 96, "firesPerDay: every-15-min cron -> 96/day");
  ok(firesPerDay({ kind: "watch", everyMinutes: 10 }) === undefined, "firesPerDay: watch cadence unknowable for prediction (posts only on diff)");
  ok(firesPerDay({ kind: "event", source: "github" }) === undefined, "firesPerDay: event trigger unknowable (not clock-scheduled)");
  ok(firesPerDay({ kind: "cron", expr: "not a cron" }) === undefined, "firesPerDay: a malformed cron degrades to undefined, not a throw");

  const store = getOperationalStore();
  await store.addRoutine({ id: "r-a", org: "default", surfaceKey: "slack/T1/C_A", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-07-01T00:00:00Z", status: "active", consecutiveFailures: 0 });
  await store.addRoutine({ id: "r-b", org: "default", surfaceKey: "slack/T1/C_B", trigger: { kind: "interval", everyMinutes: 30 }, prompt: "x", createdAt: "2026-07-01T00:00:00Z", status: "active", consecutiveFailures: 0 });
  await store.addRoutine({ id: "r-c", org: "default", surfaceKey: "slack/T1/C_C", trigger: { kind: "watch", everyMinutes: 15 }, prompt: "x", createdAt: "2026-07-01T00:00:00Z", status: "active", consecutiveFailures: 0 });
  await store.addRoutine({ id: "r-d", org: "default", surfaceKey: "slack/T1/C_D", trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: "2026-07-01T00:00:00Z", status: "disabled", consecutiveFailures: 5 });

  const rows = [
    { surfaceKey: "slack/T1/C_A", kind: "routine", inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, events: 3, sessions: 3 },
    { surfaceKey: "slack/T1/C_B", kind: "routine", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, events: 2, sessions: 2 },
    { surfaceKey: "slack/T1/C_C", kind: "routine", inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, events: 3, sessions: 3 },
    { surfaceKey: "slack/T1/C_D", kind: "routine", inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, events: 3, sessions: 3 },
  ] as never[];

  const predictions = await buildRoutinePredictions("default", rows, { inPerMtok: 1, outPerMtok: 2 });
  const byKey = new Map(predictions.map((p) => [p.surfaceKey, p]));

  const a = byKey.get("slack/T1/C_A")!;
  ok(a.observedFires === 3 && a.avgTokensPerFire === 400, "buildRoutinePredictions: avg tokens/fire = total/observedFires");
  ok(a.cadencePerDay === 24 && a.projected !== null, "buildRoutinePredictions: an active hourly interval routine yields a 24/day cadence + a projection");
  ok(a.projected!.tokens7d === 400 * 24 * 7 && a.projected!.tokens30d === 400 * 24 * 30, "buildRoutinePredictions: 7d/30d token projections = avg * cadence * days");
  ok(a.projected!.costUsd7d !== undefined && a.projected!.costUsd30d !== undefined, "buildRoutinePredictions: $ projection present when a pricing was supplied");

  const b = byKey.get("slack/T1/C_B")!;
  ok(b.projected === null && /fewer than 3/.test(b.skippedReason ?? ""), "buildRoutinePredictions: fewer than 3 observed fires -> skipped for lack of signal, even though it has an active interval routine");

  const c = byKey.get("slack/T1/C_C")!;
  ok(c.projected === null && /cadence unknowable/.test(c.skippedReason ?? ""), "buildRoutinePredictions: a watch-only surface -> cadence unknowable, skipped");

  const d = byKey.get("slack/T1/C_D")!;
  ok(d.projected === null && /no active cron\/interval/.test(d.skippedReason ?? ""), "buildRoutinePredictions: a disabled routine doesn't count as an active cadence source");
}

{
  const rows = [
    { surfaceKey: "slack/T1/C1", principalId: "U1", kind: "channel", model: undefined, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, events: 2, sessions: 1 },
    { surfaceKey: "slack/T1/C1", principalId: "U2", kind: "channel", model: undefined, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, events: 1, sessions: 1 },
    { surfaceKey: "slack/T1/C1", kind: "sandbox", model: undefined, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, events: 1, sessions: 1 },
    { surfaceKey: "slack/T1/C2", principalId: "U1", kind: "dm", model: undefined, inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, events: 1, sessions: 1 },
  ] as never[];

  ok(approxConversationCount(rows) === 3, "approxConversationCount: sums sessions across non-sandbox rows (2 on C1 + 1 dm)");

  const byUser = aggregateByUser(rows);
  ok(byUser.length === 2, "aggregateByUser: excludes the sandbox row (no meaningful principal) and groups the rest by principalId");
  const u1 = byUser.find((u) => u.principalId === "U1")!;
  ok(u1.events === 3 && u1.inputTokens === 120, "aggregateByUser: sums events/tokens across a user's surfaces (C1 channel + C2 dm)");
  ok(byUser[0].events >= byUser[1].events, "aggregateByUser: sorted busiest-first");

  const bySurface = aggregateBySurface(rows);
  ok(bySurface.length === 2, "aggregateBySurface: one row per surface, sandbox rows excluded from the surface breakdown");
  const c1 = bySurface.find((s) => s.surfaceKey === "slack/T1/C1")!;
  ok(c1.events === 3 && c1.sessions === 2 && c1.inputTokens === 110, "aggregateBySurface: sums events/sessions/tokens across a surface's principal groups");
}

{
  const empty = await execTool(sessionCostTool)({}, ctxEng("sess-empty") as never);
  ok(empty.events === 0 && empty.inputTokens === 0 && empty.sandboxSeconds === 0 && empty.costUsd === 0, "session_cost: an empty session reports all zeros, incl. a real $0 (not a fabricated non-zero)");

  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-cost", principalId: "U1", kind: "channel", inputTokens: 1000, outputTokens: 500, ts: FIXTURE_DAY + "T09:00:00Z" });
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-cost", principalId: "U1", kind: "channel", inputTokens: 200, outputTokens: 100, ts: FIXTURE_DAY + "T09:01:00Z" });
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-cost", kind: "sandbox", detail: { sandboxSeconds: 3600 }, ts: FIXTURE_DAY + "T09:02:00Z" });

  _resetModelPricingForTest();
  _setBuiltInForTest(null);
  const populated = await execTool(sessionCostTool)({}, ctxEng("sess-cost") as never);
  ok(populated.events === 2, "session_cost: events count excludes the sandbox row");
  ok(populated.inputTokens === 1200 && populated.outputTokens === 600, "session_cost: token totals sum the non-sandbox rows");
  ok(populated.pricedModel === PRICED_MODEL && populated.costUsd !== undefined, "session_cost: auto-assumes the deploy's sole priced model");
  ok(populated.sandboxSeconds === 3600 && populated.sandboxCostUsd !== undefined && Math.abs(populated.sandboxCostUsd - 0.0848) < 1e-9, "session_cost: sandbox seconds + $ estimate from the verified rate");

  const withExplicitModel = await execTool(sessionCostTool)({ assumedModelId: "no/such-model" }, ctxEng("sess-cost") as never);
  ok(withExplicitModel.costUsd === undefined && /no configured pricing/.test(withExplicitModel.note), "session_cost: an unpriced explicit model -> no $ fabricated, explained in the note");
}

{
  await appendUsageEvent({
    org: "default",
    surfaceKey: "slack/T1/C_ENG",
    sessionId: "sess-mixed",
    principalId: "U1",
    kind: "channel",
    model: "anthropic/claude-sonnet-5",
    inputTokens: 1_000_000,
    outputTokens: 0,
    ts: FIXTURE_DAY + "T09:00:00Z",
  });
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-mixed", principalId: "U1", kind: "channel", inputTokens: 1_000_000, outputTokens: 0, ts: FIXTURE_DAY + "T09:01:00Z" });

  registerModelPricing({ "anthropic/claude-sonnet-5": { inPerMtok: 3, outPerMtok: 15 } });

  const mixed = await execTool(sessionCostTool)({ assumedModelId: PRICED_MODEL }, ctxEng("sess-mixed") as never);
  const mixedExpected = 3 + modelPricing(PRICED_MODEL)!.inPerMtok;
  ok(mixed.costUsd !== undefined && Math.abs(mixed.costUsd - mixedExpected) < 1e-9, "session_cost: mixed stamped+stampless rows sum EXACT + ASSUMED pricing, not a single blended rate");
  ok(/priced exactly by their own recorded model/.test(mixed.note) && /no recorded model/.test(mixed.note), "session_cost: note honestly describes the exact/assumed mix");

  const mixedReport = await execTool(spendReportTool)({ sinceDays: 365, scope: "domain", assumedModelId: PRICED_MODEL }, ctxEng() as never);
  const engChannel = mixedReport.bySurfaceAndKind.find((r) => r.surfaceKey === "slack/T1/C_ENG" && r.kind === "channel");
  const assumedRate = modelPricing(PRICED_MODEL)!;
  const expectedStamplessCost = (1_001_200 * assumedRate.inPerMtok + 600 * assumedRate.outPerMtok) / 1_000_000;
  const expectedExactCost = (1_000_000 * 3) / 1_000_000;
  ok(engChannel?.costUsd !== undefined && Math.abs(engChannel.costUsd - (expectedStamplessCost + expectedExactCost)) < 1e-6, "spend_report: a (surfaceKey, kind) group prices EACH underlying summary row at its own resolution, then sums — never one blended rate across a merged group");
  ok(/priced exactly by their own recorded model/.test(mixedReport.note) && /no recorded model/.test(mixedReport.note), "spend_report: note honestly describes the exact/assumed mix at rollup scope too");

  _resetModelPricingForTest();
}

{
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_OTHER", sessionId: "sess-other", principalId: "U9", kind: "channel", inputTokens: 5_000_000, outputTokens: 0, ts: FIXTURE_DAY + "T09:00:00Z" });

  const domainReport = await execTool(spendReportTool)({ sinceDays: 365, scope: "domain" }, ctxEng() as never);
  ok(domainReport.domain === "eng", "spend_report: domain scope reports the caller's own domain");
  ok(domainReport.bySurfaceAndKind.every((r) => r.surfaceKey === "slack/T1/C_ENG"), "spend_report: domain scope never leaks another domain's surface");
  ok(domainReport.ledger.period.length === 7, "spend_report: ledger continuity carries a YYYY-MM period");
  ok(Array.isArray(domainReport.routinePredictions), "spend_report: routinePredictions is present even with none in scope");

  await assert.rejects(async () => execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxPlainUnassigned as never), /org admin/i, "spend_report: org scope refuses a non-admin with a clear denial");
  n++;

  const orgReport = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  ok(orgReport.bySurfaceAndKind.some((r) => r.surfaceKey === "slack/T1/C_OTHER"), "spend_report: org scope for an org admin sees every surface, including other domains'");
  ok(orgReport.domain === undefined, "spend_report: org scope carries no domain field");

  const { getOperationalStore: getOpStore } = await import("../agent/operational/provider.js");
  const ALLOWANCE = "user:slack/T1/U_REPORTED";
  await getOpStore().setSpendLimit("default", ALLOWANCE, "user", { monthlyUsd: 9 }, { reason: "onboarding", setBy: "U_ADMIN" });
  const orgWithCaps = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  const seen = (orgWithCaps.userCaps ?? []).find((r) => r.principal === ALLOWANCE);
  ok(seen?.source === "override" && seen?.monthlyUsd === 9 && seen?.setBy === "U_ADMIN", "OPE-274: spend_report at ORG scope lists a live per-user allowance with its amount and provenance");
  ok(/userCaps lists PER-PERSON monthly allowances/.test(orgWithCaps.note), "OPE-274: …and the note says it is allowances, not spend, and that the axis is independent of the room's cap");

  const domainWithCaps = await execTool(spendReportTool)({ sinceDays: 365, scope: "domain" }, ctxEng() as never);
  ok(domainWithCaps.userCaps === undefined, "🔴 OPE-274: spend_report at DOMAIN scope omits the per-person roster entirely — 'anyone in the domain' is the wrong audience for who the org has decided what about");
  ok(/userCaps .*is omitted at domain scope on purpose/.test(domainWithCaps.note), "OPE-274: …and says so, naming the ask that does work (scope=\"org\"), rather than leaving a silent absence");
  await getOpStore().clearSpendLimit("default", ALLOWANCE, "user");
}

{
  const org = "default";
  const wsSurface = "slack/T1/C_CAPTEST";
  const currentPeriod = periodOf(new Date().toISOString());
  const store = await import("../agent/spend/store.js");
  const opStore = getOperationalStore();
  const { scopeOverBudget } = await import("../agent/spend/check.js");

  await store.recordSpend({ org, surfaceKey: wsSurface } as never, { period: currentPeriod, usage: { inputTokens: 1_000_000 }, principalId: "U_CAP", model: PRICED_MODEL });
  await store.recordSpend({ org, surfaceKey: wsSurface } as never, { period: currentPeriod, usage: { inputTokens: 9_000_000 }, principalId: "U_CAP", model: "mystery/unpriced" });

  const before = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  const rowBefore = before.ledger.surfaces.find((s) => s.surfaceKey === wsSurface);
  ok(rowBefore !== undefined, "spend_report ledger: the seeded surface appears in ledger.surfaces");
  ok(Math.abs(rowBefore!.usd - modelPricing(PRICED_MODEL)!.inPerMtok) < 1e-9, `spend_report ledger: usd sums only the priced write (1M input tokens @ the built-in input rate); the unpriced-model write contributed $0 at write time, never guessed (got ${rowBefore!.usd})`);
  ok(rowBefore!.tokens === 10_000_000, "spend_report ledger: tokens sum BOTH writes — an unpriced model's tokens still count against a token cap");
  ok(rowBefore!.tokenCap === null && rowBefore!.usdCap === null, "spend_report ledger: no cap configured anywhere -> both caps null");
  ok(rowBefore!.tokenOver === false && rowBefore!.usdOver === false && rowBefore!.over === false, "spend_report ledger: no cap -> never over");

  const wsRowBefore = before.ledger.workspaces.find((w) => w.workspaceKey === "slack/T1");
  ok(wsRowBefore !== undefined, "spend_report ledger: a workspace-level row is now present (previously the report had none)");
  ok(wsRowBefore!.usd >= rowBefore!.usd - 1e-9, "spend_report ledger: the workspace usd rolls up at least its surface's contribution");
  ok(wsRowBefore!.tokens >= rowBefore!.tokens, "spend_report ledger: the workspace tokens roll up at least its surface's contribution");

  const seededUsd = modelPricing(PRICED_MODEL)!.inPerMtok;
  const usdCap = seededUsd / 2;
  await opStore.setSpendLimit(org, wsSurface, "surface", { monthlyUsd: usdCap }, { reason: "test bridge", setBy: "tester" });
  const gateVerdict = await scopeOverBudget(
    { org, platform: "slack", workspace: "T1", surface: "C_CAPTEST", workspaceKey: "slack/T1", surfaceKey: wsSurface, key: wsSurface } as never,
    "channel",
    new Date().toISOString(),
  );
  ok(gateVerdict.over === true, "sanity: the gate itself refuses this scope once the override is active");

  const afterOverride = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  const rowAfter = afterOverride.ledger.surfaces.find((s) => s.surfaceKey === wsSurface);
  ok(rowAfter!.usdCap === usdCap, "spend_report ledger: an ACTIVE override changes the shown cap (was null, now the override's)");
  ok(rowAfter!.usdOver === true && rowAfter!.over === true, "spend_report ledger: with the override active the report shows over — the SAME verdict as the gate (report == gate)");
  ok(Math.abs(rowAfter!.usd - rowBefore!.usd) < 1e-9, "spend_report ledger: the override changes the CAP shown, never the observed spend figure itself");

  await opStore.clearSpendLimit(org, wsSurface, "surface");
  const afterClear = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  const rowCleared = afterClear.ledger.surfaces.find((s) => s.surfaceKey === wsSurface);
  ok(rowCleared!.usdCap === null && rowCleared!.usdOver === false, "spend_report ledger: clearing the override reverts to the (uncapped) config baseline, same as the gate would");

  const [curYear, curMonth1Indexed] = currentPeriod.split("-").map(Number);
  const prevDate = new Date(Date.UTC(curYear, curMonth1Indexed - 1, 1));
  prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
  const prevPeriod = prevDate.toISOString().slice(0, 7);
  await store.recordSpend({ org, surfaceKey: wsSurface } as never, { period: prevPeriod, usage: { inputTokens: 2_000_000 }, principalId: "U_CAP", model: PRICED_MODEL });
  const prevReport = await execTool(spendReportTool)({ sinceDays: 365, scope: "org", period: prevPeriod }, ctxOrgAdmin as never);
  const prevRow = prevReport.ledger.surfaces.find((s) => s.surfaceKey === wsSurface);
  ok(prevReport.ledger.period === prevPeriod, "spend_report ledger: an explicit past period is honoured");
  ok(prevRow!.tokens === 2_000_000, "spend_report ledger: a past period's tokens come from THAT month's ledger rows, not the current one");
  const prevExpected = 2 * modelPricing(PRICED_MODEL)!.inPerMtok;
  ok(Math.abs(prevRow!.usd - prevExpected) < 1e-9, `spend_report ledger: a past period's usd is THAT calendar month's ledger sum (2,000,000 in-tokens at the built-in input rate = $${prevExpected}, got ${prevRow!.usd})`);
}

{
  const org = "default";
  const currentPeriod = periodOf(new Date().toISOString());
  const dmA = "slack/T1/D0CAPAAAAAA";
  const dmB = "slack/T1/D0CAPBBBBBB";
  const store = await import("../agent/spend/store.js");
  const opStore = getOperationalStore();

  await store.recordSpend({ org, surfaceKey: dmA } as never, { period: currentPeriod, usage: { inputTokens: 1_000_000 }, principalId: "U_DM_A", model: PRICED_MODEL });
  await store.recordSpend({ org, surfaceKey: dmB } as never, { period: currentPeriod, usage: { inputTokens: 500_000 }, principalId: "U_DM_B", model: PRICED_MODEL });

  await opStore.setSpendLimit(org, dmA, "surface", { monthlyUsd: modelPricing(PRICED_MODEL)!.inPerMtok / 2 }, { reason: "test", setBy: "tester" });

  const report = await execTool(spendReportTool)({ sinceDays: 365, scope: "org" }, ctxOrgAdmin as never);
  const dmBucket = report.ledger.surfaces.find((s) => s.surfaceKey === "slack/T1/(dms)");
  ok(dmBucket !== undefined, "spend_report ledger: DM ledger rows fold into the (dms) bucket");
  ok(dmBucket!.usdCap === null && dmBucket!.tokenCap === null, "spend_report ledger: the (dms) bucket hides per-DM caps as null (a shared bucket has no single cap)");
  ok(dmBucket!.usdOver === true && dmBucket!.over === true, "spend_report ledger: the (dms) bucket still surfaces `over`/`usdOver` when ANY member DM breached its own cap — never masked into silence");
  ok(
    !report.ledger.surfaces.some((s) => s.surfaceKey === dmA || s.surfaceKey === dmB),
    "spend_report ledger: individual DM surfaces are never listed, even when one of them is over budget",
  );

  await opStore.clearSpendLimit(org, dmA, "surface");
}

{
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-u1", principalId: "U_A", kind: "channel", inputTokens: 10, outputTokens: 5, ts: FIXTURE_DAY + "T09:00:00Z" });
  await appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C_ENG", sessionId: "sess-u2", principalId: "U_B", kind: "channel", inputTokens: 20, outputTokens: 10, ts: FIXTURE_DAY + "T09:00:00Z" });

  const report = await execTool(usageReportTool)({ sinceDays: 365, scope: "domain" }, ctxEng() as never);
  ok(report.domain === "eng", "usage_report: domain scope reports the caller's own domain");
  ok(report.turns > 0, "usage_report: turns is a positive exact count");
  ok(report.byUser.some((u) => u.principalId === "U_A") && report.byUser.some((u) => u.principalId === "U_B"), "usage_report: per-user breakdown includes each distinct sender");
  ok(report.busiestSurfaces.every((s) => s.surfaceKey === "slack/T1/C_ENG"), "usage_report: domain scope stays within the resolved domain's surfaces");
  ok(/approximation/.test(report.note), "usage_report: the conversations-estimate caveat is surfaced in the note");

  await assert.rejects(async () => execTool(usageReportTool)({ sinceDays: 365, scope: "org" }, ctxPlainUnassigned as never), /org admin/i, "usage_report: org scope refuses a non-admin");
  n++;
}

{
  ok(slackUserIdIn("U0EXOWNER") === "U0EXOWNER", "labels: bare slack member id recognised");
  ok(slackUserIdIn("slack:T0EXAMPLE:U0EXOWNER") === "U0EXOWNER", "labels: composite slack:T:U principal -> member id");
  ok(slackUserIdIn("slack:T0EXAMPLE:bot:U0BOT001") === "U0BOT001", "labels: bot principal -> member id (last segment)");
  ok(slackUserIdIn("eve:app") === undefined, "labels: non-slack principal (eve:app) unrecognised");
  ok(slackChannelIdIn("slack/T1/C123ABC") === "C123ABC", "labels: slack surface key -> channel id");
  ok(slackChannelIdIn("teams/T1/C123ABC") === undefined, "labels: non-slack surface key unrecognised");
  ok(slackChannelIdIn("slack/T1") === undefined, "labels: workspace-level key has no channel id");

  const labels = await resolveSlackLabels(
    ["U0EXOWNER", "eve:app", "U0EXOWNER"],
    ["slack/T1/C123ABC", "slack/T1/D123ABC"],
    {
      userName: async (id) => (id === "U0EXOWNER" ? "Rowan Hale" : undefined),
      channelName: async (id) => (id === "C123ABC" ? "test-channel" : undefined),
    },
  );
  ok(labels.users.get("U0EXOWNER") === "Rowan Hale", "labels: resolved user name keyed by the ORIGINAL principal id");
  ok(!labels.users.has("eve:app"), "labels: unresolvable principal stays unlabelled");
  ok(labels.channels.get("slack/T1/C123ABC") === "#test-channel", "labels: channel name rendered as #name, keyed by surface key");
  ok(!labels.channels.has("slack/T1/D123ABC"), "labels: DM surface never looked up (no conversations.info name)");

  const failing = await resolveSlackLabels(["U0EXOWNER"], ["slack/T1/C123ABC"], {
    userName: async () => {
      throw new Error("api down");
    },
    channelName: async () => undefined,
  });
  ok(failing.users.size === 0 && failing.channels.size === 0, "labels: lookup failures -> silently unlabelled, never a throw");
}

{
  ok(isDmSurface("slack/T1/D0EXDMCH001") === true, "dm-mask: slack D-prefixed surface id recognised without a kind");
  ok(isDmSurface("slack/T1/C123ABC") === false, "dm-mask: a channel surface is not a DM");
  ok(isDmSurface("teams/T1/19-something", "dm") === true, "dm-mask: kind=dm marks a DM on ANY platform (ledger-less rows aside)");
  ok(isDmSurface("slack/T1/C123ABC", "channel") === false, "dm-mask: kind=channel never masks");
  ok(dmBucketKey("slack/T1/D0EXDMCH001") === "slack/T1/(dms)", "dm-mask: bucket key keeps platform/workspace, drops the DM id");

  const dmRow = { surfaceKey: "slack/T1/D0EXDMCH001", kind: "dm", events: 4 };
  const chRow = { surfaceKey: "slack/T1/C123ABC", kind: "channel", events: 2 };
  ok(maskDmSurfaceKey(dmRow).surfaceKey === "slack/T1/(dms)", "dm-mask: a DM row's surfaceKey is rewritten to the bucket");
  ok(maskDmSurfaceKey(chRow) === chRow, "dm-mask: a non-DM row passes through as the SAME object");

  const aggregated = aggregateBySurface(
    [
      { surfaceKey: "slack/T1/D0AAA11AAAA", principalId: "U_A", kind: "dm", model: null, events: 2, sessions: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { surfaceKey: "slack/T1/D0BBB22BBBB", principalId: "U_B", kind: "dm", model: null, events: 3, sessions: 1, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ].map(maskDmSurfaceKey) as never,
  );
  ok(aggregated.length === 1 && aggregated[0].surfaceKey === "slack/T1/(dms)" && aggregated[0].events === 5, "dm-mask: two distinct DMs aggregate into one (dms) bucket row");
}

console.log(`✓ reporting: ${n} assertions passed (pricing/sandbox-pricing additions, reporting.ts shared plumbing incl. display labels + DM masking, session_cost/spend_report/usage_report tools)`);
