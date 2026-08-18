import { renderWake, mkMessageTrigger, type NormalizedWake } from "../channels/normalized-wake.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";

export type ApprovalOutcome = "approved" | "rejected" | "expired";

export interface ApprovalDecisionWakeInput {
  readonly origin: UnifiedWakeOrigin;
  readonly wakeId: string;
  readonly summaryLine: string;
  readonly outcome: ApprovalOutcome;
  readonly clickerId?: string;
  readonly pendingId: string;
}

function originContainerId(origin: UnifiedWakeOrigin): string {
  switch (origin.platform) {
    case "slack":
      return origin.channelId;
    case "github":
      return `${origin.owner}/${origin.repo}`;
    case "linear":
      return origin.issueId;
    case "notion":
      return origin.discussionId;
    case "discord":
      return origin.channelId;
    case "teams":
      return origin.conversationId;
  }
}

function outcomeClause(outcome: ApprovalOutcome, clickerId?: string): string {
  const by = clickerId ? ` by <@${clickerId}>` : "";
  switch (outcome) {
    case "approved":
      return `has been APPROVED${by} and applied`;
    case "rejected":
      return `was REJECTED${by} and NOT applied`;
    case "expired":
      return `EXPIRED without a decision and was NOT applied`;
  }
}

export function approvalDecisionBody(input: ApprovalDecisionWakeInput): string {
  const closed =
    input.outcome === "approved"
      ? `Nothing more is needed from you unless someone asks a follow-up.`
      : `If someone still genuinely wants this change, treat a fresh request as a NEW proposal (a new card) — do not point anyone at the old, dead card, and do not re-propose unprompted.`;
  return (
    `A pending approval you were waiting on (id ${input.pendingId}) has been decided. The request ` +
    `"${input.summaryLine}" ${outcomeClause(input.outcome, input.clickerId)}.\n\n` +
    `The people in that thread have ALREADY been notified — a decision notice was posted there — so you do ` +
    `NOT need to announce this. Just update your understanding: this pending is now CLOSED, and you must ` +
    `never describe it as "still awaiting approval" or "already posted, just needs an admin to approve". ` +
    `${closed}\n\n` +
    `Staying silent is the right, common outcome here: if nothing genuinely needs saying, call \`no_reply\`.`
  );
}

export function buildApprovalDecisionWake(input: ApprovalDecisionWakeInput, nowIso: string): NormalizedWake {
  return {
    platform: input.origin.platform,
    reason: "dispatch",
    addressing: "channel-watch",
    wakeId: input.wakeId,
    locus: { channel: { id: originContainerId(input.origin) } },
    trigger: mkMessageTrigger({
      from: "system",
      author: "open-everywhere",
      id: `approval-decision-${input.pendingId}`,
      sentAt: nowIso,
      trust: "relay",
      body: approvalDecisionBody(input),
    }),
  };
}

export function renderApprovalDecisionMessage(input: ApprovalDecisionWakeInput, nowIso: string): string {
  return renderWake(buildApprovalDecisionWake(input, nowIso), () => nowIso).message;
}
