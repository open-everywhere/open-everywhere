import { auditErrorDetail } from "../audit/tool-action.js";
import type { Channel } from "eve/channels";
import type { DiscordReceiveTarget } from "eve/channels/discord";
import type { SessionMode } from "../access/resolver.js";
import { reportDestinationOf, type Routine } from "../routines/routine.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { bridgeSlackChannel, bridgeSlackForm } from "../channels/slack-bridge.js";
import { soleAdmittedTenantFromConfig } from "../access/tenant-admission.js";

export interface DispatchTarget {
  readonly channel: Channel<any, any, any>;
  readonly target: { channelId: string; threadTs?: string } | DiscordReceiveTarget | Readonly<Record<string, unknown>>;
  readonly mode: SessionMode;
  readonly attributes: Readonly<Record<string, string>>;
  readonly origin?: UnifiedWakeOrigin;
}

export type RoutineTargetFacts = Pick<Routine, "surfaceKey" | "target">;

export type DeclaredTargetSpec =
  | { readonly kind: "room"; readonly platform: string; readonly workspace: string; readonly surface: string }
  | { readonly kind: "person"; readonly platform: string; readonly tenant?: string; readonly principalId: string };

export type DeclaredTargetResolution =
  | { readonly ok: true; readonly facts: RoutineTargetFacts }
  | { readonly ok: false; readonly reason: string };

export interface RoutineDispatchProvider {
  readonly resolveTarget: (routine: Routine) => DispatchTarget | null;
  readonly resolveDeclaredTarget?: (spec: DeclaredTargetSpec) => Promise<DeclaredTargetResolution>;
  readonly reportTargetFor?: (surfaceKey: string) => Readonly<Record<string, unknown>> | null;
}

const ROUTINE_DISPATCH: Map<string, RoutineDispatchProvider> = new Map();

export function registerRoutineDispatch(platform: string, provider: RoutineDispatchProvider): void {
  if (!admitProviderRegistration(platform, "routine-dispatch")) return;
  ROUTINE_DISPATCH.set(platform, provider);
}

export function resolveRegisteredRoutineDispatch(platform: string): RoutineDispatchProvider | undefined {
  return ROUTINE_DISPATCH.get(platform);
}

