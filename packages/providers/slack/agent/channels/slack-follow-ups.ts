import type { ParsedMessageEvent } from "./slack-events.js";
import { slackForm } from "./slack-events.js";
import { SLACK_FOLLOW_UP_ACTION_PREFIX, SLACK_FOLLOW_UP_BLOCK_ID, SLACK_INVISIBLE_CHARACTER } from "./slack-reply-blocks.js";
import { slackTsFromMs } from "./slack-shortcut.js";
import { slackInteractivityTenantIds } from "./slack-tenant-fence.js";

const FOLLOW_UP_VALUE_MAX = 75;

export interface ParsedSlackFollowUpClick {
  readonly text: string;
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly blocks?: readonly unknown[];
  readonly messageText?: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parseSlackFollowUpClick(payload: unknown): ParsedSlackFollowUpClick | undefined {
  const p = obj(payload);
  if (p?.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const action = (p.actions as unknown[]).map(obj).find((a) => typeof a?.action_id === "string" && a.action_id.startsWith(SLACK_FOLLOW_UP_ACTION_PREFIX));
  if (action === undefined) return undefined;
  const text = str(action.value)?.trim();
  if (text === undefined || text.length === 0 || Array.from(text).length > FOLLOW_UP_VALUE_MAX) return undefined;
  if (SLACK_INVISIBLE_CHARACTER.test(text)) return undefined;
  const userId = str(obj(p.user)?.id);
  const channelId = str(obj(p.channel)?.id) ?? str(obj(p.container)?.channel_id);
  const message = obj(p.message);
  const messageTs = str(message?.ts) ?? str(obj(p.container)?.message_ts);
  if (userId === undefined || channelId === undefined || messageTs === undefined) return undefined;
  if (!channelId.startsWith("D")) return undefined;
  const threadTs = str(message?.thread_ts) ?? str(obj(p.container)?.thread_ts);
  const { teamId, enterpriseId } = slackInteractivityTenantIds(p);
  const blocks = Array.isArray(message?.blocks) ? (message.blocks as unknown[]) : undefined;
  const messageText = str(message?.text);
  return {
    text,
    userId,
    channelId,
    messageTs,
    ...(threadTs !== undefined && threadTs !== messageTs ? { threadTs } : {}),
    ...(teamId === undefined ? {} : { teamId }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(blocks === undefined ? {} : { blocks }),
    ...(messageText === undefined ? {} : { messageText }),
  };
}

export function followUpMessageEvent(click: ParsedSlackFollowUpClick, nowMs: number = Date.now()): ParsedMessageEvent {
  return {
    channelId: click.channelId,
    ts: slackTsFromMs(nowMs),
    ...(click.threadTs === undefined ? {} : { threadTs: click.threadTs }),
    ...(click.teamId === undefined ? {} : { teamId: click.teamId }),
    ...(click.enterpriseId === undefined ? {} : { enterpriseId: click.enterpriseId }),
    userId: click.userId,
    channelType: "im",
    text: click.text,
    authoredText: click.text,
    isAppMention: false,
  };
}

export function followUpPressKey(click: ParsedSlackFollowUpClick): string {
  return `slack-followup:${click.channelId}:${click.messageTs}`;
}

export function followUpPressedLine(text: string): string {
  return `↳ You asked: ${text}`;
}

export function blocksAfterFollowUp(blocks: readonly unknown[], text: string): unknown[] | undefined {
  const kept = blocks.filter((b) => obj(b)?.block_id !== SLACK_FOLLOW_UP_BLOCK_ID);
  if (kept.length === blocks.length) return undefined;
  return [...kept, { type: "context", elements: [{ type: "plain_text", text: followUpPressedLine(text), emoji: true }] }];
}

export async function markFollowUpPressed(
  click: ParsedSlackFollowUpClick,
  form: (method: string, body: string) => Promise<Record<string, unknown> | undefined> = slackForm,
): Promise<boolean> {
  try {
    const blocks = click.blocks === undefined ? undefined : blocksAfterFollowUp(click.blocks, click.text);
    if (blocks === undefined) return false;
    const body = new URLSearchParams({ channel: click.channelId, ts: click.messageTs, blocks: JSON.stringify(blocks) });
    if (click.messageText !== undefined) body.set("text", click.messageText);
    const res = await form("chat.update", body.toString());
    return res?.ok === true;
  } catch {
    return false;
  }
}
