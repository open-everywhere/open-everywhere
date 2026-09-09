import "./_register-test-config.js";
import assert from "node:assert/strict";
import { spendView, routinesView, auditView, accessView, usageSummaryView, usageWindowView, skillsListView, skillRevisionsView, overridesView } from "../agent/control/views.js";
import { buildControlServer, CONTROL_TOOL_NAMES } from "../agent/control/server.js";
import { resolveAccess } from "../agent/access/resolver.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { getConfig, registerConfig } from "../agent/access/config.js";
import { appendUsageEvent } from "../agent/spend/usage-events.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { builtInModelIds, modelPricing } from "../agent/spend/pricing.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import type { TranscriptExportRequest } from "../agent/control/transcript-export.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("control");

const PRICED_MODEL = builtInModelIds()[0];

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const spend = await spendView();
ok("spendView has a period", /^\d{4}-\d{2}$/.test(spend.period));
ok("spendView surfaces is an array", Array.isArray(spend.surfaces));
ok("spendView workspaces is an array", Array.isArray(spend.workspaces));
ok("spendView is JSON-serialisable", typeof JSON.stringify(spend) === "string");
ok(
  "spendView: surface rows carry the tokenCap/tokenOver/usd/usdCap/usdOver/over shape",
  spend.surfaces.every((s) => "tokenCap" in s && "tokenOver" in s && "usd" in s && "usdCap" in s && "usdOver" in s && "over" in s),
);
ok(
  "spendView: workspace rows carry the same shape",
  spend.workspaces.every((w) => "tokenCap" in w && "tokenOver" in w && "usd" in w && "usdCap" in w && "usdOver" in w && "over" in w),
);

const spend2 = await spendView("2020-01");
ok("spendView honours an explicit period", spend2.period === "2020-01");

const routines = await routinesView();
ok("routinesView reports a total", typeof routines.total === "number");
ok("routinesView routines is an array", Array.isArray(routines.routines));
const due = await routinesView({ onlyDue: true });
ok("routinesView --due reports dueCount", typeof due.dueCount === "number");
ok("routinesView --due never exceeds total", due.routines.length <= routines.total);

const audit = await auditView({ limit: 5 });
ok("auditView entries is an array", Array.isArray(audit.entries));
ok("auditView respects the limit", audit.entries.length <= 5);
ok("auditView echoes the resolved filter limit", audit.filter.limit === 5);

const access = await accessView({ platform: "local", workspace: "dev", channel: "default" });
ok("accessView resolves a scopeKey", typeof access.scopeKey === "string" && access.scopeKey.length > 0);
ok("accessView connectors is an array", Array.isArray(access.connectors));

{
  const saved = getConfig();
  const SURFACE = "slack/T-TEST/C-CONNECTOR";
  const catalogue = [
    {
      connector: "notion",
      allows: ["service-oauth"] as const,
      credentials: [{ id: "service-oauth", type: "service-oauth" as const, endpoints: { hosts: ["mcp.notion.com"] } }],
    },
  ];
  registerConfig({
    ...saved,
    loadBundles: () => [defineBundle({ name: "connector-fixture", connectors: [{ name: "notion", credential: "service-oauth" }] })],
    loadBindings: () => [defineBinding({ bundle: "connector-fixture", scope: { level: "surface", surface: SURFACE } })],
    loadConnectorCredentials: () => catalogue,
  });
  try {
    const [platform, workspace, channel] = SURFACE.split("/") as [string, string, string];
    const q = { platform, workspace, channel };
    const req = { mode: "channel" as const, platform, workspace, channel, domains: [] };
    const cfg = getConfig();

    const withoutCatalogue = resolveAccess(req, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry);
    ok("the credential catalogue is load-bearing: omitting it empties the resolver's connector list", withoutCatalogue.connectors.length === 0);

    const oracle = resolveAccess(req, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry, cfg.loadConnectorCredentials?.() ?? []);
    ok("…and passing it resolves the granted connector", oracle.connectors.length > 0);

    const view = await accessView(q);
    assert.deepEqual(
      view.connectors,
      oracle.connectors,
      "accessView must report the resolver's own connector list — dropping the credential catalogue silently empties it",
    );
    n++;
    ok("…so access_preview reports a non-empty connector list for a surface that reaches one", view.connectors.length > 0);
  } finally {
    registerConfig(saved);
  }
}
for (const c of access.connections) {
  ok(`connection ${c.id} exposes only a secretRef name, never a value`, !("secret" in c) && !("token" in c) && !("authorization" in c));
}

