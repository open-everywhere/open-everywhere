import type { Channel } from "eve/channels";
import type { TelegramReceiveTarget } from "eve/channels/telegram";
import type { DiscordReceiveTarget } from "eve/channels/discord";
import type { SessionMode } from "../access/resolver.js";
import type { Routine } from "../routines/routine.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { bridgeSlackChannel } from "../channels/slack-bridge.js";

export interface DispatchTarget {
  readonly channel: Channel<any, any, any>;
  readonly target: { channelId: string; threadTs?: string } | TelegramReceiveTarget | DiscordReceiveTarget | Readonly<Record<string, unknown>>;
  readonly mode: SessionMode;
  readonly attributes: Readonly<Record<string, string>>;
  readonly origin?: UnifiedWakeOrigin;
}

export interface RoutineDispatchProvider {
  readonly resolveTarget: (routine: Routine) => DispatchTarget | null;
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

function resolveSlackTarget(r: Routine): DispatchTarget | null {
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
  const platform = routine.surfaceKey.split("/")[0];
  if (platform === undefined) return null;
  const provider = resolveRegisteredRoutineDispatch(platform);
  if (provider) return provider.resolveTarget(routine);
  switch (platform) {
    case "slack":
      return resolveSlackTarget(routine);
    default:
      return null;
  }
}
