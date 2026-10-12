export type PendingStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingActionRow {
  readonly id: string;
  readonly org: string;
  readonly kind: string;
  readonly argsJson: string;
  readonly scopeKey: string;
  readonly domain: string | null;
  readonly requestedBy: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly messageTs: string | null;
  readonly postedTo: string | null;
  readonly groupKey?: string | null;
  readonly status: PendingStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export type ApproverPolicy = "admin" | "member";

export interface ActionKind<A = unknown> {
  readonly kind: string;
  readonly policy: ApproverPolicy;
  readonly beneficiaryClicker?: true;
  readonly volatileArgs?: readonly string[];
  readonly proseArgs?: readonly string[];
  readonly approvalArmsCall?: true;
  armedCallReplay?(args: A): { readonly connection: string; readonly tool: string } | undefined;
  argsAfterClose?(args: A): A;
  summarize(args: A): string[];
  plainSummary(args: A): string;
  consequence?(args: A): string | undefined;
  doneSummary?(args: A): string;
  readonly consequenceQuotes?: true;
  execute(args: A, decidedBy: string): Promise<string>;
  declined?(args: A, decidedBy: string): Promise<string>;
}