const CTL_ORG = `ctl-test-${process.pid}-${Date.now()}`;
_setDeploymentIdentityForTest({ org: CTL_ORG });
{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const domains = [defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"] })];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  await appendUsageEvent({ org: CTL_ORG, surfaceKey: "slack/T1/C_ENG", sessionId: "s1", principalId: "U1", kind: "channel", inputTokens: 1000, outputTokens: 500 });
  await appendUsageEvent({ org: CTL_ORG, surfaceKey: "slack/T1/C_OTHER", sessionId: "s2", principalId: "U2", kind: "channel", inputTokens: 10, outputTokens: 5 });
  await getOperationalStore().putDomainSkill(CTL_ORG, "eng", "runbook", "# Steps", "U1", "2026-07-04T10:00:00Z");
  await getOperationalStore().putDomainSkill(CTL_ORG, "eng", "runbook", "# Steps v2", "U1", "2026-07-04T11:00:00Z", {
    armedBy: "U2",
    approvalId: "pa-runbook-v2",
  });

  const usageAll = await usageSummaryView({ org: CTL_ORG });
  ok("usageSummaryView (unscoped): sees every surface", usageAll.rows.some((r) => r.surfaceKey === "slack/T1/C_ENG") && usageAll.rows.some((r) => r.surfaceKey === "slack/T1/C_OTHER"));
  ok("usageSummaryView: prices with the deploy's sole configured model by default", usageAll.pricedModel === PRICED_MODEL && usageAll.rows.every((r) => typeof r.costUsd === "number"));

  const usageDomain = await usageSummaryView({ org: CTL_ORG, domain: "eng" });
  ok("usageSummaryView (domain-scoped): only the domain's surfaces", usageDomain.rows.every((r) => r.surfaceKey === "slack/T1/C_ENG"));

  ok("usageSummaryView: routinePredictions is present (empty) when there's no routine-kind usage", Array.isArray(usageAll.routinePredictions) && usageAll.routinePredictions.length === 0);

  await appendUsageEvent({ org: CTL_ORG, surfaceKey: "slack/T1/C_ENG", sessionId: "r1", principalId: "U1", kind: "routine", inputTokens: 100, outputTokens: 50 });
  const usageWithRoutine = await usageSummaryView({ org: CTL_ORG, domain: "eng" });
  const pred = usageWithRoutine.routinePredictions.find((p) => p.surfaceKey === "slack/T1/C_ENG");
  ok("usageSummaryView: routine-kind usage yields a prediction row for its surface", pred !== undefined);
  ok(
    "usageSummaryView: fewer than 3 observed fires -> skippedReason, projected stays null (no fabricated projection)",
    pred?.projected === null && /fewer than 3/.test(pred?.skippedReason ?? ""),
  );

  const skills = await skillsListView({ org: CTL_ORG, domain: "eng" });
  ok("skillsListView: returns the domain's runtime-authored skills", skills.skills.length === 1 && skills.skills[0].name === "runbook");

  const revs = await skillRevisionsView({ org: CTL_ORG, domain: "eng", name: "runbook" });
  ok("skillRevisionsView: returns both recorded bodies for the named skill", revs.revisions.length === 2);
  ok("skillRevisionsView: newest first — the v2 edit leads, not the first write", revs.revisions[0].content === "# Steps v2" && revs.revisions[1].content === "# Steps");
  ok(
    "skillRevisionsView: the join columns survive — approvalId + armedBy on the row that carried provenance",
    revs.revisions[0].approvalId === "pa-runbook-v2" && revs.revisions[0].armedBy === "U2",
  );
  ok("skillRevisionsView: the first write (no provenance passed) carries neither armedBy nor approvalId", revs.revisions[1].armedBy === undefined && revs.revisions[1].approvalId === undefined);
  ok("skillRevisionsView: nothing truncated — capped is false when limit >= the row count", revs.capped === false);

  const revsLimited = await skillRevisionsView({ org: CTL_ORG, domain: "eng", name: "runbook", limit: 1 });
  ok("skillRevisionsView: limit clamps the row count and still returns the newest", revsLimited.revisions.length === 1 && revsLimited.revisions[0].content === "# Steps v2");
  ok("skillRevisionsView: capped is true once the row count exceeds limit", revsLimited.capped === true);

  const revsOtherDomain = await skillRevisionsView({ org: CTL_ORG, domain: "watercooler", name: "runbook" });
  ok("skillRevisionsView: a domain with no such skill's revisions returns empty, not a throw", revsOtherDomain.revisions.length === 0 && revsOtherDomain.capped === false);

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const callJson = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as { type: string; text: string }[])[0].text);
  };

  const engServer = buildControlServer({ roles: ["domain:eng"] });
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await engServer.connect(s1);
  const engClient = new Client({ name: "eng-role", version: "0" });
  await engClient.connect(c1);

  const okDomain = await callJson(engClient, "usage_summary", { org: CTL_ORG, domain: "eng" });
  ok("usage_summary: a domain:eng role can read its own domain", Array.isArray(okDomain.rows));
  const deniedOrgWide = await engClient.callTool({ name: "usage_summary", arguments: { org: CTL_ORG } });
  ok("usage_summary: a domain:eng role is denied an unscoped, org-wide call", deniedOrgWide.isError === true);
  const deniedOtherSurface = await engClient.callTool({ name: "usage_summary", arguments: { org: CTL_ORG, surfaceKey: "slack/T1/C_OTHER" } });
  ok("usage_summary: a domain:eng role is denied a surface outside its domain", deniedOtherSurface.isError === true);
  const skillsOk = await callJson(engClient, "skills_list", { org: CTL_ORG, domain: "eng" });
  ok("skills_list: a domain:eng role can list its own domain's skills", skillsOk.skills.length === 1);
  const skillsDenied = await engClient.callTool({ name: "skills_list", arguments: { org: CTL_ORG, domain: "other" } });
  ok("skills_list: a domain:eng role is denied a different domain", skillsDenied.isError === true);
  const revisionsOk = await callJson(engClient, "skill_revisions", { org: CTL_ORG, domain: "eng", name: "runbook" });
  ok("skill_revisions: a domain:eng role can read its own domain's skill history, bodies included", revisionsOk.revisions.length === 2 && revisionsOk.revisions[0].content === "# Steps v2");
  const revisionsDenied = await engClient.callTool({ name: "skill_revisions", arguments: { org: CTL_ORG, domain: "other", name: "runbook" } });
  ok("skill_revisions: a domain:eng role is denied a different domain's skill history — the same gate as skills_list, proven, not assumed", revisionsDenied.isError === true);
  const uwDenied = await engClient.callTool({ name: "usage_window", arguments: { sinceIso: "2026-01-01T00:00:00Z", workspaceKeys: ["slack/T1"] } });
  ok("usage_window: a domain:eng role is denied (org-wide read — admin only, same posture as overrides_list)", uwDenied.isError === true);

  await engClient.close();
}

