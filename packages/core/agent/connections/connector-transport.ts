import type { ConnectionAuthResolver } from "eve/connections";
import { appProviderToken, userAwareProviderToken } from "./connector-auth.js";
import { connectorUserPrincipalEnabled } from "./connector-flags.js";
import { executorMcpUrl, executorNotionArmed, notionExecutorAuth } from "./executor-user-oauth.js";

export interface ConnectorTransportSpec {
  readonly connector: string;
  readonly directUrl: string;
  readonly provider?: string;
  readonly fallbackSecretRef?: string;
  readonly fallbackBroker?: string;
  readonly executorCredentialId?: string;
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
        ...(spec.fallbackSecretRef !== undefined ? { fallbackSecretRef: spec.fallbackSecretRef } : {}),
        ...(spec.fallbackBroker !== undefined ? { fallbackBroker: spec.fallbackBroker } : {}),
      };
      return {
        url: spec.directUrl,
        auth: connectorUserPrincipalEnabled() ? userAwareProviderToken(opts) : appProviderToken(opts),
      };
    },
  });

  registerConnectorTransport({
    name: "executor",
    priority: 100,
    isActive: (spec) => spec.executorCredentialId !== undefined && executorNotionArmed(),
    resolve: (spec) => ({
      url: executorMcpUrl()!,
      auth: notionExecutorAuth({ connector: spec.connector, provider: spec.provider!, credentialId: spec.executorCredentialId! }),
    }),
  });
}
registerCoreConnectorTransports();

export interface TransportPauseInteraction {
  readonly kind: string;
  readonly message?: string;
  readonly url?: string;
  readonly requestedSchema?: unknown;
}

export interface TransportPause {
  readonly resumeHandle: string;
  readonly interaction: TransportPauseInteraction;
  readonly expiresAt?: string;
  readonly ttlMs?: number;
}

export interface PausableDispatch<Ctx = unknown> {
  readonly ctx: Ctx;
  readonly connector: string;
  readonly op: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly pause: TransportPause;
}

export interface PausableTransport {
  resume(handle: string): Promise<unknown>;
}
