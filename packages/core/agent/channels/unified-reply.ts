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
import { onVercel } from "../access/platform.js";
import { postArm, type PostIntent } from "./post-arms.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
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
): Promise<string> {
  const clean = truncateMemoryCitationPaths(text);
  const arm = postArm(origin.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(clean, replier) : clean;
  const locus = unifiedDedupeLocus(origin);
  const key = outboundKey({
    surface: origin.platform,
    channel: locus.channel,
    threadTs: locus.threadTs,
    action: "reply.dispatch.unified",
    stableId: audit?.wakeId,
    payload: body,
  });
  const id = await postOnce({
    org: audit?.org,
    key,
    run: async () => {
      let realId: string;
      try {
        realId = await dispatchUnifiedReply(origin, body, deps, nativeReplier, intent);
      } catch (err) {
        await notePostFailure(audit, err, origin.platform);
        throw err;
      }
      await auditReplyPost(audit, realId, origin.platform, body.length);
      await recordLandedPost({
        org: audit?.org,
        editLocus: unifiedEditLocus(origin),
        messageId: realId,
        body,
        platform: origin.platform,
        wake: audit?.wakeId,
      });
      await recordContainerAnswered(audit?.org, origin);
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
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a unified ${origin.platform} reply (${text.length}c)`);
    return `spoof-unified-${origin.platform}-${Date.now()}`;
  }
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
