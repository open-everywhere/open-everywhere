import type { ConnectorContentOrigin, ConnectorContentOriginSpec } from "./bundle.js";
import type { ConnectionExecuteTarget } from "./connection-execute-target.js";

export type ConnectorContentOriginMap = Readonly<Record<string, ConnectorContentOriginSpec>>;

export function setConnectorContentOrigin(_declared: ConnectorContentOriginMap): void {
}

export function declaredContentOriginForConnection(_connection: string): ConnectorContentOriginSpec | undefined {
  return undefined;
}

export function declaredContentOriginForToolName(_toolName: string): ConnectorContentOrigin | undefined {
  return undefined;
}

export function declaredContentOriginForExecuteTarget(_target: ConnectionExecuteTarget): ConnectorContentOrigin | undefined {
  return undefined;
}

export function declaredContentOriginForConnectionSearch(_output: unknown): ConnectorContentOrigin | undefined {
  return undefined;
}

export { connectionSearchRows } from "./untrusted-projection.js";
