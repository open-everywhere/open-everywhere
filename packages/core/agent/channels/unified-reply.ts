import type { UnifiedWakeOrigin } from "./unified-window.js";
import { auditReplyPost, type ReplyAudit } from "./reply-post.js";
import { onVercel } from "../access/platform.js";
import { postArm } from "./post-arms.js";

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

export async function postUnifiedReply(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps = {}, audit?: ReplyAudit): Promise<string> {
  const id = await dispatchUnifiedReply(origin, text, deps);
  await auditReplyPost(audit, id, origin.platform, text.length);
  return id;
}

async function dispatchUnifiedReply(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps = {}): Promise<string> {
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a unified ${origin.platform} reply (${text.length}c)`);
    return `spoof-unified-${origin.platform}-${Date.now()}`;
  }
  const arm = postArm(origin.platform);
  if (!arm?.dispatchUnified) {
    throw new Error(`unified reply couldn't post — no post arm registered for "${origin.platform}".`);
  }
  return arm.dispatchUnified(origin, text, deps);
}

export async function completeLinearSessionSilently(origin: LinearOrigin, deps: UnifiedReplyDeps = {}): Promise<void> {
  if (origin.ambient) return;
  const arm = postArm("linear");
  if (!arm?.closeUnifiedSilently) {
    throw new Error("unified silent-close: no linear post arm registered (invariant broken).");
  }
  return arm.closeUnifiedSilently(origin, deps);
}
