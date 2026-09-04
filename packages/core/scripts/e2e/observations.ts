export interface Observation {
  readonly scenario: string;
  readonly line: string;
}

export function renderObservationSummary(observations: readonly Observation[]): {
  readonly stream: "stdout" | "stderr";
  readonly lines: readonly string[];
} {
  if (observations.length === 0) return { stream: "stdout", lines: [] };
  return {
    stream: "stderr",
    lines: [
      `⚠ observations (non-gating): ${observations.length} measured fact(s) reported. ` +
        "These do NOT fail the run — read them, do not roll back on them.",
      ...observations.map((o) => `  ⚠ ${o.scenario}: ${o.line}`),
    ],
  };
}
