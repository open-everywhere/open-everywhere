import type { UnifiedWakeOrigin } from "./unified-window.js";
import {
  auditReplyPost,
  notePostFailure,
  recordLandedPost,
  releasePostKeyOnFailure,
  REPLY_DEDUPE_SKIPPED_ID,
  type ReplyAudit,
  type ReplierLabel,
} from "./reply-post.js";
import { recordContainerAnswered } from "./answered-container-ledger.js";
import { withReplierPrefix, truncateMemoryCitationPaths } from "./turn-delivery.js";
import { applyReplyProvenance, auditReplyProvenance } from "./reply-provenance.js";
import { auditWithheldMemoryClaim, guardMemoryClaims } from "./memory-claim-guard.js";
import { auditWithheldApprovalClaim, guardApprovalClaims } from "./approval-claim-guard.js";
import { auditWithheldRequestClaim, guardRequestClaims } from "./request-claim-guard.js";
import { swallowRoomPost } from "./egress-spoof.js";
import { answerIntent, landsInDirectConversation, postArm, type PostIntent } from "./post-arms.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { coverLabelForReply, recordCoverReply, withCoverLabel } from "../cover/wake.js";
import type { EditLocus } from "./reply-edit.js";

type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;
type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;
type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;
type NotionOrigin = Extract<UnifiedWakeOrigin, { platform: "notion" }>;
type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;
type TeamsOrigin = Extract<UnifiedWakeOrigin, { platform: "teams" }>;

export interface UnifiedReplyDeps {
  readonly postSlack?: (origin: SlackOrigin, text: string) => Promise<string>;
  readonly postGitHub?: (origin: GitHubOrigin, text: string) => Promise<string>;
  readonly postLinear?: (origin: LinearOrigin, text: string, intent?: PostIntent) => Promise<string>;
  readonly closeLinear?: (origin: LinearOrigin, answered?: boolean) => Promise<void>;
  readonly postNotion?: (origin: NotionOrigin, text: string) => Promise<string>;
  readonly postDiscord?: (origin: DiscordOrigin, text: string) => Promise<string>;
  readonly postTeams?: (origin: TeamsOrigin, text: string) => Promise<string>;
}

function unifiedDedupeLocus(origin: UnifiedWakeOrigin): { channel: string; threadTs?: string } {
  switch (origin.platform) {
    case "slack":
      return { channel: origin.channelId, threadTs: origin.threadTs };
    case "github":
      return { channel: `${origin.owner}/${origin.repo}#${origin.issueNumber}` };
    case "linear":
      return { channel: origin.agentSessionId ?? `ambient:${origin.issueId}` };
    case "notion":
      return { channel: origin.discussionId };
    case "discord":
      return { channel: origin.channelId };
    case "teams":
      return { channel: `${origin.serviceUrl}::${origin.conversationId}`, threadTs: origin.replyToActivityId };
    case "email":
      return { channel: `${origin.inbox}::${origin.threadId}`, threadTs: origin.messageId };
    case "a2a":
      return { channel: `a2a::${origin.caller}::${origin.taskId}` };
    case "google-chat":
      return { channel: origin.space, ...(origin.thread !== undefined ? { threadTs: origin.thread } : {}) };
    default:
      return { channel: JSON.stringify(origin) };
  }
}

