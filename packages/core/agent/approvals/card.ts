import type { PendingActionRow } from "./types.js";
import {
  APPROVAL_CARD_METADATA_TYPE,
  approvalCardBlockId,
  cappedDetail,
  approvalCardMetadata,
  cardFooter,
  decidedCardLine,
  footerRequester,
  JUDGE_LIFT_BUTTON,
  judgeLiftLines,
  pendingCardLayout,
  pendingCardLines,
  type CardMeta,
  type CardOption,
  type CardOptionTone,
  type PendingCardLayout,
} from "./card-layout.js";
import { plainSummaryForRow } from "./plain-summary.js";

const APPROVAL_PREFIX = "oe_approval:";

export interface SlackBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RenderedCard {
  readonly blocks: readonly SlackBlock[];
  readonly text: string;
  readonly metadata?: { readonly event_type: string; readonly event_payload: Record<string, unknown> };
}

function headlineBlock(headline: string, blockId: string): SlackBlock {
  return { type: "section", block_id: blockId, text: { type: "mrkdwn", text: `*${headline}*` } };
}

function consequenceSection(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function decidedSection(text: string, blockId: string): SlackBlock {
  return { type: "section", block_id: blockId, text: { type: "mrkdwn", text } };
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
    ...(layout.consequence !== undefined ? [consequenceSection(layout.consequence)] : []),
    contextBlock(cardFooter(footerRequester(row, "slack"), layout.expiry)),
    { type: "actions", block_id: `oe_approval_actions:${row.id}`, elements: optionButtons(row, layout.options) },
  ];
}

export function pendingCardBlocks(row: PendingActionRow, summaryLines: readonly string[]): RenderedCard {
  const layout = pendingCardLayout(row, summaryLines);
  return {
    blocks: pendingRowBlocks(row, layout, headlineBlock(layout.headline, approvalCardBlockId(row))),
    text: [...pendingCardLines(layout), cardFooter(footerRequester(row, "slack"), layout.expiry)].join("\n"),
    metadata: approvalCardMetadata(layout.meta, row.status),
  };
}

export function judgeLiftNoticeBlocks(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): RenderedCard {
  const [headline, ...rest] = judgeLiftLines(row, outcomeLine);
  const outcome = rest.pop()!;
  const blocks: SlackBlock[] = [
    headlineBlock(headline!, approvalCardBlockId(row)),
    ...rest.map(consequenceSection),
    contextBlock(outcome),
    {
      type: "actions",
      block_id: `oe_approval_actions:${row.id}`,
      elements: [
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: JUDGE_LIFT_BUTTON, emoji: true },
          action_id: `${APPROVAL_PREFIX}contradict:${row.id}`,
          value: row.org,
        },
      ],
    },
  ];
  return { blocks, text: [headline, ...rest, outcome].join("\n"), metadata: approvalCardMetadata(cardMetaFor(row, summaryLines), "lifted") };
}

export function judgeLiftNoticeText(row: PendingActionRow, _summaryLines: readonly string[], outcomeLine: string): string {
  return [...judgeLiftLines(row, outcomeLine), "If it should not have run, say so in this conversation."].join("\n");
}

function cardMetaFor(row: PendingActionRow, summaryLines: readonly string[]): CardMeta {
  return { kind: row.kind, id: row.id, detail: [...summaryLines] };
}

function decidedContextLine(row: PendingActionRow, outcomeLine: string | undefined): string {
  return decidedCardLine(row, outcomeLine, `<@${row.decidedBy}>`);
}

export function decidedCardBlocks(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): RenderedCard {
  const line = decidedContextLine(row, outcomeLine);
  return { blocks: [decidedSection(line, approvalCardBlockId(row))], text: line, metadata: approvalCardMetadata(cardMetaFor(row, summaryLines), row.status) };
}

export interface GroupedCardItem {
  readonly row: PendingActionRow;
  readonly summaryLines: readonly string[];
  readonly outcomeLine?: string;
}

export const GROUPED_CARD_MAX_ITEMS = 5;

export function groupedHeadline(total: number, open: number): string {
  if (open === 0) return `${total} approvals for one job, all decided`;
  return `${total} approvals for one job, ${open} still open`;
}

export function groupedCardBlocks(items: readonly GroupedCardItem[]): RenderedCard {
  const open = items.filter((i) => i.row.status === "pending").length;
  const title = groupedHeadline(items.length, open);
  const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: title, emoji: true } }];
  items.forEach((item, n) => {
    blocks.push({ type: "divider" });
    if (item.row.status === "pending") {
      const itemHeadline = headlineBlock(`${n + 1}. ${plainSummaryForRow(item.row)}`, approvalCardBlockId(item.row));
      blocks.push(...pendingRowBlocks(item.row, pendingCardLayout(item.row, item.summaryLines), itemHeadline));
    } else {
      blocks.push(decidedSection(`${n + 1}. ${decidedContextLine(item.row, item.outcomeLine)}`, approvalCardBlockId(item.row)));
    }
  });
  const lines = items.map((i, n) => `${n + 1}. ${i.row.status === "pending" ? plainSummaryForRow(i.row) : decidedContextLine(i.row, i.outcomeLine)}`);
  const metadata = {
    event_type: APPROVAL_CARD_METADATA_TYPE,
    event_payload: { kind: "grouped", items: items.map((i) => ({ kind: i.row.kind, id: i.row.id, status: i.row.status, detail: cappedDetail(i.summaryLines) })) },
  };
  return { blocks, text: `${title}\n${lines.join("\n")}`, metadata };
}
