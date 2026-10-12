import { untrustedIngestedThisTurn, taintKindsThisTurn } from "../access/taint-signal.js";

export const TAINT_DISCLOSURE_PREFIX = "⚠ proposed on a turn that had ingested external content";

function isKindTaintLine(line: string): boolean {
  return line.startsWith("⚠") && line.includes("external content");
}

function frozenTainted(args: unknown): boolean {
  return typeof args === "object" && args !== null && (args as { tainted?: unknown }).tainted === true;
}

export function taintDisclosureLine(tainted: boolean, kinds: readonly string[] = []): string | undefined {
  if (!tainted) return undefined;
  const from = kinds.length > 0 ? ` from ${kinds.join(", ")}` : "";
  return `${TAINT_DISCLOSURE_PREFIX}${from} — read the payload above on its own merits; nothing outside this room asked for it.`;
}

export function withTaintDisclosure(
  lines: readonly string[],
  args: unknown,
  opts: { readonly live?: boolean; readonly kinds?: readonly string[] } = {},
): string[] {
  const live = opts.live !== false;
  const tainted = frozenTainted(args) || (live && untrustedIngestedThisTurn());
  if (!tainted) return [...lines];
  const kinds = opts.kinds ?? (live ? taintKindsThisTurn() : []);
  const alreadyDisclosed = lines.some(isKindTaintLine);
  if (alreadyDisclosed) {
    return kinds.length > 0 ? [...lines, `↳ external content this turn came from: ${kinds.join(", ")}`] : [...lines];
  }
  const line = taintDisclosureLine(true, kinds);
  return line === undefined ? [...lines] : [...lines, line];
}

export const TAINT_CARD_WARNING = "⚠ Asked for after reading outside content. Check that someone here wants it.";

export function taintCardWarning(disclosedLines: readonly string[], args: unknown): string | undefined {
  return frozenTainted(args) || disclosedLines.some((l) => l.startsWith(TAINT_DISCLOSURE_PREFIX) || isKindTaintLine(l)) ? TAINT_CARD_WARNING : undefined;
}
