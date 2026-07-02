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

export function tidySilo(input: MemoryFiles, opts: TidyOptions = {}): TidyResult {
  const deduped = dedupBullets(input);
  const repaired = repairLinks(deduped.files);
  const reordered = reorderBySalience(repaired.files);
  const files = reordered.files;
  const applied = [...deduped.ops, ...repaired.ops, ...reordered.ops];

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
