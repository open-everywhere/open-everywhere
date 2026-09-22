export const taintContextLine = (text: string): string => {
  const occurrences: string[] = [];
  for (const match of text.matchAll(/context:/gi)) {
    const end = text.indexOf("\n", match.index);
    occurrences.push(text.slice(match.index, end === -1 ? undefined : end));
  }
  const rendered = occurrences.filter((line) => /unattended:\s*(true|false)/i.test(line) && /tainted:\s*(true|false)/i.test(line));
  return rendered.at(-1) ?? occurrences[0] ?? "";
};

export const isLiveTaintLine = (line: string): boolean => line.length > 0 && !/supplied by the caller/i.test(line);

export type LiveTaintGateDecision = { readonly hard: false } | { readonly hard: true; readonly line: string };
export const liveTaintGateDecision = (contextLine: string): LiveTaintGateDecision =>
  isLiveTaintLine(contextLine) ? { hard: true, line: contextLine } : { hard: false };

export interface UnmeasuredArm {
  readonly arm: string;
  readonly what: string;
}

export interface MeasurementVerdict {
  readonly cannotRun?: string;
  readonly logged: readonly string[];
}

export const liveMeasurementVerdict = (
  measured: readonly string[],
  unmeasured: readonly UnmeasuredArm[],
): MeasurementVerdict => {
  const logged = unmeasured.map(
    (u) =>
      `${u.arm} RAN but measured nothing: ${u.what}. LOGGED BY NAME, never a red (OPE-2031): a worker that ` +
      `supplies its own \`tainted\` argument, or a doc-supervisor that declines to re-read a page, is a model ` +
      `habit rather than a taint-plane defect. This run's live route proof rests on the arm(s) that DID measure` +
      (measured.length > 0 ? `: ${measured.join(", ")}.` : ` — and on this run there were NONE.`),
  );
  if (measured.length > 0 || unmeasured.length === 0) return { logged };
  const arms = unmeasured.map((u) => `${u.arm} — ${u.what}`).join("; ");
  return {
    cannotRun:
      `NO arm measured the live route on this run, so this leg proves nothing either way — ` +
      `${unmeasured.length} arm(s) RAN and measured nothing: ${arms}. ` +
      `Every hard gate that DID have evidence passed; this is not a deployment verdict and it is not a red. ` +
      `It is a SKIP because a leg that measured nothing must not report a proof it did not make (OPE-1877: ` +
      `ships #216 and #217 both scored GREEN with arms silent). It fires only on a TOTAL absence of evidence ` +
      `(OPE-2031): a run where any arm measured scores on that arm, and the silent ones are logged by name.`,
    logged,
  };
};
