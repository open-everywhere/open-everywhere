import "./_register-test-config.js";
import assert from "node:assert/strict";
import { spendView, routinesView, auditView, accessView, usageSummaryView, skillsListView } from "../agent/control/views.js";
import { buildControlServer, CONTROL_TOOL_NAMES } from "../agent/control/server.js";
import { appendUsageEvent } from "../agent/spend/usage-events.js";
import { getOperationalStore } from "../agent/operational/provider.js";

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
for (const c of access.connections) {
  ok(`connection ${c.id} exposes only a secretRef name, never a value`, !("secret" in c) && !("token" in c) && !("authorization" in c));
}

const CTL_ORG = `ctl-test-${process.pid}-${Date.now()}`;
{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const domains = [defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"] })];
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

  const usageAll = await usageSummaryView({ org: CTL_ORG });
  ok("usageSummaryView (unscoped): sees every surface", usageAll.rows.some((r) => r.surfaceKey === "slack/T1/C_ENG") && usageAll.rows.some((r) => r.surfaceKey === "slack/T1/C_OTHER"));
  ok("usageSummaryView: prices with the deploy's sole configured model by default", usageAll.pricedModel === "zai/glm-5.2" && usageAll.rows.every((r) => typeof r.costUsd === "number"));

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

  await engClient.close();
}

const server = buildControlServer();
const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
const registered = Object.keys(reg).sort();
ok("server exposes the declared tool names", JSON.stringify(registered) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
ok("no mutating tool leaked into slice 1", !registered.some((t) => /set|grant|revoke|cancel|create|update|delete|rotate/.test(t)));

console.log(`\n✓ control surface: ${n} assertions passed (${registered.length} tools: ${registered.join(", ")})\n`);
