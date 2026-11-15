/** @deprecated No card renders this prefix since OPE-2717. Kept for the public export only. */
export const TAINT_DISCLOSURE_PREFIX = "⚠ proposed on a turn that had ingested external content";

/** @deprecated No-op since OPE-2717: always `undefined`. */
export function taintDisclosureLine(_tainted: boolean, _kinds: readonly string[] = []): string | undefined {
  return undefined;
}

/** @deprecated No-op since OPE-2717: returns a copy of `lines`, unchanged. */
export function withTaintDisclosure(
  lines: readonly string[],
  _args: unknown,
  _opts: { readonly live?: boolean; readonly kinds?: readonly string[] } = {},
): string[] {
  return [...lines];
}

/** @deprecated No card renders this line since OPE-2717. Kept for the public export only. */
export const TAINT_CARD_WARNING = "⚠ Asked for after reading outside content. Check that someone here wants it.";

/** @deprecated No-op since OPE-2717: always `undefined`. */
export function taintCardWarning(_disclosedLines: readonly string[], _args: unknown): string | undefined {
  return undefined;
}
