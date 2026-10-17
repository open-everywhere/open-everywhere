import { appendAudit } from "../audit/audit.js";

export const REPLY_FEEDBACK_ACTION = "reply.feedback";

export type ReplyFeedbackRating = "up" | "down";

export type ReplyFeedbackSurface = "slack" | "teams";

export interface ReplyFeedbackClick {
  readonly surface: ReplyFeedbackSurface;
  readonly rating: ReplyFeedbackRating;
  readonly raterId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly commentChars?: number;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surfaceKey: string;
}

export type ReplyFeedbackSink = (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;

export async function recordReplyFeedback(click: ReplyFeedbackClick, sink: ReplyFeedbackSink = appendAudit): Promise<boolean> {
  if (click.raterId.length === 0 || click.channelId.length === 0 || click.messageId.length === 0) return false;
  try {
    await sink({
      org: click.org,
      platform: click.platform,
      workspace: click.workspace,
      surface: click.surfaceKey,
      principalId: click.raterId,
      action: REPLY_FEEDBACK_ACTION,
      detail: {
        surface: click.surface,
        rating: click.rating,
        channelId: click.channelId,
        messageId: click.messageId,
        via: "native",
        ...(click.commentChars !== undefined && click.commentChars > 0 ? { comment: true, commentChars: click.commentChars } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}
