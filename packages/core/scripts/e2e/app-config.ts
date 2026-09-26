import { importAppModule } from "../../agent/scaffold/app-root.js";

type DomainsModule = typeof import("../../../../agent/memory/config/domains.js");
type BundlesModule = typeof import("../../../../agent/access/bundles.js");
type ConnectorCredentialsModule = typeof import("../../../../agent/access/connector-credentials.js");

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
