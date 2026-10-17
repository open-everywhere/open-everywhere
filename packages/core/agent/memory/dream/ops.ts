import { buildGraph, resolveNode } from "../graph.js";
import { conserveProvenanceOnMerge, donorOf, provenanceCarrierPattern } from "../provenance-mark.js";
import type { MemoryFiles } from "../store.js";
import { salienceMap } from "./salience.js";

export type OpKind =
  | "dedup"
  | "link-repair"
  | "salience-reorder"
  | "consolidate"
  | "contradiction"
  | "supersede"
  | "stale";

export const SAFE_KINDS: readonly OpKind[] = ["dedup", "link-repair", "salience-reorder"];
const DESTRUCTIVE_KINDS: readonly OpKind[] = ["consolidate", "contradiction", "supersede", "stale"];

export function isSafe(kind: OpKind): boolean {
  return (SAFE_KINDS as readonly string[]).includes(kind);
}

export interface MemoryOp {
  readonly kind: OpKind;
  readonly file: string;
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
}

const WIKILINK = /\[\[([^[\]]+?)\]\]/g;
const isMd = (rel: string): boolean => /\.md$/i.test(rel);
const isBullet = (line: string): boolean => /^\s*-\s+/.test(line);
const isPointerBullet = (line: string): boolean => /^\s*-\s+\[\[/.test(line);

export function dedupBullets(files: MemoryFiles): { files: MemoryFiles; ops: MemoryOp[] } {
  const out: MemoryFiles = {};
  const ops: MemoryOp[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!isMd(rel)) {
      out[rel] = content;
      continue;
    }
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const line of content.split("\n")) {
      if (isBullet(line)) {
        const key = line.trim();
        if (seen.has(key)) {
          ops.push({ kind: "dedup", file: rel, summary: `dropped duplicate bullet — ${key.slice(0, 72)}`, before: line });
          continue;
        }
        seen.add(key);
      }
      kept.push(line);
    }
    out[rel] = kept.join("\n");
  }
  return { files: out, ops };
}

export function repairLinks(files: MemoryFiles): { files: MemoryFiles; ops: MemoryOp[] } {
  const graph = buildGraph(files);
  const out: MemoryFiles = {};
  const ops: MemoryOp[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!isMd(rel)) {
      out[rel] = content;
      continue;
    }
    const rewritten = content.replace(WIKILINK, (whole, body: string) => {
      const [targetPart, ...aliasParts] = body.split("|");
      const [rawTarget, anchor] = targetPart.split("#");
      const target = rawTarget.trim();
      if (!target) return whole;
      const id = resolveNode(graph, target);
      if (!id || id === target) return whole;
      const anchorPart = anchor !== undefined ? `#${anchor}` : "";
      const aliasPart = aliasParts.length > 0 ? `|${aliasParts.join("|")}` : "";
      const replacement = `[[${id}${anchorPart}${aliasPart}]]`;
      ops.push({ kind: "link-repair", file: rel, summary: `[[${target}]] → [[${id}]]`, before: whole, after: replacement });
      return replacement;
    });
    out[rel] = rewritten;
  }
  return { files: out, ops };
}

function bulletTarget(line: string, graph: ReturnType<typeof buildGraph>): string | null {
  const m = line.match(/\[\[([^[\]]+?)\]\]/);
  if (!m) return null;
  return resolveNode(graph, m[1].split("|")[0].split("#")[0].trim());
}

