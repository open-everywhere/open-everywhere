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

function currentConnectorContentOrigin(): ConnectorContentOriginMap {
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

export function declaredContentOriginForConnectionSearch(output: unknown): ConnectorContentOrigin | undefined {
  if (!Array.isArray(output) || output.length === 0) return undefined;
  let sawTool = false;
  let sawExternal = false;
  for (const el of output) {
    if (el === null || typeof el !== "object") return undefined;
    const row = el as Record<string, unknown>;
    const isToolRow = "tool" in row || "qualifiedName" in row;
    if (!isToolRow) {
      if (typeof row.error === "string" || row.needsAuthorization === true) continue;
      return undefined;
    }
    if (typeof row.connection !== "string" || typeof row.tool !== "string") return undefined;
    const spec = declaredContentOriginForConnection(row.connection);
    if (spec === undefined) return undefined;
    sawTool = true;
    if (contentOriginForTool(spec, row.tool) === "external") sawExternal = true;
  }
  if (!sawTool) return undefined;
  return sawExternal ? "external" : "internal";
}
