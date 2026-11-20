import { isConnectorOpTool, isReservedNamespaceTool, type ConnectorOpToolHints } from "../access/consequence.js";
import { listedConnectorOps, splitMountedConnectorTool } from "./connector-catalogue.js";

/**
 * The connector-op hints lookup: the MCP `annotations` (`readOnlyHint`, `destructiveHint`) that
 * the connection's server listed for one op.
 *
 * On eve 1.x a connection is an OE connector mount (`connector-mount.ts`), and eve's connection
 * registry is empty. Each good listing of a mount goes to the OE connector catalogue
 * (`connector-catalogue.ts`), and this lookup reads it there. The catalogue is in memory, so the
 * lookup never waits on the server. A connection that has not listed yet in this process has no
 * hints, and the tier falls back to the verb heuristic (fail closed).
 */

export function toolHintsOf(entry: unknown): ConnectorOpToolHints | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const annotations = (entry as { annotations?: unknown }).annotations;
  if (annotations === null || typeof annotations !== "object") return undefined;
  const { readOnlyHint, destructiveHint } = annotations as { readOnlyHint?: unknown; destructiveHint?: unknown };
  const hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (typeof readOnlyHint === "boolean") hints.readOnlyHint = readOnlyHint;
  if (typeof destructiveHint === "boolean") hints.destructiveHint = destructiveHint;
  return hints.readOnlyHint === undefined && hints.destructiveHint === undefined ? undefined : hints;
}

export async function connectorOpToolHints(toolName: string): Promise<ConnectorOpToolHints | undefined> {
  if (!isConnectorOpTool(toolName) || isReservedNamespaceTool(toolName)) return undefined;
  try {
    const target = splitMountedConnectorTool(toolName);
    if (target === undefined) return undefined;
    const listed = listedConnectorOps(target.connection);
    if (listed === undefined) return undefined;
    return toolHintsOf(listed.find((e) => e.name === target.tool));
  } catch {
    return undefined;
  }
}
