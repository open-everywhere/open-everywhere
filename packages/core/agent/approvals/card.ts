import type { PendingActionRow } from "./types.js";
import { approvalLabel, pendingCardLayout, type CardOption, type CardOptionTone, type PendingCardLayout } from "./card-layout.js";
import { plainSummaryForRow } from "./plain-summary.js";

const APPROVAL_PREFIX = "oe_approval:";

export interface SlackBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RenderedCard {
  readonly blocks: readonly SlackBlock[];
  readonly text: string;
}

function headlineBlock(headline: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text: headline, emoji: true } };
}

function summarySection(summaryLines: readonly string[]): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: summaryLines.join("\n") } };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

const BUTTON_STYLE: Record<CardOptionTone, "primary" | "danger" | undefined> = { primary: "primary", danger: "danger", neutral: undefined };

function optionButtons(row: PendingActionRow, options: readonly CardOption[]): SlackBlock[] {
  return options.map((o) => {
    const style = BUTTON_STYLE[o.tone];
    return {
      type: "button",
      ...(style ? { style } : {}),
      text: { type: "plain_text", text: o.label, emoji: true },
      action_id: `${APPROVAL_PREFIX}${o.verb}:${row.id}`,
      value: row.org,
      ...(o.confirm
        ? {
            confirm: {
              title: { type: "plain_text", text: o.confirm.title },
              text: { type: "plain_text", text: o.confirm.text },
              confirm: { type: "plain_text", text: o.confirm.yes },
              deny: { type: "plain_text", text: o.confirm.no },
            },
          }
        : {}),
    };
  });
}

function pendingRowBlocks(row: PendingActionRow, layout: PendingCardLayout, headline: SlackBlock): SlackBlock[] {
  return [
    headline,
    contextBlock(layout.label),
    summarySection(layout.detail),
    contextBlock(`Requested by <@${layout.requestedBy}> · ${layout.expiry}`),
    { type: "actions", block_id: `oe_approval_actions:${row.id}`, elements: optionButtons(row, layout.options) },
  ];
}

export function pendingCardBlocks(row: PendingActionRow, summaryLines: readonly string[]): RenderedCard {
  const layout = pendingCardLayout(row, summaryLines);
  const requestedContext = `Requested by <@${row.requestedBy}> · ${layout.expiry}`;
  return {
    blocks: pendingRowBlocks(row, layout, headlineBlock(layout.headline)),
    text: `${layout.headline}\n${layout.label}\n${summaryLines.join(" · ")}\n${requestedContext}`,
  };
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

export function judgeLiftNoticeText(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): string {
  return [
    `Ran without asking: ${row.kind}`,
    ...summaryLines,
    `⚡ Auto-approved by the approval judge — no card was posted and this has already run · ${outcomeLine}`,
    `This surface cannot carry the "This should not have run" button, so there is nothing to tap here. If it should not have run, say so in this conversation and quote action ${row.id} — that is the id the act is recorded under in the audit trail. An operator stops the judge lifting further acts from the control plane.`,
  ].join("\n");
}

function decidedContextLine(row: PendingActionRow, outcomeLine: string | undefined): string {
  if (outcomeLine === undefined) {
    return row.status === "approved" ? `✅ Approved by <@${row.decidedBy}>` : row.status === "rejected" ? `❌ Rejected by <@${row.decidedBy}>` : "⏰ Expired";
  }
  return row.status === "approved"
    ? `✅ Approved by <@${row.decidedBy}> · ${outcomeLine}`
    : row.status === "rejected"
      ?
        `❌ Rejected by <@${row.decidedBy}>${outcomeLine === "rejected" ? "" : ` · ${outcomeLine}`}`
      : "⏰ Expired";
}

export function decidedCardBlocks(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): RenderedCard {
  const decidedContext = decidedContextLine(row, outcomeLine);
  const headline = plainSummaryForRow(row);
  const blocks: SlackBlock[] = [headlineBlock(headline), contextBlock(approvalLabel(row.kind)), summarySection(summaryLines), contextBlock(decidedContext)];
  return { blocks, text: `${headline}\n${approvalLabel(row.kind)}\n${summaryLines.join(" · ")}\n${decidedContext}` };
}

export interface GroupedCardItem {
  readonly row: PendingActionRow;
  readonly summaryLines: readonly string[];
  readonly outcomeLine?: string;
}

export const GROUPED_CARD_MAX_ITEMS = 5;

export function groupedHeadline(total: number, open: number): string {
  if (open === 0) return `One job asked for ${total} approvals — all decided`;
  return `One job asks for ${total} approvals — ${open} still need${open === 1 ? "s" : ""} a decision`;
}

export function groupedCardBlocks(items: readonly GroupedCardItem[]): RenderedCard {
  const open = items.filter((i) => i.row.status === "pending").length;
  const title = groupedHeadline(items.length, open);
  const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: title, emoji: true } }];
  items.forEach((item, n) => {
    const headline = plainSummaryForRow(item.row);
    const itemHeadline: SlackBlock = { type: "section", text: { type: "plain_text", text: `${n + 1}. ${headline}`, emoji: true } };
    blocks.push({ type: "divider" });
    if (item.row.status === "pending") {
      blocks.push(...pendingRowBlocks(item.row, pendingCardLayout(item.row, item.summaryLines), itemHeadline));
    } else {
      blocks.push(itemHeadline, contextBlock(approvalLabel(item.row.kind)), summarySection(item.summaryLines), contextBlock(decidedContextLine(item.row, item.outcomeLine)));
    }
  });
  const lines = items.map((i, n) => `${n + 1}. ${plainSummaryForRow(i.row)}`);
  return { blocks, text: `${title}\n${approvalLabel("grouped")}\n${lines.join("\n")}` };
}
