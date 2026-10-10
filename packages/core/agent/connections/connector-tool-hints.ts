import { isConnectorOpTool, isReservedNamespaceTool, type ConnectorOpToolHints } from "../access/consequence.js";

const EVE_CONTEXT_STORAGE = Symbol.for("eve.context-storage");

export const CONNECTION_REGISTRY_KEY_NAME = "eve.connectionRegistry";

const TOOL_HINT_READ_BUDGET_MS = 3_000;

interface EveConnectionRegistry {
  getConnectionNames(): readonly string[];
  getClient(connectionName: string): { getToolMetadata(): Promise<readonly unknown[]> };
}

function connectionRegistry(): EveConnectionRegistry | undefined {
  try {
    const storage = (globalThis as Record<symbol, unknown>)[EVE_CONTEXT_STORAGE] as { getStore?: () => unknown } | undefined;
    const store = storage?.getStore?.();
    if (store === null || typeof store !== "object") return undefined;
    const get = (store as { get?: unknown }).get;
    if (typeof get !== "function") return undefined;
    const value: unknown = get.call(store, { name: CONNECTION_REGISTRY_KEY_NAME });
    if (value === null || typeof value !== "object") return undefined;
    const registry = value as Partial<EveConnectionRegistry>;
    return typeof registry.getConnectionNames === "function" && typeof registry.getClient === "function"
      ? (value as EveConnectionRegistry)
      : undefined;
  } catch {
    return undefined;
  }
}

function splitByRegistry(toolName: string, names: readonly string[]): { readonly connection: string; readonly tool: string } | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (toolName.startsWith(`${name}__`) && (best === undefined || name.length > best.length)) best = name;
  }
  if (best === undefined) return undefined;
  const tool = toolName.slice(best.length + 2);
  return tool.length > 0 ? { connection: best, tool } : undefined;
}

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

export async function connectorOpToolHints(toolName: string, budgetMs: number = TOOL_HINT_READ_BUDGET_MS): Promise<ConnectorOpToolHints | undefined> {
  if (!isConnectorOpTool(toolName) || isReservedNamespaceTool(toolName)) return undefined;
  const registry = connectionRegistry();
  if (registry === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = splitByRegistry(toolName, registry.getConnectionNames());
    if (target === undefined) return undefined;
    const metadata = await Promise.race([
      registry.getClient(target.connection).getToolMetadata(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
    if (!Array.isArray(metadata)) return undefined;
    const entry = metadata.find((e) => e !== null && typeof e === "object" && (e as { name?: unknown }).name === target.tool);
    return toolHintsOf(entry);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
