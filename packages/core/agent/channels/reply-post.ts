import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { appendAudit } from "../audit/audit.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";

export type ReplyTarget =
  | { readonly platform: "slack"; readonly channelId: string; readonly threadTs?: string }
  | { readonly platform: "discord"; readonly channelId: string }
  | { readonly platform: "notion"; readonly discussionId: string }
  | { readonly platform: "teams"; readonly serviceUrl: string; readonly conversationId: string; readonly replyToActivityId?: string }
  | { readonly platform: "linear"; readonly agentSessionId: string };

export function resolveReplyTarget(ctx: BindableContext): ReplyTarget | null {
  const platform = channelPlatform(ctx);
  if (!capabilitiesForPlatform(platform).midTurnPost) return null;
  const arm = postArm(platform);
  if (!arm?.resolveTarget) return null;
  const t = bindFrom(ctx).target;
  const str = (k: string): string | undefined => (typeof t?.[k] === "string" && (t[k] as string).length > 0 ? (t[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof t?.[k] === "number" ? (t[k] as number) : undefined);
  return arm.resolveTarget({ str, num, threadTs: bindFrom(ctx).threadTs, ctx });
}

export interface ReplyAudit {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
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

export async function postReply(target: ReplyTarget, text: string, audit?: ReplyAudit): Promise<string> {
  const id = await dispatchReply(target, text);
  await auditReplyPost(audit, id, target.platform, text.length);
  return id;
}

async function dispatchReply(target: ReplyTarget, text: string): Promise<string> {
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a ${target.platform} reply (${text.length}c)`);
    return `spoof-${target.platform}-${Date.now()}`;
  }
  const arm = postArm(target.platform);
  if (!arm?.dispatchReply) {
    throw new Error(`reply couldn't post — no mid-turn post arm registered for "${target.platform}".`);
  }
  return arm.dispatchReply(target, text);
}

export async function postTerminalProse(target: ReplyTarget, text: string, audit: ReplyAudit): Promise<void> {
  const chunks = postArm(target.platform)?.splitText?.(text) ?? [text];
  let firstId: string | undefined;
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const id = await dispatchReply(target, chunk);
    firstId ??= id;
  }
  if (firstId === undefined) return;
  await auditReplyPost(audit, firstId, target.platform, text.length);
}

