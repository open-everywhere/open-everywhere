import {
  ingestUntrusted,
  type WakeAttachment,
} from "@open-everywhere/core/agent/adapter-api.js";
import { parseSlackFiles, type ParsedMessageEvent } from "./slack-events.js";
import { slackInteractivityTenantIds } from "./slack-tenant-fence.js";

export interface ParsedSlackShortcut {
  readonly kind: "message" | "global";
  readonly callbackId: string;
  readonly triggerId: string;
  readonly userId: string;
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly channelId?: string;
  readonly message?: {
    readonly text: string;
    readonly ts: string;
    readonly threadTs?: string;
    readonly userId?: string;
    readonly attachments?: readonly WakeAttachment[];
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function parseSlackShortcutPayload(raw: unknown): ParsedSlackShortcut | null {
  const p = obj(raw);
  if (!p) return null;
  const type = str(p.type);
  if (type !== "message_action" && type !== "shortcut") return null;
  const callbackId = str(p.callback_id);
  const triggerId = str(p.trigger_id);
  const userId = str(obj(p.user)?.id);
  if (!callbackId || !triggerId || !userId) return null;
  const { teamId, enterpriseId } = slackInteractivityTenantIds(p);
  if (type === "shortcut") {
    return { kind: "global", callbackId, triggerId, userId, ...(teamId ? { teamId } : {}), ...(enterpriseId ? { enterpriseId } : {}) };
  }
  const channelId = str(obj(p.channel)?.id);
  const message = obj(p.message);
  const ts = str(message?.ts);
  if (!channelId || !message || !ts) return null;
  const threadTs = str(message.thread_ts);
  const authorId = str(message.user);
  const attachments = parseSlackFiles(message.files);
  return {
    kind: "message",
    callbackId,
    triggerId,
    userId,
    ...(teamId ? { teamId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    channelId,
    message: {
      text: typeof message.text === "string" ? message.text : "",
      ts,
      ...(threadTs ? { threadTs } : {}),
      ...(authorId ? { userId: authorId } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

export function shortcutWakeKey(sc: ParsedSlackShortcut): string {
  return `oe-shortcut:${sc.triggerId}`;
}

function fenceShortcutIngestion(text: string): string {
  return ingestUntrusted(text, { source: "slack message shortcut" });
}

export function globalShortcutText(sc: ParsedSlackShortcut): string {
  return `Shortcut "${sc.callbackId}" invoked.`;
}

export function slackTsFromMs(nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const millis = nowMs % 1000;
  return `${seconds}.${String(millis).padStart(3, "0")}000`;
}

export function shortcutMessageEvent(
  sc: ParsedSlackShortcut,
  channelId: string,
  channelType?: string,
  nowMs: number = Date.now(),
  opts: { readonly admitAttachments?: boolean } = {},
): ParsedMessageEvent {
  const attachments = opts.admitAttachments === true ? sc.message?.attachments : undefined;
  const text = sc.kind === "message" && sc.message ? fenceShortcutIngestion(sc.message.text) : globalShortcutText(sc);
  return {
    channelId,
    ts: sc.kind === "message" && sc.message ? sc.message.ts : slackTsFromMs(nowMs),
    ...(sc.kind === "message" && sc.message?.threadTs ? { threadTs: sc.message.threadTs } : {}),
    ...(sc.teamId ? { teamId: sc.teamId } : {}),
    ...(sc.enterpriseId ? { enterpriseId: sc.enterpriseId } : {}),
    userId: sc.userId,
    ...(channelType ? { channelType } : {}),
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    authoredText: sc.kind === "global" ? text : "",
    isAppMention: false,
  };
}
