import type { ConnectorContentOrigin, ConnectorContentOriginSpec } from "./bundle.js";

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
export function declaredContentOriginForExecuteTarget(_target: { readonly connection: string; readonly tool: string }): ConnectorContentOrigin | undefined {
  return undefined;
}

/** @deprecated Always `undefined` since OPE-2723; OPE-2724 removes it. */
export function declaredContentOriginForConnectionSearch(_output: unknown): ConnectorContentOrigin | undefined {
  return undefined;
}

const CONNECTION_SEARCH_RESULT_KEYS: ReadonlySet<string> = new Set(["tools", "total", "unavailable"]);

/**
 * @deprecated The rows of an eve 0.71 `connection_search` result. eve 1.x has no such tool, so no
 * caller remains; OPE-2724 removes it. An unknown key fails closed (`undefined`).
 */
export function connectionSearchRows(output: unknown): readonly unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (output === null || typeof output !== "object") return undefined;
  const result = output as Record<string, unknown>;
  if (Object.keys(result).some((key) => !CONNECTION_SEARCH_RESULT_KEYS.has(key))) return undefined;
  if (!Array.isArray(result.tools)) return undefined;
  if (result.unavailable !== undefined && !Array.isArray(result.unavailable)) return undefined;
  return [...((result.unavailable as readonly unknown[] | undefined) ?? []), ...result.tools];
}