function storedString(t: Routine["target"], key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveSlackTarget(r: RoutineTargetFacts): DispatchTarget | null {
  const channelId = storedString(r.target, "channelId");
  if (!channelId) return null;
  const slackChannel = bridgeSlackChannel();
  if (!slackChannel) return null;
  const mode: SessionMode = channelId.startsWith("D") ? "dm" : "channel";
  return {
    channel: slackChannel,
    target: { channelId },
    mode,
    attributes: {
      team_id: r.surfaceKey.split("/")[1] ?? "",
      channel_id: channelId,
      channel_type: mode === "dm" ? "im" : "channel",
    },
    origin: { platform: "slack", channelId },
  };
}

export function resolveRoutineTarget(routine: Routine): DispatchTarget | null {
  return resolveSurfaceTarget(reportDestinationOf(routine));
}

export function resolveSurfaceTarget(r: RoutineTargetFacts): DispatchTarget | null {
  const platform = r.surfaceKey.split("/")[0];
  if (platform === undefined) return null;
  const provider = resolveRegisteredRoutineDispatch(platform);
  if (provider) return provider.resolveTarget(r as Routine);
  switch (platform) {
    case "slack":
      return resolveSlackTarget(r);
    default:
      return null;
  }
}

export function canDispatchRoutinesOn(platform: string): boolean {
  return platform === "slack" || resolveRegisteredRoutineDispatch(platform) !== undefined;
}

export function reportTargetForSurface(surfaceKey: string): Readonly<Record<string, unknown>> | null {
  const segs = surfaceKey.split("/");
  const platform = segs[0];
  const surface = segs[2];
  if (platform === undefined || surface === undefined || surface.length === 0 || segs.length !== 3) return null;
  const provider = resolveRegisteredRoutineDispatch(platform);
  if (provider) return provider.reportTargetFor ? provider.reportTargetFor(surfaceKey) : null;
  return platform === "slack" ? { channelId: surface } : null;
}

async function resolveSlackDeclaredTarget(spec: DeclaredTargetSpec): Promise<DeclaredTargetResolution> {
  const tenant = spec.kind === "room" ? spec.workspace : (spec.tenant ?? "");
  const armTenant = soleAdmittedTenantFromConfig("slack");
  if (armTenant !== undefined && armTenant !== tenant) {
    return {
      ok: false,
      reason:
        `the target names Slack workspace "${tenant}", but this deployment's Slack app serves "${armTenant}". ` +
        `Point the target at "${armTenant}", or install the app in "${tenant}".`,
    };
  }
  if (spec.kind === "room") {
    return { ok: true, facts: { surfaceKey: `slack/${tenant}/${spec.surface}`, target: { channelId: spec.surface } } };
  }
  const info = await bridgeSlackForm("users.info", new URLSearchParams({ user: spec.principalId }).toString()).catch(() => undefined);
  const member = info?.["user"] as Record<string, unknown> | undefined;
  if (info?.["ok"] !== true || !member) {
    const error = typeof info?.["error"] === "string" ? info["error"] : "no response";
    return {
      ok: false,
      reason: `Slack users.info could not confirm ${spec.principalId} (${error}). The app needs the users:read bot scope, and the target must name a member of workspace "${tenant}".`,
    };
  }
  const memberTeam = typeof member["team_id"] === "string" ? member["team_id"] : "";
  const refusal =
    memberTeam !== tenant
      ? `${spec.principalId} is a member of workspace "${memberTeam || "(none)"}", not "${tenant}"`
      : member["is_stranger"] === true
        ? `${spec.principalId} is an external (Slack Connect) user`
        : member["is_restricted"] === true || member["is_ultra_restricted"] === true
          ? `${spec.principalId} is a guest of workspace "${tenant}"`
          : member["deleted"] === true
            ? `${spec.principalId} is deactivated`
            : member["is_bot"] === true
              ? `${spec.principalId} is a bot`
              : undefined;
  if (refusal !== undefined) {
    return {
      ok: false,
      reason: `${refusal}. A webhook delivers to a person's DM only for a full member of the workspace the target names; correct the target or remove it.`,
    };
  }
  const opened = await bridgeSlackForm("conversations.open", new URLSearchParams({ users: spec.principalId }).toString()).catch(() => undefined);
  const channel = opened?.["channel"] as { id?: unknown } | undefined;
  const dmChannelId = typeof channel?.id === "string" && channel.id.length > 0 ? channel.id : undefined;
  if (opened?.["ok"] !== true || !dmChannelId) {
    const error = typeof opened?.["error"] === "string" ? opened["error"] : "no channel returned";
    return {
      ok: false,
      reason:
        `Slack could not open a DM with ${spec.principalId} (${error}). The app needs the im:write bot scope, ` +
        `and the person must be an active member of workspace "${tenant}".`,
    };
  }
  return { ok: true, facts: { surfaceKey: `slack/${tenant}/${dmChannelId}`, target: { channelId: dmChannelId } } };
}

export type ResolvedDeclaredTarget =
  | { readonly ok: true; readonly surfaceKey: string; readonly dispatch: DispatchTarget }
  | { readonly ok: false; readonly reason: string };

export async function resolveDeclaredTarget(spec: DeclaredTargetSpec): Promise<ResolvedDeclaredTarget> {
  const provider = resolveRegisteredRoutineDispatch(spec.platform);
  const arm = provider ? provider.resolveDeclaredTarget : spec.platform === "slack" ? resolveSlackDeclaredTarget : undefined;
  if (!arm) {
    const capable = [
      ...(resolveRegisteredRoutineDispatch("slack") === undefined ? ["slack"] : []),
      ...[...ROUTINE_DISPATCH.entries()].filter(([, p]) => p.resolveDeclaredTarget !== undefined).map(([name]) => name),
    ];
    return {
      ok: false,
      reason:
        `no provider on this deployment resolves a declared target on "${spec.platform}" ` +
        `(declared targets resolve on: ${capable.length > 0 ? capable.join(", ") : "no platform"}). ` +
        `Select and register the ${spec.platform} provider bundle, or point the target at a platform listed here.`,
    };
  }
  let resolved: DeclaredTargetResolution;
  try {
    resolved = await arm(spec);
  } catch (err) {
    return { ok: false, reason: `the ${spec.platform} target resolver failed: ${auditErrorDetail(err).error}` };
  }
  if (!resolved.ok) return resolved;
  const dispatch = resolveSurfaceTarget(resolved.facts);
  if (!dispatch) {
    return {
      ok: false,
      reason:
        `the target resolved to ${resolved.facts.surfaceKey}, but no ${spec.platform} channel can post there ` +
        `(is the ${spec.platform} provider bundle registered, with its credentials set?)`,
    };
  }
  return { ok: true, surfaceKey: resolved.facts.surfaceKey, dispatch };
}
