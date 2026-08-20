export interface CalibrationDraw<V extends string> {
  readonly fixture: number;
  readonly got: V;
}

export interface CalibrationFixture<V extends string> {
  readonly counts: Partial<Record<V, number>>;
  readonly unanimous: boolean;
  readonly correct: number;
  readonly of: number;
}

export interface CalibrationSummary {
  readonly fixtures: number;
  readonly draws: number;
  readonly unstable: number;
  readonly flipRate: number;
  readonly correctDraws: number;
  readonly accuracy: number;
}

export function summariseAxis<V extends string>(
  want: readonly V[],
  draws: readonly CalibrationDraw<V>[],
): { readonly summary: CalibrationSummary; readonly perFixture: readonly CalibrationFixture<V>[] } {
  let unstable = 0;
  let correctDraws = 0;
  const perFixture = want.map((expected, i) => {
    const got = draws.filter((d) => d.fixture === i).map((d) => d.got);
    if (got.length === 0) throw new Error(`judge calibration: fixture ${i} has no draws — a fixture the run never asked cannot be scored as stable or unstable`);
    const counts: Partial<Record<V, number>> = {};
    for (const v of got) counts[v] = (counts[v] ?? 0) + 1;
    const unanimous = Object.keys(counts).length === 1;
    const correct = got.filter((v) => v === expected).length;
    if (!unanimous) unstable++;
    correctDraws += correct;
    return { counts, unanimous, correct, of: got.length };
  });
  return {
    summary: {
      fixtures: want.length,
      draws: draws.length,
      unstable,
      flipRate: want.length === 0 ? 0 : unstable / want.length,
      correctDraws,
      accuracy: draws.length === 0 ? 0 : correctDraws / draws.length,
    },
    perFixture,
  };
}

export function calibrationPassed(summary: CalibrationSummary): boolean {
  return summary.unstable === 0 && summary.correctDraws === summary.draws;
}

export function distribution<V extends string>(counts: Partial<Record<V, number>>): string {
  return Object.entries(counts).map(([v, n]) => `${v}×${String(n)}`).join(" ");
}

export function fixtureMark(f: { readonly unanimous: boolean; readonly correct: number; readonly of: number }): string {
  if (!f.unanimous) return " FLIPS";
  return f.correct === f.of ? "  ok  " : " WRONG";
}
