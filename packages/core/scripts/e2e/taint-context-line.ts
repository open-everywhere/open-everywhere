export const taintContextLine = (text: string): string => /context:[^\n]*/i.exec(text)?.[0] ?? "";

export const isLiveTaintLine = (line: string): boolean => line.length > 0 && !/supplied by the caller/i.test(line);

export type LiveTaintGateDecision = { readonly hard: false } | { readonly hard: true; readonly line: string };
export const liveTaintGateDecision = (contextLine: string): LiveTaintGateDecision =>
  isLiveTaintLine(contextLine) ? { hard: true, line: contextLine } : { hard: false };

export interface UnmeasuredArm {
  readonly arm: string;
  readonly what: string;
}

export const liveMeasurementSkipReason = (unmeasured: readonly UnmeasuredArm[]): string | undefined => {
  if (unmeasured.length === 0) return undefined;
  const arms = unmeasured.map((u) => `${u.arm} — ${u.what}`).join("; ");
  return (
    `${unmeasured.length} arm(s) RAN but measured nothing, so this leg proves no live route on this run: ${arms}. ` +
    `Every hard gate that DID have evidence passed — this is not a deployment verdict, and it is not a red: ` +
    `a worker that supplies its own \`tainted\` argument, or a doc-supervisor that declines to re-read a page it ` +
    `already summarised, is a model habit. It is a SKIP because a leg that measured nothing must not report a ` +
    `proof it did not make (OPE-1877: ships #216 and #217 both scored GREEN with these same arms silent).`
  );
};
