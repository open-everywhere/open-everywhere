import { recordReplyFeedback, resolvePartition, type ReplyFeedbackClick, type ReplyFeedbackRating } from "@open-everywhere/core/agent/adapter-api.js";
import { bindableForSlackIds } from "./slack-events.js";
import { SLACK_FEEDBACK_ACTION_ID, SLACK_FEEDBACK_VALUE_DOWN, SLACK_FEEDBACK_VALUE_UP } from "./slack-reply-blocks.js";

export interface ParsedSlackFeedbackClick {
  readonly rating: ReplyFeedbackRating;
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly teamId?: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parseSlackFeedbackClick(payload: unknown): ParsedSlackFeedbackClick | undefined {
  const p = obj(payload);
  if (p?.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const action = (p.actions as unknown[]).map(obj).find((a) => a?.action_id === SLACK_FEEDBACK_ACTION_ID);
  if (action === undefined) return undefined;
  const value = str(action.value);
  const rating: ReplyFeedbackRating | undefined = value === SLACK_FEEDBACK_VALUE_UP ? "up" : value === SLACK_FEEDBACK_VALUE_DOWN ? "down" : undefined;
  if (rating === undefined) return undefined;
  const userId = str(obj(p.user)?.id);
  const channelId = str(obj(p.channel)?.id) ?? str(obj(p.container)?.channel_id);
  const messageTs = str(obj(p.message)?.ts) ?? str(obj(p.container)?.message_ts);
  if (userId === undefined || channelId === undefined || messageTs === undefined) return undefined;
  const teamId = str(obj(p.team)?.id) ?? str(obj(p.user)?.team_id);
  return { rating, userId, channelId, messageTs, ...(teamId === undefined ? {} : { teamId }) };
}

export interface SlackFeedbackRouteDeps {
  readonly record?: (click: ReplyFeedbackClick) => Promise<boolean>;
}

export async function routeSlackFeedbackClick(click: ParsedSlackFeedbackClick, deps: SlackFeedbackRouteDeps = {}): Promise<boolean> {
  try {
    const p = resolvePartition(bindableForSlackIds({ teamId: click.teamId, channelId: click.channelId, userId: click.userId }));
    const record = deps.record ?? ((c: ReplyFeedbackClick) => recordReplyFeedback(c));
    return await record({
      surface: "slack",
      rating: click.rating,
      raterId: click.userId,
      channelId: click.channelId,
      messageId: click.messageTs,
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surfaceKey: p.surfaceKey,
    });
  } catch {
    return false;
  }
}
