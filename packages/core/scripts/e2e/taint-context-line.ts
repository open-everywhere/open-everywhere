export const taintContextLine = (text: string): string => /context:[^\n]*/i.exec(text)?.[0] ?? "";

export const isLiveTaintLine = (line: string): boolean => line.length > 0 && !/supplied by the caller/i.test(line);

export type LiveTaintGateDecision = { readonly hard: false } | { readonly hard: true; readonly line: string };
export const liveTaintGateDecision = (contextLine: string): LiveTaintGateDecision =>
  isLiveTaintLine(contextLine) ? { hard: true, line: contextLine } : { hard: false };
