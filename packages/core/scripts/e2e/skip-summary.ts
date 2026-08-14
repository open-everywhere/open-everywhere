export type SkipKind =
  | "filtered-only"
  | "filtered-suite"
  | "filtered-surface"
  | "missing-capability"
  | "optional-not-included"
  | "scenario-self-skip";

export const SKIP_KINDS: readonly SkipKind[] = [
  "filtered-only",
  "filtered-suite",
  "filtered-surface",
  "missing-capability",
  "optional-not-included",
  "scenario-self-skip",
];

export function emptySkipCounts(): Record<SkipKind, number> {
  const counts = {} as Record<SkipKind, number>;
  for (const k of SKIP_KINDS) counts[k] = 0;
  return counts;
}

export function renderSkipBreakdown(counts: Readonly<Record<SkipKind, number>>): string {
  const parts = SKIP_KINDS.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}
