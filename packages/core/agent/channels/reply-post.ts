import { bindFrom, type BindableContext } from "../identity/binding.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { appendAudit } from "../audit/audit.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { withReplierPrefix, type ReplierLabel } from "./turn-delivery.js";

export type { ReplierLabel };

export type ReplyTarget =
  | { readonly platform: "slack"; readonly channelId: string; readonly threadTs?: string }
  | { readonly platform: "discord"; readonly channelId: string }
  | {
      readonly platform: "notion";
      readonly discussionId: string;
      readonly pageId?: string;
      readonly workspaceId?: string;
      readonly credentialId?: string;
    }
  | { readonly platform: "teams"; readonly serviceUrl: string; readonly conversationId: string; readonly replyToActivityId?: string }
  | { readonly platform: "linear"; readonly agentSessionId: string };

export function resolveReplyTarget(ctx: BindableContext): ReplyTarget | null {
  const binding = bindFrom(ctx);
  const platform = binding.platform;
  if (!capabilitiesForPlatform(platform).midTurnPost) return null;
  const arm = postArm(platform);
  if (!arm?.resolveTarget) return null;
  const t = binding.target;
  const str = (k: string): string | undefined => (typeof t?.[k] === "string" && (t[k] as string).length > 0 ? (t[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof t?.[k] === "number" ? (t[k] as number) : undefined);
  return arm.resolveTarget({ str, num, threadTs: binding.threadTs, ctx });
}

export interface ReplyAudit {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly creatorId?: string;
  readonly sessionId?: string;
  readonly wakeId?: string;
  readonly route: "tool" | "terminal" | "bridge";
}

export async function auditReplyPost(audit: ReplyAudit | undefined, id: string, platform: string, chars: number): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.post",
    detail: {
      id,
      platform,
      chars,
      route: audit.route,
      ...(audit.creatorId ? { creatorId: audit.creatorId } : {}),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

const REFUSED_WAKE_MAX = 200;

export async function auditReplyRefused(audit: ReplyAudit | undefined, reason: string): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.refused",
    detail: {
      reason,
      route: audit.route,
      ...(audit.wakeId ? { wakeId: audit.wakeId.slice(0, REFUSED_WAKE_MAX) } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

export async function auditReplyForced(audit: ReplyAudit | undefined, reason: string): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.forced",
    detail: {
      reason,
      route: audit.route,
      ...(audit.wakeId ? { wakeId: audit.wakeId.slice(0, REFUSED_WAKE_MAX) } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

function replyDedupeLocus(target: ReplyTarget): { channel: string; threadTs?: string } {
  switch (target.platform) {
    case "slack":
      return { channel: target.channelId, threadTs: target.threadTs };
    case "discord":
      return { channel: target.channelId };
    case "notion":
      return { channel: target.discussionId };
    case "teams":
      return { channel: `${target.serviceUrl}::${target.conversationId}`, threadTs: target.replyToActivityId };
    case "linear":
      return { channel: target.agentSessionId };
    default:
      return { channel: JSON.stringify(target) };
  }
}

export const REPLY_DEDUPE_SKIPPED_ID = "deduped:reply";

export async function postReply(target: ReplyTarget, text: string, audit?: ReplyAudit, replier?: ReplierLabel): Promise<string> {
  const arm = postArm(target.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(text, replier) : text;
  const locus = replyDedupeLocus(target);
  const key = outboundKey({
    surface: target.platform,
    channel: locus.channel,
    threadTs: locus.threadTs,
    action: "reply.dispatch",
    stableId: audit?.wakeId,
    payload: body,
  });
  const id = await postOnce({
    org: audit?.org,
    key,
    run: async () => {
      const realId = await dispatchReply(target, body, nativeReplier);
      await auditReplyPost(audit, realId, target.platform, body.length);
      return realId;
    },
    skipped: () => REPLY_DEDUPE_SKIPPED_ID,
  });
  return id ?? REPLY_DEDUPE_SKIPPED_ID;
}

async function dispatchReply(target: ReplyTarget, text: string, replier?: ReplierLabel): Promise<string> {
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a ${target.platform} reply (${text.length}c)`);
    return `spoof-${target.platform}-${Date.now()}`;
  }
  const arm = postArm(target.platform);
  if (!arm?.dispatchReply) {
    throw new Error(`reply couldn't post — no mid-turn post arm registered for "${target.platform}".`);
  }
  return arm.dispatchReply(target, text, replier);
}

export async function postTerminalProse(target: ReplyTarget, text: string, audit: ReplyAudit, replier?: ReplierLabel): Promise<void> {
  const arm = postArm(target.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(text, replier) : text;
  const chunks = arm?.splitText?.(body) ?? [body];
  let firstId: string | undefined;
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const id = await dispatchReply(target, chunk, nativeReplier);
    firstId ??= id;
  }
  if (firstId === undefined) return;
  await auditReplyPost(audit, firstId, target.platform, body.length);
}

