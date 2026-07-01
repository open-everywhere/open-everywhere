import type { MemoryFiles } from "./store.js";

export interface MemoryEdge {
  readonly from: string;
  readonly to: string;
  readonly resolved: boolean;
}

export interface MemoryGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly MemoryEdge[];
}

export interface BoostOptions {
  readonly direction?: "out" | "in" | "both";
  readonly includeUnresolved?: boolean;
}

export interface NeighborBoost {
  readonly node: string;
  readonly weight: number;
}

const WIKILINK = /\[\[([^[\]]+?)\]\]/g;

function stripMd(relPath: string): string {
  return relPath.replace(/\.md$/i, "");
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9/-]+/g, "")
    .replace(/-*\/-*/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

function baseOf(s: string): string {
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

function cleanTarget(raw: string): string {
  return raw.split("|")[0].split("#")[0].trim();
}

export function parseWikiLinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK)) {
    const target = cleanTarget(m[1]);
    if (target.length > 0) out.push(target);
  }
  return out;
}

interface NodeIndex {
  readonly byPath: Map<string, string>;
  readonly byBase: Map<string, string | null>;
}

function buildIndex(nodes: readonly string[]): NodeIndex {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string | null>();
  for (const id of nodes) {
    const s = slug(id);
    if (!byPath.has(s)) byPath.set(s, id);
    const b = baseOf(s);
    byBase.set(b, byBase.has(b) ? null : id);
  }
  return { byPath, byBase };
}

function resolveWith(index: NodeIndex, ref: string): string | null {
  const s = slug(ref);
  if (s.length === 0) return null;
  const byPath = index.byPath.get(s);
  if (byPath) return byPath;
  const byBase = index.byBase.get(baseOf(s));
  return byBase ?? null;
}

export function resolveNode(graph: MemoryGraph, ref: string): string | null {
  return resolveWith(buildIndex(graph.nodes), ref);
}

export function buildGraph(files: MemoryFiles): MemoryGraph {
  const mdPaths = Object.keys(files).filter((p) => /\.md$/i.test(p));
  const nodes = mdPaths.map(stripMd);
  const index = buildIndex(nodes);

  const seen = new Set<string>();
  const edges: MemoryEdge[] = [];
  for (const relPath of mdPaths) {
    const from = stripMd(relPath);
    for (const target of parseWikiLinks(files[relPath])) {
      const resolvedId = resolveWith(index, target);
      const to = resolvedId ?? slug(target);
      if (to.length === 0) continue;
      const key = `${from} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, resolved: resolvedId !== null });
    }
  }
  return { nodes, edges };
}

export function adjacencyBoost(
  graph: MemoryGraph,
  seeds: readonly string[],
  opts: BoostOptions = {},
): NeighborBoost[] {
  const direction = opts.direction ?? "both";
  const index = buildIndex(graph.nodes);
  const seedSet = new Set<string>();
  for (const s of seeds) {
    const id = resolveWith(index, s);
    if (id) seedSet.add(id);
  }
  if (seedSet.size === 0) return [];

  const weights = new Map<string, number>();
  const bump = (node: string): void => {
    if (seedSet.has(node)) return;
    weights.set(node, (weights.get(node) ?? 0) + 1);
  };

  for (const e of graph.edges) {
    const wantOut = direction !== "in";
    const wantIn = direction !== "out";
    if (wantOut && seedSet.has(e.from) && (e.resolved || opts.includeUnresolved)) bump(e.to);
    if (wantIn && e.resolved && seedSet.has(e.to)) bump(e.from);
  }

  return [...weights.entries()]
    .map(([node, weight]) => ({ node, weight }))
    .sort((a, b) => b.weight - a.weight || a.node.localeCompare(b.node));
}

export function graphToJSON(graph: MemoryGraph): string {
  return JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2);
}
