import { admitProviderRegistration } from "../access/provider-selection.js";
import { bridgeSlackForm } from "./slack-bridge.js";

export interface OutboundFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly caption?: string;
}

export interface SurfaceMessageOps {
  readonly platform: string;
  postText(channelId: string, text: string, opts?: { replyToMessageId?: string }): Promise<string>;
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
  postFiles(channelId: string, files: readonly OutboundFile[], comment: string | undefined): Promise<void>;
  permalink?(ref: MessageRef): Promise<string | undefined>;
  setReaction?(channelId: string, messageId: string, emoji: string, on: boolean): Promise<void>;
}

export interface MessageRef {
  readonly channelId: string;
  readonly messageId: string;
  readonly workspace?: string;
  readonly dm?: boolean;
}

const REGISTRY = new Map<string, SurfaceMessageOps>();

export function registerSurfaceMessageOps(ops: SurfaceMessageOps): void {
  if (!admitProviderRegistration(ops.platform, "surface-message-ops")) return;
  REGISTRY.set(ops.platform, ops);
}

export function surfaceMessageOps(platform: string | undefined): SurfaceMessageOps | undefined {
  return platform === undefined ? undefined : REGISTRY.get(platform);
}

export async function postSurfaceText(
  platform: string,
  target: { readonly channelId: string; readonly text: string; readonly threadTs?: string | null; readonly replyToMessageId?: string },
): Promise<string | undefined> {
  try {
    if (platform === "slack") {
      const body = new URLSearchParams({ channel: target.channelId, text: target.text });
      if (target.threadTs) body.set("thread_ts", target.threadTs);
      const res = await bridgeSlackForm("chat.postMessage", body.toString());
      return res?.ok === true && typeof res["ts"] === "string" ? (res["ts"] as string) : undefined;
    }
    const ops = surfaceMessageOps(platform);
    if (!ops) return undefined;
    return await ops.postText(target.channelId, target.text, target.replyToMessageId ? { replyToMessageId: target.replyToMessageId } : undefined);
  } catch (err) {
    console.warn(`[open-everywhere:surface] text post failed (${platform}): ${String(err)}`);
    return undefined;
  }
}

export async function resolveMessagePermalink(platform: string, ref: MessageRef): Promise<string | undefined> {
  if (!ref.channelId || !ref.messageId) return undefined;
  try {
    if (platform === "slack") {
      const q = new URLSearchParams({ channel: ref.channelId, message_ts: ref.messageId });
      const res = await bridgeSlackForm("chat.getPermalink", q.toString());
      return res?.ok === true && typeof res["permalink"] === "string" ? (res["permalink"] as string) : undefined;
    }
    return await surfaceMessageOps(platform)?.permalink?.(ref);
  } catch (err) {
    console.warn(`[open-everywhere:surface] permalink lookup failed (${platform}): ${String(err)}`);
    return undefined;
  }
}

export async function setSurfaceReaction(
  platform: string,
  ref: { readonly channelId: string; readonly messageId: string },
  emoji: { readonly slackName: string; readonly unicode: string },
  on: boolean,
): Promise<boolean> {
  if (!ref.channelId || !ref.messageId) return false;
  try {
    if (platform === "slack") {
      const body = new URLSearchParams({ channel: ref.channelId, name: emoji.slackName, timestamp: ref.messageId });
      const res = await bridgeSlackForm(on ? "reactions.add" : "reactions.remove", body.toString());
      return res?.ok === true;
    }
    const set = surfaceMessageOps(platform)?.setReaction;
    if (!set) return false;
    await set(ref.channelId, ref.messageId, emoji.unicode, on);
    return true;
  } catch (err) {
    const msg = String(err);
    if (msg.includes("already_reacted") || msg.includes("no_reaction")) return true;
    console.warn(`[open-everywhere:surface] reaction ${on ? "add" : "remove"} failed (${platform}): ${msg}`);
    return false;
  }
}
