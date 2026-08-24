import type { PendingActionRow } from "./types.js";
import { grantButtonLabel, sessionGrantKind } from "./session-grant.js";

const APPROVAL_PREFIX = "oe_approval:";

export interface SlackBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RenderedCard {
  readonly blocks: readonly SlackBlock[];
  readonly text: string;
}

function headerBlock(kind: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text: `Approval requested: ${kind}`, emoji: true } };
}

function summarySection(summaryLines: readonly string[]): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: summaryLines.join("\n") } };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

export function pendingCardBlocks(row: PendingActionRow, summaryLines: readonly string[]): RenderedCard {
  const requestedContext = `Requested by <@${row.requestedBy}> · expires ${row.expiresAt}`;
  const elements: SlackBlock[] = [
    {
      type: "button",
      style: "primary",
      text: { type: "plain_text", text: "Approve", emoji: true },
      action_id: `${APPROVAL_PREFIX}approve:${row.id}`,
      value: row.org,
    },
  ];
  if (sessionGrantKind(row) !== null) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: grantButtonLabel(row), emoji: true },
      action_id: `${APPROVAL_PREFIX}approve_session:${row.id}`,
      value: row.org,
    });
  }
  elements.push({
    type: "button",
    style: "danger",
    text: { type: "plain_text", text: "Reject", emoji: true },
    action_id: `${APPROVAL_PREFIX}reject:${row.id}`,
    value: row.org,
  });
  const blocks: SlackBlock[] = [
    headerBlock(row.kind),
    summarySection(summaryLines),
    contextBlock(requestedContext),
    { type: "actions", block_id: `oe_approval_actions:${row.id}`, elements },
  ];
  return { blocks, text: `Approval requested: ${row.kind}\n${summaryLines.join(" · ")}\n${requestedContext}` };
}

export function judgeLiftNoticeBlocks(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): RenderedCard {
  const context = `⚡ Auto-approved by the approval judge — no card was posted and this has already run · ${outcomeLine}`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Ran without asking: ${row.kind}`, emoji: true } },
    summarySection(summaryLines),
    contextBlock(context),
    {
      type: "actions",
      block_id: `oe_approval_actions:${row.id}`,
      elements: [
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "This should not have run", emoji: true },
          action_id: `${APPROVAL_PREFIX}contradict:${row.id}`,
          value: row.org,
        },
      ],
    },
  ];
  return { blocks, text: `Ran without asking: ${row.kind}\n${summaryLines.join(" · ")}\n${context}` };
}

export function decidedCardBlocks(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): RenderedCard {
  const decidedContext =
    row.status === "approved"
      ? `✅ Approved by <@${row.decidedBy}> · ${outcomeLine}`
      : row.status === "rejected"
        ? `❌ Rejected by <@${row.decidedBy}>`
        : "⏰ Expired";
  const blocks: SlackBlock[] = [headerBlock(row.kind), summarySection(summaryLines), contextBlock(decidedContext)];
  return { blocks, text: `Approval requested: ${row.kind}\n${summaryLines.join(" · ")}\n${decidedContext}` };
}
