import { defineState } from "eve/context";
import { contentOriginForTool, type ConnectorContentOrigin, type ConnectorContentOriginSpec } from "./bundle.js";

export type ConnectorContentOriginMap = Readonly<Record<string, ConnectorContentOriginSpec>>;

const connectorContentOriginSlot = defineState<ConnectorContentOriginMap>("open-everywhere.connector-content-origin", () => ({}));

export function setConnectorContentOrigin(declared: ConnectorContentOriginMap): void {
  try {
    connectorContentOriginSlot.update(() => declared);
  } catch {
  }
}

export function currentConnectorContentOrigin(): ConnectorContentOriginMap {
  try {
    return connectorContentOriginSlot.get();
  } catch {
    return {};
  }
}

export function declaredContentOriginForConnection(connection: string): ConnectorContentOriginSpec | undefined {
  return currentConnectorContentOrigin()[connection];
}

export function declaredContentOriginForToolName(toolName: string): ConnectorContentOrigin | undefined {
  const declared = currentConnectorContentOrigin();
  let best: string | undefined;
  for (const name of Object.keys(declared)) {
    if (!toolName.startsWith(`${name}__`)) continue;
    if (best === undefined || name.length > best.length) best = name;
  }
  if (best === undefined) return undefined;
  return contentOriginForTool(declared[best]!, toolName.slice(best.length + 2));
}