{
  const store = await import("../agent/spend/store.js");
  const opStore = getOperationalStore();
  const surfaceKey = "slack/T1/C_CTLCAP";
  const nowISO = new Date().toISOString();
  const period = nowISO.slice(0, 7);

  await store.recordSpend({ org: CTL_ORG, surfaceKey } as never, { period, usage: { inputTokens: 1_000_000 }, model: PRICED_MODEL });

  const spendBefore = await spendView(period);
  const rowBefore = spendBefore.surfaces.find((s) => s.org === CTL_ORG && s.surfaceKey === surfaceKey);
  ok("spendView: the seeded surface appears in this period's surfaces", rowBefore !== undefined);
  ok("spendView: usd is rendered and matches the priced row (1M input tokens @ the built-in input rate)", Math.abs((rowBefore?.usd ?? -1) - modelPricing(PRICED_MODEL)!.inPerMtok) < 1e-9);
  ok("spendView: no cap configured anywhere -> both caps null, never over", rowBefore?.tokenCap === null && rowBefore?.usdCap === null && rowBefore?.over === false);

  const wsRowBefore = spendBefore.workspaces.find((w) => w.key === `${CTL_ORG}/slack/T1`);
  ok("spendView: a workspace row exists for the seeded org/workspace", wsRowBefore !== undefined);
  ok("spendView: workspace usd rolls up at least the surface's contribution", (wsRowBefore?.usd ?? 0) >= modelPricing(PRICED_MODEL)!.inPerMtok - 1e-9);

  const ctlUsdCap = modelPricing(PRICED_MODEL)!.inPerMtok / 2;
  await opStore.setSpendLimit(CTL_ORG, surfaceKey, "surface", { monthlyUsd: ctlUsdCap }, { reason: "test", setBy: "tester" });
  const spendAfter = await spendView(period);
  const rowAfter = spendAfter.surfaces.find((s) => s.org === CTL_ORG && s.surfaceKey === surfaceKey);
  ok("spendView: an ACTIVE override changes the shown usd cap (report == gate)", rowAfter?.usdCap === ctlUsdCap);
  ok("spendView: with the override active, the surface shows over", rowAfter?.usdOver === true && rowAfter?.over === true);

  await opStore.clearSpendLimit(CTL_ORG, surfaceKey, "surface");
  const spendCleared = await spendView(period);
  const rowCleared = spendCleared.surfaces.find((s) => s.org === CTL_ORG && s.surfaceKey === surfaceKey);
  ok("spendView: clearing the override reverts to the (uncapped) config baseline", rowCleared?.usdCap === null && rowCleared?.usdOver === false);

  ok("OPE-274: spendView carries a userCaps section keyed by org", typeof spendCleared.userCaps === "object" && spendCleared.userCaps !== null);
  ok("OPE-274: an org with nothing declared reports an empty list, not an absent key (a readable 'no', not an absence to interpret)", Array.isArray(spendCleared.userCaps[CTL_ORG]) && spendCleared.userCaps[CTL_ORG].length === 0);

  const ALLOWANCE_SCOPE = "user:slack/T1/U_CTL_PERSON";
  await opStore.setSpendLimit(CTL_ORG, ALLOWANCE_SCOPE, "user", { monthlyUsd: 12.5 }, { reason: "sprint headroom", setBy: "tester" });
  const withUser = await spendView(period);
  const allowance = (withUser.userCaps[CTL_ORG] ?? []).find((r) => r.principal === ALLOWANCE_SCOPE);
  ok("OPE-274: a live per-user override appears in spendView with its amount, source and provenance", allowance?.source === "override" && allowance?.monthlyUsd === 12.5 && allowance?.setBy === "tester" && allowance?.reason === "sprint headroom");
  ok("OPE-274: …and it is NOT folded into a surface row — a person's allowance never poses as a place's cap", !withUser.surfaces.some((s) => s.surfaceKey === ALLOWANCE_SCOPE));

  const drift = await overridesView(CTL_ORG);
  const driftRow = drift.spend.find((r) => r.scopeKey === ALLOWANCE_SCOPE);
  ok("OPE-274: overridesView carries the user-level row with its level", driftRow?.level === "user");
  ok("OPE-274: …and its reconcile instruction names the perUser registry", /perUser\.overrides/.test(drift.note));

  await opStore.clearSpendLimit(CTL_ORG, ALLOWANCE_SCOPE, "user");
}

