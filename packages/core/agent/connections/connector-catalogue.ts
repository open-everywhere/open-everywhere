import { canonicalConnectorOpName } from "../access/connector-op-alias.js";
import type { ListedConnectorTool } from "./connector-mcp-client.js";

/**
 * The OE connector catalogue: which connections OE mounts, and the ops each one listed last.
 *
 * On eve 1.x a connection is an OE connector mount (`connector-mount.ts`), not an eve MCP
 * connection, so eve's connection registry is empty. The readers that asked eve's registry for
 * a connection's names and op metadata ask this catalogue instead:
 *
 * - the connector-op hints lookup (`connector-tool-hints.ts`) reads an op's listed `annotations`;
 * - the routine fire hook (`hooks/fire-toolset.ts`) lists a connection to resolve a routine's
 *   declared ops.
 *
 * A mount registers its connection when its module loads, and records each listing it makes.
 * A listing is the server's own description of its ops. The catalogue keeps, per connection,
 * every op any good listing named, with its latest entry, because the hints and the declared ops
 * are facts about the op, not about the principal that listed it.
 */

/** Lists one connection's ops for a session context. `undefined` when the listing failed or needs sign-in. */
export type ConnectorLister = (ctx: unknown) => Promise<readonly ListedConnectorTool[] | undefined>;

const MOUNTED = new Map<string, ConnectorLister | undefined>();

const LISTED = new Map<string, readonly ListedConnectorTool[]>();

export function registerMountedConnector(connection: string, lister?: ConnectorLister): void {
  MOUNTED.set(connection, lister);
}

export function mountedConnectorNames(): readonly string[] {
  return [...MOUNTED.keys()].sort();
}

/**
 * The connection's ops for this session context: the mount's memoised listing, else a live one.
 * `undefined` when the connection is not mounted, or its listing failed or needs sign-in.
 */
export async function listMountedConnector(connection: string, ctx: unknown): Promise<readonly ListedConnectorTool[] | undefined> {
  const lister = MOUNTED.get(connection);
  return lister === undefined ? listedConnectorOps(connection) : await lister(ctx);
}

/**
 * Record a listing. The ops merge by name with the earlier listings of the connection, so a later
 * listing that lacks an op (an anonymous listing, or a principal that sees fewer ops) never drops
 * that op's annotations. A later entry for the same op replaces the earlier one.
 */
export function recordConnectorListing(connection: string, listed: readonly ListedConnectorTool[]): void {
  const byName = new Map<string, ListedConnectorTool>((LISTED.get(connection) ?? []).map((op) => [op.name, op]));
  for (const op of listed) byName.set(op.name, op);
  LISTED.set(connection, [...byName.values()]);
}

/** Every op the connection's listings named, or `undefined` when it has not listed yet in this process. */
export function listedConnectorOps(connection: string): readonly ListedConnectorTool[] | undefined {
  return LISTED.get(connection);
}

/** Split `<connection>__<tool>` (a mounted short name resolves first) by the longest mounted connection name that prefixes it. */
export function splitMountedConnectorTool(rawToolName: string, names: readonly string[] = mountedConnectorNames()): { readonly connection: string; readonly tool: string } | undefined {
  const toolName = canonicalConnectorOpName(rawToolName);
  let best: string | undefined;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (toolName.startsWith(`${name}__`) && (best === undefined || name.length > best.length)) best = name;
  }
  if (best === undefined) return undefined;
  const tool = toolName.slice(best.length + 2);
  return tool.length > 0 ? { connection: best, tool } : undefined;
}

/** Test seam: forget every mount and listing. */
export function resetConnectorCatalogue(): void {
  MOUNTED.clear();
  LISTED.clear();
}
