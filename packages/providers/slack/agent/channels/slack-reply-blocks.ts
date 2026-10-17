import type { PostIntent, SourceLink } from "@open-everywhere/core/agent/adapter-api.js";

export const SLACK_FEEDBACK_ACTION_ID = "oe_feedback";

export const SLACK_FEEDBACK_VALUE_UP = "up";
export const SLACK_FEEDBACK_VALUE_DOWN = "down";

export const SLACK_FOLLOW_UP_ACTION_PREFIX = "oe_followup:";

export const SLACK_FOLLOW_UP_BLOCK_ID = "oe_followups";

export const SLACK_INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}]/u;

const BUTTON_TEXT_MAX = 75;

const SECTION_TEXT_MAX = 3000;

const MAX_BLOCKS = 50;

function escapeMrkdwn(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function chunkSlackSectionText(text: string, max: number = SECTION_TEXT_MAX): string[] {
  const fence = "```";
  const reopen = `${fence}\n`;
  const budget = max - 2 * reopen.length;
  const chunks: string[] = [];
  let cur = "";
  let open = false;
  const push = (): void => {
    chunks.push(open ? `${cur}\n${fence}` : cur);
    cur = open ? reopen : "";
  };
  for (const line of text.split("\n")) {
    let rest = line;
    for (;;) {
      const sep = cur.length === 0 || cur === reopen ? "" : "\n";
      if (cur.length + sep.length + rest.length <= budget) {
        cur += sep + rest;
        break;
      }
      if (sep.length > 0) {
        push();
        continue;
      }
      const cps = Array.from(rest);
      const room = budget - cur.length;
      cur += cps.slice(0, room).join("");
      rest = cps.slice(room).join("");
      push();
    }
    if ((line.split(fence).length - 1) % 2 === 1) open = !open;
  }
  if (cur.length > 0 && cur !== reopen) chunks.push(cur);
  return chunks;
}

export function slackSourcesLine(sources: readonly SourceLink[]): string {
  const items = sources.map((s, i) => `[${i + 1}] <${s.url}|${escapeMrkdwn(s.name)}>`);
  return `*Sources:*  ${items.join("  ·  ")}`;
}

function slackFeedbackBlock(): Record<string, unknown> {
  return {
    type: "context_actions",
    elements: [
      {
        type: "feedback_buttons",
        action_id: SLACK_FEEDBACK_ACTION_ID,
        positive_button: {
          text: { type: "plain_text", text: "Good response" },
          accessibility_label: "Mark this response as good",
          value: SLACK_FEEDBACK_VALUE_UP,
        },
        negative_button: {
          text: { type: "plain_text", text: "Bad response" },
          accessibility_label: "Mark this response as bad",
          value: SLACK_FEEDBACK_VALUE_DOWN,
        },
      },
    ],
  };
}

function slackFollowUpsBlock(followUps: readonly string[]): Record<string, unknown> | undefined {
  const fit = followUps.filter((f) => f.length > 0 && Array.from(f).length <= BUTTON_TEXT_MAX && !SLACK_INVISIBLE_CHARACTER.test(f));
  if (fit.length === 0) return undefined;
  return {
    type: "actions",
    block_id: SLACK_FOLLOW_UP_BLOCK_ID,
    elements: fit.map((text, i) => ({
      type: "button",
      action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}${i}`,
      text: { type: "plain_text", text, emoji: true },
      value: text,
    })),
  };
}

export function slackReplyBlocks(mrkdwn: string, intent: PostIntent | undefined): Record<string, unknown>[] | undefined {
  const sources = intent?.sources ?? [];
  const feedback = intent?.feedback === true;
  const followUps = slackFollowUpsBlock(intent?.followUps ?? []);
  if (sources.length === 0 && !feedback && followUps === undefined) return undefined;
  const blocks: Record<string, unknown>[] = [];
  for (const chunk of chunkSlackSectionText(mrkdwn)) {
    if (chunk.trim().length === 0) continue;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  }
  if (sources.length > 0) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackSourcesLine(sources) }] });
  if (feedback) blocks.push(slackFeedbackBlock());
  if (followUps !== undefined) blocks.push(followUps);
  return blocks.length > MAX_BLOCKS ? undefined : blocks;
}

export function isSlackBlocksRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /invalid_blocks|invalid_attachments|invalid_blocks_format|msg_blocks_too_long/u.test(message);
}
