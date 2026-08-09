import type { BindableContext } from "../identity/binding.js";
import type { ReplyTarget } from "./reply-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { soleAdmittedTenantFromConfig } from "../access/tenant-admission.js";
import { appendAudit } from "../audit/audit.js";
import { expandLinkSet } from "../identity/link-store.js";
import { isTenantScopedPlatform, tryPrincipalKey } from "../identity/principal-key.js";
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

export const DM_WORKSPACE_UNREACHABLE_REASON = "workspace-unreachable";

export type DmWorkspaceReachability =
  | { readonly reachable: true }
  | { readonly reachable: false; readonly targetTenant: string; readonly armTenant: string };

export function classifyDmWorkspaceReachability(platform: string, targetTenant: string | undefined, armTenant: string | undefined): DmWorkspaceReachability {
  if (!isTenantScopedPlatform(platform)) return { reachable: true };
  const target = typeof targetTenant === "string" ? targetTenant.trim() : "";
  if (target.length === 0) return { reachable: true };
  if (armTenant === undefined) return { reachable: true };
  if (armTenant === target) return { reachable: true };
  return { reachable: false, targetTenant: target, armTenant };
}

export function dmWorkspaceReachableFromConfig(platform: string, targetTenant: string | undefined): DmWorkspaceReachability {
  return classifyDmWorkspaceReachability(platform, targetTenant, soleAdmittedTenantFromConfig(platform));
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
    const skip = new Set((opts?.except ?? []).map((a) => tryPrincipalKey(a.platform, a.tenant, a.nativeId)).filter((k): k is string => k !== undefined));
    const members = await expandLinkSet(org, linkSetId);
    for (const m of members) {
      const key = tryPrincipalKey(m.platform, m.tenant, m.nativeId);
      if (key !== undefined && skip.has(key)) continue;
      if (!canDeliverDirectMessage(m.platform)) continue;
      const reach = dmWorkspaceReachableFromConfig(m.platform, m.tenant);
      if (!reach.reachable) {
        await appendAudit({
          org,
          platform: m.platform,
          workspace: reach.targetTenant,
          action: "dm.delivery.skipped",
          detail: {
            reason: DM_WORKSPACE_UNREACHABLE_REASON,
            linkSetId,
            targetWorkspaceId: reach.targetTenant,
            armWorkspaceId: reach.armTenant,
          },
        }).catch(() => undefined);
        console.log(`[open-everywhere:identity] link-set ${linkSetId}: SKIPPED notifying ${key ?? `${m.platform} account \"${m.nativeId}\"`} — its workspace ("${reach.targetTenant}") is not the one this deployment's ${m.platform} credential serves ("${reach.armTenant}"); see the dm.delivery.skipped audit row.`);
        continue;
      }
      try {
        await dispatchDirectMessage(m.platform, { principalId: m.nativeId, text });
        delivered++;
      } catch (err) {
        console.log(`[open-everywhere:identity] link-set ${linkSetId}: could not notify ${key ?? `${m.platform} account \"${m.nativeId}\"`}: ${String(err)}`);
      }
    }
  } catch (err) {
    console.log(`[open-everywhere:identity] link-set ${linkSetId}: member notification skipped: ${String(err)}`);
  }
  return delivered;
}
