import { existsSync } from "node:fs";
import { join } from "node:path";
import { importAppModule, resolveAppRoot } from "../../agent/scaffold/app-root.js";

type DomainsModule = typeof import("../../../../agent/memory/config/domains.js");
type BundlesModule = typeof import("../../../../agent/access/bundles.js");
type ConnectorCredentialsModule = typeof import("../../../../agent/access/connector-credentials.js");
type SpendBudgetsModule = typeof import("../../../../agent/spend/budgets.js");
type A2aAgentsModule = typeof import("../../../../agent/access/a2a-agents.js");

export async function loadAppDomains(root?: string): Promise<ReturnType<DomainsModule["loadDomains"]>> {
  const { loadDomains } = await importAppModule<DomainsModule>("agent/memory/config/domains.ts", root);
  return loadDomains();
}

export async function loadAppBundles(root?: string): Promise<ReturnType<BundlesModule["loadBundles"]>> {
  const { loadBundles } = await importAppModule<BundlesModule>("agent/access/bundles.ts", root);
  return loadBundles();
}

export async function loadAppBindings(root?: string): Promise<ReturnType<BundlesModule["loadBindings"]>> {
  const { loadBindings } = await importAppModule<BundlesModule>("agent/access/bundles.ts", root);
  return loadBindings();
}

export async function loadAppConnectorCredentials(root?: string): Promise<ReturnType<ConnectorCredentialsModule["loadConnectorCredentials"]>> {
  const { loadConnectorCredentials } = await importAppModule<ConnectorCredentialsModule>("agent/access/connector-credentials.ts", root);
  return loadConnectorCredentials();
}

export async function loadAppSpendBudgets(root?: string): Promise<ReturnType<SpendBudgetsModule["loadSpendBudgets"]>> {
  const appRoot = root ?? resolveAppRoot();
  if (!existsSync(join(appRoot, "agent", "spend", "budgets.ts"))) return {};
  const { loadSpendBudgets } = await importAppModule<SpendBudgetsModule>("agent/spend/budgets.ts", appRoot);
  return loadSpendBudgets();
}

export async function loadAppA2aAgents(root?: string): Promise<A2aAgentsModule["A2A_AGENTS"]> {
  const { A2A_AGENTS } = await importAppModule<A2aAgentsModule>("agent/access/a2a-agents.ts", root);
  return A2A_AGENTS;
}
