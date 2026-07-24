import type { BindableContext } from "../identity/binding.js";
import type { ReplyTarget } from "./reply-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";

export interface TargetResolveBag {
  str(k: string): string | undefined;
  num(k: string): number | undefined;
  readonly threadTs?: string;
  readonly ctx: BindableContext;
}

export interface PostArm {
  readonly platform: string;
  resolveTarget?(bag: TargetResolveBag): ReplyTarget | null;
  dispatchReply?(target: ReplyTarget, text: string): Promise<string>;
  splitText?(text: string): readonly string[];
  dispatchUnified?(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps): Promise<string>;
  closeUnifiedSilently?(origin: UnifiedWakeOrigin, deps: UnifiedReplyDeps): Promise<void>;
  describeRedriveTarget?(origin: UnifiedWakeOrigin): string;
  redriveContainerId?(origin: UnifiedWakeOrigin): string;
}

const POST_ARMS: Record<string, PostArm> = {};

export function registerPostArm(arm: PostArm): void {
  POST_ARMS[arm.platform] = arm;
}

export function postArm(platform: string | undefined): PostArm | undefined {
  return platform === undefined ? undefined : POST_ARMS[platform];
}

export function registeredPostArmPlatforms(): readonly string[] {
  return Object.keys(POST_ARMS);
}

import { slackPostArm } from "./slack-post-arm.js";
import { discordPostArm } from "./discord-post-arm.js";
import { teamsPostArm } from "./teams-post-arm.js";
import { linearPostArm } from "./linear-post-arm.js";

registerPostArm(slackPostArm);
registerPostArm(discordPostArm);
registerPostArm(teamsPostArm);
registerPostArm(linearPostArm);