export async function postUnifiedReply(
  origin: UnifiedWakeOrigin,
  text: string,
  deps: UnifiedReplyDeps = {},
  audit?: ReplyAudit,
  replier?: ReplierLabel,
  intent?: PostIntent,
  opts?: { readonly host?: boolean },
): Promise<string> {
  const claimGuard = guardMemoryClaims(truncateMemoryCitationPaths(text), audit);
  const approvalGuard = guardApprovalClaims(claimGuard.body, audit);
  const requestGuard = guardRequestClaims(approvalGuard.body, audit);
  const provenance = applyReplyProvenance(requestGuard.body, audit, landsInDirectConversation(origin.platform, unifiedEditLocus(origin)?.channelId));
  const postIntent = answerIntent(audit, provenance.sources, intent?.terminal ?? true, opts?.host === true);
  const cover = await coverLabelForReply(audit?.org, audit?.wakeId);
  const clean = cover ? withCoverLabel(provenance.body, cover.label) : provenance.body;
  const arm = postArm(origin.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const prefixed = (b: string): string => (replier && !arm?.displayNameCapable ? withReplierPrefix(b, replier) : b);
  const body = prefixed(clean);
  const locus = unifiedDedupeLocus(origin);
  const key = outboundKey({
    surface: origin.platform,
    channel: locus.channel,
    threadTs: locus.threadTs,
    action: "reply.dispatch.unified",
    stableId: audit?.wakeId,
    payload: prefixed(provenance.body),
  });
  const id = await postOnce({
    org: audit?.org,
    key,
    run: async () => {
      let realId: string;
      try {
        realId = await dispatchUnifiedReply(origin, body, deps, nativeReplier, postIntent);
      } catch (err) {
        await notePostFailure(audit, err, origin.platform);
        throw err;
      }
      await auditReplyPost(audit, realId, origin.platform, body.length, intent?.terminal);
      await auditReplyProvenance(audit, realId, origin.platform, provenance.reads, provenance.shown, postIntent.sources?.length ?? 0);
      await auditWithheldMemoryClaim(audit, origin.platform, claimGuard.withheld);
      await auditWithheldApprovalClaim(audit, origin.platform, approvalGuard.withheld, approvalGuard.cause);
      await auditWithheldRequestClaim(audit, origin.platform, requestGuard.withheld);
      await recordLandedPost({
        org: audit?.org,
        editLocus: unifiedEditLocus(origin),
        messageId: realId,
        body,
        platform: origin.platform,
        wake: audit?.wakeId,
      });
      await recordContainerAnswered(audit?.org, origin);
      if (cover && audit?.wakeId) {
        await recordCoverReply({ org: audit.org, platform: audit.platform, workspace: audit.workspace ?? "", surface: audit.surface ?? "" }, audit.wakeId, cover, provenance.body);
      }
      return realId;
    },
    releaseKeyOnFailure: releasePostKeyOnFailure,
    skipped: () => REPLY_DEDUPE_SKIPPED_ID,
  });
  return id ?? REPLY_DEDUPE_SKIPPED_ID;
}

export function unifiedEditLocus(origin: UnifiedWakeOrigin): EditLocus | null {
  switch (origin.platform) {
    case "slack":
      return { platform: "slack", channelId: origin.channelId };
    case "discord":
      return { platform: "discord", channelId: origin.channelId };
    case "teams":
      return { platform: "teams", channelId: origin.conversationId, serviceUrl: origin.serviceUrl };
    case "github":
      return { platform: "github", channelId: `${origin.owner}/${origin.repo}` };
    case "linear":
      return origin.ambient
        ? { platform: "linear", channelId: origin.issueId, ...(origin.organizationId ? { organizationId: origin.organizationId } : {}) }
        : null;
    case "notion":
      return origin.workspaceId && origin.pageId
        ? { platform: "notion", channelId: `${origin.workspaceId}/${origin.pageId}` }
        : null;
    default:
      return null;
  }
}

export function terminalPostClosesConversation(origin: UnifiedWakeOrigin): boolean {
  return origin.platform === "linear" && origin.ambient !== true;
}

export async function resolveUnifiedEditLocus(origin: UnifiedWakeOrigin): Promise<EditLocus | null> {
  const locus = unifiedEditLocus(origin);
  if (!locus) return null;
  const retarget = postArm(origin.platform)?.retargetEditLocus;
  if (!retarget) return locus;
  return (await retarget(origin, locus).catch(() => locus)) ?? locus;
}

async function dispatchUnifiedReply(
  origin: UnifiedWakeOrigin,
  text: string,
  deps: UnifiedReplyDeps = {},
  replier?: ReplierLabel,
  intent?: PostIntent,
): Promise<string> {
  const swallowed = swallowRoomPost(`a unified ${origin.platform} reply (${text.length}c)`, `unified-${origin.platform}`);
  if (swallowed !== undefined) return swallowed;
  const arm = postArm(origin.platform);
  if (!arm?.dispatchUnified) {
    throw new Error(`unified reply couldn't post — no post arm registered for "${origin.platform}".`);
  }
  return arm.dispatchUnified(origin, text, deps, replier, intent);
}

export async function completeUnifiedSessionSilently(origin: UnifiedWakeOrigin, deps: UnifiedReplyDeps = {}, answered = false): Promise<boolean> {
  if ((origin as { ambient?: boolean }).ambient) return false;
  const arm = postArm(origin.platform);
  if (!arm?.closeUnifiedSilently) return false;
  await arm.closeUnifiedSilently(origin, deps, answered);
  return true;
}
