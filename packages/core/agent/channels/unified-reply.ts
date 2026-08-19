import type { UnifiedWakeOrigin } from "./unified-window.js";
import { auditReplyPost, REPLY_DEDUPE_SKIPPED_ID, type ReplyAudit, type ReplierLabel } from "./reply-post.js";
import { withReplierPrefix } from "./turn-delivery.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { recordOwnPost } from "./own-post-ledger.js";
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
  readonly postLinear?: (origin: LinearOrigin, text: string) => Promise<string>;
  readonly closeLinear?: (origin: LinearOrigin) => Promise<void>;
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
): Promise<string> {
  const arm = postArm(origin.platform);
  const nativeReplier = arm?.displayNameCapable ? replier : undefined;
  const body = replier && !arm?.displayNameCapable ? withReplierPrefix(text, replier) : text;
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
      const realId = await dispatchUnifiedReply(origin, body, deps, nativeReplier);
      await auditReplyPost(audit, realId, origin.platform, body.length);
      const editLocus = unifiedEditLocus(origin);
      if (editLocus) await recordOwnPost(audit?.org, editLocus, realId);
      return realId;
    },
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
    default:
      return null;
  }
}

async function dispatchUnifiedReply(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps = {}, replier?: ReplierLabel): Promise<string> {
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a unified ${origin.platform} reply (${text.length}c)`);
    return `spoof-unified-${origin.platform}-${Date.now()}`;
  }
  const arm = postArm(origin.platform);
  if (!arm?.dispatchUnified) {
    throw new Error(`unified reply couldn't post — no post arm registered for "${origin.platform}".`);
  }
  return arm.dispatchUnified(origin, text, deps, replier);
}

export async function completeUnifiedSessionSilently(origin: UnifiedWakeOrigin, deps: UnifiedReplyDeps = {}): Promise<boolean> {
  if ((origin as { ambient?: boolean }).ambient) return false;
  const arm = postArm(origin.platform);
  if (!arm?.closeUnifiedSilently) return false;
  await arm.closeUnifiedSilently(origin, deps);
  return true;
}
