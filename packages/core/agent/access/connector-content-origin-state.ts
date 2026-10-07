import { defineState } from "eve/context";
import { contentOriginForTool, type ConnectorContentOrigin, type ConnectorContentOriginSpec } from "./bundle.js";
import type { ConnectionExecuteTarget } from "./connection-execute-target.js";

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

export function declaredContentOriginForExecuteTarget(target: ConnectionExecuteTarget): ConnectorContentOrigin | undefined {
  const spec = declaredContentOriginForConnection(target.connection);
  if (spec === undefined) return undefined;
  return contentOriginForTool(spec, target.tool);
}

const CONNECTION_SEARCH_RESULT_KEYS: ReadonlySet<string> = new Set(["tools", "total", "unavailable"]);

export function connectionSearchRows(output: unknown): readonly unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (output === null || typeof output !== "object") return undefined;
  const result = output as Record<string, unknown>;
  if (Object.keys(result).some((key) => !CONNECTION_SEARCH_RESULT_KEYS.has(key))) return undefined;
  if (!Array.isArray(result.tools)) return undefined;
  if (result.unavailable !== undefined && !Array.isArray(result.unavailable)) return undefined;
  return [...((result.unavailable as readonly unknown[] | undefined) ?? []), ...result.tools];
}

export function declaredContentOriginForConnectionSearch(output: unknown): ConnectorContentOrigin | undefined {
  const rows = connectionSearchRows(output);
  if (rows === undefined || rows.length === 0) return undefined;
  let sawTool = false;
  let sawExternal = false;
  for (const el of rows) {
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
