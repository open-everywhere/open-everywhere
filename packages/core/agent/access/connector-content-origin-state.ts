import type { ConnectorContentOrigin, ConnectorContentOriginSpec } from "./bundle.js";
import type { ConnectionExecuteTarget } from "./connection-execute-target.js";

/** @deprecated Ignored since OPE-2723; OPE-2724 removes it. */
export type ConnectorContentOriginMap = Readonly<Record<string, ConnectorContentOriginSpec>>;

/** @deprecated A no-op since OPE-2723; OPE-2724 removes it. It stores nothing. */
export function setConnectorContentOrigin(_declared: ConnectorContentOriginMap): void {
}

/** @deprecated Always `undefined` since OPE-2723; OPE-2724 removes it. */
export function declaredContentOriginForConnection(_connection: string): ConnectorContentOriginSpec | undefined {
  return undefined;
}

/** @deprecated Always `undefined` since OPE-2723; OPE-2724 removes it. */
export function declaredContentOriginForToolName(_toolName: string): ConnectorContentOrigin | undefined {
  return undefined;
}

/** @deprecated Always `undefined` since OPE-2723; OPE-2724 removes it. */
export function declaredContentOriginForExecuteTarget(_target: ConnectionExecuteTarget): ConnectorContentOrigin | undefined {
  return undefined;
}

/** @deprecated Always `undefined` since OPE-2723; OPE-2724 removes it. */
export function declaredContentOriginForConnectionSearch(_output: unknown): ConnectorContentOrigin | undefined {
  return undefined;
}

/** @deprecated Moved to `access/untrusted-projection.ts` (OPE-2723); this re-export goes with OPE-2724. */
export { connectionSearchRows } from "./untrusted-projection.js";
