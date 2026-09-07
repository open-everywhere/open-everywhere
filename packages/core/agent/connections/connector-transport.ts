import type { ConnectionAuthResolver } from "eve/connections";
import { appProviderToken, userAwareProviderToken } from "./connector-auth.js";
import { connectorUserPrincipalEnabled } from "./connector-flags.js";

export interface ConnectorTransportSpec {
  readonly connector: string;
  readonly directUrl: string;
  readonly provider?: string;
  readonly fallbackSecretRef?: string;
  readonly fallbackBroker?: string;
}

export interface ResolvedConnectorTransport {
  readonly url: string;
  readonly auth: ConnectionAuthResolver;
}

export interface ConnectorTransport {
  readonly name: string;
  readonly priority: number;
  isActive(spec: ConnectorTransportSpec): boolean;
  resolve(spec: ConnectorTransportSpec): ResolvedConnectorTransport;
}

const TRANSPORTS = new Map<string, ConnectorTransport>();

const SPECS = new Map<string, ConnectorTransportSpec>();

export function connectorTransportSpec(connector: string): ConnectorTransportSpec | undefined {
  return SPECS.get(connector);
}

export function registerConnectorTransport(transport: ConnectorTransport): void {
  TRANSPORTS.set(transport.name, transport);
}

export function registeredConnectorTransports(): readonly ConnectorTransport[] {
  return [...TRANSPORTS.values()];
}

export function resetConnectorTransports(): void {
  TRANSPORTS.clear();
  registerCoreConnectorTransports();
}

export function selectConnectorTransport(spec: ConnectorTransportSpec): ResolvedConnectorTransport {
  SPECS.set(spec.connector, spec);
  const active = [...TRANSPORTS.values()].filter((t) => t.isActive(spec)).sort((a, b) => b.priority - a.priority);
  const chosen = active[0];
  if (!chosen) {
    throw new Error(
      `connection "${spec.connector}": no connector transport is active — the direct-MCP transport should ` +
        `always apply. Was registerCoreConnectorTransports() run (registry cleared without restore)?`,
    );
  }
  return chosen.resolve(spec);
}

function registerCoreConnectorTransports(): void {
  registerConnectorTransport({
    name: "direct-mcp",
    priority: 0,
    isActive: () => true,
    resolve: (spec) => {
      const opts = {
        connector: spec.connector,
        directUrl: spec.directUrl,
        ...(spec.fallbackSecretRef !== undefined ? { fallbackSecretRef: spec.fallbackSecretRef } : {}),
        ...(spec.fallbackBroker !== undefined ? { fallbackBroker: spec.fallbackBroker } : {}),
      };
      const userAware = userAwareProviderToken(opts);
      const app = appProviderToken(opts);
      return {
        url: spec.directUrl,
        auth: (ctx) => (connectorUserPrincipalEnabled() ? userAware : app)(ctx),
      };
    },
  });
}
registerCoreConnectorTransports();
