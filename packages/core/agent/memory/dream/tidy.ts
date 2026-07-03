import { buildGraph } from "../graph.js";
import type { MemoryFiles } from "../store.js";
import {
  dedupBullets,
  repairLinks,
  reorderBySalience,
  detectConsolidations,
  detectContradictions,
  detectStale,
  type MemoryOp,
} from "./ops.js";
import { salienceScores, type NodeSalience } from "./salience.js";
import { selectCandidates, type CandidateOptions } from "./candidates.js";
import type { DreamJudge } from "./judge.js";

export interface TidyOptions {
  readonly now?: Date;
  readonly staleDays?: number;
  readonly consolidateThreshold?: number;
}

export interface TidyResult {
  readonly files: MemoryFiles;
  readonly applied: readonly MemoryOp[];
  readonly proposals: readonly MemoryOp[];
  readonly salience: readonly NodeSalience[];
  readonly changed: boolean;
}

export interface JudgeStats {
  readonly candidates: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly failed: number;
}

export interface JudgedTidyResult extends TidyResult {
  readonly judged: JudgeStats;
}

function applySafeOps(input: MemoryFiles): { files: MemoryFiles; applied: MemoryOp[] } {
  const deduped = dedupBullets(input);
  const repaired = repairLinks(deduped.files);
  const reordered = reorderBySalience(repaired.files);
  return { files: reordered.files, applied: [...deduped.ops, ...repaired.ops, ...reordered.ops] };
}

export function tidySilo(input: MemoryFiles, opts: TidyOptions = {}): TidyResult {
  const { files, applied } = applySafeOps(input);

  const now = opts.now ?? new Date();
  const proposals = [
    ...detectConsolidations(files, opts.consolidateThreshold ?? 0.7),
    ...detectContradictions(files),
    ...detectStale(files, now, opts.staleDays ?? 180),
  ];

  const salience = salienceScores(buildGraph(files));
  const changed = JSON.stringify(files) !== JSON.stringify(input);
  return { files, applied, proposals, salience, changed };
}

export async function tidySiloJudged(
  input: MemoryFiles,
  scope: string,
  judge: DreamJudge,
  opts: TidyOptions & CandidateOptions = {},
): Promise<JudgedTidyResult> {
  const { files, applied } = applySafeOps(input);

  const candidates = selectCandidates(files, opts);
  const proposals: MemoryOp[] = [];
  let rejected = 0;
  let failed = 0;
  for (const c of candidates) {
    let verdict;
    try {
      verdict = await judge.judge(scope, c);
    } catch {
      verdict = null;
    }
    if (verdict === null) {
      failed++;
      continue;
    }
    if (!verdict.confirm) {
      rejected++;
      continue;
    }
    proposals.push({
      kind: c.kind,
      file: c.file,
      summary: `judge-confirmed ${c.kind} — ${verdict.note ?? c.reason}`,
      before: c.bullets.join("\n"),
      after: verdict.keep,
    });
  }

  const salience = salienceScores(buildGraph(files));
  const changed = JSON.stringify(files) !== JSON.stringify(input);
  return {
    files,
    applied,
    proposals,
    salience,
    changed,
    judged: { candidates: candidates.length, confirmed: proposals.length, rejected, failed },
  };
}
