import { createHash } from "node:crypto";
import {
  claimPlainConnectorOpName,
  CONNECTOR_OP_ALIAS_HASH_LENGTH,
  EVE_TOOL_NAME_MAX,
  registerConnectorOpAlias,
} from "../access/connector-op-alias.js";

/** The qualified name of one connector op on eve 1.x: `<connection>__<tool>`, eve's own catalog spelling. */
export function connectorToolName(connection: string, tool: string): string {
  return `${connection}__${tool}`;
}

/** eve's tool-name rule (`TOOL_SLUG_PATTERN`). One illegal key makes eve refuse the whole dynamic map. */
const EVE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const LEGAL_LONG_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * True when the mount can key this op: its qualified name passes eve's tool-name rule, or it is a
 * legal long name that gets a short name. An op that fails this is left out of the mount. The
 * routine reach block uses the same rule, so it never names an op the mount leaves out.
 */
export function isMountableConnectorOp(connection: string, tool: string): boolean {
  const qualified = connectorToolName(connection, tool);
  return EVE_TOOL_NAME.test(qualified) || LEGAL_LONG_NAME.test(qualified);
}

/**
 * The short name of an op whose qualified name is longer than eve's limit: the first characters
 * of the qualified name, a `-`, and the first 12 hex characters of the SHA-256 of the qualified
 * name. It is exactly 64 characters, and the same op always gets the same name. The `-` never
 * makes a new `__`, so the connection part of the name stays the same. When the connection name
 * alone is too long to keep, its first characters are kept instead.
 */
export function shortConnectorToolName(connection: string, tool: string): string {
  const qualified = connectorToolName(connection, tool);
  const hash = createHash("sha256").update(qualified).digest("hex").slice(0, CONNECTOR_OP_ALIAS_HASH_LENGTH);
  const headLength = EVE_TOOL_NAME_MAX - 1 - CONNECTOR_OP_ALIAS_HASH_LENGTH;
  const head =
    connection.length + 2 < headLength
      ? qualified.slice(0, headLength)
      : `${connection.slice(0, headLength - 3)}__${tool.slice(0, 1)}`;
  return `${head}-${hash}`;
}

/**
 * The key a mount gives one op, with no registration: the qualified name when eve can mount it,
 * else the short name of a legal long name. A routine's reach block names this key, because the
 * model calls the mounted name. (A short name that another op holds is left out at mount time,
 * so this key then names no tool, and the call fails closed.)
 */
export function connectorToolKey(connection: string, tool: string): string {
  const qualified = connectorToolName(connection, tool);
  if (EVE_TOOL_NAME.test(qualified) || !LEGAL_LONG_NAME.test(qualified)) return qualified;
  return shortConnectorToolName(connection, tool);
}

export type MountedConnectorToolName =
  | { readonly ok: true; readonly name: string; readonly shortened: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The name eve mounts one connector op under. A legal qualified name of 64 characters or fewer is
 * kept. A legal qualified name that is longer gets its short name, registered so that every rule
 * that keys on the qualified name resolves it (`access/connector-op-alias.ts`). A name with an
 * illegal character, or a short name that another op already holds, is refused.
 */
export function mountedConnectorToolName(connection: string, tool: string): MountedConnectorToolName {
  const qualified = connectorToolName(connection, tool);
  if (EVE_TOOL_NAME.test(qualified)) {
    const claimed = claimPlainConnectorOpName(qualified);
    if (!claimed.ok) return { ok: false, reason: `the name is already the short name of "${claimed.holder}"` };
    return { ok: true, name: qualified, shortened: false };
  }
  if (!isMountableConnectorOp(connection, tool)) return { ok: false, reason: "eve cannot mount a tool by that name" };
  const name = shortConnectorToolName(connection, tool);
  const registered = registerConnectorOpAlias(name, qualified);
  if (!registered.ok) return { ok: false, reason: `its short name "${name}" already names "${registered.holder}"` };
  return { ok: true, name, shortened: true };
}
