import { bindFrom, currentTurnId, type BindableContext } from "../identity/binding.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { appendAudit } from "../audit/audit.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { withReplierPrefix, truncateMemoryCitationPaths, type ReplierLabel } from "./turn-delivery.js";
import { recordOwnPost } from "./own-post-ledger.js";
import { resolvePartition } from "../memory/partition.js";
import type { EditLocus } from "./reply-edit.js";
import { platformFailureClass, platformFailureStatus, type PlatformFailureClass } from "./platform-failure.js";
import { recordPostTail } from "./session-tail-record.js";
import { markWakeRefusedThisTurn } from "./reply-signal.js";

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
  | { readonly platform: "linear"; readonly agentSessionId: string; readonly organizationId?: string }
  | { readonly platform: "linear"; readonly issueId: string; readonly parentId?: string; readonly organizationId?: string }
  | { readonly platform: "github"; readonly owner: string; readonly repo: string; readonly issueNumber: number; readonly installationId?: number };

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
  readonly turnId?: string;
  readonly route: "tool" | "terminal" | "bridge";
}

export function replyAuditFor(ctx: BindableContext, route: ReplyAudit["route"], wakeId?: string): ReplyAudit {
  const p = resolvePartition(ctx);
  const sessionId = (ctx as { session?: { id?: string } }).session?.id;
  const turnId = currentTurnId(ctx);
  return {
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    principalId: bindFrom(ctx).principalId,
    ...(sessionId ? { sessionId } : {}),
    ...(wakeId ? { wakeId } : {}),
    ...(turnId ? { turnId } : {}),
    route,
  };
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

export const POST_PLATFORM_ERROR_REASON = "platform-error";

export async function auditReplyPostFailed(
  audit: ReplyAudit | undefined,
  platform: string,
  failure: PlatformFailureClass,
  status?: number,
): Promise<void> {
  if (!audit) return;
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: "reply.post.failed",
    detail: {
      reason: POST_PLATFORM_ERROR_REASON,
      platform,
      failure,
      route: audit.route,
      ...(status !== undefined ? { status } : {}),
      ...(audit.wakeId ? { wakeId: audit.wakeId.slice(0, REFUSED_WAKE_MAX) } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

export async function notePostFailure(audit: ReplyAudit | undefined, err: unknown, platform: string): Promise<void> {
  await auditReplyPostFailed(audit, platform, platformFailureClass(err), platformFailureStatus(err));
}

export const releasePostKeyOnFailure = (err: unknown): boolean => platformFailureClass(err) === "definitive";

export async function auditReplyRefused(audit: ReplyAudit | undefined, reason: string): Promise<void> {
  if (!audit) return;
  markWakeRefusedThisTurn(audit.turnId, audit.wakeId, reason);
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
      return "agentSessionId" in target ? { channel: target.agentSessionId } : { channel: target.issueId, threadTs: target.parentId };
    case "github":
      return { channel: `${target.owner}/${target.repo}`, threadTs: `#${target.issueNumber}` };
    default:
      return { channel: JSON.stringify(target) };
  }
}

export const REPLY_DEDUPE_SKIPPED_ID = "deduped:reply";

export async function recordLandedPost(input: {
  readonly org: string | undefined;
  readonly editLocus: EditLocus | null;
  readonly messageId: string;
  readonly body: string;
  readonly platform: string;
  readonly wake?: string | undefined;
}): Promise<void> {
  if (input.editLocus) await recordOwnPost(input.org, input.editLocus, input.messageId);
  await recordPostTail({
    text: input.body,
    at: new Date().toISOString(),
    platform: input.platform,
    id: input.messageId,
    ...(input.wake ? { wake: input.wake } : {}),
  });
}

export async function postReply(target: ReplyTarget, text: string, audit?: ReplyAudit, replier?: ReplierLabel): Promise<string> {
  const clean = truncateMemoryCitationPaths(text);
  const arm = postArm(target.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(clean, replier) : clean;
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
      let realId: string;
      try {
        realId = await dispatchReply(target, body, nativeReplier);
      } catch (err) {
        await notePostFailure(audit, err, target.platform);
        throw err;
      }
      await auditReplyPost(audit, realId, target.platform, body.length);
      await recordLandedPost({
        org: audit?.org,
        editLocus: replyEditLocus(target),
        messageId: realId,
        body,
        platform: target.platform,
        wake: audit?.wakeId,
      });
      return realId;
    },
    releaseKeyOnFailure: releasePostKeyOnFailure,
    skipped: () => REPLY_DEDUPE_SKIPPED_ID,
  });
  return id ?? REPLY_DEDUPE_SKIPPED_ID;
}

export function replyEditLocus(target: ReplyTarget): EditLocus | null {
  switch (target.platform) {
    case "slack":
      return { platform: "slack", channelId: target.channelId };
    case "discord":
      return { platform: "discord", channelId: target.channelId };
    case "teams":
      return { platform: "teams", channelId: target.conversationId, serviceUrl: target.serviceUrl };
    case "github":
      return { platform: "github", channelId: `${target.owner}/${target.repo}` };
    case "linear":
      return "agentSessionId" in target
        ? null
        : { platform: "linear", channelId: target.issueId, ...(target.organizationId ? { organizationId: target.organizationId } : {}) };
    case "notion":
      return target.workspaceId && target.pageId
        ? { platform: "notion", channelId: `${target.workspaceId}/${target.pageId}` }
        : null;
    default:
      return null;
  }
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
  const clean = truncateMemoryCitationPaths(text);
  const arm = postArm(target.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(clean, replier) : clean;
  const chunks = arm?.splitText?.(body) ?? [body];
  let firstId: string | undefined;
  try {
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await dispatchReply(target, chunk, nativeReplier);
      firstId ??= id;
    }
  } catch (err) {
    await notePostFailure(audit, err, target.platform);
    throw err;
  }
  if (firstId === undefined) return;
  await auditReplyPost(audit, firstId, target.platform, body.length);
}

