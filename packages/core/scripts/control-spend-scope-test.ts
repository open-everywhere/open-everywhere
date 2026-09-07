import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import "./_register-test-config.js";

const dir = join(tmpdir(), `open-everywhere-control-spend-scope-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "home-org";
const FOREIGN_ORG = "other-tenant";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer } = await import("../agent/control/server.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

interface SpendSurfaceWire {
  readonly org: string;
  readonly surfaceKey: string;
  readonly tokens: number;
  readonly usd: number;
}
interface SpendWorkspaceWire {
  readonly key: string;
  readonly tokens: number;
}
interface UserCapWire {
  readonly principal: string;
}
interface SpendWire {
  readonly period: string;
  readonly surfaces: SpendSurfaceWire[];
  readonly workspaces: SpendWorkspaceWire[];
  readonly userCaps: Record<string, UserCapWire[]>;
}

ok("the deployment org is the one this test pins against", deploymentOrg() === "home-org");

const PERIOD = new Date().toISOString().slice(0, 7);
const HOME_SURFACE = "slack/T_HOME/C_HOME";
const FOREIGN_SURFACE = "slack/T_FOREIGN/C_FOREIGN";
const HOME_PRINCIPAL = "user:slack/U_HOME";
const FOREIGN_PRINCIPAL = "user:slack/U_FOREIGN";

const store = getOperationalStore();
await store.recordSpend(deploymentOrg(), { surfaceKey: HOME_SURFACE, period: PERIOD, inputTokens: 1_000, outputTokens: 500, usdMicros: 3_000_000 });
await store.recordSpend(FOREIGN_ORG, { surfaceKey: FOREIGN_SURFACE, period: PERIOD, inputTokens: 7_000, outputTokens: 900, usdMicros: 9_000_000 });
await store.recordSpend(FOREIGN_ORG, { surfaceKey: FOREIGN_SURFACE, period: "2026-01", inputTokens: 4_000, outputTokens: 100, usdMicros: 2_000_000 });
await store.setSpendLimit(deploymentOrg(), HOME_PRINCIPAL, "user", { monthlyUsd: 25 });
await store.setSpendLimit(FOREIGN_ORG, FOREIGN_PRINCIPAL, "user", { monthlyUsd: 50 });

const server = buildControlServer();
const client = new Client({ name: "spend-scope-test", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const report = async (args: Record<string, unknown>): Promise<{ view: SpendWire; raw: string }> => {
  const res = await client.callTool({ name: "spend_report", arguments: args });
  const raw = (res.content as { type: string; text: string }[])[0].text;
  return { view: JSON.parse(raw) as SpendWire, raw };
};

{
  const tools = await client.listTools();
  const spend = tools.tools.find((t) => t.name === "spend_report");
  ok("spend_report is registered", spend !== undefined);
  const props = (spend!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  ok("🔴 spend_report's input schema advertises no `org` — a model cannot ask for another tenant", !("org" in props));
  ok("control: the `period` filter is still advertised", "period" in props);
  const description = spend!.description ?? "";
  ok("the description says the read is this deployment's own org", /this deployment's own org/i.test(description));
  ok("the description says what the tool reads", /spend ledger/i.test(description));
}

{
  const { view, raw } = await report({});
  ok("the read returns rows", view.surfaces.length > 0);
  ok("🔴 every surface row a bare call returns belongs to the deployment's own org", view.surfaces.every((s) => s.org === deploymentOrg()));
  ok("🔴 the foreign tenant's surface key is not among them", !view.surfaces.some((s) => s.surfaceKey === FOREIGN_SURFACE));
  const home = view.surfaces.find((s) => s.surfaceKey === HOME_SURFACE);
  ok("control: the deployment's own surface row IS returned — the filter narrows by org, it does not empty the report", home !== undefined);
  ok("control: with its own ledger figures intact ($3 over 1,500 billable tokens)", home?.usd === 3 && home.tokens === 1_500);

  ok("🔴 no workspace row carries the foreign tenant's key", !view.workspaces.some((w) => w.key.startsWith(`${FOREIGN_ORG}/`)));
  ok("control: the deployment's own workspace row IS returned", view.workspaces.some((w) => w.key === `${deploymentOrg()}/slack/T_HOME`));

  ok("🔴 the userCaps map holds exactly one key — the deployment's own org", Object.keys(view.userCaps).length === 1 && view.userCaps[deploymentOrg()] !== undefined);
  ok("control: the deployment's own per-person allowance IS listed", (view.userCaps[deploymentOrg()] ?? []).some((c) => c.principal === HOME_PRINCIPAL));
  ok("🔴 the foreign tenant's per-person allowance is listed nowhere", !Object.values(view.userCaps).flat().some((c) => c.principal === FOREIGN_PRINCIPAL));

  ok("🔴 no part of the serialised answer names the foreign tenant", !raw.includes(FOREIGN_ORG) && !raw.includes(FOREIGN_SURFACE) && !raw.includes("U_FOREIGN"));
  ok("control: the same serialised answer does name the deployment's own surface", raw.includes(HOME_SURFACE));
}

{
  const { view, raw } = await report({ period: "2026-01" });
  ok("the January read is answered for the period asked", view.period === "2026-01");
  ok("🔴 a period with only foreign rows returns none of them", view.surfaces.length === 0 && !raw.includes(FOREIGN_SURFACE));
  ok("control: the empty month is still a report — its userCaps still name this org", view.userCaps[deploymentOrg()] !== undefined);
}

{
  let answered = true;
  let view: SpendWire = { period: PERIOD, surfaces: [], workspaces: [], userCaps: {} };
  let raw = "";
  let refusal = "";
  try {
    ({ view, raw } = await report({ org: FOREIGN_ORG }));
  } catch (err) {
    answered = false;
    refusal = err instanceof Error ? err.message : String(err);
  }
  ok("🔴 naming a foreign org returns none of its rows", !raw.includes(FOREIGN_SURFACE) && !raw.includes(FOREIGN_ORG));
  if (answered) {
    ok("…and the call is answered about THIS deployment instead — the argument is ignored, not honoured", view.surfaces.length > 0 && view.surfaces.every((s) => s.org === deploymentOrg()));
  } else {
    ok("…because the call was refused outright with a stated reason, and the reason names no foreign row", refusal.length > 0 && !refusal.includes(FOREIGN_SURFACE) && !refusal.includes("U_FOREIGN"));
  }
}

{
  const domainServer = buildControlServer({ roles: ["domain:eng"] });
  const [dc, ds] = InMemoryTransport.createLinkedPair();
  await domainServer.connect(ds);
  const domainClient = new Client({ name: "spend-scope-domain-role", version: "0" });
  await domainClient.connect(dc);

  const denied = await domainClient.callTool({ name: "spend_report", arguments: {} });
  ok("🔴 a domain:eng identity is DENIED spend_report — an org-wide read needs the org-wide admin role", denied.isError === true);
  const deniedText = (denied.content as { type: string; text: string }[])[0].text;
  ok(
    "…with the same denial shape usage_* returns, and no ledger row inside the refusal",
    /forbidden: no role covers/.test(deniedText) && !deniedText.includes(HOME_SURFACE) && !deniedText.includes(FOREIGN_SURFACE),
  );

  const sibling = await domainClient.callTool({
    name: "usage_window",
    arguments: { sinceIso: "2026-01-01T00:00:00Z", workspaceKeys: [`slack/T_HOME`] },
  });
  ok("control: usage_window refuses the same identity — the sibling gate this one copies is really armed", sibling.isError === true);
  ok(
    "🔴 spend_report's refusal is usage_window's refusal, word for word",
    deniedText === (sibling.content as { type: string; text: string }[])[0].text,
  );

  const allowed = await client.callTool({ name: "spend_report", arguments: {} });
  ok("control: an admin-role identity still reads the report — the gate narrows by role, it does not disable the tool", allowed.isError !== true);

  await domainClient.close();
}

{
  const foreignLedger = await store.listSpendLedger(FOREIGN_ORG);
  ok("fixture control: the foreign tenant's ledger rows exist in the shared store", foreignLedger.length === 2);
  ok("fixture control: including its current-period row — the exact row the control read must not surface", foreignLedger.some((r) => r.period === PERIOD && r.surfaceKey === FOREIGN_SURFACE));
  const foreignLimits = await store.spendLimits(FOREIGN_ORG);
  ok("fixture control: the foreign tenant's per-person allowance exists in the shared store", foreignLimits.some((l) => l.scopeKey === FOREIGN_PRINCIPAL));
  const everyOrg = await store.listSpendLedger();
  ok("fixture control: the UNFILTERED ledger read spans both orgs — the pin is what narrows it", everyOrg.some((r) => r.org === FOREIGN_ORG) && everyOrg.some((r) => r.org === deploymentOrg()));
}

await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ control spend read is org-pinned: ${n} assertions passed\n`);
