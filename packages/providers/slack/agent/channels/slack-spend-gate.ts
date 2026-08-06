import { ingressSpendGate, SLACK_SPEND_BADGES, spendRefusalCopy as coreSpendRefusalCopy, spendBypassWarnCopy as coreSpendBypassWarnCopy, type IngressSpendGateInput, type SpendGateDecision } from "@open-everywhere/core/agent/adapter-api.js";

export type { SpendGateDoor, SpendGateDecision, SpendGateAuditRow } from "@open-everywhere/core/agent/adapter-api.js";

export interface SlackSpendGateInput extends Omit<IngressSpendGateInput, "workspaceRef" | "badges" | "mode"> {
  readonly mode: NonNullable<IngressSpendGateInput["mode"]>;
  readonly teamId?: string | null;
}

export function spendRefusalCopy(reason: string | undefined, surfaceKey: string, workspaceKey: string, isDm = false): string {
  return coreSpendRefusalCopy(reason, surfaceKey, workspaceKey, isDm, SLACK_SPEND_BADGES.refusal);
}

export function spendBypassWarnCopy(reason: string | undefined): string {
  return coreSpendBypassWarnCopy(reason, SLACK_SPEND_BADGES.warning);
}

export function slackSpendGate(input: SlackSpendGateInput): Promise<SpendGateDecision> {
  const { teamId, ...rest } = input;
  return ingressSpendGate({ ...rest, workspaceRef: teamId ?? null, badges: SLACK_SPEND_BADGES });
}
