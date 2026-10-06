import { readAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { toolForActionKind } from "../access/approver-chain.js";
import {
  APPROVAL_JUDGE_ADMIN_DISARM,
  APPROVAL_JUDGE_ADMIN_REARM,
  recordApprovalJudgeContradiction,
} from "../access/approval-judge.js";
import { orgWideWhere, whereFromScope } from "./actions.js";
import type { PendingActionRow } from "./types.js";
import type { DecisionVenueDetail } from "./flow.js";

export const JUDGE_LIFT_DECIDED_BY = "chain:judge";

export type ContradictionRoute = "click" | "control";

const CONTRADICTION_OVERRULE = "overrule";

export type ContradictJudgeAllowOutcome =
  | "recorded"
  | "unknown"
  | "not-judge-lift"
  | "already-recorded";

export interface ContradictJudgeAllowInput {
  readonly org: string;
  readonly id: string;
  readonly principalId: string;
  readonly route: ContradictionRoute;
  readonly venue?: DecisionVenueDetail;
}

export interface ContradictJudgeAllowResult {
  readonly outcome: ContradictJudgeAllowOutcome;
  readonly row?: PendingActionRow;
}

async function alreadyContradicted(org: string, pendingId: string): Promise<boolean> {
  try {
    const rows = await readAudit({ org, action: "approval.judge.contradicted", limit: 1000 });
    return rows.some((r) => (r.detail as { id?: unknown } | undefined)?.id === pendingId);
  } catch {
    return false;
  }
}

function frozenConnectorOp(kind: string, argsJson: string): string | undefined {
  if (kind !== "op.connector") return undefined;
  try {
    const tool = (JSON.parse(argsJson) as { tool?: unknown } | null)?.tool;
    return typeof tool === "string" ? tool : undefined;
  } catch {
    return undefined;
  }
}

export async function contradictJudgeAllow(input: ContradictJudgeAllowInput): Promise<ContradictJudgeAllowResult> {
  const row = await getOperationalStore().getPendingAction(input.org, input.id);
  if (!row) return { outcome: "unknown" };
  if (row.status !== "approved" || row.decidedBy !== JUDGE_LIFT_DECIDED_BY) return { outcome: "not-judge-lift", row };
  if (await alreadyContradicted(row.org, row.id)) return { outcome: "already-recorded", row };

  const tool = toolForActionKind(row.kind) ?? frozenConnectorOp(row.kind, row.argsJson);
  await recordApprovalJudgeContradiction(
    { ...whereFromScope(input.org, row.scopeKey), principalId: input.principalId },
    {
      id: row.id,
      kind: row.kind,
      ...(tool !== undefined ? { tool } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
      judgeVerdict: "allow",
      humanAction: CONTRADICTION_OVERRULE,
      route: input.route,
      ...(input.venue ?? {}),
    },
  );
  return { outcome: "recorded", row };
}

export function judgeContradictionNotice(outcome: ContradictJudgeAllowOutcome): string {
  switch (outcome) {
    case "recorded":
      return "recorded — your overrule is in the audit trail for review. It does NOT undo the action (it already ran) and it does not turn the approval judge off; an operator does that with the control plane's disarm.";
    case "already-recorded":
      return "this action was already flagged, so it is in the trail once. Nothing changed.";
    case "not-judge-lift":
      return "this action was not auto-approved by the approval judge, so there is no judge verdict to overrule.";
    case "unknown":
      return "that action is no longer known (it may have aged out).";
  }
}

export type JudgeOperatorScope = { readonly domain: string; readonly orgWide?: never } | { readonly domain?: never; readonly orgWide: true };

export type DisarmApprovalJudgeInput = {
  readonly org: string;
  readonly principalId: string;
} & JudgeOperatorScope;

export type RearmApprovalJudgeInput = DisarmApprovalJudgeInput;

function operatorWhere(input: DisarmApprovalJudgeInput): { org: string; platform: string; workspace: string; surface?: string } {
  return input.domain === undefined ? orgWideWhere(input.org) : whereFromScope(input.org, input.domain);
}

function operatorAddress(input: DisarmApprovalJudgeInput): { domain: string } | { orgWide: true } {
  return input.domain === undefined ? { orgWide: true } : { domain: input.domain };
}

export async function disarmApprovalJudge(input: DisarmApprovalJudgeInput): Promise<void> {
  await recordApprovalJudgeContradiction(
    { ...operatorWhere(input), principalId: input.principalId },
    {
      ...operatorAddress(input),
      judgeVerdict: "allow",
      humanAction: APPROVAL_JUDGE_ADMIN_DISARM,
      route: "control",
    },
  );
}

export async function rearmApprovalJudge(input: RearmApprovalJudgeInput): Promise<void> {
  await recordApprovalJudgeContradiction(
    { ...operatorWhere(input), principalId: input.principalId },
    {
      ...operatorAddress(input),
      humanAction: APPROVAL_JUDGE_ADMIN_REARM,
      route: "control",
    },
  );
}
