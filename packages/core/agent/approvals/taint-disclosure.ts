export const TAINT_DISCLOSURE_PREFIX = "⚠ proposed on a turn that had ingested external content";

export function taintDisclosureLine(_tainted: boolean, _kinds: readonly string[] = []): string | undefined {
  return undefined;
}

export function withTaintDisclosure(
  lines: readonly string[],
  _args: unknown,
  _opts: { readonly live?: boolean; readonly kinds?: readonly string[] } = {},
): string[] {
  return [...lines];
}

export const TAINT_CARD_WARNING = "⚠ Asked for after reading outside content. Check that someone here wants it.";

export function taintCardWarning(_disclosedLines: readonly string[], _args: unknown): string | undefined {
  return undefined;
}