{
  const UW_ORG = `uw-test-${process.pid}-${Date.now()}`;
  const t0 = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u1", principalId: "U1", kind: "channel", inputTokens: 1000, outputTokens: 500, model: PRICED_MODEL, ts: iso(t0) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u2", principalId: "U2", kind: "channel", inputTokens: 1000, outputTokens: 500, model: PRICED_MODEL, ts: iso(t0 + 1000) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u3", principalId: "U1", kind: "channel", inputTokens: 100, outputTokens: 10, model: "mystery/unpriced-9b", ts: iso(t0 + 2000) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u4", principalId: "U1", kind: "channel", inputTokens: 50, outputTokens: 5, ts: iso(t0 + 3000) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "discord/G1/CH1", sessionId: "u5", kind: "channel", inputTokens: 2000, outputTokens: 1000, model: PRICED_MODEL, ts: iso(t0 + 4000) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u0", principalId: "U1", kind: "channel", inputTokens: 999999, outputTokens: 999999, model: PRICED_MODEL, ts: iso(t0 - 86400e3) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TOTHER/C9", sessionId: "u6", kind: "channel", inputTokens: 777, outputTokens: 77, model: PRICED_MODEL, ts: iso(t0 + 5000) });

  const view = await usageWindowView({ org: UW_ORG, sinceIso: iso(t0 - 1000), workspaceKeys: ["slack/TW1", "discord/G1", "slack/TW1"] });
  const pricedRow = view.rows.find((r) => r.surfaceKey === "slack/TW1/C1" && r.model === PRICED_MODEL);
  ok("usage_window: groups to (surface, model), summing calls/tokens across principals", pricedRow?.calls === 2 && pricedRow?.inputTokens === 2000 && pricedRow?.outputTokens === 1000);
  const uwRate = modelPricing(PRICED_MODEL)!;
  const uwExpected = (2000 * uwRate.inPerMtok + 1000 * uwRate.outPerMtok) / 1_000_000;
  ok("usage_window: priced row carries the exact estimate at its own stamped model's rate", Math.abs((pricedRow?.estimatedUsd ?? 0) - uwExpected) < 1e-12);
  const mysteryRow = view.rows.find((r) => r.model === "mystery/unpriced-9b");
  ok("usage_window: unpriced model -> tokens shown, estimatedUsd OMITTED (never guessed)", mysteryRow !== undefined && !("estimatedUsd" in mysteryRow) && mysteryRow.inputTokens === 100);
  ok("usage_window: unpricedModels names the unpriced model", view.unpricedModels.includes("mystery/unpriced-9b"));
  const unstamped = view.rows.find((r) => r.surfaceKey === "slack/TW1/C1" && r.model === undefined);
  ok("usage_window: unstamped row -> tokens only, bucketed as (unstamped), NO assumed-model fallback", unstamped !== undefined && !("estimatedUsd" in unstamped) && view.unpricedModels.includes("(unstamped)"));
  const discordRow = view.rows.find((r) => r.surfaceKey === "discord/G1/CH1");
  ok("usage_window: every requested workspace contributes", discordRow?.calls === 1 && Math.abs((discordRow?.estimatedUsd ?? 0) - uwExpected) < 1e-12);
  ok("usage_window: totalUsd sums ONLY the priced rows (honest partial)", Math.abs(view.totalUsd - 2 * uwExpected) < 1e-12);
  ok("usage_window: rows older than sinceIso are excluded", !view.rows.some((r) => r.inputTokens > 100000));
  ok("usage_window: an unrequested workspace is excluded", !view.rows.some((r) => r.surfaceKey.startsWith("slack/TOTHER")));
  ok("usage_window: duplicate workspaceKeys are deduped (no double count)", view.workspaceKeys.length === 2);
  ok("usage_window: since echoes the normalised ISO actually filtered on", view.since === iso(t0 - 1000));

  const throws = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };
  ok("usage_window: unparseable sinceIso is refused", await throws(() => usageWindowView({ org: UW_ORG, sinceIso: "not-a-time", workspaceKeys: ["slack/TW1"] })));
  ok("usage_window: empty workspaceKeys is refused", await throws(() => usageWindowView({ org: UW_ORG, sinceIso: iso(t0), workspaceKeys: [] })));
  ok("usage_window: a surface-grain key (3 segments) is refused", await throws(() => usageWindowView({ org: UW_ORG, sinceIso: iso(t0), workspaceKeys: ["slack/TW1/C1"] })));
  ok("usage_window: a bare platform (1 segment) is refused", await throws(() => usageWindowView({ org: UW_ORG, sinceIso: iso(t0), workspaceKeys: ["slack"] })));

  const lateFlushWindowStart = iso(t0 - 1000);
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u-late-flush", principalId: "U1", kind: "channel", inputTokens: 42, outputTokens: 4, model: PRICED_MODEL, ts: iso(t0 - 5000) });
  await appendUsageEvent({ org: UW_ORG, surfaceKey: "slack/TW1/C1", sessionId: "u-late-flush", principalId: "U1", kind: "channel", inputTokens: 8, outputTokens: 1, model: PRICED_MODEL, ts: iso(t0 + 6000) });

  const viewWithoutBound = await usageWindowView({ org: UW_ORG, sinceIso: lateFlushWindowStart, workspaceKeys: ["slack/TW1"] });
  const lateFlushRow = viewWithoutBound.rows.find((r) => r.surfaceKey === "slack/TW1/C1" && r.model === PRICED_MODEL);
  ok("OPE-402: absent sessionStartedAfter, a late-flushing write from a pre-window session still counts (today's unchanged behaviour)", lateFlushRow?.calls === 3);
  ok("OPE-402: …and sessionStartedAfter is absent from the result when the query didn't carry one", !("sessionStartedAfter" in viewWithoutBound));

  const viewWithBound = await usageWindowView({ org: UW_ORG, sinceIso: lateFlushWindowStart, workspaceKeys: ["slack/TW1"], sessionStartedAfter: lateFlushWindowStart });
  const boundedRow = viewWithBound.rows.find((r) => r.surfaceKey === "slack/TW1/C1" && r.model === PRICED_MODEL);
  ok("OPE-402: with sessionStartedAfter set, the late-flusher's session is excluded wholesale (leak closed)", boundedRow?.calls === 2);
  ok("OPE-402: sessionStartedAfter echoes the normalised bound actually applied", viewWithBound.sessionStartedAfter === lateFlushWindowStart);
  ok("OPE-402: unparseable sessionStartedAfter is refused, same as sinceIso", await throws(() => usageWindowView({ org: UW_ORG, sinceIso: iso(t0), workspaceKeys: ["slack/TW1"], sessionStartedAfter: "not-a-time" })));

  ok("OPE-1622: no bound in the query → NO excluded block (its absence means 'no bound applied', never 'nothing excluded')", viewWithoutBound.excluded === undefined);
  ok("OPE-1622: 🔴 with the bound applied, the read REPORTS the excluded slice rather than only shrinking the total", viewWithBound.excluded !== undefined);
  ok("OPE-1622: …and counts the rows it removed exactly — one in-window write from the pre-window session", viewWithBound.excluded?.calls === 1);
  ok("OPE-1622: …naming WHICH surface's total is short, which is the question a $0.0000 leaves unanswered", viewWithBound.excluded?.surfaceKeys.join(",") === "slack/TW1/C1");
  ok("OPE-1622: …with the excluded session count as an upper bound beside it", viewWithBound.excluded?.sessionsUpperBound === 1);
  const unboundedTotal = viewWithoutBound.totalUsd;
  ok(
    "OPE-1622: 🔴 excluded.estimatedUsd is real money, priced the same way the included rows are — included + excluded reconciles to the unbounded total",
    (viewWithBound.excluded?.estimatedUsd ?? 0) > 0 && Math.abs(viewWithBound.totalUsd + (viewWithBound.excluded?.estimatedUsd ?? 0) - unboundedTotal) < 1e-12,
  );
  ok("OPE-1622: …and names no unpriced model, because the excluded rows carry a priced one", viewWithBound.excluded?.unpricedModels.length === 0);

  const nothingExcluded = await usageWindowView({ org: UW_ORG, sinceIso: lateFlushWindowStart, workspaceKeys: ["slack/TW1"], sessionStartedAfter: iso(t0 - 999999) });
  ok("OPE-1622 CONTROL: a bound before every session's first row excludes NOTHING — a reported zero, not an absent block", nothingExcluded.excluded?.calls === 0 && nothingExcluded.excluded?.surfaceKeys.length === 0);
  ok("OPE-1622 CONTROL: …and the total is then the unbounded one, so the excluded slice really was empty", Math.abs(nothingExcluded.totalUsd - unboundedTotal) < 1e-12);
}

