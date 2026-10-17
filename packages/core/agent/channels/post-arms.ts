import type { BindableContext } from "../identity/binding.js";
import type { ReplyAudit, ReplyTarget, ReplierLabel } from "./reply-post.js";
import type { EditLocus } from "./reply-edit.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";
import type { SourceLink } from "./reply-provenance.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { soleAdmittedTenantFromConfig } from "../access/tenant-admission.js";
import { appendAudit } from "../audit/audit.js";
import { expandLinkSet } from "../identity/link-store.js";
import { isTenantScopedPlatform, tryPrincipalKey } from "../identity/principal-key.js";
import type { LinkedAccount } from "../identity/link-store.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { FRIENDLY_GUARDED, FRIENDLY_SOURCE, friendlyOutboundText, isFriendlyGuarded } from "./friendly-outbound.js";

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

export interface DirectMessageAction {
  readonly id: string;
  readonly label: string;
  readonly intent: "affirm" | "reject";
}

export interface DirectMessageRequest {
  readonly principalId: string;
  readonly text: string;
  readonly actions?: readonly DirectMessageAction[];
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

export type ReactTarget =
  | { readonly platform: "linear"; readonly issueId: string; readonly organizationId?: string }
  | { readonly platform: "github"; readonly owner: string; readonly repo: string; readonly issueNumber: number; readonly installationId?: number }
  | { readonly platform: "discord"; readonly channelId: string; readonly messageId: string };

export interface PostIntent {
  readonly terminal: boolean;
  readonly sources?: readonly SourceLink[];
  readonly feedback?: boolean;
  readonly generated?: boolean;
}

export interface PostArm {
  readonly platform: string;
  resolveTarget?(bag: TargetResolveBag): ReplyTarget | null;
  dispatchReply?(target: ReplyTarget, text: string, replier?: ReplierLabel, intent?: PostIntent): Promise<string>;
  isDirectConversation?(locus: { readonly channelId: string }): boolean;
  readonly displayNameCapable?: boolean;
  dispatchUnified?(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps, replier?: ReplierLabel, intent?: PostIntent): Promise<string>;
  closeUnifiedSilently?(origin: UnifiedWakeOrigin, deps: UnifiedReplyDeps, answered?: boolean): Promise<void>;
  editMessage?(locus: EditLocus, messageId: string, text: string, intent?: PostIntent): Promise<void>;
  editReachable?(locus: { readonly platform: string; readonly channelId: string }): Promise<boolean>;
  retargetEditLocus?(origin: UnifiedWakeOrigin, locus: EditLocus): Promise<EditLocus>;
  describeRedriveTarget?(origin: UnifiedWakeOrigin): string;
  redriveContainerId?(origin: UnifiedWakeOrigin): string;
  deliverDirectMessage?(input: DirectMessageRequest): Promise<DirectMessageDelivery>;
  resolveReactTarget?(bag: TargetResolveBag): ReactTarget | null;
  react?(target: ReactTarget, emoji: string): Promise<void>;
}

function guardPostArm(arm: PostArm): PostArm {
  if (isFriendlyGuarded(arm)) return arm;
  const source = arm as unknown as Record<string, unknown>;
  const guarded: Record<string | symbol, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    guarded[key] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(arm) : value;
  }
  const p = arm.platform;
  const wrap = (key: string, textAt: number, intentAt: number): void => {
    const fn = source[key];
    if (typeof fn !== "function") return;
    guarded[key] = async (...args: unknown[]) => {
      if (typeof args[textAt] === "string") args[textAt] = await friendlyOutboundText(args[textAt] as string, p);
      const intent = args[intentAt] as PostIntent | undefined;
      if (intent?.sources !== undefined && intent.sources.length > 0) {
        const sources = await Promise.all(intent.sources.map(async (s) => ({ ...s, name: await friendlyOutboundText(s.name, p) })));
        args[intentAt] = { ...intent, sources };
      }
      return (fn as (...a: unknown[]) => unknown).apply(arm, args);
    };
  };
  wrap("dispatchReply", 1, 3);
  wrap("dispatchUnified", 1, 4);
  wrap("editMessage", 2, 3);
  const deliver = source.deliverDirectMessage;
  if (typeof deliver === "function") {
    guarded.deliverDirectMessage = async (input: { readonly text: string }) =>
      (deliver as (i: unknown) => unknown).call(arm, { ...input, text: await friendlyOutboundText(input.text, p) });
  }
  guarded[FRIENDLY_GUARDED] = true;
  guarded[FRIENDLY_SOURCE] = arm;
  return guarded as unknown as PostArm;
}

const POST_ARMS = processRegistryMap<PostArm>("post-arms.v1");

export function registerPostArm(arm: PostArm): void {
  if (!admitProviderRegistration(arm.platform, "post-arm")) return;
  POST_ARMS.set(arm.platform, guardPostArm(arm));
}

export function answerIntent(
  audit: ReplyAudit | undefined,
  sources: readonly SourceLink[],
  terminal = true,
  host = false,
): PostIntent {
  if (host) return { terminal };
  return {
    terminal,
    ...(audit !== undefined ? { generated: true } : {}),
    ...(audit !== undefined && terminal ? { feedback: true } : {}),
    ...(terminal && sources.length > 0 ? { sources } : {}),
  };
}

export function landsInDirectConversation(platform: string | undefined, channelId: string | undefined): boolean {
  if (channelId === undefined || channelId.length === 0) return false;
  try {
    return postArm(platform)?.isDirectConversation?.({ channelId }) === true;
  } catch {
    return false;
  }
}

export function postArm(platform: string | undefined): PostArm | undefined {
  return platform === undefined ? undefined : POST_ARMS.get(platform);
}

export function registeredPostArmPlatforms(): readonly string[] {
  return [...POST_ARMS.keys()];
}

export function directMessageCapablePlatforms(): readonly string[] {
  return [...POST_ARMS.values()]
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
  text: string | ((platform: string) => string | Promise<string>),
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
        await dispatchDirectMessage(m.platform, { principalId: m.nativeId, text: typeof text === "string" ? text : await text(m.platform) });
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

