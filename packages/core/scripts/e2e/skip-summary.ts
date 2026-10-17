export type SkipKind =
  | "filtered-only"
  | "filtered-suite"
  | "filtered-surface"
  | "filtered-diff"
  | "stopped-first-red"
  | "missing-capability"
  | "expensive-not-included"
  | "fixture-missing"
  | "scenario-self-skip";

export const SKIP_KINDS: readonly SkipKind[] = [
  "filtered-only",
  "filtered-suite",
  "filtered-surface",
  "filtered-diff",
  "stopped-first-red",
  "missing-capability",
  "expensive-not-included",
  "fixture-missing",
  "scenario-self-skip",
];

export const GAP_SKIP_KINDS: readonly SkipKind[] = ["missing-capability", "fixture-missing", "scenario-self-skip"];

export function isGapKind(kind: SkipKind): boolean {
  return GAP_SKIP_KINDS.includes(kind);
}

export function emptySkipCounts(): Record<SkipKind, number> {
  const counts = {} as Record<SkipKind, number>;
  for (const k of SKIP_KINDS) counts[k] = 0;
  return counts;
}

export function renderSkipBreakdown(counts: Readonly<Record<SkipKind, number>>): string {
  const parts = SKIP_KINDS.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}