{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { TranscriptExportError, TRANSCRIPT_EXPORT_DEFAULT_LIMIT } = await import("../agent/control/transcript-export.js");

  type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

  const call = async (
    build: Parameters<typeof buildControlServer>[0],
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const srv = buildControlServer(build);
    await srv.connect(serverTransport);
    const client = new Client({ name: "control-test", version: "0" });
    await client.connect(clientTransport);
    try {
      return (await client.callTool({ name: "session_transcript", arguments: args })) as unknown as ToolResult;
    } finally {
      await client.close();
      await srv.close();
    }
  };

  const seen: TranscriptExportRequest[] = [];
  const reader = async (req: TranscriptExportRequest) => {
    seen.push(req);
    return { sessionId: req.sessionId, startIndex: req.startIndex, nextIndex: req.startIndex + 2, complete: true, eventCount: 2, text: "03:00:01 [said] hello" };
  };

  const okRes = await call({ readTranscript: reader }, { sessionId: "wrun_abc" });
  ok("session_transcript: an admin call succeeds", okRes.isError !== true);
  ok("session_transcript: the answer is the rendered transcript, not JSON", okRes.content[0].text.includes("[said] hello") && !okRes.content[0].text.trimStart().startsWith("{"));
  ok("session_transcript: the banner names the session and its completeness", okRes.content[0].text.includes("session wrun_abc") && okRes.content[0].text.includes("complete"));
  ok("session_transcript: the untrusted banner rides every answer", okRes.content[0].text.includes("UNTRUSTED CONTENT"));
  ok("session_transcript: paging defaults come from the module's constants", seen.length === 1 && seen[0].startIndex === 0 && seen[0].limit === TRANSCRIPT_EXPORT_DEFAULT_LIMIT);

  await call({ readTranscript: reader }, { sessionId: "wrun_abc", startIndex: 40, limit: 7 });
  ok("session_transcript: explicit paging reaches the reader", seen.length === 2 && seen[1].startIndex === 40 && seen[1].limit === 7);

  const before = seen.length;
  const denied = await call({ roles: ["domain:eng"], readTranscript: reader }, { sessionId: "wrun_abc" });
  ok("session_transcript: a domain-scoped role is REFUSED", denied.isError === true && /forbidden/.test(denied.content[0].text));
  ok("🔴 session_transcript: the refusal happens BEFORE the read — the reader is never called", seen.length === before);

  const deniedUnconfigured = await call({ roles: ["viewer"] }, { sessionId: "wrun_abc" });
  ok(
    "session_transcript: an unauthorised caller on an UNCONFIGURED mount still gets the denial, never the configuration hint",
    deniedUnconfigured.isError === true && /forbidden/.test(deniedUnconfigured.content[0].text) && !/OE_DEPLOY_CONTROL_TOKEN/.test(deniedUnconfigured.content[0].text),
  );

  const unconfigured = await call({}, { sessionId: "wrun_abc" });
  ok(
    "session_transcript: an unconfigured mount names the env an operator must set",
    unconfigured.isError === true && /OE_DEPLOY_CONTROL_TOKEN/.test(unconfigured.content[0].text) && /E2E_TARGET_URL/.test(unconfigured.content[0].text),
  );

  const failing = await call(
    {
      readTranscript: async () => {
        throw new TranscriptExportError("the deployment refused this process's control-read token (401).");
      },
    },
    { sessionId: "wrun_abc" },
  );
  ok("session_transcript: a reader failure surfaces as a tool error with its own message", failing.isError === true && /refused this process's control-read token/.test(failing.content[0].text));
}

const server = buildControlServer();
const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
const registered = Object.keys(reg).sort();
ok("server exposes the declared tool names", JSON.stringify(registered) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
ok("no mutating tool leaked into slice 1", !registered.some((t) => /set|grant|revoke|cancel|create|update|delete|rotate/.test(t)));

console.log(`\n✓ control surface: ${n} assertions passed (${registered.length} tools: ${registered.join(", ")})\n`);
