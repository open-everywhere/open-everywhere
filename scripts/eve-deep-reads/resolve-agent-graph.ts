import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/runtime/resolve-agent-graph.js`.
 *
 * The integration tier's fast prewarm turns the built bundle's compiled artifacts into the agent graph
 * that `prewarmAppSandboxes` takes as `loadAgentGraph`. Without it, eve rebuilds the graph from
 * authored source, which is the slow path.
 */
export const EVE_RESOLVE_AGENT_GRAPH_FILE = "runtime/resolve-agent-graph.js";

const OWNER = "scripts/eve-deep-reads/resolve-agent-graph.ts";

export type ResolveRuntimeAgentGraph = (input: { readonly manifest: unknown; readonly moduleMap: unknown }) => Promise<unknown>;

/** Loads `resolveRuntimeAgentGraph`. */
export async function loadResolveRuntimeAgentGraph(root: string): Promise<ResolveRuntimeAgentGraph> {
  const { resolveRuntimeAgentGraph } = await loadEveInternalFunctions({
    root,
    file: EVE_RESOLVE_AGENT_GRAPH_FILE,
    names: ["resolveRuntimeAgentGraph"],
    owner: OWNER,
  });
  return resolveRuntimeAgentGraph as unknown as ResolveRuntimeAgentGraph;
}
