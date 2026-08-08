import type { BindableContext } from "../identity/binding.js";
import type { ReplyTarget } from "./reply-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { expandLinkSet } from "../identity/link-store.js";
import { principalKey } from "../identity/principal-key.js";
import type { LinkedAccount } from "../identity/link-store.js";

export interface TargetResolveBag {
  str(k: string): string | undefined;
  num(k: string): number | undefined;
  readonly threadTs?: string;
  readonly ctx: BindableContext;
}

export interface DirectMessageDelivery {
  readonly surfaceId: string;
  readonly messageId: string;
}

export interface DirectMessageRequest {
  readonly principalId: string;
  readonly text: string;
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
  deliverDirectMessage?(input: DirectMessageRequest): Promise<DirectMessageDelivery>;
}

const POST_ARMS: Record<string, PostArm> = {};

export function registerPostArm(arm: PostArm): void {
  if (!admitProviderRegistration(arm.platform, "post-arm")) return;
  POST_ARMS[arm.platform] = arm;
}

export function postArm(platform: string | undefined): PostArm | undefined {
  return platform === undefined ? undefined : POST_ARMS[platform];
}

export function registeredPostArmPlatforms(): readonly string[] {
  return Object.keys(POST_ARMS);
}

export function directMessageCapablePlatforms(): readonly string[] {
  return Object.values(POST_ARMS)
    .filter((a) => typeof a.deliverDirectMessage === "function")
    .map((a) => a.platform);
}

export function canDeliverDirectMessage(platform: string | undefined): boolean {
  return typeof postArm(platform)?.deliverDirectMessage === "function";
}

export async function dispatchDirectMessage(platform: string | undefined, input: DirectMessageRequest): Promise<DirectMessageDelivery> {
  const arm = postArm(platform);
  const deliver = arm?.deliverDirectMessage;
  if (!arm || !deliver) {
    const capable = directMessageCapablePlatforms();
    throw new Error(
      `no DM-delivery arm for platform "${platform ?? "(unknown)"}" — DM delivery is implemented by: ${capable.length ? capable.join(", ") : "(no provider)"}.`,
    );
  }
  return await deliver.call(arm, input);
}

export async function notifyLinkSetMembers(
  org: string,
  linkSetId: string,
  text: string,
  opts?: { readonly except?: readonly LinkedAccount[] },
): Promise<number> {
  let delivered = 0;
  try {
    const skip = new Set((opts?.except ?? []).map((a) => principalKey(a.platform, a.nativeId)));
    const members = await expandLinkSet(org, linkSetId);
    for (const m of members) {
      if (skip.has(principalKey(m.platform, m.nativeId))) continue;
      if (!canDeliverDirectMessage(m.platform)) continue;
      try {
        await dispatchDirectMessage(m.platform, { principalId: m.nativeId, text });
        delivered++;
      } catch (err) {
        console.log(`[open-everywhere:identity] link-set ${linkSetId}: could not notify ${principalKey(m.platform, m.nativeId)}: ${String(err)}`);
      }
    }
  } catch (err) {
    console.log(`[open-everywhere:identity] link-set ${linkSetId}: member notification skipped: ${String(err)}`);
  }
  return delivered;
}
