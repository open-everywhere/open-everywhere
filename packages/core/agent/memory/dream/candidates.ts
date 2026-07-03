import { buildGraph, parseWikiLinks, resolveNode } from "../graph.js";
import type { MemoryFiles } from "../store.js";
import { contentWords, jaccard, isNegated, bulletDate } from "./ops.js";

export type CandidateKind = "consolidate" | "contradiction" | "stale";

export interface CandidateCluster {
  readonly kind: CandidateKind;
  readonly file: string;
  readonly bullets: readonly string[];
  readonly reason: string;
  readonly score: number;
}

export interface CandidateOptions {
  readonly now?: Date;
  readonly staleDays?: number;
  readonly overlapThreshold?: number;
  readonly subjectThreshold?: number;
  readonly maxCandidates?: number;
}

export const DEFAULT_CANDIDATE_CAP = 10;

const HUB_LINK_BULLETS = 5;

const isMd = (rel: string): boolean => /\.md$/i.test(rel);
const isBullet = (line: string): boolean => /^\s*-\s+/.test(line);

interface Ref {
  readonly line: string;
  readonly words: Set<string>;
  readonly negated: boolean;
  readonly date: string | null;
  readonly links: readonly string[];
}

function lineLinks(line: string, graph: ReturnType<typeof buildGraph>): string[] {
  return parseWikiLinks(line).map((t) => resolveNode(graph, t) ?? t.toLowerCase());
}

function refsFor(content: string, graph: ReturnType<typeof buildGraph>): Ref[] {
  const raw = content
    .split("\n")
    .filter(isBullet)
    .map((line) => ({ line, words: contentWords(line), negated: isNegated(line), date: bulletDate(line), links: lineLinks(line, graph) }));
  const linkCount = new Map<string, number>();
  for (const r of raw) for (const l of new Set(r.links)) linkCount.set(l, (linkCount.get(l) ?? 0) + 1);
  return raw.map((r) => ({ ...r, links: r.links.filter((l) => (linkCount.get(l) ?? 0) <= HUB_LINK_BULLETS) }));
}

function sharedLinks(a: Ref, b: Ref): number {
  if (a.links.length === 0 || b.links.length === 0) return 0;
  const set = new Set(a.links);
  return new Set(b.links.filter((l) => set.has(l))).size;
}

export function selectCandidates(files: MemoryFiles, opts: CandidateOptions = {}): CandidateCluster[] {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? 180;
  const overlapThreshold = opts.overlapThreshold ?? 0.5;
  const subjectThreshold = opts.subjectThreshold ?? 0.25;
  const cap = opts.maxCandidates ?? DEFAULT_CANDIDATE_CAP;
  const horizon = now.getTime() - staleDays * 24 * 60 * 60 * 1000;

  const graph = buildGraph(files);
  const out: CandidateCluster[] = [];

  for (const [file, content] of Object.entries(files)) {
    if (!isMd(file)) continue;
    const refs = refsFor(content, graph);

    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const a = refs[i];
        const b = refs[j];
        if (a.line.trim() === b.line.trim()) continue;
        const shared = sharedLinks(a, b);
        const overlap = jaccard(a.words, b.words);

        if (a.negated === b.negated && overlap >= overlapThreshold) {
          out.push({
            kind: "consolidate",
            file,
            bullets: [a.line, b.line],
            reason: `high word overlap (${overlap.toFixed(2)}) with matching polarity`,
            score: overlap + shared * 0.5,
          });
        } else if (shared > 0 || (a.negated !== b.negated && overlap >= subjectThreshold)) {
          out.push({
            kind: "contradiction",
            file,
            bullets: [a.line, b.line],
            reason:
              shared > 0
                ? `both reference the same [[link]] subject (${shared} shared)`
                : `same-subject overlap (${overlap.toFixed(2)}) with opposing polarity`,
            score: shared + overlap,
          });
        }
      }
    }

    for (const a of refs) {
      if (a.date === null) continue;
      const t = Date.parse(a.date);
      if (!Number.isFinite(t) || t >= horizon) continue;
      let best: { ref: Ref; score: number } | null = null;
      for (const b of refs) {
        if (b === a || b.date === null || b.date <= a.date) continue;
        const shared = sharedLinks(a, b);
        const overlap = jaccard(a.words, b.words);
        if (shared === 0 && overlap < subjectThreshold) continue;
        const score = shared + overlap;
        if (!best || score > best.score || (score === best.score && b.date > best.ref.date!)) best = { ref: b, score };
      }
      if (!best) continue;
      out.push({
        kind: "stale",
        file,
        bullets: [a.line, best.ref.line],
        reason: `dated ${a.date} (past the ${staleDays}d horizon) with a later same-subject bullet (${best.ref.date})`,
        score: best.score,
      });
    }
  }

  return out
    .sort((x, y) => y.score - x.score || x.file.localeCompare(y.file) || x.kind.localeCompare(y.kind) || x.bullets[0].localeCompare(y.bullets[0]))
    .slice(0, cap);
}
