/** @deprecated OPE-2721: the source-tier table is removed. The value is ignored. */
export type IngestionTier = "trusted" | "untrusted";

/** @deprecated OPE-2721: the source-tier table is removed. The value is ignored. */
export type IngestionKind =
  | "chat-message"
  | "notion"
  | "linear"
  | "github"
  | "connector"
  | "web"
  | "webhook"
  | "a2a-inbound"
  | "routine-event"
  | "delegation-result"
  | "image-description"
  | "file-upload"
  | "aws"
  | "skill-declared"
  | "work-search";

/** @deprecated OPE-2721: the source-tier table is removed. An `ingestion` option of this shape on */
export interface IngestionSource {
  readonly kind: IngestionKind;
  readonly repoPrivate?: boolean;
  readonly workspaceTrust?: "internal" | "public";
  readonly grantContentOrigin?: "internal" | "external";
  readonly authoredByNonMember?: boolean;
  readonly carriesUntrustedPost?: boolean;
  readonly label?: string;
}

/** @deprecated OPE-2721: the source-tier table is removed. */
export interface IngestionVerdict {
  readonly tier: IngestionTier;
  readonly reason: string;
  readonly assumed: boolean;
}

/** @deprecated OPE-2721: every kind the removed table named, kept for the published constant only. */
export const INGESTION_KINDS: readonly IngestionKind[] = [
  "chat-message",
  "notion",
  "linear",
  "github",
  "connector",
  "web",
  "webhook",
  "a2a-inbound",
  "routine-event",
  "delegation-result",
  "image-description",
  "file-upload",
  "aws",
  "skill-declared",
  "work-search",
];

const SHIM_VERDICT: IngestionVerdict = Object.freeze({
  tier: "untrusted",
  reason: "the source-tier table is removed (OPE-2721); every outside body is fenced and nothing is marked",
  assumed: true,
});

/** @deprecated OPE-2721: no table. Always the same fixed verdict, which decides nothing. */
export function classifyIngestion(_src: IngestionSource): IngestionVerdict {
  return SHIM_VERDICT;
}

/** @deprecated OPE-2721: no verdict log. Does nothing. */
export function noteIngestionVerdict(_src: IngestionSource | undefined, _taintsToday: boolean): void {
}

/** @deprecated OPE-2721: the shape a removed sink received. Nothing produces it. */
export interface TaintVerdictRow {
  readonly divergence: "over-taint" | "under-taint" | "assumed";
  readonly kind: IngestionKind;
  readonly label?: string;
  readonly mode: "enforced" | "dryrun";
  readonly applied: boolean;
  readonly taintsToday: boolean;
  readonly tableTier: IngestionTier;
  readonly assumed: boolean;
  readonly reason: string;
}

/** @deprecated OPE-2721: no verdict log. Does nothing, and nothing ever calls the sink. */
export function registerTaintVerdictSink(_fn: ((row: TaintVerdictRow) => void) | null): void {
}

/** @deprecated OPE-2721: always `null`. */
export function currentTaintVerdictSink(): ((row: TaintVerdictRow) => void) | null {
  return null;
}

/** @deprecated OPE-2721: no slot, so no mark lands anywhere. Always `false`. */
export function taintMarkLands(): boolean {
  return false;
}

/** @deprecated OPE-2721: no slot. Always `false`. */
export function untrustedIngestedThisTurn(): boolean {
  return false;
}

/** @deprecated OPE-2721: no slot. Always an empty list. */
export function taintKindsThisTurn(): readonly string[] {
  return [];
}

/** @deprecated OPE-2720: nothing reads this attribute. Kept for {@link taintedFireAttrs}. */
export const OE_TAINTED_FIRE_ATTR = "oe_tainted_fire";

/** @deprecated OPE-2720: the stamp it builds is ignored. OPE-2721 keeps the old return shape. */
export function taintedFireAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_TAINTED_FIRE_ATTR]: "true" } : {};
}

/** @deprecated OPE-2721: the chat read's source-tier declaration. Nothing reads it. Returns the bare `chat-message` shape. */
export function chatReadIngestion(label: string, _out: { readonly authoredByNonMember?: boolean; readonly carriesUntrustedPost?: boolean } = {}): IngestionSource {
  return { kind: "chat-message", label };
}
