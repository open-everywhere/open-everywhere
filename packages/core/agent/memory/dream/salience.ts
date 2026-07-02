import { adjacencyBoost, type MemoryGraph } from "../graph.js";

export interface NodeSalience {
  readonly node: string;
  readonly score: number;
}

export function salienceScores(graph: MemoryGraph): NodeSalience[] {
  return graph.nodes
    .map((node) => ({
      node,
      score: adjacencyBoost(graph, [node]).reduce((sum, n) => sum + n.weight, 0),
    }))
    .sort((a, b) => b.score - a.score || a.node.localeCompare(b.node));
}

export function salienceMap(graph: MemoryGraph): Map<string, number> {
  return new Map(salienceScores(graph).map((s) => [s.node, s.score]));
}