export function reorderBySalience(files: MemoryFiles): { files: MemoryFiles; ops: MemoryOp[] } {
  const graph = buildGraph(files);
  const score = salienceMap(graph);
  const out: MemoryFiles = {};
  const ops: MemoryOp[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!isMd(rel)) {
      out[rel] = content;
      continue;
    }
    const lines = content.split("\n");
    let changed = false;
    let i = 0;
    while (i < lines.length) {
      if (!isPointerBullet(lines[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && isPointerBullet(lines[j])) j++;
      const run = lines.slice(i, j);
      const sorted = run
        .map((line, idx) => ({ line, idx, s: score.get(bulletTarget(line, graph) ?? "") ?? 0 }))
        .sort((a, b) => b.s - a.s || a.idx - b.idx)
        .map((e) => e.line);
      if (sorted.some((line, k) => line !== run[k])) {
        changed = true;
        ops.push({ kind: "salience-reorder", file: rel, summary: `reordered ${run.length} pointer bullet(s) by salience` });
        for (let k = 0; k < run.length; k++) lines[i + k] = sorted[k];
      }
      i = j;
    }
    out[rel] = changed ? lines.join("\n") : content;
  }
  return { files: out, ops };
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "by", "at", "as", "it", "its", "this", "that", "from",
  "see", "also", "via", "per", "our", "we", "you", "they", "he", "she",
]);
const NEGATION = /\b(not|no|never|n't|dont|doesn't|isn't|aren't|wasn't|stop(?:ped)?|deprecat(?:ed)?|remov(?:ed)?|cancel(?:led)?|drop(?:ped)?|no longer|instead of)\b/i;
const DATE_PREFIX = /^\s*-\s+(\d{4}-\d{2}-\d{2})\s*[:]?\s*/;

const PROVENANCE_CARRIER = provenanceCarrierPattern();

export function factText(line: string): string {
  return line.replace(PROVENANCE_CARRIER, " ");
}

interface BulletRef {
  readonly file: string;
  readonly line: string;
  readonly words: Set<string>;
  readonly negated: boolean;
}

export function isNegated(line: string): boolean {
  return NEGATION.test(factText(line));
}

export function bulletDate(line: string): string | null {
  return line.match(DATE_PREFIX)?.[1] ?? null;
}

export function contentWords(line: string): Set<string> {
  const body = factText(line)
    .replace(DATE_PREFIX, "")
    .replace(/^\s*-\s+/, "")
    .replace(WIKILINK, " ")
    .toLowerCase();
  const words = body.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
  return new Set(words);
}

function bulletRefs(files: MemoryFiles, exclude?: ReadonlySet<string>): BulletRef[] {
  const refs: BulletRef[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (!isMd(file)) continue;
    if (exclude?.has(file)) continue;
    for (const line of content.split("\n")) {
      if (!isBullet(line)) continue;
      refs.push({ file, line, words: contentWords(line), negated: isNegated(line) });
    }
  }
  return refs;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function factTokens(line: string): Set<string> {
  const body = factText(line)
    .replace(DATE_PREFIX, "")
    .replace(/^\s*-\s+/, "")
    .toLowerCase();
  return new Set(body.split(/[^a-z0-9]+/).filter((t) => t.length > 0));
}

export const RESTATEMENT_THRESHOLD = 0.9;

export function restatesDonor(survivor: string, sources: readonly string[], threshold = RESTATEMENT_THRESHOLD): boolean {
  const donor = donorOf(sources);
  if (donor === undefined) return false;
  if (isNegated(survivor) !== isNegated(donor)) return false;
  const survivorTokens = factTokens(survivor);
  const donorTokens = factTokens(donor);
  if (survivorTokens.size === 0 || donorTokens.size === 0) return false;
  for (const token of donorTokens) if (!survivorTokens.has(token)) return false;
  return jaccard(survivorTokens, donorTokens) >= threshold;
}

export function detectConsolidations(files: MemoryFiles, threshold = 0.7, exclude?: ReadonlySet<string>): MemoryOp[] {
  const refs = bulletRefs(files, exclude);
  const ops: MemoryOp[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i];
      const b = refs[j];
      if (a.file !== b.file) continue;
      if (a.line.trim() === b.line.trim()) continue;
      if (a.negated !== b.negated) continue;
      if (jaccard(a.words, b.words) < threshold) continue;
      const keep = a.line.length >= b.line.length ? a.line : b.line;
      const survivor = conserveProvenanceOnMerge(keep, [a.line, b.line]);
      ops.push({ kind: "consolidate", file: a.file, summary: `near-duplicate bullets — merge into one`, before: `${a.line}\n${b.line}`, after: survivor });
    }
  }
  return ops;
}

export function detectContradictions(files: MemoryFiles, subjectThreshold = 0.34, exclude?: ReadonlySet<string>): MemoryOp[] {
  const refs = bulletRefs(files, exclude);
  const ops: MemoryOp[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i];
      const b = refs[j];
      if (a.file !== b.file) continue;
      if (a.negated === b.negated) continue;
      if (jaccard(a.words, b.words) < subjectThreshold) continue;
      ops.push({ kind: "contradiction", file: a.file, summary: `possible contradiction (one bullet negates the other)`, before: `${a.line}\n${b.line}` });
    }
  }
  return ops;
}

export function detectStale(files: MemoryFiles, now: Date, staleDays = 180, exclude?: ReadonlySet<string>): MemoryOp[] {
  const horizon = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const ops: MemoryOp[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (!isMd(file)) continue;
    if (exclude?.has(file)) continue;
    for (const line of content.split("\n")) {
      const m = line.match(DATE_PREFIX);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (!Number.isFinite(t) || t >= horizon) continue;
      const ageDays = Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
      ops.push({ kind: "stale", file, summary: `bullet is ${ageDays}d old (> ${staleDays}d) — review or archive`, before: line });
    }
  }
  return ops;
}
