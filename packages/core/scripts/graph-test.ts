// proves: MEM-20

import {
  parseWikiLinks,
  buildGraph,
  resolveNode,
  adjacencyBoost,
  graphToJSON,
} from "../agent/memory/graph.js";
import type { MemoryFiles } from "../agent/memory/store.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);

{
  eq(parseWikiLinks("see [[alpha]] and [[beta]]"), ["alpha", "beta"], "parse: multiple links per line");
  eq(parseWikiLinks("[[alpha]], [[beta]]."), ["alpha", "beta"], "parse: adjacent punctuation trimmed off");
  eq(parseWikiLinks("[[alpha|the alias]]"), ["alpha"], "parse: alias dropped (keeps target)");
  eq(parseWikiLinks("[[alpha#a-heading]]"), ["alpha"], "parse: heading anchor dropped");
  eq(parseWikiLinks("[[  spaced out  ]]"), ["spaced out"], "parse: inner whitespace trimmed");
  eq(parseWikiLinks("nothing here or [[]] or [[   ]]"), [], "parse: empty/whitespace links dropped");
  eq(parseWikiLinks("[[a]]\n[[b]]\n[[a]]"), ["a", "b", "a"], "parse: duplicates kept in order");
}

const files: MemoryFiles = {
  "MEMORY.md": "index: [[People]] and [[decisions/rollout]]",
  "people.md": "Ada owns billing — see [[rollout]]. Also [[People]] (self).",
  "decisions/rollout.md": "Decided by [[people]]. Depends on [[not-a-real-note]].",
  "ignore.txt": "[[people]] — non-markdown, must NOT become a node or be parsed",
};
{
  const g = buildGraph(files);
  eq([...g.nodes].sort(), ["MEMORY", "decisions/rollout", "people"], "graph: only .md files are nodes");

  const has = (from: string, to: string, resolved: boolean) =>
    g.edges.some((e) => e.from === from && e.to === to && e.resolved === resolved);

  ok(has("MEMORY", "people", true), "resolve: '[[People]]' → people (case-insensitive)");
  ok(has("MEMORY", "decisions/rollout", true), "resolve: path-qualified '[[decisions/rollout]]'");
  ok(has("people", "decisions/rollout", true), "resolve: bare basename '[[rollout]]' → decisions/rollout");
  ok(has("people", "people", true), "resolve: self-link kept");
  ok(has("decisions/rollout", "people", true), "resolve: '[[people]]' back-link");
  ok(has("decisions/rollout", "not-a-real-note", false), "resolve: dangling link kept, resolved=false");
  ok(!g.edges.some((e) => e.from === "ignore" || e.to === "ignore"), "resolve: non-md file neither node nor source");

  eq(resolveNode(g, "people.md"), "people", "resolveNode: relPath with extension resolves");
  eq(resolveNode(g, "Decisions / Rollout"), "decisions/rollout", "resolveNode: normalised path ref");
  eq(resolveNode(g, "missing"), null, "resolveNode: unknown ref → null");
}

{
  const g = buildGraph({
    "a/note.md": "x",
    "b/note.md": "y",
    "hub.md": "[[note]] is ambiguous; [[a/note]] is not",
  });
  ok(!g.edges.some((e) => e.from === "hub" && e.resolved && (e.to === "a/note" || e.to === "b/note") && e.to !== "a/note"),
    "ambiguous: bare '[[note]]' does not silently pick one");
  ok(g.edges.some((e) => e.from === "hub" && e.to === "note" && !e.resolved), "ambiguous: bare basename left unresolved");
  ok(g.edges.some((e) => e.from === "hub" && e.to === "a/note" && e.resolved), "ambiguous: path-qualified still resolves");
}

{
  const g = buildGraph({
    "hub.md": "[[a]] [[b]] [[c]]",
    "a.md": "[[b]]",
    "b.md": "[[a]]",
    "c.md": "leaf",
    "d.md": "[[hub]]",
  });

  const both = adjacencyBoost(g, ["hub"]);
  eq(both.map((n) => n.node).sort(), ["a", "b", "c", "d"].sort(), "boost: 1-hop neighbors of hub (both directions incl. d→hub)");
  eq(both.find((n) => n.node === "d")?.weight, 1, "boost: in-edge d→hub counts under 'both'");

  const out = adjacencyBoost(g, ["hub"], { direction: "out" });
  eq(out.map((n) => n.node).sort(), ["a", "b", "c"], "boost: direction=out excludes the d→hub in-edge");

  const pair = adjacencyBoost(g, ["a", "b"]);
  eq(pair.find((n) => n.node === "hub")?.weight, 2, "boost: shared neighbor weight accumulates across seeds");
  ok(!pair.some((n) => n.node === "a" || n.node === "b"), "boost: seeds excluded from their own result");

  eq(adjacencyBoost(g, ["does-not-exist"]), [], "boost: unresolved seeds → empty");
}

{
  const g = buildGraph({ "src.md": "[[real]] and [[ghost]]", "real.md": "here" });
  eq(adjacencyBoost(g, ["src"]).map((n) => n.node), ["real"], "boost: dangling neighbor excluded by default");
  ok(
    adjacencyBoost(g, ["src"], { includeUnresolved: true }).some((n) => n.node === "ghost"),
    "boost: includeUnresolved surfaces the dangling target",
  );
}

{
  const g = buildGraph({ "x.md": "[[y]]", "y.md": "" });
  const parsed = JSON.parse(graphToJSON(g));
  eq(parsed.nodes.sort(), ["x", "y"], "json: nodes serialised");
  ok(Array.isArray(parsed.edges) && parsed.edges[0].from === "x" && parsed.edges[0].to === "y", "json: edges serialised");
}

console.log(`✓ graph: ${passed} assertions passed`);
