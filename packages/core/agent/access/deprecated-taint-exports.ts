export type IngestionTier = "trusted" | "untrusted";

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

export interface IngestionSource {
  readonly kind: IngestionKind;
  readonly repoPrivate?: boolean;
  readonly workspaceTrust?: "internal" | "public";
  readonly grantContentOrigin?: "internal" | "external";
  readonly authoredByNonMember?: boolean;
  readonly carriesUntrustedPost?: boolean;
  readonly label?: string;
}

export interface IngestionVerdict {
  readonly tier: IngestionTier;
  readonly reason: string;
  readonly assumed: boolean;
}

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

export function classifyIngestion(_src: IngestionSource): IngestionVerdict {
  return SHIM_VERDICT;
}

export function noteIngestionVerdict(_src: IngestionSource | undefined, _taintsToday: boolean): void {
}

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

export function registerTaintVerdictSink(_fn: ((row: TaintVerdictRow) => void) | null): void {
}

export function currentTaintVerdictSink(): ((row: TaintVerdictRow) => void) | null {
  return null;
}

export function taintMarkLands(): boolean {
  return false;
}

export function untrustedIngestedThisTurn(): boolean {
  return false;
}

export function taintKindsThisTurn(): readonly string[] {
  return [];
}

export const OE_TAINTED_FIRE_ATTR = "oe_tainted_fire";

export function taintedFireAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_TAINTED_FIRE_ATTR]: "true" } : {};
}

export function chatReadIngestion(label: string, _out: { readonly authoredByNonMember?: boolean; readonly carriesUntrustedPost?: boolean } = {}): IngestionSource {
  return { kind: "chat-message", label };
}
