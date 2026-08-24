import { readAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { toolForActionKind } from "../access/approver-chain.js";
import {
  APPROVAL_JUDGE_ADMIN_DISARM,
  APPROVAL_JUDGE_BREAKER_WINDOW_DAYS,
  recordApprovalJudgeContradiction,
} from "../access/approval-judge.js";
import { whereFromScope } from "./actions.js";
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

async function alreadyContradicted(pendingId: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - APPROVAL_JUDGE_BREAKER_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = await readAudit({ action: "approval.judge.contradicted", since, limit: 1000 });
    return rows.some((r) => (r.detail as { id?: unknown } | undefined)?.id === pendingId);
  } catch {
    return false;
  }
}

export async function contradictJudgeAllow(input: ContradictJudgeAllowInput): Promise<ContradictJudgeAllowResult> {
  const row = await getOperationalStore().getPendingAction(input.org, input.id);
  if (!row) return { outcome: "unknown" };
  if (row.status !== "approved" || row.decidedBy !== JUDGE_LIFT_DECIDED_BY) return { outcome: "not-judge-lift", row };
  if (await alreadyContradicted(row.id)) return { outcome: "already-recorded", row };

  const tool = toolForActionKind(row.kind);
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
      return "recorded — the approval judge is now one overrule closer to being disarmed for this domain. This does NOT undo the action; it already ran.";
    case "already-recorded":
      return "this action was already flagged, so it still counts once. Nothing changed.";
    case "not-judge-lift":
      return "this action was not auto-approved by the approval judge, so there is no judge verdict to overrule.";
    case "unknown":
      return "that action is no longer known (it may have aged out).";
  }
}

export interface DisarmApprovalJudgeInput {
  readonly org: string;
  readonly domain: string;
  readonly principalId: string;
}

export async function disarmApprovalJudge(input: DisarmApprovalJudgeInput): Promise<void> {
  await recordApprovalJudgeContradiction(
    { ...whereFromScope(input.org, input.domain), principalId: input.principalId },
    {
      domain: input.domain,
      judgeVerdict: "allow",
      humanAction: APPROVAL_JUDGE_ADMIN_DISARM,
      route: "control",
    },
  );
}
