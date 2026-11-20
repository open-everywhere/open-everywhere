/**
 * The short names of long connector ops.
 *
 * eve mounts a tool only when its name matches `TOOL_SLUG_PATTERN` (at most 64 characters). A
 * connector op is named `<connection>__<tool>`, and a server can list a tool whose qualified name
 * is longer. `connections/connector-tool-name.ts#mountedConnectorToolName` gives such an op a short
 * name: the first characters of the qualified name, a `-`, and a hash of the whole qualified name.
 * The short name is the same for the same op in every process, and two ops get two names.
 *
 * Every rule that keys on the qualified name (the consequence tiers, the never tier, the routine
 * permission kinds, the connector-op hints, the job-wake read rule) reads the name the model
 * called. This registry maps a short name back to its qualified name, and
 * `access/consequence.ts` resolves it at the parse step, so each rule sees the qualified name.
 *
 * A mount registers each short name when it builds the tool, so a short name is registered in
 * every process that can run it. A short name that is NOT registered never classifies as a read:
 * the tier rule returns "destructive" for it (fail closed), because the cut-off part of the name
 * could hold the verb that decides the tier.
 */

/** The hex characters of the hash in a short name. 48 bits. */
export const CONNECTOR_OP_ALIAS_HASH_LENGTH = 12;

/** eve's tool-name length limit (`TOOL_SLUG_PATTERN`). */
export const EVE_TOOL_NAME_MAX = 64;

const ALIAS_SHAPE = new RegExp(`^[a-zA-Z][a-zA-Z0-9_-]*__[a-zA-Z0-9_-]*-[0-9a-f]{${CONNECTOR_OP_ALIAS_HASH_LENGTH}}$`);

const ALIASES = new Map<string, string>();

/** Plain (unshortened) op names in the short-name shape that a mount used. No short name may take one. */
const PLAIN_IN_ALIAS_SHAPE = new Set<string>();

function hasAliasShape(name: string): boolean {
  return name.length === EVE_TOOL_NAME_MAX && ALIAS_SHAPE.test(name);
}

export type AliasRegistration = { readonly ok: true } | { readonly ok: false; readonly holder: string };

/**
 * Record that `alias` names the op `qualified`. A short name that already names a different op is
 * refused, so two ops never share a name: the caller then leaves the second op out.
 */
export function registerConnectorOpAlias(alias: string, qualified: string): AliasRegistration {
  if (PLAIN_IN_ALIAS_SHAPE.has(alias)) return { ok: false, holder: alias };
  const holder = ALIASES.get(alias);
  if (holder !== undefined && holder !== qualified) return { ok: false, holder };
  ALIASES.set(alias, qualified);
  return { ok: true };
}

/**
 * Record that a mount uses `name` as a plain op name. A plain name that is already a short name of
 * a different op is refused, so the rules never read the other op's qualified name for it.
 */
export function claimPlainConnectorOpName(name: string): AliasRegistration {
  const holder = ALIASES.get(name);
  if (holder !== undefined) return { ok: false, holder };
  if (hasAliasShape(name)) PLAIN_IN_ALIAS_SHAPE.add(name);
  return { ok: true };
}

/** The qualified `<connection>__<tool>` name for a tool name. A name that is not a registered short name returns as it is. */
export function canonicalConnectorOpName(toolName: string): string {
  return ALIASES.get(toolName) ?? toolName;
}

/**
 * True for a name in the short-name shape (exactly 64 characters, a `__`, and a `-` with the hash
 * at the end) that this process has not registered. The tier rule fails closed on it.
 */
export function isUnresolvedConnectorOpAlias(toolName: string): boolean {
  return hasAliasShape(toolName) && !ALIASES.has(toolName) && !PLAIN_IN_ALIAS_SHAPE.has(toolName);
}

/** Test seam: forget every short name. */
export function resetConnectorOpAliases(): void {
  ALIASES.clear();
  PLAIN_IN_ALIAS_SHAPE.clear();
}
